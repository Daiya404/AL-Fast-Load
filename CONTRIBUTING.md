# Contributing

Thanks for helping improve AniList Fast Load.

## Before opening an issue

- Search existing issues for the same bug or suggestion.
- Use the bug report template for broken behavior, compatibility problems, or regressions.
- Use the feature request template for proposed improvements.
- Keep one issue focused on one main problem.

## Bug reports

Useful reports include:

- Fast Load version
- Browser and version
- Userscript manager and version
- AniList page or route affected
- Steps to reproduce
- Expected behaviour and actual behaviour
- Relevant console errors or `window.__ALFL_STATS__` output
- Other userscripts that may be involved

When practical, compare the page with Fast Load temporarily disabled. Never attach cookies, authorization headers, login tokens, or other private account information.

## Pull requests

1. Fork the repository and create a branch for your change.
2. Explain the user-visible problem or maintenance need.
3. Keep the patch focused and avoid unrelated formatting changes.
4. Test the relevant AniList pages and check the browser console.
5. Describe the tests you performed and any limitations in the pull request.

The project is distributed as a single userscript; no build step is required.

## Implementation guidelines

- Keep the page usable if an optimization fails.
- Be cautious with request caching, request deduplication, and stale fallbacks. Not all GraphQL requests are interchangeable.
- Avoid adding repeated work to hot paths such as DOM mutation callbacks and list rendering.
- Preserve compatibility with AniList and other userscripts where practical.
- Do not add telemetry or external network destinations without clearly documenting the change and its privacy implications.

## Scope

Changes should relate to performance, compatibility, diagnostics, safety, or maintainability of AniList Fast Load. Discuss large behavioural changes in an issue before investing in a large pull request.
