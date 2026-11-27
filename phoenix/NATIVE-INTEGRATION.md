# Phoenix native integration investigation

Status: experimental alpha.2, 2026-11-27. Keep the working JS plugin unchanged.

## Validated on Windows
- Sunbird build reported 2026.11.27.1324-5630669.
- Own stream detection and event delivery observed; real nonzero viewer audience remains to be validated.
- Demo audience panel and SVG eye in the general member list work.
- Desktop addMemberDecoration covers general member/DM lists, not verified voice rows or call tiles.
- Upstream runtime-desktop/src/js/ui.rs implements desktop no-op shims for several generic UI tree operations; do not assume mobile operations work on Windows.

## Static candidates (build-specific, not production signatures)
- fw-voice-user-name-{}-{} / fw-voice-user-{}-{}: function RVA 0x1cf4dc4.
- rtc-voice-user / rtc-voice-user-shake: function RVA 0x36da011.
- call-tile-avatar: function RVA 0x393c2b0.

Static labels are not proof of the intended UI surface, participant identity, ABI, or safe insertion site.

Two short observation runs installed and removed all three observers successfully; all counters were zero. Second run lasted approximately two seconds. This is inconclusive, not proof that the functions never run. No persistent hook or runtime binary changes were made.

## Recommended next steps
1. Validate a real viewer joining/leaving a stream in alpha.2, with demo disabled.
2. Request or develop upstream native decoration support for voice channel participants and call tiles. Proposed independent optional APIs: addVoiceUserDecoration and addCallTileDecoration, keyed by userId; these names are design proposals, not existing APIs.
3. Reuse upstream members.rs decoration worker/cache, invalidation and GPUI primitives; validate layout/ABI and unique signatures, fail closed on unsupported builds, and test with a separate experimental runtime.
4. Only after native support is available, adapt ViewerEyes settings independently for both surfaces and validate real/demo states, viewer departure, stream termination, plugin reload, and missing APIs.

Upstream reference: https://github.com/sunbird-tools/sunbird/blob/main/crates/runtime-desktop/src/members.rs

No upstream issue or PR submitted. No native implementation or build has been validated.
