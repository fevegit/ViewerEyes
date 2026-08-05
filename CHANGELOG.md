# Changelog

## 3.17.0 - voice-list compatibility and placement

- Fixed missing viewer eyes on some Discord voice-channel rows.
- Prevented viewer indicators from inheriting black colors from status and activity icons.
- Prevented voice-list indicators from appearing in Friends, direct messages, navigation entries or the connection panel.
- Improved placement around mute, deafen, Live and activity badges.
- Reordered the plugin settings for clearer navigation.
- Removed the development-only demo controls from the public release.

## 3.16.0 - voice-list indicator reliability

- Fixed the viewer eye occasionally disappearing from voice-channel member rows.
- Prevented the viewer eye from overlapping Discord's Live badge.
- Improved voice-row detection for avatar URLs and background images.
- Ignored icons that belong to the Live badge when selecting status anchors.
- Added a short grace period for transient Discord row rebuilds.

## 3.15 - defensive hardening

- Kept v3.14 visual behavior unchanged.
- Added redundant ApplicationStreamingStore resolution.
- Added defensive validation for active streams and viewer IDs.
- Added isolated feature startup and cleanup.
- Added throttled runtime error logging.
- Added fallback polling if Flux subscriptions become unavailable.
- Added internal diagnostics exposed as `getDiagnostics()`.
