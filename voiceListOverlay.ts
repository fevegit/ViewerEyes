/*
 * ViewerEyes - voice channel list badge overlay
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SettingsStore } from "@api/Settings";
import type { User } from "@vencord/discord-types";
import { ChannelStore, RelationshipStore, SelectedChannelStore, UserStore, VoiceStateStore } from "@webpack/common";
import { t } from "./i18n";

import {
    type ActiveBroadcast,
    getCurrentUserActiveStream,
    getServerNickname,
    getViewerIds,
    markFeatureEnabled,
    reportRuntimeError,
    subscribeToStreamingChanges,
    updateFeatureHealth
} from "./runtime";

export interface VoiceListEyeRuntime {
    includeSelf(): boolean;
    previewSettingPath: string;
}

interface LocatedVoiceRow {
    row: HTMLElement;
    nameElement: HTMLElement | null;
    directAnchor?: HTMLElement;
}

const LEFT_SIDEBAR_LIMIT = 620;
const EYE_SIZE = 16;
const EYE_GAP = 5;
const ROW_MISS_GRACE_MS = 1_800;

let runtime: VoiceListEyeRuntime | null = null;
let voiceObserver: MutationObserver | null = null;
let storeUnsubscribe: (() => void) | null = null;
let previewSettingListener: (() => void) | null = null;
let previewPollTimer: number | null = null;
let scheduledFrame = 0;
let pointerX = -1;
let pointerY = -1;

function foldText(value: string | null | undefined): string {
    return value?.trim().toLocaleLowerCase() ?? "";
}


function displayName(user: User): string {
    return RelationshipStore.getNickname(user.id) || user.globalName || user.username;
}

function serverNickname(userId: string, guildId?: string): string | undefined {
    return getServerNickname(guildId, userId);
}

function identityAliases(user: User, guildId?: string): Set<string> {
    const names = new Set<string>();
    const candidates = [
        serverNickname(user.id, guildId),
        RelationshipStore.getNickname(user.id),
        user.globalName,
        user.username
    ];

    for (const candidate of candidates) {
        const value = foldText(candidate);
        if (value) names.add(value);
    }

    return names;
}

function textMatchesAlias(text: string, alias: string): boolean {
    if (!alias) return false;
    if (text === alias || text.startsWith(`${alias} `) || text.startsWith(`${alias},`)) return true;
    return [...alias].length > 2 && text.includes(alias);
}

function isAvatarLike(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    if (rect.width < 16 || rect.width > 52 || rect.height < 16 || rect.height > 52) return false;

    if (element.tagName === "IMG") return true;
    const className = typeof element.className === "string" ? element.className : "";
    const style = getComputedStyle(element);
    return /avatar/i.test(className) || (style.backgroundImage !== "none" && style.backgroundImage !== "");
}

function rowHasAvatar(row: HTMLElement): boolean {
    return [...row.querySelectorAll<HTMLElement>("img, [class*='avatar'], [style*='background-image']")]
        .some(isAvatarLike);
}

/* VIEWEREYES_DEMO_ALL_VOICE_USERS_TEST
 * En modo demo, todos los usuarios del canal de voz actual son objetivos.
 * Esto permite comprobar de forma determinista cada fila y cada rerender de Discord.
 */
function currentVoiceGuildId(): string | undefined {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return undefined;

    const channel = ChannelStore.getChannel(channelId) as {
        guild_id?: string;
        guildId?: string;
    } | null | undefined;

    return channel?.guild_id ?? channel?.guildId;
}

function resolveDemoVoiceUsers(): User[] {
    if (runtime?.includeSelf() !== true) return [];

    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return [];

    const voiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) as
        | Record<string, { userId?: string; }>
        | null
        | undefined;

    if (!voiceStates) return [];

    const users: User[] = [];
    const seen = new Set<string>();

    for (const [stateKey, state] of Object.entries(voiceStates)) {
        const userId = state?.userId ?? stateKey;
        if (!userId || seen.has(userId)) continue;

        const user = UserStore.getUser(userId) as User | undefined;
        if (!user) continue;

        seen.add(userId);
        users.push(user);
    }

    return users;
}

function resolveEyeTargets(
    stream: ActiveBroadcast | null = getCurrentUserActiveStream()
): User[] {
    const users = stream
        ? getViewerIds(stream)
            .map(id => UserStore.getUser(id) as User | undefined)
            .filter((user): user is User => user != null)
        : [];

    const seen = new Set(users.map(user => user.id));

    for (const demoUser of resolveDemoVoiceUsers()) {
        if (seen.has(demoUser.id)) continue;

        seen.add(demoUser.id);
        users.push(demoUser);
    }

    return users;
}

function isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
        element.isConnected &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
    );
}

function isInsideLeftChannelSidebar(element: HTMLElement): boolean {
    if (!isInsideLeftSidebarGeometry(element)) return false;

    // Prefer semantic containers when Discord exposes them, but do not require
    // generated class names: recent builds render voice rows in obfuscated divs.
    return element.closest("nav, aside, [class*='sidebar'], [class*='channels']") != null ||
        element.getBoundingClientRect().left >= 55;
}

