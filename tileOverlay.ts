/*
 * ViewerEyes - participant badge overlay
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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

export
function displayName(user: User): string {
    return RelationshipStore.getNickname(user.id) || user.globalName || user.username;
}
function resolveActiveViewers(stream: ActiveBroadcast | null = getCurrentUserActiveStream()): User[] {
    if (!stream) return [];

    return getViewerIds(stream)
        .map(id => UserStore.getUser(id) as User | undefined)
        .filter((user): user is User => user != null);
}

function resolveEyeTargets(
    stream: ActiveBroadcast | null = getCurrentUserActiveStream()
): User[] {
    return resolveActiveViewers(stream);
}

const CALL_ROOT_SELECTORS = [
    '[class*="callContainer"]',
    '[class*="videoGrid"]',
    '[class*="videoGridWrapper"]'
].join(",");

const TILE_SELECTORS = [
    '[class^="tile"]',
    '[class*=" tile"]',
    '[class*="tile_"]',
    '[class*="videoWrapper"]',
    '[class*="participantTile"]'
].join(",");

function foldText(value: string | null | undefined): string {
    return value?.trim().toLocaleLowerCase() ?? "";
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

function isShortAlias(value: string): boolean {
    return [...value].length <= 2;
}

function hasStrongIdentitySignal(element: HTMLElement, root: HTMLElement, user: User): boolean {
    const escapedId = CSS.escape(user.id);
    let current: HTMLElement | null = element;
    let depth = 0;

    while (current && current !== root && depth < 8) {
        if (current.matches(`[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"]`)) return true;
        if (current.querySelector(`[data-user-id="${escapedId}"], [data-list-item-id*="${escapedId}"], img[src*="${escapedId}"]`)) return true;
        current = current.parentElement;
        depth += 1;
    }

    return false;
}

function visibleCallSurfaces(): HTMLElement[] {
    const roots = [...document.querySelectorAll<HTMLElement>(CALL_ROOT_SELECTORS)]
        .filter(root => {
            const rect = root.getBoundingClientRect();
            return root.isConnected && rect.width >= 320 && rect.height >= 180 && root.offsetParent !== null;
        });

    // Discord suele exponer varios wrappers anidados para la misma llamada. Mantener
    // los más internos reduce falsos positivos en barras laterales y controles.
    return roots.filter(root => !roots.some(other => other !== root && root.contains(other)));
}

function isVisiblyRenderedCard(element: HTMLElement): boolean {
    const style = getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity || "1");

    if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        opacity < 0.55 ||
        element.offsetParent === null
    ) {
        return false;
    }

    const rect = element.getBoundingClientRect();
    const points: Array<[number, number]> = [
        [rect.left + rect.width * 0.5, rect.top + rect.height * 0.5],
        [rect.left + rect.width * 0.22, rect.top + rect.height * 0.4],
        [rect.left + rect.width * 0.78, rect.top + rect.height * 0.4]
    ];

    return points.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit instanceof HTMLElement && (hit === element || element.contains(hit));
    });
}

function isCandidateCard(element: HTMLElement, root: HTMLElement): boolean {
    if (!root.contains(element)) return false;
    if (element.closest("nav, aside, [class*='sidebar'], [class*='panels']")) return false;
    if (!isVisiblyRenderedCard(element)) return false;

    const rect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const area = rect.width * rect.height;
    const rootArea = rootRect.width * rootRect.height;
    const ratio = rect.width / Math.max(1, rect.height);

    if (rect.width < 110 || rect.height < 65) return false;
    if (ratio < 0.75 || ratio > 6) return false;
    if (area >= rootArea * 0.94) return false;

    // A focused stream can occupy almost the whole call surface. It is not a
    // participant tile, even though it may expose the streamer's avatar/name.
    // Rejecting only very large media surfaces keeps normal grid tiles valid.
    const areaRatio = area / Math.max(1, rootArea);
    const largeMediaSurface = [...element.querySelectorAll<HTMLElement>("video, canvas")].some(media => {
        const mediaRect = media.getBoundingClientRect();
        return (
            mediaRect.width >= rect.width * 0.68 &&
            mediaRect.height >= rect.height * 0.52 &&
            mediaRect.width >= rootRect.width * 0.56
        );
    });
    if (largeMediaSurface && (areaRatio >= 0.68 || (rect.width >= rootRect.width * 0.9 && rect.height >= rootRect.height * 0.55))) {
        return false;
    }

    if (rect.right <= rootRect.left || rect.left >= rootRect.right) return false;
    if (rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) return false;

    return true;
}

function nearestCandidateCard(element: Element, root: HTMLElement): HTMLElement | null {
    const semanticTile = element.closest<HTMLElement>(TILE_SELECTORS);
    if (semanticTile && isCandidateCard(semanticTile, root)) return semanticTile;

    const candidates: HTMLElement[] = [];
    let parent = element.parentElement;
    while (parent && parent !== root) {
        if (isCandidateCard(parent, root)) candidates.push(parent);
        parent = parent.parentElement;
    }

    candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
    });

    return candidates[0] ?? null;
}

function rankCard(tile: HTMLElement, user: User, root: HTMLElement): number {
    const rect = tile.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const text = foldText(tile.textContent);
    let score = 0;

    if (tile.matches(TILE_SELECTORS)) score += 34;

    // Un avatar cuyo URL contiene el ID es la señal más fuerte de que se trata
    // del recuadro del participante y no de una miniatura de su stream.
    const id = CSS.escape(user.id);
    if (tile.querySelector(`img[src*="${id}"]`)) score += 120;
    if (tile.querySelector("img")) score += 20;

    // Las tarjetas de transmisiones suelen contener vídeo y badges de calidad/live.
    if (tile.querySelector("video, canvas")) score -= 15;
    if (/en directo|\blive\b|\d{3,4}p|\d{2,3}\s*fps/.test(text)) score -= 80;

    // En la vista enfocada, el participante correcto suele estar en la tira inferior.
    score += ((rect.top - rootRect.top) / Math.max(1, rootRect.height)) * 12;

    // Entre candidatos equivalentes, favorece el recuadro más pequeño.
    score -= Math.log(Math.max(1, rect.width * rect.height));
    return score;
}

function identityAnchors(root: HTMLElement, user: User, guildId?: string): Set<HTMLElement> {
    const result = new Set<HTMLElement>();
    const escapedId = CSS.escape(user.id);

    for (const selector of [
        `[data-user-id="${escapedId}"]`,
        `[data-list-item-id*="${escapedId}"]`,
        `[id*="${escapedId}"]`,
        `img[src*="${escapedId}"]`
    ]) {
        root.querySelectorAll<HTMLElement>(selector).forEach(element => result.add(element));
    }

    const names = identityAliases(user, guildId);
    if (!names.size) return result;

    root.querySelectorAll<HTMLElement>(
        '[aria-label], [title], img[alt], [data-name], [data-username]'
    ).forEach(element => {
        const values = [
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
            element.getAttribute("alt"),
            element.getAttribute("data-name"),
            element.getAttribute("data-username")
        ].map(foldText).filter(Boolean);

        if (values.some(value => [...names].some(name =>
            (value === name || value.startsWith(`${name},`) || value.startsWith(`${name} `)) &&
            (!isShortAlias(name) || hasStrongIdentitySignal(element, root, user))
        ))) result.add(element);
    });

    // El nombre visible de la tarjeta no siempre tiene aria-label. Solo se miran
    // nodos pequeños con texto exacto para no confundir el contenedor completo.
    root.querySelectorAll<HTMLElement>("span, div").forEach(element => {
        if (element.childElementCount > 2) return;
        const rect = element.getBoundingClientRect();
        if (rect.height > 56 || rect.width > 260) return;

        const text = foldText(element.textContent);
        if (!names.has(text)) return;
        if (isShortAlias(text) && !hasStrongIdentitySignal(element, root, user)) return;
        result.add(element);
    });

    return result;
}

interface LocatedTile {
    tile: HTMLElement;
    root: HTMLElement;
}

function locateParticipantCard(roots: HTMLElement[], user: User, guildId?: string): LocatedTile | null {
    let best: { tile: HTMLElement; root: HTMLElement; score: number; } | null = null;
    const seen = new Set<HTMLElement>();

    for (const root of roots) {
        for (const identityElement of identityAnchors(root, user, guildId)) {
            const tile = nearestCandidateCard(identityElement, root);
            if (!tile || seen.has(tile)) continue;
            seen.add(tile);

            const score = rankCard(tile, user, root);
            const strongIdentity = hasStrongIdentitySignal(identityElement, root, user);
            if (!strongIdentity && score < 18) continue;
            if (!best || score > best.score) best = { tile, root, score };
        }
    }

    return best ? { tile: best.tile, root: best.root } : null;
}

/**
 * Variante muy concreta de Discord: una transmisión enfocada ocupa casi toda
 * la llamada y los participantes aparecen como tarjetas pequeñas en una tira
 * inferior. No se aplica a la cuadrícula normal ni a las tarjetas grandes.
 */
