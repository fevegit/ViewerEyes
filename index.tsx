/*
 * ViewerEyes
 * Copyright (c) 2026 feve
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";

import { AudiencePanel, createShareIconDecorator } from "./audience";
import { t } from "./i18n";
import { startEyeOverlay, stopEyeOverlay } from "./tileOverlay";
import { startVoiceListOverlay, stopVoiceListOverlay } from "./voiceListOverlay";
import {
    getViewerEyesDiagnostics,
    markFeatureEnabled,
    reportRuntimeError,
    VIEWER_EYES_VERSION
} from "./runtime";

/* VIEWEREYES_SETTINGS_ORDER_TEST: recuadros > lista de voz > panel > tooltip > demo */
const settings = definePluginSettings({
    showTileEyes: {
        get displayName() {
            return t("Mostrar ojos en recuadros", "Show Tile Eyes");
        },
        get description() {
            return t(
                "Muestra un ojo en el recuadro de cada persona que está viendo tu transmisión",
                "Show an eye on the tile of every person watching your stream."
            );
        },
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    showVoiceListEyes: {
        get displayName() {
            return t("Mostrar ojos en lista de voz", "Show Voice List Eyes");
        },
        get description() {
            return t(
                "Muestra un ojo junto a cada usuario del canal de voz que está viendo tu transmisión",
                "Show an eye next to every voice-channel user watching your stream."
            );
        },
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    showPanel: {
        get displayName() {
            return t("Mostrar panel", "Show Panel");
        },
        get description() {
            return t(
                "Muestra los espectadores debajo del panel de compartir pantalla",
                "Show viewers below the screen-sharing panel."
            );
        },
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    showStreamIconTooltip: {
        get displayName() {
            return t("Tooltip del icono de transmisión", "Stream Icon Tooltip");
        },
        get description() {
            return t(
                "Muestra los espectadores al pasar el ratón por el icono de compartir pantalla",
                "Show viewers when hovering over the screen-sharing icon."
            );
        },
        type: OptionType.BOOLEAN,
        default: true,
        restartNeeded: true
    },
    previewSelf: {
        get displayName() {
            return t("Modo demo", "Demo Mode");
        },
        get description() {
            return t(
                "Modo demo: muestra el ojo en todos los usuarios del canal de voz, también en tu recuadro, y añade espectadores simulados al panel",
                "Demo mode: show the eye on every user in the current voice channel, also on your tile, and add simulated viewers to the panel."
            );
        },
        type: OptionType.BOOLEAN,
        default: false
    },
    demoViewerCount: {
        get displayName() {
            return t("Espectadores de prueba", "Demo Viewer Count");
        },
        get description() {
            return t(
                "Cantidad total de espectadores de prueba; el primero eres tú (máximo 30)",
                "Total number of demo viewers; the first viewer is you (maximum 30)."
            );
        },
        type: OptionType.SLIDER,
        markers: Array.from({ length: 30 }, (_, index) => index + 1),
        default: 1,
        stickToMarkers: true,
        componentProps: {
            onValueRender: (value: number) => String(Math.round(value)),
            onMarkerRender: (value: number) => [1, 5, 10, 15, 20, 25, 30].includes(value)
                ? String(value)
                : ""
        }
    },
});

interface DemoSettings {
    enabled: boolean;
    viewerCount: number;
}

function useDemoSettings(): DemoSettings {
    const { previewSelf, demoViewerCount } = settings.use(["previewSelf", "demoViewerCount"]);

    return {
        enabled: previewSelf,
        viewerCount: Math.max(1, Math.min(30, Math.round(demoViewerCount)))
    };
}

function ViewerAudiencePanel() {
    const demo = useDemoSettings();

    return (
        <AudiencePanel
            includeSelf={demo.enabled}
            demoViewerCount={demo.enabled ? demo.viewerCount : 0}
        />
    );
}

export default definePlugin({
    name: "ViewerEyes",
    get description() {
        return t(
            "Indica quién está viendo tu transmisión en los recuadros, la lista del canal de voz, el panel de actividad y el icono de pantalla compartida.",
            "Show who is watching your stream in tiles, the voice-channel list, the activity panel, and the screen-sharing icon."
        );
    },
    authors: [{ name: "feve", id: 0n }],
    settings,

    patches: [
        {
            predicate: () => settings.store.showStreamIconTooltip,
            find: ".Masks.STATUS_SCREENSHARE,width:32",
            replacement: {
                match: /jsx\)\((\i\.\i),{mask:/,
                replace: "jsx)($self.decorateShareIcon({OriginalComponent:$1}),{mask:"
            }
        },
        {
            predicate: () => settings.store.showPanel,
            find: "#{intl::vTl6Lk::raw}",
            replacement: {
                match: /ACTIVITY_PANEL,children:\(0.{0,100}?(?=,\(0)/,
                replace: "$&,$self.renderAudiencePanel()"
            }
        }
    ],

    start() {
        settings.store.demoViewerCount = Math.max(
            1,
            Math.min(30, Math.round(settings.store.demoViewerCount || 1))
        );

        const previewSettingPath = `plugins.${settings.pluginName}.previewSelf`;

        markFeatureEnabled("audience", settings.store.showPanel !== false || settings.store.showStreamIconTooltip !== false);

        if (settings.store.showTileEyes !== false) {
            try {
                startEyeOverlay({
                    includeSelf: () => settings.store.previewSelf,
                    previewSettingPath
                });
            } catch (error) {
                reportRuntimeError("tile.start", error);
            }
        } else {
            markFeatureEnabled("tile", false);
        }

        if (settings.store.showVoiceListEyes !== false) {
            try {
                startVoiceListOverlay({
                    includeSelf: () => settings.store.previewSelf,
                    previewSettingPath
                });
            } catch (error) {
                reportRuntimeError("voice.start", error);
            }
        } else {
            markFeatureEnabled("voiceList", false);
        }
    },

    stop() {
        try {
            stopEyeOverlay();
        } catch (error) {
            reportRuntimeError("tile.stop", error);
        }

        try {
            stopVoiceListOverlay();
        } catch (error) {
            reportRuntimeError("voice.stop", error);
        }

        markFeatureEnabled("audience", false);
    },

    version: VIEWER_EYES_VERSION,
    getDiagnostics: getViewerEyesDiagnostics,

    renderAudiencePanel: ViewerAudiencePanel,
    decorateShareIcon(props) {
        return createShareIconDecorator(props, useDemoSettings);
    }
});