function isInsideLeftSidebarGeometry(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    if (!isVisible(element)) return false;
    if (rect.left < 55 || rect.right > Math.min(window.innerWidth, LEFT_SIDEBAR_LIMIT)) return false;

    return element.closest(
        ".vc-viewer-eyes-layer, .vc-viewer-eyes-voice-layer, " +
        "[class*='callContainer'], [class*='videoGrid'], [class*='videoGridWrapper'], " +
        "[class*='panels']"
    ) == null;
}

function rowContainsIdentity(row: HTMLElement, user: User, guildId?: string): boolean {
    const escapedId = CSS.escape(user.id);
    if (row.matches(`[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"]`)) return true;
    if (row.querySelector(
        `[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"], ` +
        `[src*="${escapedId}"], [style*="${escapedId}"]`
    )) return true;

    const text = foldText(row.textContent);
    return [...identityAliases(user, guildId)].some(name => textMatchesAlias(text, name));
}

function isVoiceRowCandidate(element: HTMLElement, user: User, guildId?: string): boolean {
    // Discord's current voice-user rows are not always nested inside an element
    // whose generated class contains "sidebar" or "channels". Geometry is more
    // reliable here, while the identity and row-size checks below keep the match
    // constrained to the left channel column.
    if (!isVisible(element) || !isInsideLeftSidebarGeometry(element)) return false;

    const rect = element.getBoundingClientRect();
    const ratio = rect.width / Math.max(1, rect.height);

    if (rect.width < 90 || rect.width > 430) return false;
    if (rect.height < 22 || rect.height > 80) return false;
    if (ratio < 2.0) return false;
    if (element.querySelector("video, canvas")) return false;

    if (!rowHasAvatar(element)) return false;
    return rowContainsIdentity(element, user, guildId);
}

function rankVoiceRow(row: HTMLElement, user: User, guildId?: string): number {
    const rect = row.getBoundingClientRect();
    const escapedId = CSS.escape(user.id);
    const text = foldText(row.textContent);
    const aliases = identityAliases(user, guildId);
    let score = 0;

    if (row.matches(`[data-user-id="${escapedId}"]`)) score += 160;
    if (row.matches(`[data-list-item-id*="${escapedId}"]`)) score += 145;
    if (row.querySelector(`[src*="${escapedId}"], [style*="${escapedId}"]`)) score += 120;
    if (row.querySelector(`[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"]`)) score += 90;
    if (row.matches("[role='button'], [role='treeitem'], [role='listitem']")) score += 28;
    if (/voice|user|member/.test(row.className)) score += 18;
    if ([...aliases].some(name => text === name || text.startsWith(`${name} `))) score += 35;

    score -= Math.abs(rect.height - 36) * 1.4;
    score -= Math.log(Math.max(1, rect.width * rect.height));
    return score;
}

function identityAnchors(user: User, guildId?: string): Set<HTMLElement> {
    const result = new Set<HTMLElement>();
    const escapedId = CSS.escape(user.id);

    for (const selector of [
        `[data-user-id="${escapedId}"]`,
        `[data-list-item-id*="${escapedId}"]`,
        `[src*="${escapedId}"]`,
        `[style*="${escapedId}"]`
    ]) {
        document.querySelectorAll<HTMLElement>(selector).forEach(element => {
            if (isInsideLeftChannelSidebar(element)) result.add(element);
        });
    }

    if (result.size) return result;

    const names = identityAliases(user, guildId);
    if (!names.size) return result;

    document.querySelectorAll<HTMLElement>(
        "[aria-label], [title], img[alt], [data-name], [data-username]"
    ).forEach(element => {
        if (!isInsideLeftChannelSidebar(element)) return;

        const values = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("alt"),
            element.getAttribute("data-name"),
            element.getAttribute("data-username")
        ].map(foldText).filter(Boolean);

        if (values.some(value => [...names].some(name => textMatchesAlias(value, name)))) result.add(element);
    });

    // Discord does not always expose the current user's voice-row identity through
    // aria/data attributes. Fall back to exact visible username text in the left
    // channel sidebar so preview mode can also mark the local user reliably.
    if (!result.size) {
        document.querySelectorAll<HTMLElement>(
            "span, [class*='name'], [data-name], [data-username]"
        ).forEach(element => {
            if (!isInsideLeftChannelSidebar(element)) return;
            if (element.childElementCount > 1) return;

            const text = foldText(element.textContent);
            if (!names.has(text)) return;

            const rect = element.getBoundingClientRect();
            if (rect.width < 4 || rect.width > 220 || rect.height < 8 || rect.height > 34) return;
            result.add(element);
        });
    }

    return result;
}

