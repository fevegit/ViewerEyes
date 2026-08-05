
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
});

function ViewerAudiencePanel() {
    return <AudiencePanel />;
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
markFeatureEnabled("audience", settings.store.showPanel !== false || settings.store.showStreamIconTooltip !== false);

        if (settings.store.showTileEyes !== false) {
            try {
                startEyeOverlay();
            } catch (error) {
                reportRuntimeError("tile.start", error);
            }
        } else {
            markFeatureEnabled("tile", false);
        }

        if (settings.store.showVoiceListEyes !== false) {
            try {
                startVoiceListOverlay();
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
        return createShareIconDecorator(props);
    }
});
