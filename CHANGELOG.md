# Changelog

Notable changes to AniList Fast Load are documented here.

## [0.2.5] - 2026-10-17

- Current baseline imported from the published userscript.
- Optimizes media loading and off-screen row rendering.
- Coalesces selected mutation-observer work and reduces repeated text/selector work.
- Adds GraphQL request deduplication, short-lived caching, and stale fallback.
- Adds navigation prefetching and early request starts based on previously observed requests.
- Includes AniList Tier Labels compatibility assistance.
- Exposes diagnostic counters through `window.__ALFL_STATS__`.

For full details, see the comments and configuration in `al-fast-load.user.js`.