function findNameElement(row: HTMLElement, user: User, guildId?: string): HTMLElement | null {
    const names = identityAliases(user, guildId);
    let best: { element: HTMLElement; score: number; } | null = null;

    row.querySelectorAll<HTMLElement>("span, div").forEach(element => {
        if (element.childElementCount > 2) return;

        const text = foldText(element.textContent);
        if (!names.has(text)) return;

        const rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 8 || rect.height > 34) return;

        const score = 100 - rect.width * 0.01 - rect.height * 0.1;
        if (!best || score > best.score) best = { element, score };
    });

    return (best as { element: HTMLElement } | null)?.element ?? null;
}


function locateCurrentStreamerLiveBadge(): LocatedVoiceRow | null {
    let best: { element: HTMLElement; score: number; } | null = null;

    document.querySelectorAll<HTMLElement>("span, div").forEach(element => {
        if (!/^(?:en directo|live)$/.test(foldText(element.textContent))) return;
        if (!isInsideLeftSidebarGeometry(element)) return;

        const rect = element.getBoundingClientRect();
        if (rect.width < 28 || rect.width > 130 || rect.height < 12 || rect.height > 34) return;

        // Prefer the voice-list badge, which is compact and sits inside the
        // channel column. The stream tile's badge is outside the geometry limit.
        const score = 300
            - Math.abs(rect.height - 18) * 4
            - Math.abs(rect.width - 68) * 0.3
            - rect.left * 0.01;

        if (!best || score > best.score) best = { element, score };
    });

    if (!best) return null;

    return {
        row: (best as { element: HTMLElement }).element.parentElement ?? (best as { element: HTMLElement }).element,
        nameElement: null,
        directAnchor: (best as { element: HTMLElement }).element
    };
}

function locateCurrentStreamerVoiceRow(user: User, guildId?: string): LocatedVoiceRow | null {
    const aliases = identityAliases(user, guildId);
    let best: { row: HTMLElement; nameElement: HTMLElement | null; score: number; } | null = null;

    document.querySelectorAll<HTMLElement>("span, div").forEach(liveBadge => {
        const liveText = foldText(liveBadge.textContent);
        if (!/^(?:en directo|live)$/.test(liveText)) return;
        if (!isInsideLeftSidebarGeometry(liveBadge)) return;

        let row: HTMLElement | null = liveBadge.parentElement;
        let depth = 0;

        while (row && depth < 12) {
            const rect = row.getBoundingClientRect();
            const text = foldText(row.textContent);
            const hasAlias = [...aliases].some(alias =>
                text === alias || text.startsWith(`${alias} `) || text.includes(alias)
            );
            const escapedId = CSS.escape(user.id);
            const hasUserIdentity = hasAlias || row.matches(
                `[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"]`
            ) || row.querySelector(
                `[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"], ` +
                `[src*="${escapedId}"], [style*="${escapedId}"]`
            ) != null;
            const hasAvatar = rowHasAvatar(row);

            if (
                isInsideLeftSidebarGeometry(row) &&
                rect.width >= 120 && rect.width <= 430 &&
                rect.height >= 24 && rect.height <= 62 &&
                !row.querySelector("video, canvas") &&
                hasAvatar && hasUserIdentity
            ) {
                const nameElement = findNameElement(row, user, guildId);
                const score = 500
                    - Math.abs(rect.height - 34) * 4
                    - Math.abs(rect.width - 245) * 0.03
                    - depth * 5;

                if (!best || score > best.score) {
                    best = { row, nameElement, score };
                }
            }

            row = row.parentElement;
            depth += 1;
        }
    });

    if (!best) return locateCurrentStreamerLiveBadge();
    return { row: (best as { row: HTMLElement; nameElement: HTMLElement | null }).row, nameElement: (best as { row: HTMLElement; nameElement: HTMLElement | null }).nameElement };
}

function locateVoiceRowByExactText(user: User, guildId?: string): LocatedVoiceRow | null {
    const names = identityAliases(user, guildId);
    let best: { row: HTMLElement; nameElement: HTMLElement; score: number; } | null = null;

    document.querySelectorAll<HTMLElement>(
        "span, [class*='name'], [data-name], [data-username]"
    ).forEach(element => {
        if (!isInsideLeftSidebarGeometry(element)) return;
        if (element.childElementCount > 2) return;

        const text = foldText(element.textContent);
        if (!names.has(text)) return;

        let row: HTMLElement | null = element;
        let depth = 0;
        while (row && depth < 12) {
            if (isVoiceRowCandidate(row, user, guildId)) {
                const rect = row.getBoundingClientRect();
                const score = 200 - Math.abs(rect.height - 34) - Math.abs(rect.width - 240) * 0.02 - depth * 4;
                if (!best || score > best.score) best = { row, nameElement: element, score };
            }
            row = row.parentElement;
            depth += 1;
        }
    });

    if (!best) return null;
    return { row: (best as { row: HTMLElement; nameElement: HTMLElement }).row, nameElement: (best as { row: HTMLElement; nameElement: HTMLElement }).nameElement };
}

