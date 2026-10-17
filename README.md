# AniList Fast Load

**A standalone performance layer for AniList.**

AniList Fast Load focuses on the work a page does behind the scenes: media scheduling, off-screen list rendering, repeated DOM work, and GraphQL requests. It is intended to improve responsiveness without redesigning AniList's interface or changing the site's normal features.

It can run by itself or alongside other AniList userscripts. In particular, it includes optimizations intended to reduce the repeated page-scanning work associated with AniList Tier Labels, plus an optional repair pass for list-score badges.

[Install from Greasy Fork](https://greasyfork.org/en/scripts/598442-anilist-fast-load) · [Issues](https://github.com/Daiya404/AL-Fast-Load/issues)

## Overview

| Area | Behaviour |
| --- | --- |
| Connection warm-up | Preconnects to AniList's GraphQL endpoint, media CDN, and Google Fonts origins. |
| Media scheduling | Applies lazy-loading defaults to supported images, iframes, and videos, including media inserted through HTML. |
| Off-screen rows | Uses `content-visibility` and measured row sizes to reduce rendering work for supported list/activity content. |
| Observer coalescing | Batches selected page-wide mutation-observer callbacks so repeated scans happen less often during DOM update bursts. |
| Text and selector work | Optimizes selected score/label text reads and shares repeated selector probes within a task. |
| GraphQL layer | Deduplicates matching in-flight requests and temporarily caches eligible successful query responses. |
| Stale fallback | Can serve an eligible recent response if a refresh fails with a network or server-side error. |
| Navigation prefetch | Uses learned route queries to warm eligible anime, manga, character, staff, studio, or user pages before navigation. |
| Early request start | Learns a limited set of route queries and can start them at the beginning of a later page load. |
| Tier Labels support | Checks list scores after page changes and gives missing or outdated badges back to Tier Labels for rebuilding. |

The exact effect depends on the browser, device, network, AniList page, and other enabled scripts. This project does not promise a fixed speed increase.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Visit [AniList Fast Load on Greasy Fork](https://greasyfork.org/en/scripts/598442-anilist-fast-load).
3. Select **Install** and confirm in your userscript manager.
4. Open or reload [AniList](https://anilist.co/).

Greasy Fork is the recommended installation and update source. The repository contains the readable source for review and contributions.

## Compatibility

- Matches `https://anilist.co/*` and `https://www.anilist.co/*`.
- Runs at `document-start` and is configured not to run in frames.
- Designed to work independently and alongside other AniList userscripts, including [AL Additions](https://greasyfork.org/en/scripts/594705-al-additions) and AniList Tier Labels.
- Off-screen row skipping depends on browser support for `content-visibility`; unsupported environments should simply miss that optimization.

## Configuration

Feature switches and limits live in the `CFG` object near the top of `al-fast-load.user.js`. You can open the script in your userscript manager and change a setting from `true` to `false` to disable that feature. The same object contains timing and size limits for caching, prefetching, early starts, and Tier Labels assistance.

Some features depend on others. For example, prefetching and early request starts use the GraphQL layer. Set `gqlTtl` to `0` to disable that layer.

## Diagnostics

On an AniList page, open your browser's developer console and evaluate:

```js
window.__ALFL_STATS__
```

The object exposes counters including GraphQL requests, cache hits, deduplicated requests, stale responses served, prefetches, early starts, observer batches, merged observer records, shared selector probes, and Tier Labels badge repairs.

These counters are intended for troubleshooting and are not a formal benchmark.

## Request handling and privacy

The GraphQL layer is designed to cache eligible read-only queries, not mutations that change account data. Requests associated with notifications and activity are excluded from caching. Only successful responses without GraphQL errors are stored, and stored responses do not replay rate-limit headers.

The script learns limited route/query information in browser local storage under `alfl:routes:v1`, with a 30-day expiry, so it can recognize requests to start early on a later visit. It does not store the AniList login token; when an early request needs authentication, the script obtains the current token from the live page.

Network activity is directed to AniList's own API/media infrastructure and the listed font origins for connection warm-up. The project does not intentionally send usage analytics to a separate service. You can inspect the complete source in this repository before installing.

## Troubleshooting

If something looks wrong:

1. Temporarily disable Fast Load and reload the same page.
2. If the issue changes, re-enable it and switch off relevant features one at a time in `CFG`.
3. Check the developer console for errors and inspect `window.__ALFL_STATS__`.
4. If you open an issue, include the script version, browser, userscript manager, affected page, reproduction steps, and relevant errors.

Remove cookies, authorization headers, login tokens, and other private information from any logs or screenshots before posting them.

## Contributing

Bug reports, focused improvements, and compatibility feedback are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Use the issue templates where possible.

## Related project

**[AL Additions](https://greasyfork.org/en/scripts/594705-al-additions)** adds convenience features to AniList, including one-way list syncing to MyAnimeList, score and progress editing, airing indicators, opening and ending themes, MyAnimeList and Nyaa shortcuts, and banner downloads. Fast Load and AL Additions are separate scripts designed to work together.

## License

Distributed under the [MIT License](LICENSE).
