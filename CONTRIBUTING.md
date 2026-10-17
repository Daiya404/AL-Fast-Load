# Contributing to AniList Fast Load

Thanks for taking the time to help improve the project!

## Before opening an issue

- Search existing issues to see whether the problem or idea has already been reported.
- Use the bug report template for broken behavior or performance regressions.
- Use the feature request template for suggestions.
- Keep reports focused on one problem where possible.

## Bug reports

Please include:

- AniList page or route where the issue happens
- Fast Load version
- Browser and version
- Userscript manager and version
- Other AniList userscripts that may be relevant
- Steps to reproduce and expected versus actual behavior
- Relevant console errors, with private information removed

If possible, test once with Fast Load disabled to help isolate the cause.

## Code changes

1. Fork the repository and create a branch for your change.
2. Keep changes focused and explain the reason for them.
3. Preserve compatibility with AniList and other userscripts where practical.
4. Avoid unnecessary changes to unrelated code.
5. Test on the affected AniList pages and check the browser console.
6. Open a pull request describing the change, how it was tested, and any trade-offs.

The project is currently distributed as a standalone userscript, so no build process is required.

## Performance and safety considerations

- Avoid adding work to hot paths such as DOM mutation callbacks or repeated list rendering.
- Be careful with GraphQL caching and request deduplication; do not assume every request is interchangeable.
- Do not collect, log, or request private account information unnecessarily.
- Do not include cookies, authorization headers, login tokens, or personal account data in issues or pull requests.
- If an optimization can fail, prefer a safe fallback that leaves normal browser behavior intact.

## Scope

Changes should relate to AniList performance, compatibility, diagnostics, or maintainability. Large architectural changes should be discussed in an issue first.