function locateVoiceRow(user: User, guildId?: string): LocatedVoiceRow | null {
    let best: { row: HTMLElement; score: number; } | null = null;
    const seen = new Set<HTMLElement>();

    for (const anchor of identityAnchors(user, guildId)) {
        let element: HTMLElement | null = anchor;
        let depth = 0;

        while (element && depth < 14) {
            if (!seen.has(element) && isVoiceRowCandidate(element, user, guildId)) {
                seen.add(element);
                const score = rankVoiceRow(element, user, guildId);
                if (!best || score > best.score) best = { row: element, score };
            }

            element = element.parentElement;
            depth += 1;
        }
    }

    if (!best) return locateVoiceRowByExactText(user, guildId);
    return {
        row: best.row,
        nameElement: findNameElement(best.row, user, guildId)
    };
}

/* VIEWEREYES_VOICE_ROWS_V4_TEST
 * El modo demo descubre todas las filas visibles directamente en el DOM.
 * Así no depende de que Discord exponga el ID o el apodo de cada usuario.
 */
/* VIEWEREYES_VOICE_ROW_CENTERS_V5_TEST
 * Cada fila se identifica por el centro vertical de su avatar.
 * Las filas altas por actividades, etiquetas o LIVE ya no absorben a sus vecinas.
 */
function rowAvatarGeometry(
    element: HTMLElement
): { anchor: HTMLElement; centerY: number; } | null {
    const rowRect = element.getBoundingClientRect();
    const anchors = element.querySelectorAll<HTMLElement>(
        "img, [class*='avatar'], [style*='background-image']"
    );

    for (const anchor of anchors) {
        if (!isVisible(anchor)) continue;

        const rect = anchor.getBoundingClientRect();
        const squareDifference = Math.abs(rect.width - rect.height);
        const centerY = rect.top + rect.height / 2;

        if (rect.width < 18 || rect.width > 44) continue;
        if (rect.height < 18 || rect.height > 44) continue;
        if (squareDifference > 9) continue;
        if (rect.left < rowRect.left - 1 || rect.right > rowRect.left + 82) continue;
        if (centerY < rowRect.top || centerY > rowRect.bottom) continue;

        return { anchor, centerY };
    }

    return null;
}

/* VIEWEREYES_VOICE_SCOPE_COLOR_V6_TEST
 * El modo demo sigue funcionando sin compartir pantalla, pero las filas
 * solo se aceptan dentro del bloque visible del canal de voz seleccionado.
 */
