# AniList Fast Load

**A performance-focused userscript for AniList.** It optimizes media loading, off-screen rendering, repeated DOM work, GraphQL requests, and navigation prefetching to help AniList feel smoother—especially on pages with lots of content or other userscripts enabled.

[Install from Greasy Fork](https://greasyfork.org/en/scripts/598442-anilist-fast-load) · [Report a bug](https://github.com/Daiya404/AL-Fast-Load/issues/new?template=bug_report.yml) · [Request a feature](https://github.com/Daiya404/AL-Fast-Load/issues/new?template=feature_request.yml)

> **Current release:** v0.2.5

## What it does

- **Lazy media loading:** applies lazy-loading defaults to images, iframes, and videos when appropriate.
- **Off-screen rendering optimization:** uses browser rendering hints for supported list rows and activity content.
- **Mutation observer coalescing:** reduces repeated callback work during bursts of DOM updates.
- **Cheaper text and selector work:** optimizes selected `innerText` reads and memoizes repeated selector probes within a task.
- **GraphQL request deduplication and caching:** identical requests can share in-flight work and briefly reuse cached responses.
- **Stale-response fallback:** where eligible, a recent cached response can be used if a refresh fails.
- **Navigation prefetching:** can start suitable requests when you hover over or touch navigation targets.
- **Early request starts:** learns a limited set of requests from previous visits and can start them earlier on a later load.
- **AniList Tier Labels assistance:** includes compatibility optimizations for score badges, including cases where badges need to be rebuilt.

The script is designed to work on its own and to coexist with other AniList userscripts. It does not edit their source files.

## Install

1. Install a userscript manager such as [Violentmonkey](https://violentmonkey.github.io/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Open [AniList Fast Load on Greasy Fork](https://greasyfork.org/en/scripts/598442-anilist-fast-load).
3. Click **Install** and confirm in your userscript manager.
4. Reload [AniList](https://anilist.co/).

The script runs at `document-start` on AniList's main site and does not run inside frames.

## Compatibility

- Supported site patterns: `https://anilist.co/*` and `https://www.anilist.co/*`.
- Intended to run independently or alongside other AniList userscripts, including AL Additions and AniList Tier Labels.
- Some optimizations depend on browser features and on AniList's current page implementation.

Results vary by browser, device, network, page, and enabled userscripts. Fast Load does not promise a fixed speed increase. If a page behaves unexpectedly, temporarily disable the script and reload to help determine whether it is involved.

## Diagnostics

Open the browser's developer console while on AniList and run:

```js
window.__ALFL_STATS__
```

The object exposes diagnostic counters for supported optimizations. These counters help with troubleshooting; they are not a benchmark and should not be treated as proof of a particular performance gain.

## Configuration

The script's `CFG` object near the top of `al-fast-load.user.js` contains feature switches and limits. Advanced users can inspect the source to understand or adjust the available optimizations. If you change the script locally, keep a copy of your edits because an update from Greasy Fork may replace them.

## Privacy

Fast Load is a client-side userscript that works with AniList pages and its GraphQL API. Its request caching, prefetching, and early-start features affect requests made by your browser to AniList. The script's source is available in this repository for inspection.

Do not post browser cookies, authorization headers, login tokens, or other private account data in an issue. Review the source code before installing if you want to verify the exact behavior for yourself.

This project is independent and is not affiliated with or endorsed by AniList.

## Troubleshooting

1. Confirm the script is enabled in your userscript manager.
2. Check that you're visiting `anilist.co`.
3. Update to the latest version from Greasy Fork.
4. Reload the page and check whether the problem persists.
5. Temporarily disable Fast Load to compare behavior.
6. If the problem remains, report it using the repository's bug report template.

When reporting an issue, include your browser, userscript manager, script version, affected AniList page, steps to reproduce, and any relevant console errors. Remove private information before sharing logs.

## Development

The userscript is currently distributed as a single JavaScript file: `al-fast-load.user.js`. There is no build step required to install or inspect it.

For contributions, read [CONTRIBUTING.md](CONTRIBUTING.md). For changes between releases, see [CHANGELOG.md](CHANGELOG.md).

## Links

- **Install / automatic updates:** [Greasy Fork](https://greasyfork.org/en/scripts/598442-anilist-fast-load)
- **Source code:** [GitHub repository](https://github.com/Daiya404/AL-Fast-Load)
- **Bug reports and feature requests:** [GitHub Issues](https://github.com/Daiya404/AL-Fast-Load/issues)

## License

This project is licensed under the [MIT License](LICENSE).
