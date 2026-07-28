# Changelog

## 3.15 - defensive hardening

- Kept v3.14 visual behavior unchanged.
- Added redundant ApplicationStreamingStore resolution.
- Added defensive validation for active streams and viewer IDs.
- Added isolated feature startup and cleanup.
- Added throttled runtime error logging.
- Added fallback polling if Flux subscriptions become unavailable.
- Added internal diagnostics exposed as `getDiagnostics()`.
