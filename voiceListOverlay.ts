/*
 * ViewerEyes - voice channel list badge overlay
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SettingsStore } from "@api/Settings";
import type { User } from "@vencord/discord-types";
import { RelationshipStore, UserStore } from "@webpack/common";
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

function resolveEyeTargets(stream: ActiveBroadcast | null = getCurrentUserActiveStream()): User[] {
    if (!stream) return [];

    const users = getViewerIds(stream)
        .map(id => UserStore.getUser(id) as User | undefined)
        .filter((user): user is User => user != null);

    if (runtime?.includeSelf()) {
        const currentUser = UserStore.getCurrentUser() as User | undefined;
        if (currentUser && !users.some(user => user.id === currentUser.id)) users.push(currentUser);
    }

    return users;
}

function isVisible(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
        element.isConnected &&
        element.offsetParent !== null &&
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
    if (row.querySelector(`[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"], img[src*="${escapedId}"]`)) return true;

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
    if (row.querySelector(`img[src*="${escapedId}"]`)) score += 120;
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
        `img[src*="${escapedId}"]`
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

    return best?.element ?? null;
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
        row: best.element.parentElement ?? best.element,
        nameElement: null,
        directAnchor: best.element
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
                `[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"], img[src*="${escapedId}"]`
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
    return { row: best.row, nameElement: best.nameElement };
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
    return { row: best.row, nameElement: best.nameElement };
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

function findStatusAnchor(row: HTMLElement, nameElement: HTMLElement | null): HTMLElement | null {
    const rowRect = row.getBoundingClientRect();
    const minimumLeft = Math.max(
        rowRect.left + rowRect.width * 0.46,
        (nameElement?.getBoundingClientRect().right ?? rowRect.left + 54) + 4
    );
    let best: { element: HTMLElement; left: number; } | null = null;

    row.querySelectorAll<HTMLElement>("svg, [role='img'], [class*='icon']").forEach(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 10 || rect.width > 30 || rect.height < 10 || rect.height > 30) return;
        if (rect.left < minimumLeft || rect.right > rowRect.right + 1) return;
        if (rect.top < rowRect.top - 1 || rect.bottom > rowRect.bottom + 1) return;

        if (!best || rect.left < best.left) best = { element, left: rect.left };
    });

    return best?.element ?? null;
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

    return best?.element ?? null;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.max(minimum, Math.min(maximum, value));
}

function px(value: number): string {
    return `${Math.round(value * 100) / 100}px`;
}


function applyMatchingStatusColor(host: HTMLElement, anchor: HTMLElement | null): void {
    if (!anchor?.isConnected) {
        host.style.removeProperty("color");
        return;
    }

    const candidates = [
        anchor,
        anchor.querySelector<HTMLElement>("svg"),
        anchor.querySelector<HTMLElement>("path")
    ].filter((element): element is HTMLElement => element != null);

    for (const element of candidates) {
        const style = getComputedStyle(element);
        const colors = [style.color, style.stroke, style.fill];

        for (const color of colors) {
            if (!color || color === "none" || color === "currentcolor" || color === "transparent" || color === "rgba(0, 0, 0, 0)") continue;
            host.style.color = color;
            return;
        }
    }

    host.style.removeProperty("color");
}

function placeVoiceBadge(host: HTMLElement, located: LocatedVoiceRow): void {
    const { row, nameElement, directAnchor } = located;

    if (directAnchor?.isConnected) {
        const liveRect = directAnchor.getBoundingClientRect();
        let placementAnchor: HTMLElement = directAnchor;
        let matchingStatusAnchor: HTMLElement | null = null;

        // Find the compact row containing the LIVE badge and, when present,
        // position the eye before the first mute/deafen/status icon instead of
        // overlapping those icons.
        let container: HTMLElement | null = directAnchor.parentElement;
        let depth = 0;
        while (container && depth < 7) {
            const rect = container.getBoundingClientRect();
            if (
                isInsideLeftSidebarGeometry(container) &&
                rect.width >= 110 && rect.width <= 430 &&
                rect.height >= 22 && rect.height <= 70
            ) break;

            container = container.parentElement;
            depth += 1;
        }

        if (container) {
            let firstStatus: { element: HTMLElement; left: number; } | null = null;
            container.querySelectorAll<HTMLElement>("svg, [role='img'], [class*='icon']").forEach(element => {
                const rect = element.getBoundingClientRect();
                if (!isVisible(element)) return;
                if (rect.width < 10 || rect.width > 30 || rect.height < 10 || rect.height > 30) return;
                if (rect.left < container!.getBoundingClientRect().left + 45) return;
                if (rect.left >= liveRect.left) return;
                if (!firstStatus || rect.left < firstStatus.left) firstStatus = { element, left: rect.left };
            });

            if (firstStatus) {
                placementAnchor = firstStatus.element;
                matchingStatusAnchor = firstStatus.element;
            }
        }

        applyMatchingStatusColor(host, matchingStatusAnchor);
        const anchorRect = placementAnchor.getBoundingClientRect();
        const left = Math.max(62, anchorRect.left - EYE_GAP - EYE_SIZE);
        const top = anchorRect.top + (anchorRect.height - EYE_SIZE) / 2;

        host.style.left = px(left);
        host.style.top = px(top);
        host.style.width = `${EYE_SIZE}px`;
        host.style.height = `${EYE_SIZE}px`;
        return;
    }

    const rowRect = row.getBoundingClientRect();
    const nameRect = nameElement?.getBoundingClientRect();
    const statusAnchor = findStatusAnchor(row, nameElement);
    const liveBadge = statusAnchor ? null : findLiveBadge(row, nameElement);
    const statusRect = statusAnchor?.getBoundingClientRect() ?? liveBadge?.getBoundingClientRect();

    applyMatchingStatusColor(host, statusAnchor);

    const minimumLeft = rowRect.left + 48;
    const maximumLeft = rowRect.right - EYE_SIZE - 6;
    let left: number;

    if (statusRect) {
        left = statusRect.left - EYE_GAP - EYE_SIZE;
    } else if (nameRect) {
        left = nameRect.right + 7;
    } else {
        left = maximumLeft;
    }

    left = clamp(left, minimumLeft, maximumLeft);
    const top = rowRect.top + (rowRect.height - EYE_SIZE) / 2;

    host.style.left = px(left);
    host.style.top = px(top);
    host.style.width = `${EYE_SIZE}px`;
    host.style.height = `${EYE_SIZE}px`;
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
    const viewers = stream ? resolveEyeTargets(stream) : [];
    let layer = document.querySelector<HTMLDivElement>(".vc-viewer-eyes-voice-layer");

    if (!stream || !viewers.length) {
        layer?.remove();
        updateFeatureHealth("voiceList", {
            active: stream != null,
            viewerCount: viewers.length,
            targetsFound: 0,
            surfacesFound: 0
        });
        return;
    }

    layer ??= ensureVoiceLayer();
    const desired = new Map<string, { user: User; located: LocatedVoiceRow; }>();

    const currentUser = UserStore.getCurrentUser() as User | undefined;

    for (const user of viewers) {
        const isPreviewSelf = runtime?.includeSelf() && currentUser?.id === user.id;
        const located = isPreviewSelf
            ? locateCurrentStreamerVoiceRow(user, stream.guildId) ?? locateVoiceRow(user, stream.guildId)
            : locateVoiceRow(user, stream.guildId);

        if (located) desired.set(user.id, { user, located });
    }

    const existing = new Map<string, HTMLElement>();
    layer.querySelectorAll<HTMLElement>(".vc-viewer-eyes-voice-host").forEach(host => {
        const id = host.dataset.viewerEyesUserId;
        if (id) existing.set(id, host);
    });

    for (const [id, host] of existing) {
        if (!desired.has(id)) host.remove();
    }

    for (const [id, { user, located }] of desired) {
        const host = existing.get(id) ?? makeVoiceBadge(user);
        const isNew = !host.isConnected;

        updateVoiceBadgeLabel(host, user);
        placeVoiceBadge(host, located);

        if (isNew) {
            layer.append(host);
            requestAnimationFrame(() => {
                if (host.isConnected) host.classList.remove("vc-viewer-eyes-voice-host-entering");
            });
        }
    }

    refreshVoiceHover();
    if (!desired.size) layer.remove();

    updateFeatureHealth("voiceList", {
        active: true,
        viewerCount: viewers.length,
        targetsFound: desired.size,
        surfacesFound: desired.size > 0 ? 1 : 0
    });
}

function reconcileVoiceBadges(): void {
    try {
        reconcileVoiceBadgesUnsafe();
    } catch (error) {
        reportRuntimeError("voice.reconcile", error);
        document.querySelector(".vc-viewer-eyes-voice-layer")?.remove();
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
    const hasActiveStream = getCurrentUserActiveStream() != null;

    if (!hasActiveStream) {
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

        previewSettingListener = queueVoiceReconcile;
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
