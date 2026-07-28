/*
 * ViewerEyes - audience data and UI
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { openUserProfile } from "@utils/discord";
import type { User } from "@vencord/discord-types";
import { React, ReactDOM, RelationshipStore, UserStore } from "@webpack/common";
import type { ComponentType, JSX } from "react";

import {
    getCurrentUserActiveStream,
    getViewerIds,
    reportRuntimeError,
    subscribeToStreamingChanges,
    updateFeatureHealth
} from "./runtime";

interface BroadcastDescriptor {
    guildId?: string;
}

interface AudienceEntry {
    key: string;
    displayName: string;
    user?: User;
    mockAvatarUrl?: string;
}

interface AudienceSnapshot {
    broadcast: BroadcastDescriptor | null;
    entries: AudienceEntry[];
    unresolved: number;
    total: number;
}

interface ShareIconFactoryProps {
    OriginalComponent: ComponentType<Record<string, unknown>>;
}

interface AudiencePanelProps {
    includeSelf?: boolean;
    demoViewerCount?: number;
}

interface DemoSettings {
    enabled: boolean;
    viewerCount: number;
}

type DemoSettingsHook = () => DemoSettings;

interface AudiencePopoverProps {
    snapshot: AudienceSnapshot;
    children: JSX.Element;
    className?: string;
}

interface PopoverPosition {
    left: number;
    bottom: number;
}

const MAX_PANEL_FACES = 13;
const TOOLTIP_PAGE_SIZE = 5;
const POPOVER_WIDTH = 152;
const MOCK_NAMES = [
    "Nova", "Pixel", "Echo", "Mika", "Luna", "Kai",
    "Nox", "Sora", "Iris", "Axel", "Milo"
];
const MOCK_COLORS = [
    "#5865f2", "#eb459e", "#57f287", "#fee75c", "#ed4245", "#9b84ee",
    "#00a8fc", "#f47b67", "#45ddc0", "#c27c0e", "#e67e22"
];

function preferredName(user: User): string {
    return RelationshipStore.getNickname(user.id) || user.globalName || user.username;
}

function localizedCopy(spanish: string, english: string): string {
    const locale = document.documentElement.lang || navigator.language || "en";
    return locale.toLowerCase().startsWith("es") ? spanish : english;
}

function emptyLabel(): string {
    return localizedCopy("No hay espectadores", "No viewers");
}

function audienceAriaLabel(total: number): string {
    return localizedCopy(
        `Espectadores de la transmisión: ${total}`,
        `Stream viewers: ${total}`
    );
}

function mockAvatar(index: number): string {
    const number = index + 1;
    const fill = MOCK_COLORS[index % MOCK_COLORS.length];
    const label = `M${number}`;
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
        `<rect width="64" height="64" rx="32" fill="${fill}"/>`,
        `<text x="32" y="39" text-anchor="middle" font-family="Arial, sans-serif" font-size="23" font-weight="700" fill="#fff">${label}</text>`,
        "</svg>"
    ].join("");

    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function createMockEntry(index: number): AudienceEntry {
    return {
        key: `viewer-eyes-mock-${index}`,
        displayName: `${MOCK_NAMES[index % MOCK_NAMES.length]} ${index + 1}`,
        mockAvatarUrl: mockAvatar(index)
    };
}

function avatarUrl(entry: AudienceEntry, guildId: string | undefined, size: number): string {
    return entry.user?.getAvatarURL(guildId, size, true) || entry.mockAvatarUrl || "";
}

function useStreamingRevision(): void {
    const [, forceUpdate] = React.useReducer((value: number) => value + 1, 0);

    React.useEffect(() => subscribeToStreamingChanges(forceUpdate), []);
}

function useAudience(includeSelf = false, demoViewerCount = 0): AudienceSnapshot {
    useStreamingRevision();

    try {
        const broadcast = getCurrentUserActiveStream() as BroadcastDescriptor | null;

        if (!broadcast) {
            updateFeatureHealth("audience", {
                active: false,
                viewerCount: 0,
                targetsFound: 0,
                surfacesFound: 0
            });
            return { broadcast: null, entries: [], unresolved: 0, total: 0 };
        }

        const ids = getViewerIds(broadcast);
        const entries: AudienceEntry[] = [];
        let unresolved = 0;

        for (const id of ids) {
            const user = UserStore.getUser(id) as User | undefined;

            if (user) {
                entries.push({
                    key: `viewer-eyes-user-${user.id}`,
                    displayName: preferredName(user),
                    user
                });
            } else {
                unresolved += 1;
            }
        }

        if (includeSelf) {
            const currentUser = UserStore.getCurrentUser() as User | undefined;
            const desiredDemoCount = Math.max(1, Math.floor(demoViewerCount || 1));

            if (currentUser && !ids.includes(currentUser.id)) {
                entries.unshift({
                    key: `viewer-eyes-user-${currentUser.id}`,
                    displayName: preferredName(currentUser),
                    user: currentUser
                });
            }

            for (let index = 0; index < desiredDemoCount - 1; index++) {
                entries.push(createMockEntry(index));
            }
        }

        const total = entries.length + unresolved;
        updateFeatureHealth("audience", {
            active: true,
            viewerCount: ids.length,
            targetsFound: entries.length,
            surfacesFound: 1
        });

        return {
            broadcast,
            entries,
            unresolved,
            total
        };
    } catch (error) {
        reportRuntimeError("audience.snapshot", error);
        return { broadcast: null, entries: [], unresolved: 0, total: 0 };
    }
}

function AvatarItem({ entry, guildId, compact = false }: { entry: AudienceEntry; guildId?: string; compact?: boolean; }): JSX.Element {
    const className = compact ? "ve-audience-avatar ve-audience-avatar-compact" : "ve-audience-avatar";
    const image = <img src={avatarUrl(entry, guildId, compact ? 32 : 80)} alt="" />;

    if (entry.user) {
        return (
            <button
                type="button"
                className={className}
                aria-label={entry.displayName}
                title={entry.displayName}
                onClick={() => openUserProfile(entry.user!.id)}
            >
                {image}
            </button>
        );
    }

    return (
        <span
            className={`${className} ve-audience-avatar-mock`}
            aria-label={entry.displayName}
            title={entry.displayName}
        >
            {image}
        </span>
    );
}

function AudiencePerson({ entry, guildId }: { entry: AudienceEntry; guildId?: string; }): JSX.Element {
    const content = (
        <>
            <img src={avatarUrl(entry, guildId, 40)} alt="" />
            <span>{entry.displayName}</span>
        </>
    );

    if (entry.user) {
        return (
            <button
                type="button"
                className="ve-audience-person"
                onClick={() => openUserProfile(entry.user!.id)}
            >
                {content}
            </button>
        );
    }

    return <div className="ve-audience-person ve-audience-person-mock">{content}</div>;
}

function AudiencePopover({ snapshot, children, className }: AudiencePopoverProps): JSX.Element {
    const triggerRef = React.useRef<HTMLSpanElement>(null);
    const closeTimerRef = React.useRef<number | null>(null);
    const [open, setOpen] = React.useState(false);
    const [position, setPosition] = React.useState<PopoverPosition>({ left: 8, bottom: 8 });

    const cancelClose = React.useCallback(() => {
        if (closeTimerRef.current != null) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
    }, []);

    const updatePosition = React.useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;

        const rect = trigger.getBoundingClientRect();
        const estimatedWidth = POPOVER_WIDTH;
        const margin = 8;
        const centeredLeft = rect.left + rect.width / 2 - estimatedWidth / 2;

        setPosition({
            left: Math.max(margin, Math.min(centeredLeft, window.innerWidth - estimatedWidth - margin)),
            bottom: Math.max(margin, window.innerHeight - rect.top + 7)
        });
    }, []);

    const show = React.useCallback(() => {
        cancelClose();
        updatePosition();
        setOpen(true);
    }, [cancelClose, updatePosition]);

    const scheduleClose = React.useCallback(() => {
        cancelClose();
        closeTimerRef.current = window.setTimeout(() => {
            closeTimerRef.current = null;
            setOpen(false);
        }, 260);
    }, [cancelClose]);

    React.useEffect(() => {
        if (!open) return;

        const reposition = () => updatePosition();
        window.addEventListener("resize", reposition);
        window.addEventListener("scroll", reposition, true);

        return () => {
            window.removeEventListener("resize", reposition);
            window.removeEventListener("scroll", reposition, true);
        };
    }, [open, updatePosition]);

    React.useEffect(() => () => cancelClose(), [cancelClose]);

    return (
        <span
            ref={triggerRef}
            className={className}
            onMouseEnter={show}
            onMouseLeave={scheduleClose}
            onFocus={show}
            onBlur={scheduleClose}
        >
            {children}

            {open && ReactDOM.createPortal(
                <div
                    className="ve-audience-popover"
                    style={{ left: position.left, bottom: position.bottom }}
                    role="dialog"
                    onMouseEnter={cancelClose}
                    onMouseLeave={scheduleClose}
                    onMouseDown={event => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onClick={event => event.stopPropagation()}
                    onPointerDown={event => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onPointerMove={event => event.stopPropagation()}
                    onWheel={event => event.stopPropagation()}
                >
                    <AudienceCard snapshot={snapshot} />
                </div>,
                document.body
            )}
        </span>
    );
}

function AudienceCard({ snapshot }: { snapshot: AudienceSnapshot; }): JSX.Element {
    const pageCount = Math.max(1, Math.ceil(snapshot.entries.length / TOOLTIP_PAGE_SIZE));
    const [page, setPage] = React.useState(0);

    React.useEffect(() => {
        setPage(current => Math.min(current, pageCount - 1));
    }, [pageCount]);

    const pageStart = page * TOOLTIP_PAGE_SIZE;
    const visibleEntries = snapshot.entries.slice(pageStart, pageStart + TOOLTIP_PAGE_SIZE);
    const showPagination = snapshot.entries.length > TOOLTIP_PAGE_SIZE;

    const changePage = (nextPage: number) => {
        setPage(Math.max(0, Math.min(nextPage, pageCount - 1)));
    };

    return (
        <div className="ve-audience-card" aria-label={audienceAriaLabel(snapshot.total)}>
            {snapshot.total === 0 ? (
                <div className="ve-audience-empty">{emptyLabel()}</div>
            ) : (
                <>
                    <div className={showPagination ? "ve-audience-list ve-audience-list-paged" : "ve-audience-list"}>
                        {visibleEntries.map(entry => (
                            <AudiencePerson
                                key={entry.key}
                                entry={entry}
                                guildId={snapshot.broadcast?.guildId}
                            />
                        ))}

                        {snapshot.entries.length === 0 && snapshot.unresolved > 0 && (
                            <div className="ve-audience-unresolved">
                                +{snapshot.unresolved} {localizedCopy("sin cargar", "unresolved")}
                            </div>
                        )}
                    </div>

                    {showPagination && (
                        <div className="ve-audience-pagination" aria-label={localizedCopy("Paginación de espectadores", "Viewer pagination")}>
                            <button
                                type="button"
                                className="ve-audience-page-button"
                                aria-label={localizedCopy("Página anterior", "Previous page")}
                                disabled={page === 0}
                                onMouseDown={event => event.stopPropagation()}
                                onClick={event => {
                                    event.stopPropagation();
                                    changePage(page - 1);
                                }}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M15 18l-6-6 6-6" />
                                </svg>
                            </button>

                            <span className="ve-audience-page-counter" aria-live="polite">
                                {page + 1} / {pageCount}
                            </span>

                            <button
                                type="button"
                                className="ve-audience-page-button"
                                aria-label={localizedCopy("Página siguiente", "Next page")}
                                disabled={page >= pageCount - 1}
                                onMouseDown={event => event.stopPropagation()}
                                onClick={event => {
                                    event.stopPropagation();
                                    changePage(page + 1);
                                }}
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M9 6l6 6-6 6" />
                                </svg>
                            </button>
                        </div>
                    )}

                    {snapshot.unresolved > 0 && snapshot.entries.length > 0 && page === pageCount - 1 && (
                        <div className="ve-audience-unresolved">
                            +{snapshot.unresolved} {localizedCopy("sin cargar", "unresolved")}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export const AudiencePanel = ErrorBoundary.wrap(({
    includeSelf = false,
    demoViewerCount = 0
}: AudiencePanelProps): JSX.Element | null => {
    const snapshot = useAudience(includeSelf, demoViewerCount);
    if (!snapshot.broadcast) return null;

    const visible = snapshot.entries.slice(0, MAX_PANEL_FACES);
    const overflow = Math.max(0, snapshot.total - visible.length);

    return (
        <section className="ve-audience-panel" aria-label={audienceAriaLabel(snapshot.total)}>
            {snapshot.total === 0 ? (
                <div className="ve-audience-empty">{emptyLabel()}</div>
            ) : (
                <div className="ve-audience-avatar-line">
                    {visible.map(entry => (
                        <AvatarItem
                            key={entry.key}
                            entry={entry}
                            guildId={snapshot.broadcast?.guildId}
                        />
                    ))}

                    {overflow > 0 && (
                        <AudiencePopover snapshot={snapshot} className="ve-audience-overflow-trigger">
                            <div className="ve-audience-overflow" tabIndex={0}>+{overflow}</div>
                        </AudiencePopover>
                    )}
                </div>
            )}
        </section>
    );
});

export function createShareIconDecorator(
    { OriginalComponent }: ShareIconFactoryProps,
    useDemoSettings: DemoSettingsHook = () => ({ enabled: false, viewerCount: 0 })
): ComponentType<Record<string, unknown>> {
    return ErrorBoundary.wrap((props: Record<string, unknown>): JSX.Element => {
        const demo = useDemoSettings();
        const snapshot = useAudience(demo.enabled, demo.enabled ? demo.viewerCount : 0);

        if (!snapshot.broadcast) {
            return <OriginalComponent {...props} />;
        }

        return (
            <AudiencePopover snapshot={snapshot} className="ve-audience-share-trigger">
                <OriginalComponent {...props} />
            </AudiencePopover>
        );
    });
}
