// ==UserScript==
// @name         AniList Fast Load
// @namespace    https://anilist.co/
// @version      0.2.5
// @description  AniList performance optimizer: lazy media, off-screen row skipping, observer coalescing (makes heavy scripts like Tier Labels cheap), safe GraphQL cache/de-duplication with stale fallback, navigation prefetch, and early request start on reload.
// @author       Daiya
// @match        https://anilist.co/*
// @match        https://www.anilist.co/*
// @license      MIT
// @noframes
// @run-at       document-start
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/598442/AniList%20Fast%20Load.user.js
// @updateURL https://update.greasyfork.org/scripts/598442/AniList%20Fast%20Load.meta.js
// ==/UserScript==

/*
 * AniList Fast Load
 *
 * Works alone, and is built to sit underneath other AniList userscripts
 * (AL Additions, AniList Tier Labels) without touching them.
 *
 *   1. Preconnects to the API and the image CDN.
 *   2. Lazy media: <img>/<iframe>/<video> become lazy when created, including
 *      ones that arrive through innerHTML (activities, descriptions).
 *   3. Off-screen rows skip rendering (content-visibility) with measured sizes,
 *      so their cover images are not fetched until you scroll near them.
 *   4. Observer coalescing: a MutationObserver on the whole page whose callback
 *      ignores its records (Tier Labels' does) is run once per batch instead
 *      of after every DOM change. Nothing is lost, it just stops re-scanning
 *      the page hundreds of times while AniList renders. The first change after
 *      a quiet moment still runs at once, so decorations appear with the content.
 *   5. Cheap innerText for score/label leaf elements: innerText forces a full
 *      layout on every read, which thrashes when a script reads it in a loop.
 *   6. Selector probe memo: Tier Labels asks "which score format is this page?"
 *      once per score element, and a failed probe scans the whole list each
 *      time. Identical probes inside one task now share one answer.
 *   7. GraphQL layer: de-duplicates and briefly caches identical queries, serves
 *      a stale copy if a refresh fails, and prefetches the page you are about
 *      to open (hover / touch).
 *   8. Early start: the queries a page type used last time are remembered, and
 *      on a fresh load they are sent at document-start, while the site's own
 *      bundle is still downloading. The site's later identical request joins
 *      the one already in flight. Your login token is never stored.
 *   9. Tier Labels assist: after the page settles, list scores whose badge is
 *      missing or out of date (a framework patched the row in place after Tier
 *      Labels had marked it done) are released so Tier Labels rebuilds them.
 *
 * Every feature has a switch in CFG below. Failures in any part fall back to the
 * untouched browser behaviour. Counters are visible in the console as
 * window.__ALFL_STATS__.
 */
