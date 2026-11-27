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

## Subsequent dynamic validation

- A forced redraw without changing the visible surface also yielded zero hits. This was inconclusive.
- During actual navigation (switching servers, returning to the existing call and opening its large view while sharing the screen), the avatar renderer at RVA `0x393c2b0` recorded 11 hits; both voice-row candidates recorded zero. All three observers were removed successfully.
- A second limited trace recorded five avatar calls, all returning to RVA `0x50f34c3`, within function `0x50f33d0..0x50f3536`. The temporary observer was removed (true).
- Static inspection found a pointer to the avatar function at `0x16384830` and a pointer to the intermediary at `0x149da328`. Neither establishes the participant ID or a safe GPUI insertion site. The intermediary appears to return a 40-byte element; its exact type/ABI remains unverified.
- The global at `0x17e47cf0` has many unrelated references and is not a useful call-tile-specific anchor. Do not pursue it without new evidence.
- These RVAs apply only to the examined executable, not future builds. Do not install persistent hooks using them.

## Resume checkpoint

Paused by request on 2026-11-27, pending improved Sunbird/Phoenix desktop UI support. Preserve ViewerEyes alpha.2 and the original Vencord implementation. On resumption, first inspect upstream API and release changes for native voice-user and call-tile decoration support; prefer supported APIs over further manual binary reversing. Do not interpret the 11 avatar hits as proof of safe insertion or verified viewer identity. Real nonzero audience tracking is still untested.

## Recommended next steps
1. Validate a real viewer joining/leaving a stream in alpha.2, with demo disabled.
2. Request or develop upstream native decoration support for voice channel participants and call tiles. Proposed independent optional APIs: addVoiceUserDecoration and addCallTileDecoration, keyed by userId; these names are design proposals, not existing APIs.
3. Reuse upstream members.rs decoration worker/cache, invalidation and GPUI primitives; validate layout/ABI and unique signatures, fail closed on unsupported builds, and test with a separate experimental runtime.
4. Only after native support is available, adapt ViewerEyes settings independently for both surfaces and validate real/demo states, viewer departure, stream termination, plugin reload, and missing APIs.

Upstream reference: https://github.com/sunbird-tools/sunbird/blob/main/crates/runtime-desktop/src/members.rs

No upstream issue or PR submitted. No native implementation or build has been validated.
