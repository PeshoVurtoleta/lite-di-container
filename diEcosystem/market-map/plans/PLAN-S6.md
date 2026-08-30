# Session 6 -- Tests, seams, CI

## 1. SPEC

Make `bootKernel` (`kernel.js:365`) headless-bootable by injecting its two hard imports -- `createSocketFactory` (`kernel.js:24`) and `@zakkster/lite-gl/backend` (`kernel.js:26`) -- as defaulted parameters, then prove the demo with `node:test` only, a `lite-leak` retention gate, and a CI workflow whose Pages deploy (S1) is gated on tests.

Acceptance gate (measurable): from a clean clone, `npm ci && npm test && npm run torture` in `market-map/` exits 0 on every matrix node; `MM_TORTURE_BREAK=1 npm run torture` exits non-zero. Both are CI jobs, so a green badge means both held.

## 2. TASKS

1. **`market-map/package.json`** (new; `"private": true`, `"type": "module"`). Deps = the 12 runtime packages pinned to the *same exact versions* as the S1 import map (`index.html` import map is the source of truth); devDeps `@zakkster/lite-leak`, `@zakkster/lite-gc-profiler` (mirroring `LiteDiContainer/package.json:60-63`). Scripts: `test: node --test test/*.test.js`, `torture: node --expose-gc test/torture.mjs`, `verify: npm test && npm run torture`.
2. **`kernel.js:26` -> cold path.** Delete the static `lite-gl/backend` import; add `async function defaultGlSinks(gl)` doing `await import('@zakkster/lite-gl/backend')` and returning `{point, quad}`. Nothing in the hot body changes -- `GLRenderer.draw` (`kernel.js:272`) still reads `v.glSink` / `v.glQuadSink`.
3. **`kernel.js:365` `bootKernel` signature** -> `{ctx, gl, w, h, onEvent, onMode, socketFactory = createSocketFactory, glSinks = defaultGlSinks, now = Date.now, setTimer = setInterval, clearTimer = clearInterval}`. Rationale line in the header comment: *pure DI applied to the DI demo*.
4. **`kernel.js:371-379`** -> guard becomes `if (gl && ctx)`; `ctx: null` skips sink construction entirely. `RenderSystem.update` (`kernel.js:354`) already returns on `!v.ctx`, so headless render is a no-op with zero new branches; assert that in a comment, do not add a second flag.
5. **`kernel.js:398`** -> `const {createSocket} = socketFactory(rx.registry);`. Nothing else in `makeSocket` (`kernel.js:400-412`) moves.
6. **`kernel.js:494`** -> `tpsTimer = setTimer(...)`; call `.unref?.()` so a headless boot never holds the node:test event loop open; `stop()` (`kernel.js:547`) uses `clearTimer`.
7. **`kernel.js:500`** -> handle gains `shutdown()` (calls `stop()` then `c.shutdown()`, returns the container's teardown result) and `_c: c`, `_bus: bus`, `_sup: sup` under an explicit "test seam" comment. S3's Shutdown button consumes the same method.
8. **`kernel.js:40` `parseFrame` + `kernel.js:50` `OrderBook` + `LVL`/`RING`** -> add `export` so tests import them without booting. No behavior change.
9. **Break control (cold path only).** Read `MM_TORTURE_BREAK` once at boot, beside `refs` (`kernel.js:134`); when armed, register `LeakyTapeApply` (pushes `t` into a module-scope array) *instead of* `TapeApply` at the `bus.on` call (`kernel.js:394`). No `if (BREAK)` inside any `handle()` -- the hot body is byte-identical when disarmed.
10. **`test/fixtures/frames.json`** -- formalize S2's seven captures: bookTicker, depth20, aggTrade, combined `{stream,data}` wrapper, local feed-server shape, `sim://random-walk` shape, garbage.
11. **`test/parse.test.js`** -- asserts each fixture yields its tag (QUOTE/DEPTH/TRADE), garbage yields `null` (fail closed, never throws), and the scratch object per tag is reference-stable across 1000 parses.
12. **`test/book.test.js`** -- `OrderBook.apply` over the captured depth20 payload: 20 bid + 20 ask levels land in the `Float32Array`s, bids strictly descending, asks strictly ascending, no `sin/cos` residue, and the four typed arrays keep the same `.buffer` identity across 10k applies.
13. **`test/heal.test.js`** -- scripted fake `socketFactory`: boot headless, `sup.reportFault('feed')`, assert `restarts === 1`, assert the factory was called a 2nd time (fresh socket), assert socket #1 `disposed === true` and socket #2 `disposed === false`, via the `onTeardown('feed')` path (`kernel.js:426`).
14. **`test/teardown.test.js`** -- boot headless, resolve `viz,tape,book,agg,feed` in that order, patch `console.*`, `shutdown()`, assert the teardown log array is exactly the reverse of the resolve order and the console capture is length 0.
15. **`test/scope-churn.test.js`** -- 256 open/close symbol-scope cycles headless (S3's `app.scope()`), wrapped in `lite-leak`'s tracker; run under `--expose-gc`.
16. **`test/feed-server.test.js`** -- import `textFrame` (add `export` at `feed-server.mjs:16`): assert header bytes for payload lengths 125 (2-byte header), 126 and 65535 (4-byte, `126` marker), 65536 (10-byte, `127` marker, big-endian split at `feed-server.mjs:26-27`); assert the close-opcode branch (`feed-server.mjs:63`) clears the interval and ends the socket exactly once.
17. **`test/torture.mjs`** -- lite-leak + lite-gc-profiler harness: 5000 headless bus emits, retention gate + `maxMajor`/bytes-per-op budget; prints a gate line (no output = FAIL).
18. **`.github/workflows/ci.yml`** -- `test` (matrix node 20/22/24, `npm ci`, `npm test`), `leak` (node 22, `--expose-gc` torture), `break-gate` (runs torture with `MM_TORTURE_BREAK=1`, **fails if exit code is 0**), then S1's `pages` job with `needs: [test, leak, break-gate]`.
19. **Badges** -- CI badge in `market-map/README.md` line 2 and in the container `README.md` ecosystem/demo section.

## 3. ASSERTIONS

1. `npm test` runs 6 files, all pass, on node 20/22/24; total wall time under 30 s per matrix leg.
2. `MM_TORTURE_BREAK=1 npm run torture` exits **non-zero** and names the retained handler; unarmed exits **0**. The workflow inverts the armed run, so a break control that stops breaking turns CI red.
3. `test/teardown.test.js`: teardown order equals the exact reverse of the 5-token resolve order (deep-equal on the array) **and** the console capture has `length === 0`.
4. `test/scope-churn.test.js`: after 256 open/close cycles + 3 forced GCs, `tracker.size() === 0` (exact), and no scope is retained (non-vacuous: the gate is proven by a deliberately-leaking control scope in the same file that makes `size()` return 1).
5. `test/torture.mjs`: 5000 emits -> `maxMajor 0`, bytes-per-op `<= 8`, `maxPauseMs <= 2`.
6. `test/feed-server.test.js`: header lengths are exactly 2/4/4/10 bytes for payloads 125/126/65535/65536.

## 4. CROSS-SESSION DEPENDENCIES

- **S1 consumed:** the pinned import map in `index.html` is the version source for `market-map/package.json`; S1's Pages job is edited here to add `needs: [test, leak, break-gate]`. If S1 has not landed, task 18 creates `ci.yml` with the test jobs only and leaves a named `pages:` placeholder.
- **S2 consumed:** `parseFrame` and its 7 fixtures. Seam = `export function parseFrame` (`kernel.js:40`) + `test/fixtures/frames.json`.
- **S3 consumed:** `app.scope()` for task 15, `handle.shutdown()` for task 14, and finding 12 (`refs.stats` at `kernel.js:134` moved into the container) -- **hard prerequisite**: with a module singleton, two headless boots share cron counters and tasks 13-15 are non-deterministic in parallel.
- **S8/S9 reuse:** the same `test/torture.mjs` harness and the 256-scope churn gate become the base for the SymbolVM gate (S8) and the 4096-cycle park/revive gate (S9). Seams they inherit: `bootKernel({ctx: null, socketFactory})`, `handle._c`, the lite-leak tracker wrapper.

## 5. RISKS/OPEN

- **`ctx: null` cleanliness.** The GL skip must be one cold-path guard at `kernel.js:371`; `RenderSystem.update` already short-circuits on `!v.ctx` (`kernel.js:354`). Open: whether headless should also skip `ticker.system('render', ...)` (`kernel.js:436`) -- recommend **no**, keeping the ticker registered is exactly what makes the teardown-order test meaningful.
- **Node has no `WebSocket` before v22 and no `document`.** Tests must never construct the default `socketFactory`; every headless boot passes the scripted fake. Matrix starts at node 20 for that reason (`engines` in the container is `>=18`, but the demo is not published -- state that in `package.json`).
- **Version drift** between the esm.sh import map and `node_modules`: two pin sites, one truth. Mitigation: a 7th tiny test asserting each `dependencies` version string appears verbatim in `index.html`'s import map.
- **Vacuous leak gate** (the known ecosystem failure mode): assertion 4's deliberately-leaking control scope is not optional -- without it the retention check is a tautology.