(() => {
    'use strict';

    if (window.top !== window.self) return;
    // Also bails if an older version is still enabled, to avoid double-patching.
    if (window.__ANILIST_FAST_LOAD__ || window.__ANILIST_FAST_LOAD_V4__) return;
    window.__ANILIST_FAST_LOAD__ = '0.2.5';

    /* ======================================================================
     * 0. Config
     * ====================================================================== */
    const CFG = {
        lazyMedia: true,
        rowSkipping: true,
        coalesceObservers: true,   // helps Tier Labels the most
        observerBatchMs: 80,       // minimum gap between runs of a coalesced observer (the first change runs at once)
        fastInnerText: true,
        memoSelectorProbes: true,
        blockTierInData: true,     // keep AniList Tier Labels out of the sidebar .data block (Average / Mean Score)
        tierAssist: true,          // repair missing or out-of-date Tier Labels badges on list scores
        tierAssistMs: 250,         // how soon after a page change the repair check runs

        gqlTtl: 15_000,            // 0 disables the whole GraphQL layer
        gqlStaleTtl: 5 * 60_000,
        gqlMaxBytes: 40 * 1024 * 1024,
        gqlMaxEntryBytes: 16 * 1024 * 1024,

        prefetch: true,            // needs the GraphQL layer
        earlyStart: true,          // needs the GraphQL layer
        prefetchMaxPerMin: 8,
        prefetchDwellMs: 140,
        learnWindowMs: 3_000,
        learnMaxReqs: 4,
    };

    const GQL_ORIGIN = 'https://graphql.anilist.co';
    const MEDIA_ORIGIN = 'https://s4.anilist.co';

    // Debug counters, readable from the console as window.__ALFL_STATS__.
    const stats = {
        graphqlRequests: 0, cacheHits: 0, deduped: 0, staleServed: 0,
        prefetched: 0, earlyStarts: 0,
        observerBatches: 0, observerRecordsMerged: 0,
        probesShared: 0, labelsReleased: 0,
    };
    window.__ALFL_STATS__ = stats;

    /** Runs fn and swallows any error: a failed optimisation must never break the page. */
    const attempt = (fn) => { try { return fn(); } catch { /* ignore */ } };
    /** Runs fn when the browser is idle (or on the next tick where requestIdleCallback is missing). */
    const idle = (fn, timeout = 1500) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 0));

    /* ======================================================================
     * 1. Connection warm-up
     * ====================================================================== */
    attempt(() => {
        const parent = document.head || document.documentElement;
        for (const [href, cors] of [[GQL_ORIGIN, true], [MEDIA_ORIGIN, false], ['https://fonts.googleapis.com', false], ['https://fonts.gstatic.com', true]]) {
            if (parent.querySelector(`link[rel="preconnect"][href="${href}"]`)) continue;
            const link = document.createElement('link');
            link.rel = 'preconnect';
            link.href = href;
            if (cors) link.crossOrigin = ''; // fetch() uses the anonymous pool, <img> the credentialed one
            parent.appendChild(link);
        }
    });

    /* ======================================================================
     * 2. Shared: SPA navigation hook
     * ====================================================================== */
    const navListeners = [];
    attempt(() => {
        const fire = () => navListeners.forEach(attempt);
        for (const name of ['pushState', 'replaceState']) {
            const orig = history[name];
            history[name] = function (...args) {
                const r = orig.apply(this, args);
                fire();
                return r;
            };
        }
        window.addEventListener('popstate', fire);
    });

    /* ======================================================================
     * 3. Lazy media
     *    Site choices win: an explicit loading/preload/decoding is never overwritten.
     * ====================================================================== */
    function installLazyMedia() {
        const lazify = (el) => {
            if (!el || el.nodeType !== 1) return;
            switch (el.localName) {
                case 'img':
                    if (!el.hasAttribute('loading')) el.loading = 'lazy';
                    if (!el.hasAttribute('decoding')) el.decoding = 'async';
                    break;
                case 'iframe':
                    if (!el.hasAttribute('loading')) el.loading = 'lazy';
                    break;
                case 'video':
                    if (!el.hasAttribute('preload')) el.preload = 'metadata';
                    break;
            }
        };

        // Vue builds its DOM with createElement, so this covers nearly everything.
        const nativeCreate = Document.prototype.createElement;
        Document.prototype.createElement = function (tag, options) {
            const el = nativeCreate.call(this, tag, options);
            const n = el.localName;
            if (n === 'img' || n === 'iframe' || n === 'video') { try { lazify(el); } catch { /* ignore */ } }
            return el;
        };

        // Markup that arrives as a string (activities, descriptions) bypasses createElement.
        // Cheap string test first, so the common case costs nothing.
        const MEDIA_TAG = /<(?:img|iframe|video)[\s>/]/i;
        const MEDIA_SEL = 'img:not([loading]),iframe:not([loading]),video:not([preload])';
        const lazifyTree = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return;
            lazify(root);
            for (const el of root.querySelectorAll(MEDIA_SEL)) lazify(el);
        };

        attempt(() => {
            const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
            if (!desc || !desc.set || !desc.configurable) return;
            Object.defineProperty(Element.prototype, 'innerHTML', {
                ...desc,
                set(value) {
                    desc.set.call(this, value);
                    if (typeof value === 'string' && MEDIA_TAG.test(value)) {
                        attempt(() => lazifyTree(this instanceof HTMLTemplateElement ? this.content : this));
                    }
                },
            });
        });

        attempt(() => {
            const native = Element.prototype.insertAdjacentHTML;
            Element.prototype.insertAdjacentHTML = function (position, html) {
                const r = native.call(this, position, html);
                if (typeof html === 'string' && MEDIA_TAG.test(html)) {
                    const outer = /^(?:beforebegin|afterend)$/i.test(position);
                    attempt(() => lazifyTree(outer ? this.parentNode : this));
                }
                return r;
            };
        });
    }

    /* ======================================================================
     * 4. Off-screen row skipping (content-visibility)
     *    Only repeated row-like elements. Hovered/focused rows are lifted out of
     *    containment so popovers and shadows are never clipped. The intrinsic
     *    size starts as a guess and is replaced by a measurement of rows that
     *    are really on screen; `auto` then remembers each row's true size.
     * ====================================================================== */
    const ROW_GROUPS = [
        { selector: '.medialist .entry.row',  h: 56 },
        { selector: '.medialist .entry-card', h: 220 },
        { selector: '.activity-entry',        h: 160 },
    ];

    /** Adds a stylesheet, preferring constructable sheets (no DOM node, immune to head re-renders). */
    function injectCSS(text) {
        try {
            if ('adoptedStyleSheets' in document && typeof CSSStyleSheet !== 'undefined') {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(text);
                document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
                return;
            }
        } catch { /* fall through */ }
        const style = document.createElement('style');
        style.textContent = text;
        (document.head || document.documentElement).appendChild(style);
    }

    function installRowSkipping() {
        const rules = ROW_GROUPS.map(({ selector, h }, i) => `
            ${selector} {
                content-visibility: auto;
                contain-intrinsic-height: auto var(--alfast-h${i}, ${h}px);
                overflow-clip-margin: 16px;
            }
            ${selector}:hover,
            ${selector}:focus-within {
                content-visibility: visible;
            }`).join('\n');

        // Both required, otherwise skipped rows could collapse to 0px tall.
        injectCSS(`@supports (content-visibility: auto) and (contain-intrinsic-height: auto 1px) { ${rules} }`);

        const measuredFor = ROW_GROUPS.map(() => '');
        let timers = [];

        function measure() {
            const path = location.pathname;
            const vh = window.innerHeight || document.documentElement.clientHeight;
            ROW_GROUPS.forEach(({ selector }, i) => {
                if (measuredFor[i] === path) return;
                let nodes;
                try { nodes = document.querySelectorAll(selector); } catch { return; }
                let total = 0, count = 0;
                for (const el of nodes) {
                    const r = el.getBoundingClientRect();
                    if (r.top > vh) break;
                    if (r.height > 0 && r.bottom > 0) {
                        total += r.height;
                        if (++count >= 6) break;
                    }
                }
                if (!count) return; // not rendered yet; a later attempt retries
                document.documentElement.style.setProperty(`--alfast-h${i}`, `${Math.max(1, Math.round(total / count))}px`);
                measuredFor[i] = path;
            });
        }

        // No observer needed: a few timed attempts after load / navigation catch the render.
        function schedule() {
            timers.forEach(clearTimeout);
            timers = [500, 1800, 4500].map((ms) => setTimeout(() => idle(() => { if (!document.hidden) measure(); }), ms));
        }

        navListeners.push(schedule);
        if (document.readyState !== 'loading') schedule();
        else document.addEventListener('DOMContentLoaded', schedule, { once: true });
        window.addEventListener('load', schedule, { once: true });

        let resizeTimer = 0;
        const onResize = () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { measuredFor.fill(''); schedule(); }, 200);
        };
        window.addEventListener('resize', onResize, { passive: true });
        window.addEventListener('orientationchange', onResize, { passive: true });
    }

    /* ======================================================================
     * 5. Observer coalescing
     *    A MutationObserver on the whole page whose callback declares no
     *    parameters cannot be reading the mutation records, so running it once
     *    per batch instead of once per DOM change loses nothing. (AniList Tier
     *    Labels is exactly this: it re-scans the page on every change, and its
     *    own edits trigger it again.) Observers that do read their records,
     *    such as AL Additions' shared observer, and every observer on a
     *    smaller subtree are left completely alone.
     * ====================================================================== */
    function installObserverCoalescing() {
        const Native = window.MutationObserver;
        if (typeof Native !== 'function') return;

        const states = new WeakMap();

        // `callback.length === 0` alone is not proof that the records are ignored:
        // `(...records) => ...`, `(records = []) => ...` and `arguments[0]` all report
        // length 0 yet read them. So the source must also have an empty parameter list
        // and never mention `arguments`. Bound/native functions stringify as an empty
        // list and are treated as eligible, as before.
        const ignoresRecords = (fn) => {
            if (typeof fn !== 'function' || fn.length !== 0) return false;
            try {
                const src = Function.prototype.toString.call(fn);
                if (/\barguments\b/.test(src)) return false;
                const params = /^[^(]*\(([^)]*)\)/.exec(src);
                return !params || params[1].trim() === '';
            } catch { return false; }
        };

        const isPageRoot = (t) => t === document || t === document.documentElement || t === document.body;

        // The first change after a quiet moment runs the callback on the next task, so
        // badges and similar decorations show up with the content rather than a few
        // hundred ms later. During a burst, runs are at least observerBatchMs apart,
        // counted from the END of the previous run so a slow callback cannot hog the
        // thread, and the last change of a burst always gets a final run.
        function schedule(st) {
            if (st.timer) return;
            const wait = Math.max(0, st.last + CFG.observerBatchMs - performance.now());
            st.timer = setTimeout(() => {
                st.timer = 0;
                if (!st.queue.length) return;
                const records = st.queue.splice(0);
                stats.observerBatches++;
                stats.observerRecordsMerged += records.length;
                try { st.callback.call(st.self, records, st.self); }
                catch (e) { setTimeout(() => { throw e; }); } // still reported, just not inside our timer
                st.last = performance.now();
            }, wait);
        }

        class CoalescedMutationObserver extends Native {
            constructor(callback) {
                const st = { callback, eligible: ignoresRecords(callback), on: false, queue: [], timer: 0, last: -Infinity, self: null };
                super(typeof callback === 'function'
                    ? (records) => {
                        if (!st.on) return callback.call(st.self, records, st.self);
                        for (const r of records) st.queue.push(r);
                        schedule(st);
                    }
                    : callback);
                st.self = this;
                states.set(this, st);
            }
            observe(target, options) {
                const st = states.get(this);
                if (st && st.eligible && options && options.subtree && isPageRoot(target)) st.on = true;
                return super.observe(target, options);
            }
            disconnect() {
                const st = states.get(this);
                if (st) { st.queue.length = 0; st.on = false; } // a later observe() decides again
                return super.disconnect();
            }
            takeRecords() {
                const st = states.get(this);
                const pending = super.takeRecords();
                return st ? st.queue.splice(0).concat(pending) : pending;
            }
        }

        Object.defineProperty(window, 'MutationObserver', { value: CoalescedMutationObserver, writable: true, configurable: true });
    }

    /* ======================================================================
     * 6. Cheap innerText
     *    Reading innerText forces a synchronous layout. A script that reads it
     *    for many elements while also writing to the DOM (Tier Labels reads
     *    the label of every stat block on every scan) makes the browser lay the
     *    page out over and over. For childless score/label elements the visible
     *    text is just their text content, so that is returned instead. Anything
     *    else keeps the native behaviour.
     * ====================================================================== */
    function installFastInnerText() {
        const proto = HTMLElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'innerText');
        if (!desc || !desc.get || !desc.configurable) return;
        const LEAF = '.score, .value, .type, .percentage';
        Object.defineProperty(proto, 'innerText', {
            ...desc,
            get() {
                try {
                    if (this.childElementCount === 0 && this.matches(LEAF)) {
                        return this.textContent.replace(/\s+/g, ' ').trim();
                    }
                } catch { /* fall through */ }
                return desc.get.call(this);
            },
        });
    }

    /* ======================================================================
     * 7. Selector probe memo
     *    Tier Labels calls container.querySelector('.medialist.table.POINT_100')
     *    (then POINT_10_DECIMAL, POINT_5) once per score element. On a page
     *    that is not in that format the probe fails only after scanning the
     *    whole list, 600 times over. Within one task (cleared by a microtask)
     *    the answer for the same element and the same probe cannot change in
     *    any way that matters, so it is computed once. Only selectors that start
     *    with '.medialist.table.POINT_' are touched.
     * ====================================================================== */
    function installProbeMemo() {
        const native = Element.prototype.querySelector;
        let memo = null;
        Element.prototype.querySelector = function querySelector(sel) {
            if (typeof sel === 'string' && sel.charCodeAt(0) === 46 && sel.startsWith('.medialist.table.POINT_')) {
                if (!memo) { memo = new WeakMap(); queueMicrotask(() => { memo = null; }); }
                let perEl = memo.get(this);
                if (!perEl) memo.set(this, perEl = new Map());
                if (perEl.has(sel)) { stats.probesShared++; return perEl.get(sel); }
                const r = native.call(this, sel);
                perEl.set(sel, r);
                return r;
            }
            return native.call(this, sel);
        };
    }

    /* ======================================================================
     * 7b. Tier Labels support
     *    (a) blockTierInData: Tier Labels skips any element carrying
     *    data-tier-modified, so marking the Average/Mean Score values up front leaves
     *    AniList's own text untouched. (Tier Labels' "refresh" on the developer
     *    settings page clears the marker; a reload restores the blocking.)
     *    (b) tierAssist: Tier Labels marks a score as done the first time it sees it
     *    and never looks again. When the framework later patches that row in place
     *    (sort, filter, edit) it updates a text node Tier Labels already detached, so
     *    the row keeps a stale badge, or none. A moment after the page changes, any
     *    list score whose badge is missing or shows an old value is released, and a
     *    throwaway comment on <body> wakes Tier Labels (it listens for child changes,
     *    not attribute changes) to rebuild it from the current `score` attribute.
     *    Each element is released at most twice, so nothing can loop.
     *    This observer takes its records, so observer coalescing never batches it.
     * ====================================================================== */
    function installTierSupport() {
        const DATA_VALUE = '.data .data-set .value';
        const mark = (node) => {
            if (!node || node.nodeType !== 1) return;
            if (node.matches(DATA_VALUE)) node.dataset.tierModified = 'true';
            if (node.firstElementChild) for (const el of node.querySelectorAll(DATA_VALUE)) el.dataset.tierModified = 'true';
        };

        const DONE_SCORE = '.medialist .score[data-tier-modified]';
        const releases = new WeakMap();
        let sweepTimer = 0;

        // Tier Labels' badge is <div><span>score</span><span>tier</span></div> inside the score element.
        const needsBadge = (el) => {
            const attr = el.getAttribute('score');
            if (!attr || !(parseFloat(attr) > 0)) return false;
            const badge = el.firstElementChild;
            return !badge || (badge.firstElementChild?.textContent || '').trim() !== attr.trim();
        };

        function sweep() {
            sweepTimer = 0;
            if (document.hidden) return; // re-checked when the tab becomes visible
            let released = 0;
            for (const el of document.querySelectorAll(DONE_SCORE)) {
                const n = releases.get(el) || 0;
                if (n >= 2 || !needsBadge(el)) continue;
                releases.set(el, n + 1);
                delete el.dataset.tierModified;
                released++;
            }
            if (!released || !document.body) return;
            stats.labelsReleased += released;
            const wake = document.createComment('');
            document.body.appendChild(wake);
            wake.remove();
        }
        const scheduleSweep = () => { if (!sweepTimer) sweepTimer = setTimeout(() => attempt(sweep), CFG.tierAssistMs); };

        const observer = new MutationObserver((records) => {
            if (CFG.blockTierInData) {
                for (const r of records) {
                    for (const n of r.addedNodes) {
                        try { mark(n); } catch { /* ignore */ }
                    }
                }
            }
            if (CFG.tierAssist) scheduleSweep();
        });
        // `score` attribute changes matter because a patched row changes that, not its children.
        observer.observe(document, CFG.tierAssist
            ? { childList: true, subtree: true, attributes: true, attributeFilter: ['score'] }
            : { childList: true, subtree: true });
        if (CFG.tierAssist) document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSweep(); });
        if (CFG.blockTierInData) attempt(() => mark(document.documentElement));
    }

    /* ======================================================================
     * 8. GraphQL layer: cache, de-duplication, stale-on-error, prefetch
     *
     *  - Only POSTs to graphql.anilist.co with a plain string JSON body.
     *  - Anything mentioning `mutation` is never cached and wipes the cache
     *    (before it is sent and again when it settles). Responses that were in
     *    flight during a mutation are discarded.
     *  - Notification and activity queries are volatile: never cached.
     *  - Identical query + variables + login within gqlTtl reuse one response;
     *    simultaneous identical requests are merged.
     *  - Only HTTP 200 responses without GraphQL errors are stored. Rate-limit headers
     *    are never replayed from a stored copy.
     *  - A failed refresh (network error, 429, 5xx) falls back to a copy no
     *    older than gqlStaleTtl. Other 4xx responses are never masked.
     *  - Prefetch replays the queries a page type used, for the page you are
     *    about to open. The learned queries are saved (without the login token)
     *    so a fresh load can start them at document-start (early start).
     * ====================================================================== */
    function installGraphQLLayer() {
        const nativeFetch = window.fetch.bind(window);

        const store = new Map();     // key -> { time, size, snap }, oldest first
        const inflight = new Map();  // key -> Promise<snap>
        let bytes = 0;
        let epoch = 0;               // bumped by mutations
        let pausedUntil = 0;         // set after a 429
        let prefetching = false;

        /* ------------------------- helpers ------------------------- */

        const isGraphQL = (u) => {
            try { return new URL(u, location.href).origin === GQL_ORIGIN; } catch { return false; }
        };

        const SKIP_HEADERS = /^(?:content-encoding|content-length|transfer-encoding)$/i;
        // Rate-limit headers describe one specific request. Other scripts read them to pace
        // themselves (AL Additions does), so a replayed copy must not carry old values, and a
        // stale copy served after a 429/5xx must carry the live ones so they still back off.
        const RATE_HEADERS = /^(?:retry-after|x-ratelimit-.+)$/i;
        function toResponse(snap, live) {
            const headers = new Headers(snap.headers);
            if (live) for (const [k, v] of live.headers.entries()) if (RATE_HEADERS.test(k)) headers.set(k, v);
            return new Response(snap.buf, { status: snap.status, statusText: snap.statusText, headers });
        }

        // Makes a shared promise obey this caller's own AbortSignal.
        function abortable(promise, signal) {
            if (!signal) return promise;
            return new Promise((resolve, reject) => {
                const fail = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                if (signal.aborted) return fail();
                signal.addEventListener('abort', fail, { once: true });
                const done = () => signal.removeEventListener('abort', fail);
                promise.then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
            });
        }

        function clearAll() {
            epoch++;
            store.clear();
            inflight.clear();
            bytes = 0;
        }

        function evict() {
            const now = Date.now();
            for (const [key, entry] of store) {
                if (now - entry.time > CFG.gqlStaleTtl) { bytes -= entry.size; store.delete(key); }
            }
            if (bytes <= CFG.gqlMaxBytes) return;
            for (const [key, entry] of store) {
                bytes -= entry.size;
                store.delete(key);
                if (bytes <= CFG.gqlMaxBytes) break;
            }
        }

        function put(key, snap) {
            const old = store.get(key);
            if (old) { bytes -= old.size; store.delete(key); } // re-insert so Map order stays oldest-first
            const size = snap.buf.byteLength;
            if (size > CFG.gqlMaxEntryBytes) return;
            store.set(key, { time: Date.now(), size, snap });
            bytes += size;
            evict();
        }

        function parseBody(body) {
            try {
                const parsed = JSON.parse(body);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.query === 'string' ? parsed : null;
            } catch { return null; }
        }

        // Deliberately broad: a false positive only skips the cache, a false
        // negative could replay a stale mutation result.
        const isMutation = (parsed) => /\bmutation\b/i.test(String(parsed.query).replace(/#[^\n\r]*/g, ' '));
        // Substring match on purpose: catches unreadNotificationCount, ListActivity, activities...
        const isVolatile = (parsed) => /notification|activit/i.test(parsed.query);
        const noStore = (d) => d.cache === 'no-store' || d.cache === 'reload' || !!d.headers.get('cache-control')?.toLowerCase().includes('no-store');

        // GraphQL puts a top-level "errors" key first or last, so only the ends of the
        // body are checked (parsing a multi-MB response just to look would defeat the
        // cache). The window is generous because a long errors array pushes its key
        // far from the end. A false positive only skips caching.
        const decoder = new TextDecoder();
        const ERROR_SCAN_BYTES = 2048;
        function hasGraphQLErrors(buf) {
            const view = new Uint8Array(buf);
            const head = decoder.decode(view.subarray(0, ERROR_SCAN_BYTES));
            const tail = view.length > ERROR_SCAN_BYTES ? decoder.decode(view.subarray(view.length - ERROR_SCAN_BYTES)) : '';
            return /"errors"\s*:/.test(head) || /"errors"\s*:/.test(tail);
        }

        const makeKey = (d) => [
            d.headers.get('authorization') || '', d.headers.get('accept') || '',
            d.url, d.method, d.credentials || '', d.mode || '', d.body,
        ].join('\u0001');

        const note429 = (res) => { if (res.status === 429) pausedUntil = Date.now() + 60_000; };

        /* --------------------- route learning ---------------------- */

        const sameId = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase());
        // Case-sensitive suffix on purpose, so `grid`/`valid` don't count.
        const isIdKey = (key) => /^(?:id|name|userName|username)$|Id$/.test(key);

        // Pages with no id in the URL whose queries only depend on the URL itself.
        const STATIC_ROUTE = /^\/(?:home|search\/(?:anime|manga))\/?$/;

        function parseRoute(path, search = '') {
            const parts = path.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
            if (['anime', 'manga', 'character', 'staff', 'studio'].includes(parts[0]) && /^\d+$/.test(parts[1] || '')) {
                return { shape: `${parts[0]}/${parts[3] || ''}`, id: Number(parts[1]) };
            }
            if (parts[0] === 'user' && parts[1]) return { shape: `user/${parts[2] || ''}`, id: parts[1] };
            if (STATIC_ROUTE.test(path)) return { shape: `static:${path.replace(/\/$/, '')}${search}`, id: null, static: true };
            return null;
        }
        const here = () => parseRoute(location.pathname, location.search);

        function hasPageId(value, id) {
            if (!value || typeof value !== 'object') return false;
            return Object.keys(value).some((key) => {
                const x = value[key];
                if (x && typeof x === 'object') return hasPageId(x, id);
                return isIdKey(key) && sameId(x, id);
            });
        }

        function replacePageId(value, from, to) {
            if (!value || typeof value !== 'object') return 0;
            let count = 0;
            for (const key of Object.keys(value)) {
                const x = value[key];
                if (x && typeof x === 'object') count += replacePageId(x, from, to);
                else if (isIdKey(key) && sameId(x, from)) { value[key] = to; count++; }
            }
            return count;
        }

        // shape -> { route, reqs, t }. Each req: { url, body, headers (no authorization), auth, credentials, mode }.
        // `auth` means the site sent `Bearer <window.al_token>`; the token itself is never kept.
        const learned = new Map();
        const ROUTES_KEY = 'alfl:routes:v1';
        const ROUTES_TTL = 30 * 86400e3;

        let persistTimer = 0;
        const persistRoutes = () => {
            clearTimeout(persistTimer);
            persistTimer = setTimeout(() => attempt(() => {
                const out = {};
                for (const [shape, v] of [...learned].slice(-40)) out[shape] = { t: v.t, id: v.route.id, static: !!v.route.static, reqs: v.reqs };
                localStorage.setItem(ROUTES_KEY, JSON.stringify(out));
            }), 1000);
        };

        function loadRoutes() {
            attempt(() => {
                const raw = localStorage.getItem(ROUTES_KEY);
                if (!raw) return;
                const now = Date.now();
                for (const [shape, v] of Object.entries(JSON.parse(raw))) {
                    if (!v || !Array.isArray(v.reqs) || typeof v.t !== 'number' || now - v.t > ROUTES_TTL) continue;
                    const reqs = v.reqs.filter((r) => r && typeof r.body === 'string' && typeof r.url === 'string' && isGraphQL(r.url) && r.headers && typeof r.headers === 'object');
                    if (reqs.length) learned.set(shape, { route: { shape, id: v.id, static: !!v.static }, reqs, t: v.t });
                }
            });
        }

        let learning = { key: '', started: 0, route: null, reqs: [] };

        // Called on every cacheable query, so SPA navigations are always noticed.
        function refreshLearning() {
            const key = location.pathname + (STATIC_ROUTE.test(location.pathname) ? location.search : '');
            if (learning.key === key) return;
            learning = { key, started: 0, route: here(), reqs: [] };
        }

        function rememberQuery(desc, parsed) {
            refreshLearning();
            if (!(CFG.prefetch || CFG.earlyStart) || prefetching || !learning.route) return;
            // The window opens at the page's first query, so a slow bundle doesn't eat it.
            if (!learning.started) learning.started = Date.now();
            if (Date.now() - learning.started > CFG.learnWindowMs) return;
            if (learning.reqs.length >= CFG.learnMaxReqs) return;
            if (!learning.route.static && !hasPageId(parsed.variables, learning.route.id)) return;
            // Only requests that re-serialise byte-for-byte, so a replay looks exactly like the site's own.
            if (JSON.stringify(parsed) !== desc.body) return;

            const headers = Object.fromEntries(desc.headers.entries());
            const authValue = headers.authorization;
            delete headers.authorization;
            let auth = false;
            if (authValue !== undefined) {
                // Only the exact `Bearer <al_token>` form can be rebuilt later; anything else is not replayed.
                if (!window.al_token || authValue !== `Bearer ${window.al_token}`) return;
                auth = true;
            } else if (window.al_token) {
                return; // logged in but anonymous: not the site's own request (e.g. another userscript's query)
            }
            learning.reqs.push({ url: desc.url, body: desc.body, headers, auth, credentials: desc.credentials, mode: desc.mode });
            learned.delete(learning.route.shape); // re-insert so Map order == recency (persist keeps the newest 40)
            learned.set(learning.route.shape, { route: learning.route, reqs: [...learning.reqs], t: Date.now() });
            persistRoutes();
        }

        /* ---------------------- fetch wrapper ---------------------- */

        // Everything that can throw happens here, before any network call, so a
        // failure falls back to a single untouched native fetch. Cheap
        // rejections come first because this runs for every fetch() the site makes.
        function classify(input, init) {
            const isRequest = input instanceof Request;
            const method = String(init?.method || (isRequest ? input.method : 'GET')).toUpperCase();
            if (method !== 'POST') return null;

            const url = isRequest ? input.url : (input instanceof URL ? input.href : String(input));
            if (!isGraphQL(url)) return null;

            // A Request's own body can't be read synchronously; only a plain string body is handled.
            const body = init?.body ?? null;
            if (typeof body !== 'string') return null;

            const parsed = parseBody(body);
            if (!parsed) return null;

            const desc = {
                url, method, body,
                headers: new Headers(init?.headers ?? (isRequest ? input.headers : undefined)),
                credentials: init?.credentials ?? (isRequest ? input.credentials : undefined),
                mode: init?.mode ?? (isRequest ? input.mode : undefined),
                cache: init?.cache ?? (isRequest ? input.cache : undefined),
            };
            return { desc, parsed, mutation: isMutation(parsed), bypass: isVolatile(parsed) || noStore(desc) };
        }

        function cachedFetch(job, input, init) {
            const { desc, parsed } = job;
            // Already cancelled: let the browser fail it the way it normally would.
            if (init?.signal?.aborted) return nativeFetch(input, init);
            attempt(() => rememberQuery(desc, parsed));

            const key = makeKey(desc);
            const now = Date.now();
            const cached = store.get(key);

            if (cached && now - cached.time < CFG.gqlTtl) {
                stats.cacheHits++;
                return Promise.resolve(toResponse(cached.snap));
            }

            const flying = inflight.get(key);
            if (flying) {
                stats.deduped++;
                return abortable(flying.then((snap) => toResponse(snap), () => nativeFetch(input, init)), init?.signal);
            }

            const myEpoch = epoch;
            const stale = cached && now - cached.time < CFG.gqlStaleTtl ? cached.snap : null;
            const original = nativeFetch(input, init);

            const snapshot = original.then(async (res) => {
                note429(res);
                if (res.status !== 200) throw new Error('not cacheable');
                const copy = res.clone(); // cloned before the page reads the body
                const buf = await copy.arrayBuffer();
                if (hasGraphQLErrors(buf)) throw new Error('graphql errors');
                return {
                    buf,
                    status: res.status,
                    statusText: res.statusText,
                    headers: [...res.headers.entries()].filter(([k]) => !SKIP_HEADERS.test(k) && !RATE_HEADERS.test(k)),
                };
            });

            inflight.set(key, snapshot);
            snapshot.then(
                (snap) => {
                    if (inflight.get(key) === snapshot) inflight.delete(key);
                    if (epoch === myEpoch) put(key, snap);
                },
                () => { if (inflight.get(key) === snapshot) inflight.delete(key); }
            );

            if (!stale) return original; // the page gets the untouched, original response

            return original.then(
                (res) => {
                    if (res.status === 429 || res.status >= 500) { stats.staleServed++; return toResponse(stale, res); }
                    return res;
                },
                (err) => {
                    // A request the page cancelled stays cancelled; stale data would hand it an answer for a page it has left.
                    if (init?.signal?.aborted || err?.name === 'AbortError') throw err;
                    stats.staleServed++;
                    return toResponse(stale);
                }
            );
        }

        window.fetch = function fetch(input, init) {
            let job = null;
            try { job = classify(input, init); } catch { /* fall back to native */ }
            if (!job) return nativeFetch(input, init);
            stats.graphqlRequests++;

            if (job.mutation) {
                clearAll();
                const p = nativeFetch(input, init);
                p.then((res) => { note429(res); clearAll(); }, () => clearAll());
                return p;
            }
            if (job.bypass) {
                const p = nativeFetch(input, init);
                p.then(note429, () => {});
                return p;
            }
            return cachedFetch(job, input, init);
        };

        /* ==================================================================
         * Replaying learned queries: navigation prefetch and early start
         * ================================================================== */

        // A stale cache must never outlive an edit made in another tab or by a script
        // whose requests do not pass through this wrapper.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) clearAll(); });

        const prefetched = new Map(); // `${shape}|${id}` -> time
        const stamps = [];            // request timestamps for the per-minute budget
        let dwellTimer = 0;

        function waitForToken(cb) {
            let tries = 0;
            const t = setInterval(() => {
                if (window.al_token) { clearInterval(t); cb(); }
                else if (++tries > 300) clearInterval(t); // 3 s
            }, 10);
        }

        // Sends the learned requests of `known` for `route`; returns how many were started.
        function replayRoute(known, route) {
            let sent = 0;
            for (const request of known.reqs) {
                let parsed;
                try { parsed = JSON.parse(request.body); } catch { continue; }
                if (isMutation(parsed) || isVolatile(parsed)) continue;
                if (!known.route.static && !replacePageId(parsed.variables, known.route.id, route.id)) continue;
                const body = JSON.stringify(parsed);

                const send = () => {
                    const headers = { ...request.headers };
                    if (request.auth) headers.authorization = `Bearer ${window.al_token}`;
                    prefetching = true; // keeps our own replay out of route learning
                    try {
                        window.fetch(request.url, { method: 'POST', headers, body, credentials: request.credentials, mode: request.mode }).catch(() => {});
                    } catch { /* ignore */ }
                    prefetching = false;
                };
                stamps.push(Date.now());
                sent++;
                if (request.auth && !window.al_token) waitForToken(send); else send();
            }
            return sent;
        }

        // On a fresh load, start the page's queries before the site's bundle has even run.
        // The site's identical request later joins this one (or hits the cache).
        if (CFG.earlyStart) {
            loadRoutes();
            attempt(() => {
                if (navigator.connection?.saveData) return;
                const route = here();
                const known = route && learned.get(route.shape);
                if (known) stats.earlyStarts += replayRoute(known, route);
            });
        } else if (CFG.prefetch) {
            loadRoutes();
        }

        if (!CFG.prefetch) return;

        function prefetchFor(anchor) {
            const now = Date.now();
            if (document.hidden || now < pausedUntil || navigator.connection?.saveData) return;

            let url;
            try { url = new URL(anchor.href, location.href); } catch { return; }
            if (url.origin !== location.origin) return;

            const route = parseRoute(url.pathname, url.search);
            if (!route || route.static) return;
            const known = learned.get(route.shape);
            if (!known || known.route.static) return;
            if (typeof known.route.id !== typeof route.id || sameId(known.route.id, route.id)) return;

            const current = here();
            if (current && current.shape === route.shape && sameId(current.id, route.id)) return; // already there

            const key = `${route.shape}|${String(route.id).toLowerCase()}`;
            if (now - (prefetched.get(key) || 0) < CFG.gqlTtl) return;

            while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
            if (prefetched.size > 200) {
                for (const [k, t] of prefetched) if (now - t > CFG.gqlTtl) prefetched.delete(k);
            }
            if (stamps.length + known.reqs.length > CFG.prefetchMaxPerMin) return;

            const sent = replayRoute(known, route);
            if (sent) { prefetched.set(key, now); stats.prefetched += sent; }
        }

        const linkOf = (event) => event.target?.closest?.('a[href]') || null;
        const opts = { capture: true, passive: true };

        document.addEventListener('pointerover', (event) => {
            if (event.pointerType !== 'mouse') return;
            const anchor = linkOf(event);
            clearTimeout(dwellTimer);
            if (anchor) dwellTimer = setTimeout(() => prefetchFor(anchor), CFG.prefetchDwellMs);
        }, opts);
        document.addEventListener('pointerout', () => clearTimeout(dwellTimer), opts);
        // Touch has no hover: start as soon as the finger / button goes down.
        document.addEventListener('pointerdown', (event) => {
            const anchor = linkOf(event);
            if (anchor) prefetchFor(anchor);
        }, opts);
    }

    /* ======================================================================
     * Start
     * ====================================================================== */
    if (CFG.coalesceObservers) attempt(installObserverCoalescing);
    if (CFG.fastInnerText) attempt(installFastInnerText);
    if (CFG.memoSelectorProbes) attempt(installProbeMemo);
    if (CFG.blockTierInData || CFG.tierAssist) attempt(installTierSupport);
    if (CFG.lazyMedia) attempt(installLazyMedia);
    if (CFG.rowSkipping) attempt(installRowSkipping);
    if (CFG.gqlTtl > 0 && typeof window.fetch === 'function') attempt(installGraphQLLayer);
})();