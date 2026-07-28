/*
 * ViewerEyes - defensive Discord runtime adapter and diagnostics
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { findByPropsLazy, findStoreLazy } from "@webpack";

export const VIEWER_EYES_VERSION = "3.15";

export interface ActiveBroadcast {
    guildId?: string;
}

type ChangeListener = () => void;

interface StreamingStoreLike {
    getCurrentUserActiveStream?: () => unknown;
    getViewerIds?: (broadcast: unknown) => unknown;
    addChangeListener?: (listener: ChangeListener) => void;
    removeChangeListener?: (listener: ChangeListener) => void;
}

interface GuildMemberStoreLike {
    getMember?: (guildId: string, userId: string) => { nick?: string | null; } | null | undefined;
}

interface FeatureHealth {
    enabled: boolean;
    active: boolean;
    viewerCount: number;
    targetsFound: number;
    surfacesFound: number;
    lastSuccessAt: number | null;
    lastError: string | null;
    errorCount: number;
}

interface RuntimeHealth {
    version: string;
    storeSource: "name" | "props" | "unresolved";
    storeAvailable: boolean;
    lastStoreResolutionAt: number | null;
    tile: FeatureHealth;
    voiceList: FeatureHealth;
    audience: FeatureHealth;
}

const logger = new Logger("ViewerEyes");
const namedStreamingStore = findStoreLazy("ApplicationStreamingStore") as StreamingStoreLike;
const propsStreamingStore = findByPropsLazy(
    "getCurrentUserActiveStream",
    "getViewerIds",
    "addChangeListener",
    "removeChangeListener"
) as StreamingStoreLike;
const guildMemberStore = findStoreLazy("GuildMemberStore") as GuildMemberStoreLike;

function emptyFeatureHealth(): FeatureHealth {
    return {
        enabled: false,
        active: false,
        viewerCount: 0,
        targetsFound: 0,
        surfacesFound: 0,
        lastSuccessAt: null,
        lastError: null,
        errorCount: 0
    };
}

const health: RuntimeHealth = {
    version: VIEWER_EYES_VERSION,
    storeSource: "unresolved",
    storeAvailable: false,
    lastStoreResolutionAt: null,
    tile: emptyFeatureHealth(),
    voiceList: emptyFeatureHealth(),
    audience: emptyFeatureHealth()
};

let resolvedStreamingStore: StreamingStoreLike | null = null;
let nextStoreResolutionAttempt = 0;
const lastLoggedErrorAt = new Map<string, number>();

function isStreamingStore(value: StreamingStoreLike | null | undefined): value is StreamingStoreLike {
    try {
        return value != null &&
            typeof value.getCurrentUserActiveStream === "function" &&
            typeof value.getViewerIds === "function";
    } catch {
        return false;
    }
}

function resolveStreamingStore(): StreamingStoreLike | null {
    if (resolvedStreamingStore && isStreamingStore(resolvedStreamingStore)) return resolvedStreamingStore;

    const now = Date.now();
    if (now < nextStoreResolutionAttempt) return null;
    nextStoreResolutionAttempt = now + 2_000;

    const candidates: Array<[RuntimeHealth["storeSource"], StreamingStoreLike]> = [
        ["name", namedStreamingStore],
        ["props", propsStreamingStore]
    ];

    for (const [source, candidate] of candidates) {
        if (!isStreamingStore(candidate)) continue;

        resolvedStreamingStore = candidate;
        health.storeSource = source;
        health.storeAvailable = true;
        health.lastStoreResolutionAt = now;
        return candidate;
    }

    health.storeSource = "unresolved";
    health.storeAvailable = false;
    health.lastStoreResolutionAt = now;
    return null;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    try {
        return String(error);
    } catch {
        return "Unknown error";
    }
}

export function reportRuntimeError(scope: string, error: unknown): void {
    const message = errorMessage(error);
    const feature = scope.startsWith("tile")
        ? health.tile
        : scope.startsWith("voice")
            ? health.voiceList
            : health.audience;

    feature.lastError = message;
    feature.errorCount += 1;

    const now = Date.now();
    const last = lastLoggedErrorAt.get(scope) ?? 0;
    if (now - last >= 5_000) {
        lastLoggedErrorAt.set(scope, now);
        logger.error(`[${scope}]`, error);
    }
}

export function markFeatureEnabled(feature: "tile" | "voiceList" | "audience", enabled: boolean): void {
    health[feature].enabled = enabled;
    if (!enabled) health[feature].active = false;
}

export function updateFeatureHealth(
    feature: "tile" | "voiceList" | "audience",
    patch: Partial<Pick<FeatureHealth, "active" | "viewerCount" | "targetsFound" | "surfacesFound">>
): void {
    Object.assign(health[feature], patch, {
        lastSuccessAt: Date.now(),
        lastError: null
    });
}

export function getViewerEyesDiagnostics(): RuntimeHealth {
    return JSON.parse(JSON.stringify(health)) as RuntimeHealth;
}

export function getCurrentUserActiveStream(): ActiveBroadcast | null {
    try {
        const store = resolveStreamingStore();
        const stream = store?.getCurrentUserActiveStream?.();
        return stream && typeof stream === "object" ? stream as ActiveBroadcast : null;
    } catch (error) {
        reportRuntimeError("audience.store.activeStream", error);
        resolvedStreamingStore = null;
        return null;
    }
}

export function getViewerIds(broadcast: ActiveBroadcast): string[] {
    try {
        const store = resolveStreamingStore();
        const raw = store?.getViewerIds?.(broadcast);
        if (!Array.isArray(raw)) return [];

        const ids = new Set<string>();
        for (const value of raw) {
            if (typeof value !== "string" || !value) continue;
            ids.add(value);
            // Defensive ceiling against malformed store output.
            if (ids.size >= 250) break;
        }
        return [...ids];
    } catch (error) {
        reportRuntimeError("audience.store.viewerIds", error);
        resolvedStreamingStore = null;
        return [];
    }
}

export function subscribeToStreamingChanges(listener: ChangeListener): () => void {
    const store = resolveStreamingStore();

    try {
        if (
            store &&
            typeof store.addChangeListener === "function" &&
            typeof store.removeChangeListener === "function"
        ) {
            store.addChangeListener(listener);
            return () => {
                try {
                    store.removeChangeListener?.(listener);
                } catch (error) {
                    reportRuntimeError("audience.store.unsubscribe", error);
                }
            };
        }
    } catch (error) {
        reportRuntimeError("audience.store.subscribe", error);
    }

    // If Discord changes the Flux surface, keep the plugin functional through
    // a low-frequency fallback instead of crashing or becoming permanently stale.
    const timer = window.setInterval(listener, 1_500);
    return () => window.clearInterval(timer);
}

export function getServerNickname(guildId: string | undefined, userId: string): string | undefined {
    if (!guildId) return undefined;

    try {
        const nick = guildMemberStore.getMember?.(guildId, userId)?.nick;
        return typeof nick === "string" && nick ? nick : undefined;
    } catch {
        // Nicknames are an optional matching signal; losing them must never
        // disable ViewerEyes or affect the stronger ID/avatar strategies.
        return undefined;
    }
}