interface CurrentVoiceSectionBounds {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

function currentVoiceSectionBounds(): CurrentVoiceSectionBounds | null {
    const channelId = SelectedChannelStore.getVoiceChannelId();

    if (!channelId) return null;

    const escapedId = CSS.escape(channelId);
    const possibleHeaders = document.querySelectorAll<HTMLElement>(
        `[data-list-item-id*="${escapedId}"], [data-channel-id="${escapedId}"]`
    );
    let bestHeader: { element: HTMLElement; score: number; } | null = null;

    possibleHeaders.forEach(candidate => {
        let element: HTMLElement | null =
            candidate.closest<HTMLElement>(
                "[data-list-item-id^='channels___'], [data-channel-id]"
            ) ?? candidate;
        let depth = 0;

        while (element && depth < 5) {
            if (isInsideLeftSidebarGeometry(element)) {
                const rect = element.getBoundingClientRect();
                const itemId = element.getAttribute("data-list-item-id") ?? "";
                const channelAttribute = element.getAttribute("data-channel-id");
                const containsId =
                    itemId.includes(channelId) ||
                    channelAttribute === channelId;

                if (
                    containsId &&
                    rect.width >= 150 &&
                    rect.width <= 430 &&
                    rect.height >= 24 &&
                    rect.height <= 64
                ) {
                    const score =
                        (itemId.startsWith("channels___") ? 200 : 0) +
                        (channelAttribute === channelId ? 120 : 0) +
                        100 -
                        Math.abs(rect.height - 36) * 4 -
                        depth * 8;

                    if (!bestHeader || score > bestHeader.score) {
                        bestHeader = {
                            element,
                            score
                        };
                    }
                }
            }

            element = element.parentElement;
            depth += 1;
        }
    });

    if (!bestHeader) return null;

    const headerRect = (bestHeader as { element: HTMLElement }).element.getBoundingClientRect();
    let bottom = window.innerHeight;

    document.querySelectorAll<HTMLElement>(
        "[data-list-item-id^='channels___']"
    ).forEach(element => {
        if (element === bestHeader!.element || !isVisible(element)) return;

        const rect = element.getBoundingClientRect();
        const sameColumn =
            rect.left < headerRect.right &&
            rect.right > headerRect.left;

        if (
            sameColumn &&
            rect.top > headerRect.bottom + 2 &&
            rect.top < bottom
        ) {
            bottom = rect.top;
        }
    });

    document.querySelectorAll<HTMLElement>("[class*='panels']").forEach(panel => {
        if (!isVisible(panel)) return;

        const rect = panel.getBoundingClientRect();
        const sameColumn =
            rect.left < headerRect.right &&
            rect.right > headerRect.left;

        if (
            sameColumn &&
            rect.top > headerRect.bottom &&
            rect.top < bottom
        ) {
            bottom = rect.top;
        }
    });

    if (bottom <= headerRect.bottom + 18) return null;

    return {
        left: headerRect.left - 6,
        right: headerRect.right + 6,
        top: headerRect.bottom - 2,
        bottom
    };
}

function isInsideCurrentVoiceSection(
    element: HTMLElement,
    bounds: CurrentVoiceSectionBounds
): boolean {
    if (!isVisible(element)) return false;

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    return (
        centerX >= bounds.left &&
        centerX <= bounds.right &&
        centerY >= bounds.top &&
        centerY < bounds.bottom
    );
}

function isGenericVoiceRowCandidate(element: HTMLElement): boolean {
    const bounds = currentVoiceSectionBounds();

    if (
        !bounds ||
        !isInsideCurrentVoiceSection(element, bounds) ||
        !isInsideLeftSidebarGeometry(element)
    ) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    const ratio = rect.width / Math.max(1, rect.height);

    if (rect.width < 150 || rect.width > 430) return false;
    if (rect.height < 24 || rect.height > 58) return false;
    if (ratio < 3) return false;
    if (element.querySelector("video, canvas")) return false;

    return rowAvatarGeometry(element) != null;
}

function locateVisibleVoiceRows(): LocatedVoiceRow[] {
    type Candidate = {
        row: HTMLElement;
        centerY: number;
        score: number;
    };

    const bounds = currentVoiceSectionBounds();

    if (!bounds) return [];

    const candidates: Candidate[] = [];
    const anchors = document.querySelectorAll<HTMLElement>(
        "img, [class*='avatar'], [style*='background-image']"
    );

    anchors.forEach(anchor => {
        if (
            !isInsideCurrentVoiceSection(anchor, bounds) ||
            !isInsideLeftChannelSidebar(anchor)
        ) {
            return;
        }

        const anchorRect = anchor.getBoundingClientRect();
        const centerY = anchorRect.top + anchorRect.height / 2;

        if (anchorRect.width < 18 || anchorRect.width > 44) return;
        if (anchorRect.height < 18 || anchorRect.height > 44) return;
        if (Math.abs(anchorRect.width - anchorRect.height) > 9) return;

        let element: HTMLElement | null = anchor;
        let depth = 0;
        let best: Candidate | null = null;

        while (element && depth < 14) {
            if (isGenericVoiceRowCandidate(element)) {
                const rect = element.getBoundingClientRect();
                const avatar = rowAvatarGeometry(element);

                if (avatar && Math.abs(avatar.centerY - centerY) <= 5) {
                    const preferredHeightPenalty =
                        Math.abs(rect.height - 32) * 24;
                    const tallPenalty = rect.height > 46
                        ? (rect.height - 46) * 70 + 350
                        : 0;
                    const widthReward =
                        Math.min(rect.width, 330) * 0.45;
                    const roleBonus = element.matches(
                        "[role='button'], [role='treeitem'], [role='listitem']"
                    ) ? 12 : 0;
                    const score =
                        1400 +
                        widthReward +
                        roleBonus -
                        preferredHeightPenalty -
                        tallPenalty -
                        depth * 3;

                    if (!best || score > best.score) {
                        best = {
                            row: element,
                            centerY,
                            score
                        };
                    }
                }
            }

            element = element.parentElement;
            depth += 1;
        }

        if (best) candidates.push(best);
    });

    const groups: Array<{
        centerY: number;
        candidate: Candidate;
    }> = [];

    candidates
        .sort((a, b) => a.centerY - b.centerY || b.score - a.score)
        .forEach(candidate => {
            const group = groups.find(
                existing =>
                    Math.abs(existing.centerY - candidate.centerY) <= 5
            );

            if (!group) {
                groups.push({
                    centerY: candidate.centerY,
                    candidate
                });
                return;
            }

            if (candidate.score > group.candidate.score) {
                group.centerY = candidate.centerY;
                group.candidate = candidate;
            }
        });

    return groups
        .sort((a, b) => a.centerY - b.centerY)
        .map(({ candidate }) => ({
            row: candidate.row,
            nameElement: null
        }));
}

function ensureVoiceLayer(): HTMLDivElement {
    const layer = document.createElement("div");
    layer.className = "vc-viewer-eyes-voice-layer";
    document.body.append(layer);
    return layer;
}

function updateVoiceBadgeLabel(host: HTMLElement, user: User): void {
    const name = displayName(user);
    const tooltip = t(
        `${name} está viendo tu transmisión`,
        `${name} is watching your stream`
    );

    host.dataset.viewerEyesTooltip = tooltip;
    host.setAttribute("aria-label", tooltip);
}

function makeVoiceBadge(user: User): HTMLDivElement {
    const host = document.createElement("div");
    host.className = "vc-viewer-eyes-voice-host vc-viewer-eyes-voice-host-entering";
    host.dataset.viewerEyesUserId = user.id;
    host.setAttribute("role", "img");
    updateVoiceBadgeLabel(host, user);

    host.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M2.1 12s3.6-6.1 9.9-6.1S21.9 12 21.9 12 18.3 18.1 12 18.1 2.1 12 2.1 12Z"></path>
            <circle cx="12" cy="12" r="3.1"></circle>
        </svg>`;

    return host;
}

function findStatusAnchor(
    row: HTMLElement,
    nameElement: HTMLElement | null,
    liveBadge: HTMLElement | null
): HTMLElement | null {
    const rowRect = row.getBoundingClientRect();
    const liveRect = liveBadge?.getBoundingClientRect();
    const minimumLeft = Math.max(
        rowRect.left + rowRect.width * 0.46,
        (nameElement?.getBoundingClientRect().right ?? rowRect.left + 54) + 4
    );
    let best: { element: HTMLElement; left: number; } | null = null;

    row.querySelectorAll<HTMLElement>(
        "svg, [role='img'], [class*='icon']"
    ).forEach(element => {
        if (
            liveBadge &&
            (
                element === liveBadge ||
                liveBadge.contains(element) ||
                element.contains(liveBadge)
            )
        ) return;

        const rect = element.getBoundingClientRect();

        if (
            rect.width < 10 ||
            rect.width > 30 ||
            rect.height < 10 ||
            rect.height > 30
        ) return;

        if (rect.left < minimumLeft || rect.right > rowRect.right + 1) return;
        if (rect.top < rowRect.top - 1 || rect.bottom > rowRect.bottom + 1) return;

        if (
            liveRect &&
            rect.left < liveRect.right + 1 &&
            rect.right > liveRect.left - 1
        ) return;

        if (!best || rect.left < best.left) {
            best = { element, left: rect.left };
        }
    });

    return (best as { element: HTMLElement } | null)?.element ?? null;
}

function findLiveBadge(row: HTMLElement, nameElement: HTMLElement | null): HTMLElement | null {
    const rowRect = row.getBoundingClientRect();
    const minimumLeft = (nameElement?.getBoundingClientRect().right ?? rowRect.left + 54) + 4;
    let best: { element: HTMLElement; left: number; } | null = null;

    row.querySelectorAll<HTMLElement>("span, div").forEach(element => {
        const text = foldText(element.textContent);
        if (!/^(?:en directo|live)$/.test(text)) return;

        const rect = element.getBoundingClientRect();
        if (rect.left < minimumLeft || rect.width < 20 || rect.width > 120 || rect.height > 30) return;
        if (!best || rect.left < best.left) best = { element, left: rect.left };
    });

    return (best as { element: HTMLElement } | null)?.element ?? null;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}

function px(value: number): string {
    return `${Math.round(value * 100) / 100}px`;
}


function applyMatchingStatusColor(
    host: HTMLElement,
    _anchor: HTMLElement | null
): void {
    // No copiar colores de mute, deafen, actividades, insignias o LIVE:
    // algunos iconos internos de Discord exponen negro como fill/stroke.
    host.style.setProperty(
        "color",
        "#737883",
        "important"
    );
    host.style.setProperty("opacity", "1", "important");
}

function setVoiceBadgeRect(
    host: HTMLElement,
    left: number,
    top: number
): void {
    host.style.left = px(left);
    host.style.top = px(top);
    host.style.width = `${EYE_SIZE}px`;
    host.style.height = `${EYE_SIZE}px`;
}

function overlapsRect(
    left: number,
    top: number,
    rect: DOMRect,
    padding = 2
): boolean {
    return (
        left < rect.right + padding &&
        left + EYE_SIZE > rect.left - padding &&
        top < rect.bottom + padding &&
        top + EYE_SIZE > rect.top - padding
    );
}

function placeVoiceBadge(
    host: HTMLElement,
    located: LocatedVoiceRow
): void {
    const { row, nameElement, directAnchor } = located;
    const rowRect = row.getBoundingClientRect();
    const nameRect = nameElement?.getBoundingClientRect();
    const liveBadge = directAnchor?.isConnected
        ? directAnchor
        : findLiveBadge(row, nameElement);
    const statusAnchor = findStatusAnchor(row, nameElement, liveBadge);
    const top = rowRect.top + (rowRect.height - EYE_SIZE) / 2;
    const minimumLeft = Math.max(
        rowRect.left + 48,
        (nameRect?.right ?? rowRect.left + 48) + 5
    );
    const maximumLeft = rowRect.right - EYE_SIZE - 7;

    applyMatchingStatusColor(host, statusAnchor);

    const obstacleRects: DOMRect[] = [];

    row.querySelectorAll<HTMLElement>(
        "svg, [role='img'], [class*='icon'], span, div"
    ).forEach(element => {
        if (
            element === row ||
            element === host ||
            element.closest(".vc-viewer-eyes-voice-host") ||
            (
                nameElement &&
                (
                    element === nameElement ||
                    nameElement.contains(element) ||
                    element.contains(nameElement)
                )
            )
        ) return;

        const rect = element.getBoundingClientRect();
        const text = foldText(element.textContent);
        const iconLike =
            element.matches("svg, [role='img'], [class*='icon']") ||
            element.querySelector(":scope > svg") != null;
        const compactBadge =
            rect.width >= 14 &&
            rect.width <= 120 &&
            rect.height >= 12 &&
            rect.height <= 30 &&
            text.length > 0 &&
            text.length <= 24;

        if (!iconLike && !compactBadge) return;
        if (rect.width < 8 || rect.width > 120) return;
        if (rect.height < 8 || rect.height > 32) return;
        if (rect.left < rowRect.left + 46 || rect.right > rowRect.right + 1) return;
        if (rect.top < rowRect.top - 1 || rect.bottom > rowRect.bottom + 1) return;

        const duplicate = obstacleRects.some(existing =>
            Math.abs(existing.left - rect.left) < 1 &&
            Math.abs(existing.top - rect.top) < 1 &&
            Math.abs(existing.width - rect.width) < 1 &&
            Math.abs(existing.height - rect.height) < 1
        );

        if (!duplicate) obstacleRects.push(rect);
    });

    const directRect = directAnchor?.getBoundingClientRect();
    if (
        directRect &&
        !obstacleRects.some(rect =>
            Math.abs(rect.left - directRect.left) < 1 &&
            Math.abs(rect.top - directRect.top) < 1
        )
    ) {
        obstacleRects.push(directRect);
    }

    let left: number | null = null;

    for (
        let candidate = Math.floor(maximumLeft);
        candidate >= Math.ceil(minimumLeft);
        candidate -= 1
    ) {
        if (obstacleRects.every(rect => !overlapsRect(candidate, top, rect, 3))) {
            left = candidate;
            break;
        }
    }

    left ??= clamp(maximumLeft, rowRect.left + 48, maximumLeft);
    setVoiceBadgeRect(host, left, top);
}

function refreshVoiceHover(): void {
    document.querySelectorAll<HTMLElement>(".vc-viewer-eyes-voice-host").forEach(host => {
        const rect = host.getBoundingClientRect();
        const hovered =
            pointerX >= rect.left && pointerX <= rect.right &&
            pointerY >= rect.top && pointerY <= rect.bottom;

        host.classList.toggle("vc-viewer-eyes-voice-host-hovered", hovered);
    });
}

function trackVoicePointer(event: PointerEvent): void {
    pointerX = event.clientX;
    pointerY = event.clientY;
    refreshVoiceHover();
}

function reconcileVoiceBadgesUnsafe(): void {
    const stream = getCurrentUserActiveStream();
    const isDemo = runtime?.includeSelf() === true;
    const viewers = resolveEyeTargets(stream);
    let layer = document.querySelector<HTMLDivElement>(
        ".vc-viewer-eyes-voice-layer"
    );

    if ((!stream && !isDemo) || (!viewers.length && !isDemo)) {
        layer?.remove();

        updateFeatureHealth("voiceList", {
            active: stream != null || isDemo,
            viewerCount: viewers.length,
            targetsFound: 0,
            surfacesFound: 0
        });

        return;
    }

    layer ??= ensureVoiceLayer();

    const desired = new Map<
        string,
        { user: User; located: LocatedVoiceRow; }
    >();
    const currentUser = UserStore.getCurrentUser() as User | undefined;
    const guildId = stream?.guildId ?? currentVoiceGuildId();

    if (isDemo) {
        const rows = locateVisibleVoiceRows();
        const labelUsers = viewers.length
            ? viewers
            : currentUser
                ? [currentUser]
                : [];

        rows.forEach((located, index) => {
            const user = labelUsers[index % Math.max(1, labelUsers.length)];
            if (!user) return;

            desired.set(`demo-row-${index}`, { user, located });
        });
    } else {
        for (const user of viewers) {
            const located = locateVoiceRow(user, guildId);
            if (located) desired.set(user.id, { user, located });
        }
    }

    const existing = new Map<string, HTMLElement>();

    layer.querySelectorAll<HTMLElement>(
        ".vc-viewer-eyes-voice-host"
    ).forEach(host => {
        const id = host.dataset.viewerEyesUserId;
        if (id) existing.set(id, host);
    });

    const targetIds = new Set(desired.keys());
    const now = Date.now();

    for (const [id, host] of existing) {
        if (!targetIds.has(id)) {
            host.remove();
            continue;
        }

        if (!desired.has(id)) {
            const missingSince = Number(
                host.dataset.viewerEyesMissingSince ?? now
            );

            host.dataset.viewerEyesMissingSince ??= String(now);

            if (now - missingSince >= ROW_MISS_GRACE_MS) {
                host.remove();
            }
        }
    }

    for (const [id, { user, located }] of desired) {
        const host = existing.get(id) ?? makeVoiceBadge(user);
        const isNew = !host.isConnected;

        host.dataset.viewerEyesUserId = id;
        delete host.dataset.viewerEyesMissingSince;
        updateVoiceBadgeLabel(host, user);
        placeVoiceBadge(host, located);

        if (isNew) {
            layer.append(host);

            requestAnimationFrame(() => {
                if (host.isConnected) {
                    host.classList.remove(
                        "vc-viewer-eyes-voice-host-entering"
                    );
                }
            });
        }
    }

    refreshVoiceHover();

    const renderedCount = layer.querySelectorAll(
        ".vc-viewer-eyes-voice-host"
    ).length;

    if (renderedCount === 0) {
        layer.remove();
    }

    updateFeatureHealth("voiceList", {
        active: stream != null || isDemo,
        viewerCount: isDemo ? desired.size : viewers.length,
        targetsFound: renderedCount,
        surfacesFound: renderedCount > 0 ? 1 : 0
    });
}

function reconcileVoiceBadges(): void {
    try {
        reconcileVoiceBadgesUnsafe();
    } catch (error) {
        reportRuntimeError("voice.reconcile", error);
    }
}

function queueVoiceReconcile(): void {
    if (scheduledFrame) return;

    scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        reconcileVoiceBadges();
    });
}

function containsOnlyVoiceBadgeMutations(records: MutationRecord[]): boolean {
    const changedNodes = records.flatMap(record => [...record.addedNodes, ...record.removedNodes]);
    return changedNodes.length > 0 && changedNodes.every(node =>
        node instanceof HTMLElement && (
            node.classList.contains("vc-viewer-eyes-voice-layer") ||
            node.classList.contains("vc-viewer-eyes-voice-host") ||
            node.closest?.(".vc-viewer-eyes-voice-layer") != null
        )
    );
}

function detachVoiceObservation(): void {
    voiceObserver?.disconnect();
    voiceObserver = null;
    window.removeEventListener("resize", queueVoiceReconcile);
    window.removeEventListener("scroll", queueVoiceReconcile, true);
    document.removeEventListener("pointermove", trackVoicePointer, true);
}

function syncVoiceObservationStateUnsafe(): void {
    const shouldObserve =
        getCurrentUserActiveStream() != null ||
        runtime?.includeSelf() === true;

    if (!shouldObserve) {
        detachVoiceObservation();
        if (previewPollTimer != null) {
            window.clearInterval(previewPollTimer);
            previewPollTimer = null;
        }
        document.querySelector(".vc-viewer-eyes-voice-layer")?.remove();
        pointerX = -1;
        pointerY = -1;
        return;
    }

    if (!voiceObserver) {
        voiceObserver = new MutationObserver(records => {
            if (!containsOnlyVoiceBadgeMutations(records)) queueVoiceReconcile();
        });
        voiceObserver.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", queueVoiceReconcile);
        window.addEventListener("scroll", queueVoiceReconcile, true);
        document.addEventListener("pointermove", trackVoicePointer, true);
    }

    if (previewPollTimer == null) {
        previewPollTimer = window.setInterval(queueVoiceReconcile, 750);
    }

    queueVoiceReconcile();
}

function syncVoiceObservationState(): void {
    try {
        syncVoiceObservationStateUnsafe();
    } catch (error) {
        reportRuntimeError("voice.observation", error);
        detachVoiceObservation();
    }
}

export function startVoiceListOverlay(options: VoiceListEyeRuntime): void {
    if (storeUnsubscribe || voiceObserver || previewSettingListener) stopVoiceListOverlay();
    runtime = options;

    try {
        document.querySelector(".vc-viewer-eyes-voice-layer")?.remove();

        markFeatureEnabled("voiceList", true);
        storeUnsubscribe = subscribeToStreamingChanges(syncVoiceObservationState);

        previewSettingListener = syncVoiceObservationState;
        SettingsStore.addChangeListener(runtime.previewSettingPath, previewSettingListener);

        syncVoiceObservationState();
    } catch (error) {
        try {
            stopVoiceListOverlay();
        } catch {
            // Best-effort rollback; preserve the original startup error.
        }
        throw error;
    }
}

export function stopVoiceListOverlay(): void {
    if (storeUnsubscribe) {
        try {
            storeUnsubscribe();
        } catch (error) {
            reportRuntimeError("voice.unsubscribe", error);
        }
        storeUnsubscribe = null;
    }
    markFeatureEnabled("voiceList", false);

    if (previewSettingListener) {
        try {
            if (runtime) SettingsStore.removeChangeListener(runtime.previewSettingPath, previewSettingListener);
        } catch (error) {
            reportRuntimeError("voice.settings.unsubscribe", error);
        }
        previewSettingListener = null;
    }

    detachVoiceObservation();

    if (previewPollTimer != null) {
        window.clearInterval(previewPollTimer);
        previewPollTimer = null;
    }

    if (scheduledFrame) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
    }

    document.querySelector(".vc-viewer-eyes-voice-layer")?.remove();
    pointerX = -1;
    pointerY = -1;
    runtime = null;
}
/* VIEWEREYES_VOICE_COLOR_V7_TEST
 * Color fijo igualado a los iconos de estado de Discord: #737883.
 */
