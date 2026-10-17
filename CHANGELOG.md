# Changelog

## [0.3.0] - 2026-10-17

- Current repository baseline, matching the supplied `AniList Fast Load` userscript v0.3.0.
- Adds connection warm-up for the GraphQL API, media CDN, and font origins.
- Adds lazy-media handling, off-screen row skipping, observer coalescing, faster text reads, and selector-probe memoization.
- Adds Tier Labels assistance for missing or outdated list-score badges and keeps the sidebar data block out of its repair scope.
- Adds safe GraphQL request deduplication, short-lived response caching, and eligible stale-response fallback.
- Adds route learning, early request starts, and limited navigation prefetching.
- Exposes runtime diagnostic counters through `window.__ALFL_STATS__`.

This changelog begins with the current project baseline. Older releases are not described here unless their source or release notes are added to the repository.