function isFocusedFilmstripCard(tile: HTMLElement, root: HTMLElement): boolean {
    const rect = tile.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();

    if (rootRect.width < 680 || rootRect.height < 420) return false;
    if (rect.width < 110 || rect.width > 270 || rect.height < 65 || rect.height > 170) return false;

    const isInLowerBand = rect.top >= rootRect.top + rootRect.height * 0.58;
    const isNearBottom = rootRect.bottom - rect.bottom <= Math.max(110, rootRect.height * 0.18);
    if (!isInLowerBand || !isNearBottom) return false;

    // La vista enfocada siempre tiene una superficie de vídeo/canvas grande
    // situada por encima de la tira. Esto evita afectar a cuadrículas densas.
    const hasLargeMediaAbove = [...root.querySelectorAll<HTMLElement>("video, canvas")].some(media => {
        const mediaRect = media.getBoundingClientRect();
        return (
            mediaRect.width >= rootRect.width * 0.42 &&
            mediaRect.height >= rootRect.height * 0.34 &&
            mediaRect.top < rect.top &&
            mediaRect.bottom <= rect.top + 70
        );
    });

    return hasLargeMediaAbove;
}

function ensureBadgeLayer(): HTMLDivElement {
    const layer = document.createElement("div");
    layer.className = "vc-viewer-eyes-layer";
    document.body.append(layer);
    return layer;
}

