# Changelog

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