function updateBadgeLabel(host: HTMLElement, user: User): void {
    const name = displayName(user);
    const tooltip = t(
        `${name} está viendo tu transmisión`,
        `${name} is watching your stream`
    );
    host.dataset.viewerEyesTooltip = tooltip;
    host.setAttribute("aria-label", tooltip);
}

function makeBadge(user: User): HTMLDivElement {
    const host = document.createElement("div");

    host.className = "vc-viewer-eyes-host vc-viewer-eyes-host-entering";
    host.dataset.viewerEyesUserId = user.id;
    updateBadgeLabel(host, user);
    host.setAttribute("role", "img");

    host.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M2.1 12s3.6-6.1 9.9-6.1S21.9 12 21.9 12 18.3 18.1 12 18.1 2.1 12 2.1 12Z"></path>
            <circle cx="12" cy="12" r="3.1"></circle>
        </svg>`;

    return host;
}

const OPTIONS_LABEL = /^(?:opciones|options|más opciones|mas opciones|more options|acciones|actions)$/i;

interface ControlAppearance {
    backgroundColor: string;
    color: string;
    borderRadius: string;
    boxShadow: string;
}

interface ControlGeometry {
    width: number;
    height: number;
    rightInset: number;
    bottomInset: number;
}

const CONTROL_SKIN_CACHE_KEY = "vc-viewer-eyes-control-skin-v1";
const FALLBACK_CONTROL_APPEARANCE: ControlAppearance = {
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    color: "rgb(242, 243, 245)",
    borderRadius: "8px",
    boxShadow: "none"
};

let cachedControlAppearance: ControlAppearance | null = null;
const cachedControlGeometry = new Map<string, ControlGeometry>();

function loadCachedControlAppearance(): void {
    cachedControlAppearance = null;

    try {
        const raw = localStorage.getItem(CONTROL_SKIN_CACHE_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw) as Partial<ControlAppearance>;
        if (
            typeof parsed.backgroundColor !== "string" ||
            typeof parsed.color !== "string" ||
            typeof parsed.borderRadius !== "string"
        ) return;

        if (isClearColor(parsed.backgroundColor) || isGreenTint(parsed.backgroundColor)) return;

        cachedControlAppearance = {
            backgroundColor: parsed.backgroundColor,
            color: parsed.color,
            borderRadius: parsed.borderRadius,
            boxShadow: typeof parsed.boxShadow === "string" ? parsed.boxShadow : "none"
        };
    } catch {
        // Un valor antiguo o corrupto no debe impedir que arranque el plugin.
    }
}

function persistControlAppearance(appearance: ControlAppearance): void {
    try {
        localStorage.setItem(CONTROL_SKIN_CACHE_KEY, JSON.stringify(appearance));
    } catch {
        // localStorage puede estar bloqueado en instalaciones muy restringidas.
    }
}

interface PatchedTilePosition {
    originalInlinePosition: string;
    users: number;
}

const patchedTilePositions = new Map<HTMLElement, PatchedTilePosition>();
const embeddedTileByHost = new WeakMap<HTMLElement, HTMLElement>();

function retainTilePosition(tile: HTMLElement): void {
    const current = patchedTilePositions.get(tile);
    if (current) {
        current.users += 1;
        return;
    }

    const originalInlinePosition = tile.style.position;
    if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
    patchedTilePositions.set(tile, { originalInlinePosition, users: 1 });
}

function releaseTilePosition(tile: HTMLElement): void {
    const current = patchedTilePositions.get(tile);
    if (!current) return;

    current.users -= 1;
    if (current.users > 0) return;

    tile.style.position = current.originalInlinePosition;
    patchedTilePositions.delete(tile);
}

function embedBadgeInTile(host: HTMLElement, tile: HTMLElement): void {
    const previousTile = embeddedTileByHost.get(host);
    if (previousTile === tile && host.parentElement === tile) return;

    if (previousTile) releaseTilePosition(previousTile);
    retainTilePosition(tile);
    embeddedTileByHost.set(host, tile);
    tile.append(host);
}

function moveBadgeToLayer(host: HTMLElement, layer: HTMLElement): void {
    const previousTile = embeddedTileByHost.get(host);
    if (previousTile) {
        releaseTilePosition(previousTile);
        embeddedTileByHost.delete(host);
    }

    if (host.parentElement !== layer) layer.append(host);
}

function removeBadgeHost(host: HTMLElement): void {
    const previousTile = embeddedTileByHost.get(host);
    if (previousTile) {
        releaseTilePosition(previousTile);
        embeddedTileByHost.delete(host);
    }
    host.remove();
}

function restorePatchedTilePositions(): void {
    for (const [tile, state] of patchedTilePositions) {
        tile.style.position = state.originalInlinePosition;
    }
    patchedTilePositions.clear();
}

function controlLabels(element: HTMLElement): string[] {
    return [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-tooltip-text")
    ].map(foldText).filter(Boolean);
}

function isControlSized(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return (
        style.display !== "none" &&
        rect.width >= 18 &&
        rect.height >= 18 &&
        rect.width <= 52 &&
        rect.height <= 52
    );
}

function isControlReady(element: HTMLElement): boolean {
    if (!isControlSized(element)) return false;

    const style = getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity || "1");

    // Esperamos a que la transición esté prácticamente terminada. De esta
    // manera el ojo no se desplaza antes de que los tres puntos sean visibles.
    return (
        style.visibility !== "hidden" &&
        opacity >= 0.85 &&
        style.pointerEvents !== "none"
    );
}

function isOverflowMenuButton(element: HTMLElement): boolean {
    /*
     * Solo aceptamos la etiqueta exacta del control de tres puntos. Expresiones
     * como “Opciones de transmisión” quedan fuera, evitando copiar el verde del
     * control de pantalla compartida en la vista enfocada.
     */
    return controlLabels(element).some(label => OPTIONS_LABEL.test(label));
}

function findOverflowMenuButton(tile: HTMLElement, visibleOnly: boolean): HTMLElement | null {
    const tileRect = tile.getBoundingClientRect();
    let best: { element: HTMLElement; score: number; } | null = null;

    for (const element of tile.querySelectorAll<HTMLElement>('button, [role="button"]')) {
        if (!isOverflowMenuButton(element) || !isControlSized(element)) continue;
        if (visibleOnly && !isControlReady(element)) continue;

        const rect = element.getBoundingClientRect();
        const distanceRight = Math.abs(tileRect.right - rect.right);
        const distanceBottom = Math.abs(tileRect.bottom - rect.bottom);
        const nearRight = distanceRight <= 80;
        const nearBottom = distanceBottom <= 80;
        if (!nearRight || !nearBottom) continue;

        let score = 160;
        if (element.querySelector("svg")) score += 18;
        if (isControlReady(element)) score += 12;
        score += Math.max(0, 60 - distanceRight);
        score += Math.max(0, 60 - distanceBottom);
        score -= Math.abs(rect.width - rect.height);

        if (!best || score > best.score) best = { element, score };
    }

    return best?.element ?? null;
}

function isClearColor(value: string): boolean {
    return value === "transparent" || /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value);
}

function isGreenTint(value: string): boolean {
    const numbers = value.match(/[\d.]+/g)?.map(Number);
    if (!numbers || numbers.length < 3) return false;

    const [red, green, blue] = numbers;
    return green > red + 18 && green > blue + 12;
}

function readNeutralControlSkin(control: HTMLElement): ControlAppearance | null {
    const style = getComputedStyle(control);
    if (isClearColor(style.backgroundColor) || isGreenTint(style.backgroundColor)) return null;

    return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow
    };
}

function applyBadgeSkin(host: HTMLElement, appearance: ControlAppearance | null): void {
    const resolved = appearance ?? FALLBACK_CONTROL_APPEARANCE;

    host.style.setProperty("--vc-viewer-eyes-bg", resolved.backgroundColor);
    host.style.setProperty("--vc-viewer-eyes-color", resolved.color);
    host.style.setProperty("--vc-viewer-eyes-radius", resolved.borderRadius);
    host.style.setProperty("--vc-viewer-eyes-shadow", "none");
}

function findGlobalOverflowControl(): HTMLElement | null {
    let best: { element: HTMLElement; score: number; } | null = null;

    for (const element of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
        if (!isOverflowMenuButton(element) || !isControlReady(element)) continue;

        const appearance = readNeutralControlSkin(element);
        if (!appearance) continue;

        const rect = element.getBoundingClientRect();
        let score = 100;
        score -= Math.abs(rect.width - rect.height);
        if (rect.width >= 26 && rect.width <= 40) score += 20;
        if (element.closest(CALL_ROOT_SELECTORS)) score += 40;

        if (!best || score > best.score) best = { element, score };
    }

    return best?.element ?? null;
}

function refreshBadgeSkin(host: HTMLElement, optionsControl: HTMLElement | null): void {
    let appearance = cachedControlAppearance;
    const control = optionsControl ?? (!appearance ? findGlobalOverflowControl() : null);

    // La apariencia se aprende del botón real de tres puntos en cuanto Discord
    // lo haya montado. Se persiste para que el primer frame del próximo arranque
    // ya use el color correcto, sin esperar a que el usuario pase el ratón.
    if (control && !control.matches(":hover")) {
        const captured = readNeutralControlSkin(control);
        if (captured) {
            appearance = captured;
            cachedControlAppearance = captured;
            persistControlAppearance(captured);
        }
    }

    applyBadgeSkin(host, appearance);
}

/* legacy body intentionally removed */
function px(value: number): string {
    return `${Math.round(value * 100) / 100}px`;
}

function placeBadge(host: HTMLElement, tile: HTMLElement, root: HTMLElement, userId: string, layer: HTMLElement): boolean {
    if (!tile.isConnected || !root.isConnected || !root.contains(tile) || tile.offsetParent === null) return false;

    const rect = tile.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (rect.width < 110 || rect.height < 65) return false;
    if (rect.right <= rootRect.left || rect.left >= rootRect.right || rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) return false;
    const remainedEmbeddedDuringTransition =
        embeddedTileByHost.get(host) === tile && performance.now() < transitionFollowUntil;
    const focusedStrip = isFocusedFilmstripCard(tile, root) || remainedEmbeddedDuringTransition;
    const compact = rect.width < 230 || rect.height < 145;
    const geometryControl = findOverflowMenuButton(tile, false);
    const visibleOptionsControl = findOverflowMenuButton(tile, true);
    const geometryRect = geometryControl?.getBoundingClientRect();
    const fallbackSize = focusedStrip ? 32 : compact ? 28 : 32;
    const gap = compact ? 5 : 7;
    const fallbackInset = focusedStrip ? 7 : compact ? 7 : 10;
    const geometryKey = focusedStrip ? `${userId}:focused-stream-strip` : userId;

    let geometry = cachedControlGeometry.get(geometryKey);

    if (geometryRect) {
        geometry = {
            width: focusedStrip ? 32 : Math.max(26, Math.min(40, geometryRect.width)),
            height: focusedStrip ? 32 : Math.max(26, Math.min(40, geometryRect.height)),
            rightInset: focusedStrip
                ? Math.max(7, rect.right - geometryRect.right)
                : Math.max(0, rect.right - geometryRect.right),
            bottomInset: focusedStrip
                ? Math.max(3, rect.bottom - geometryRect.bottom)
                : Math.max(0, rect.bottom - geometryRect.bottom)
        };
        cachedControlGeometry.set(geometryKey, geometry);
    }

    let width = geometry?.width ?? fallbackSize;
    let height = geometry?.height ?? fallbackSize;
    let rightInset = geometry?.rightInset ?? fallbackInset;
    let bottomInset = geometry?.bottomInset ?? fallbackInset;

    /*
     * SOLO para la tira inferior de la vista enfocada:
     * - botón completo de 32x32 (evita que el fondo parezca recortado);
     * - estilo neutro, sin heredar rojo/verde de controles de estado;
     * - 2 px más abajo que la geometría detectada en esa vista.
     */
    if (focusedStrip) {
        width = 32;
        height = 32;
        rightInset = Math.max(7, rightInset);
        bottomInset = Math.max(3, bottomInset);
    }

    const nativeLeft = geometryRect?.left ?? (rect.right - rightInset - width);
    const nativeTop = geometryRect?.top ?? (rect.bottom - bottomInset - height);
    let left = visibleOptionsControl ? nativeLeft - gap - width : nativeLeft;
    let top = nativeTop + (focusedStrip ? 1 : 0);

    if (focusedStrip) {
        // Mantiene todo el cuadrado dentro de la tarjeta aun cuando Discord
        // devuelve una geometría transitoria o parcialmente escalada.
        const safeRight = rect.right - 7 - width;
        const safeBottom = rect.bottom - 2 - height;
        left = Math.min(left, safeRight);
        top = Math.min(top, safeBottom);
    }

    host.classList.toggle("vc-viewer-eyes-host-compact", compact);
    host.classList.toggle("vc-viewer-eyes-host-focused-strip", focusedStrip);
    host.classList.toggle("vc-viewer-eyes-host-embedded", focusedStrip);

    if (focusedStrip) {
        /*
         * En la tira enfocada el ojo se monta DENTRO de la tarjeta real.
         * Así hereda directamente el translate/scale, el clipping y el orden
         * de apilado de Discord durante “Mostrar/Ocultar miembros”. Ya no hay
         * que imitar la animación desde una capa fija independiente.
         */
        embedBadgeInTile(host, tile);

        const scaleX = rect.width / Math.max(1, tile.offsetWidth || rect.width);
        const scaleY = rect.height / Math.max(1, tile.offsetHeight || rect.height);
        const localLeft = (left - rect.left) / Math.max(0.001, scaleX);
        const localTop = (top - rect.top) / Math.max(0.001, scaleY);
        const localWidth = width / Math.max(0.001, scaleX);
        const localHeight = height / Math.max(0.001, scaleY);

        host.style.width = px(localWidth);
        host.style.height = px(localHeight);
        host.style.left = px(localLeft);
        host.style.top = px(localTop);

        const stripControl = visibleOptionsControl ?? geometryControl;
        refreshBadgeSkin(host, stripControl);
        return true;
    }

    moveBadgeToLayer(host, layer);

    /*
     * Fuera de la tira enfocada seguimos usando la capa fija. En esas vistas
     * no existe la animación problemática, pero conservamos la validación para
     * no dibujar sobre superficies que ya estén ocultas por Discord.
     */
    const badgeCenterX = left + width / 2;
    const badgeCenterY = top + height / 2;
    const visibleUnderBadge = document.elementFromPoint(badgeCenterX, badgeCenterY);
    if (!(visibleUnderBadge instanceof Element) || !tile.contains(visibleUnderBadge)) {
        return false;
    }

    host.style.width = px(width);
    host.style.height = px(height);
    host.style.left = px(left);
    host.style.top = px(top);
    refreshBadgeSkin(host, visibleOptionsControl);
    return true;
}

function clearOldMarkers(): void {
    document.querySelectorAll<HTMLElement>("[data-vc-viewer-eyes-tile]").forEach(tile => {
        delete tile.dataset.vcViewerEyesTile;
    });
}

function reconcileBadgesUnsafe(): void {
    clearOldMarkers();

    const stream = getCurrentUserActiveStream();
    const viewers = stream ? resolveEyeTargets(stream) : [];
    const roots = visibleCallSurfaces();
    let layer = document.querySelector<HTMLDivElement>(".vc-viewer-eyes-layer");

    if (!stream || !viewers.length || !roots.length) {
        document.querySelectorAll<HTMLElement>(".vc-viewer-eyes-host").forEach(removeBadgeHost);
        layer?.remove();
        restorePatchedTilePositions();
        updateFeatureHealth("tile", {
            active: stream != null,
            viewerCount: viewers.length,
            targetsFound: 0,
            surfacesFound: roots.length
        });
        return;
    }

    layer ??= ensureBadgeLayer();
    const desired = new Map<string, { user: User; tile: HTMLElement; root: HTMLElement; }>();

    for (const user of viewers) {
        const located = locateParticipantCard(roots, user, stream.guildId);
        if (located) desired.set(user.id, { user, ...located });
    }

    const existing = new Map<string, HTMLElement>();
    document.querySelectorAll<HTMLElement>(".vc-viewer-eyes-host").forEach(host => {
        const id = host.dataset.viewerEyesUserId;
        if (id) existing.set(id, host);
    });

    for (const [id, host] of existing) {
        if (!desired.has(id)) removeBadgeHost(host);
    }

    for (const [id, { user, tile, root }] of desired) {
        const host = existing.get(id) ?? makeBadge(user);
        const isNew = !host.isConnected;

        updateBadgeLabel(host, user);
        if (!placeBadge(host, tile, root, id, layer)) {
            removeBadgeHost(host);
            continue;
        }

        if (isNew) {
            // Espera al siguiente frame para mostrarlo: el navegador ya tendrá
            // posición, tamaño y color definitivos y no habrá flash claro.
            requestAnimationFrame(() => {
                if (host.isConnected) host.classList.remove("vc-viewer-eyes-host-entering");
            });
        }
    }

    refreshVirtualHover();
    updateFeatureHealth("tile", {
        active: true,
        viewerCount: viewers.length,
        targetsFound: desired.size,
        surfacesFound: roots.length
    });
}

function reconcileBadges(): void {
    try {
        reconcileBadgesUnsafe();
    } catch (error) {
        reportRuntimeError("tile.reconcile", error);

        try {
            document.querySelectorAll<HTMLElement>(".vc-viewer-eyes-host").forEach(removeBadgeHost);
            document.querySelector(".vc-viewer-eyes-layer")?.remove();
            restorePatchedTilePositions();
        } catch {
            // Cleanup is best effort; the next mutation/store update retries.
        }
    }
}

let pointerX = -1;
let pointerY = -1;
let delayedScanShort = 0;
let delayedScanLong = 0;

function refreshVirtualHover(): void {
    document.querySelectorAll<HTMLElement>(".vc-viewer-eyes-host").forEach(host => {
        const rect = host.getBoundingClientRect();
        const hovered =
            pointerX >= rect.left && pointerX <= rect.right &&
            pointerY >= rect.top && pointerY <= rect.bottom;
        host.classList.toggle("vc-viewer-eyes-host-hovered", hovered);
    });
}

function trackPointer(event: PointerEvent): void {
    pointerX = event.clientX;
    pointerY = event.clientY;
    queueReconcile();
}

function queueTransitionChecks(): void {
    window.clearTimeout(delayedScanShort);
    window.clearTimeout(delayedScanLong);

    // Discord suele mostrar “Opciones” con una transición. Volvemos a medir
    // cuando ya ha aparecido, incluso aunque el ratón se quede quieto.
    delayedScanShort = window.setTimeout(queueReconcile, 45);
    delayedScanLong = window.setTimeout(queueReconcile, 130);
}

let tileObserver: MutationObserver | null = null;
let storeUnsubscribe: (() => void) | null = null;
let scheduledFrame = 0;
let transitionFrame = 0;
let transitionFollowUntil = 0;

function followDiscordTransition(durationMs = 450): void {
    transitionFollowUntil = Math.max(transitionFollowUntil, performance.now() + durationMs);
    if (transitionFrame) return;

    const tick = () => {
        transitionFrame = 0;

        if (getCurrentUserActiveStream() == null) {
            transitionFollowUntil = 0;
            return;
        }

        // Durante la animación nativa de Discord, actualizamos el overlay en
        // cada frame para que el ojo siga exactamente la posición, escala y
        // desaparición de la tarjeta, sin ejecutar una transición propia.
        reconcileBadges();

        if (performance.now() < transitionFollowUntil) {
            transitionFrame = requestAnimationFrame(tick);
        }
    };

    transitionFrame = requestAnimationFrame(tick);
}

function beginInteractionTransition(): void {
    followDiscordTransition();
}

function queueReconcile(): void {
    if (scheduledFrame) return;
    scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        reconcileBadges();
    });
}

function containsOnlyBadgeMutations(records: MutationRecord[]): boolean {
    const changedNodes = records.flatMap(record => [...record.addedNodes, ...record.removedNodes]);
    return changedNodes.length > 0 && changedNodes.every(node =>
        node instanceof HTMLElement && (
            node.classList.contains("vc-viewer-eyes-layer") ||
            node.classList.contains("vc-viewer-eyes-host") ||
            node.closest?.(".vc-viewer-eyes-layer") != null
        )
    );
}

function detachTileObservation(): void {
    tileObserver?.disconnect();
    tileObserver = null;
    window.removeEventListener("resize", queueReconcile);
    window.removeEventListener("scroll", queueReconcile, true);
    document.removeEventListener("pointermove", trackPointer, true);
    document.removeEventListener("pointerover", queueTransitionChecks, true);
    document.removeEventListener("pointerout", queueTransitionChecks, true);
    document.removeEventListener("pointerdown", beginInteractionTransition, true);
    document.removeEventListener("click", beginInteractionTransition, true);

    if (transitionFrame) {
        cancelAnimationFrame(transitionFrame);
        transitionFrame = 0;
    }
    transitionFollowUntil = 0;

    window.clearTimeout(delayedScanShort);
    window.clearTimeout(delayedScanLong);
    delayedScanShort = 0;
    delayedScanLong = 0;
}

function syncObservationStateUnsafe(): void {
    const hasActiveStream = getCurrentUserActiveStream() != null;

    if (!hasActiveStream) {
        detachTileObservation();
        document.querySelectorAll<HTMLElement>(".vc-viewer-eyes-host").forEach(removeBadgeHost);
        document.querySelector(".vc-viewer-eyes-layer")?.remove();
        restorePatchedTilePositions();
        clearOldMarkers();
        pointerX = -1;
        pointerY = -1;
        return;
    }

    if (!tileObserver) {
        tileObserver = new MutationObserver(records => {
            if (!containsOnlyBadgeMutations(records)) {
                queueReconcile();
                followDiscordTransition();
            }
        });
        tileObserver.observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", queueReconcile);
        window.addEventListener("scroll", queueReconcile, true);
        document.addEventListener("pointermove", trackPointer, true);
        document.addEventListener("pointerover", queueTransitionChecks, true);
        document.addEventListener("pointerout", queueTransitionChecks, true);
        document.addEventListener("pointerdown", beginInteractionTransition, true);
        document.addEventListener("click", beginInteractionTransition, true);
    }

    queueReconcile();
}

function syncObservationState(): void {
    try {
        syncObservationStateUnsafe();
    } catch (error) {
        reportRuntimeError("tile.observation", error);
        detachTileObservation();
    }
}

export export function startEyeOverlay(): void {
    if (storeUnsubscribe || tileObserver) stopEyeOverlay();

    try {
        document
            .querySelectorAll<HTMLElement>(".vc-viewer-eyes-host")
            .forEach(removeBadgeHost);
        document
            .querySelectorAll(".vc-viewer-eyes-layer")
            .forEach(element => element.remove());

        restorePatchedTilePositions();
        loadCachedControlAppearance();
        cachedControlGeometry.clear();
        clearOldMarkers();
        markFeatureEnabled("tile", true);

        storeUnsubscribe =
            subscribeToStreamingChanges(syncObservationState);

        syncObservationState();
    } catch (error) {
        try {
            stopEyeOverlay();
        } catch {
            // Preserve the original startup error.
        }

        throw error;
    }
}

export export function stopEyeOverlay(): void {
    if (storeUnsubscribe) {
        try {
            storeUnsubscribe();
        } catch (error) {
            reportRuntimeError("tile.unsubscribe", error);
        }

        storeUnsubscribe = null;
    }

    markFeatureEnabled("tile", false);
    detachTileObservation();
    pointerX = -1;
    pointerY = -1;

    if (scheduledFrame) {
        cancelAnimationFrame(scheduledFrame);
        scheduledFrame = 0;
    }

    document
        .querySelectorAll<HTMLElement>(".vc-viewer-eyes-host")
        .forEach(removeBadgeHost);

    document.querySelector(".vc-viewer-eyes-layer")?.remove();
    restorePatchedTilePositions();
    cachedControlAppearance = null;
    cachedControlGeometry.clear();
    clearOldMarkers();
}
