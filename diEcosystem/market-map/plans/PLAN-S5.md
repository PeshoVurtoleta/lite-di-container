# Session 5 -- The observability panel

## 1. SPEC

**Goal.** Make the zero-GC / self-healing claims measurable on screen: a Perf group in the HUD (fps, frame p99, worst frame, long tasks, ring occupancy, uptime, restarts, optional heap), a `Burst x100` stress button that pumps synthetic ticks straight into the bus, three downloadable `lite-di-graph` exports, and a self-narrating soak line in the footer.

**Acceptance gate (measured, recorded).** 10-minute Binance soak, desktop Chrome, GPU mode:
- long-task count `0` for entries > 50 ms after a 30 s warm-up (warm-up entries logged separately, not hidden);
- browser Task Manager JS memory delta over minutes 2..10 within +/- 5 MB (flat);
- fps / p99 / worst / uptime / restarts all visible and updating in the panel;
- numbers transcribed verbatim into the S7 README perf table (fps, p99 idle, p99 under burst, worst frame, long tasks, tps idle, tps burst).

## 2. TASKS

Ordered. `[HOT]` = touches the per-frame body.

1. **`kernel.js:28` -- add perf constants.** `const PERF_RING = 1024;` (pow2, bitmask wrap, house pattern -- the roadmap's 600-sample window is read as the newest 600 out of it), `const PERF_WINDOW = 600;`, `const HIST_BUCKETS = 512;`, `const HIST_MS = 0.25;` (0..128 ms, clamp-to-last). ASCII comment stating the window/resolution.

2. **`kernel.js` -- `class PerfCounters` (new, after `LabelCache` at :172).** All state preallocated in the constructor: `this.d = new Float32Array(PERF_RING)`, `this.head = 0`, `this.filled = 0`, `this.hist = new Uint32Array(HIST_BUCKETS)`, plus scalars `frames`, `worst`, `p99`, `fps`, `lastTime`, `longTasks` (init `-1` = unsupported until the observer is proven), `longWorst`, `heapMB` (init `null`), `bootAt`. No object literals, no arrays, no closures held.
   - `[HOT]` `sample(time)` -- one branch on `Number.isFinite(time)` (fail closed: a non-finite timestamp is skipped, not recorded as 0), `const dt = time - this.lastTime`, `this.lastTime = time`, `this.d[this.head] = dt`, `this.head = (this.head + 1) & (PERF_RING - 1)`, `if (this.filled < PERF_RING) this.filled++`, `if (dt > this.worst) this.worst = dt`, `this.frames++`. Nine scalar ops, zero allocation, no `Math.*` call.
   - `computeP99()` **(1 Hz, cold)** -- `this.hist.fill(0)`; walk backwards `n = Math.min(this.filled, PERF_WINDOW)` samples from `head`, bucket `b = (dt / HIST_MS) | 0` clamped to `HIST_BUCKETS - 1`, increment; scan cumulative to `ceil(n * 0.99)`; `this.p99 = (b + 1) * HIST_MS`; `this.fps = this.frames; this.frames = 0`. **No sort, no comparator, no scratch array** -- a histogram is the only percentile that is provably alloc-free. Deliberate: 0.25 ms bucket resolution is stated in the HUD legend.

3. **`kernel.js` -- `class PerfSystem` (new).** `constructor(perf) { this.perf = perf; }`, `[HOT]` `update(dt, time) { this.perf.sample(time); }`. Registered in the **`post`** lane so it measures the frame after `RenderSystem` (`kernel.js:436`): `ticker.system('perf', PerfSystem, {lane: 'post', deps: ['perf']})`. Keeping it a separate system, not an added branch inside `RenderSystem.update` (`kernel.js:353`), keeps the render hot body byte-identical to S4.

4. **`kernel.js:380-390` -- register `c.value('perf', new PerfCounters())`** next to `viz`, so a second `bootKernel` gets its own counters (same rule that moved `refs.stats` in S3).

5. **`kernel.js` -- long-task observer (cold).** After `c.boot()` (`:461`): feature-detect `typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes) && PerformanceObserver.supportedEntryTypes.includes('longtask')`. Only then `perf.longTasks = 0` and observe; the callback iterates `list.getEntries()` (fires only when a long task exists -- cold by construction), incrementing `longTasks` and raising `longWorst`. Unsupported stays `-1` and the HUD prints `n/a`. **null is not zero.**

6. **`kernel.js:494-498` -- extend the existing 1 Hz `tpsTimer`, do not add a second timer.** Inside it: `perf.computeP99()`; sample memory behind `const pm = performance.memory; perf.heapMB = (pm && typeof pm.usedJSHeapSize === 'number') ? pm.usedJSHeapSize / 1048576 : null;`.

7. **`kernel.js` -- burst injection.** Add boot-scoped `const burstTick = {mid: 0, bid: 0, ask: 0, t: 0};` (ONE reused scratch object, mirroring S2's tagged-scratch rule) and `let burstN = 0, burstUntil = 0;`. New `class BurstSystem` registered **pre-boot** in the **`pre`** lane (`system()` is pre-boot-only -- post-boot registration throws) and **left disabled**: `ticker.system('burst', BurstSystem, {lane: 'pre', deps: ['viz']}); ticker.enable('burst', false);`. `[HOT]` its `update(dt, time)` is gated by the ticker's own `Uint8Array` enabled flag, so when burst is off the system is **not called at all** -- no dead branch in any hot body. Its body: loop `burstN` times mutating `burstTick` fields from the last real mid (`agg.mid()` read once, outside the loop) with an integer LCG walk, `bus.emit('tick', burstTick)`, `tickCount++`. Zero allocation per synthetic tick.
   - Handle method `burst(n = 100, ms = 10000)`: sets `burstN = n`, `burstUntil = now + ms`, `ticker.enable('burst', true)`, logs `stress: burst x100 for 10s -- synthetic ticks, bypassing the socket`; a single `setTimeout` (cold) disables it and logs the p99 before/after pair. Handle also exposes `burstActive` so the HUD can tag tps as synthetic.

8. **`kernel.js:21` -- fix the graph import and add exports.** Currently `import {fromContainer, toJSON}`; add `toDOT` and `toChromeTrace` (**exact export names -- `toDOT` is upper-case `DOT`; `import {toDot}` is `undefined` at call time**). New handle method `exportGraph(kind)` returning `{name, mime, text}` for `'json' | 'dot' | 'trace'` over `fromContainer(c)`, wrapped in try/catch that logs `down: graph export failed` (fail closed, no half file). **This single function is the S10 seam** -- S10 swaps only the formatter behind it.

9. **`kernel.js:500-519` -- extend `readState()`** with `fps, p99, worst, longTasks, longWorst, ringUse: tape.count / RING, uptimeMs: now - bootAt, heapMB, burstActive`. Returned object shape unchanged in kind (one literal per 120 ms HUD poll -- cold, the existing cost).

10. **`index.html:390-399` -- new `Perf & soak` group** after `Kernel`, rows: `fps`, `frame p99`, `worst frame`, `long tasks`, `ring`, `uptime`, `heap`. Heap row carries a static `<small>Chrome only</small>` label in markup, not written per tick.

11. **`index.html:401-413` -- controls.** `Burst x100 (10s)` button plus a three-button export row (`JSON` / `DOT` / `Chrome-Trace`). Download helper is click-only (cold): `Blob` -> `URL.createObjectURL` -> anchor `click()` -> `URL.revokeObjectURL` in the same handler (revoke is mandatory -- an un-revoked object URL is a retained buffer).

12. **`index.html:509-515` -- extend the cached `el` map** with the seven perf nodes plus `foot`. No new `getElementById` in the interval.

13. **`index.html:518-540` -- HUD writes.** Append perf rows to the SAME 120 ms interval; **writes only, no layout reads** (the only `getBoundingClientRect` stays in `size()` at `:441`, resize-only) -- no read-then-write interleave, so no forced reflow.

14. **`index.html:421-423` -- soak line in `.foot`.** Build `uptime 14m -- 0 long tasks -- worst frame 21ms -- restarts 3` and **change-gate the WHOLE line**: keep the last-written string in a closure variable and assign `textContent` only when it differs (the audio-rooms lesson -- gate the line, not one field).

15. **`README.md` (after `:71` caveats) -- add `## Perf & exports`**: the measured soak table (placeholders until the gate runs), the Perfetto hint (`open ui.perfetto.dev or chrome://tracing, load market-map-graph.trace.json`), and one honest sentence that the trace is lite-di-graph's documented synthetic-timeline mapping of a DI graph, not a wall-clock trace.

## 3. ASSERTIONS

1. **Long tasks.** 10-min Binance soak, GPU mode, after 30 s warm-up: `longTasks === 0` for entries > 50 ms. A single entry fails the gate; the count is displayed, never suppressed.
2. **p99 flat under burst.** Record `p99` for 10 s idle, then during `Burst x100`: `p99_burst <= p99_idle + 2.0 ms` and `worst_burst <= worst_idle + 8 ms`, while `tps_burst >= 100 * tps_idle` (two orders of magnitude, both numbers on screen). Both p99 values go in the README table.
3. **Zero alloc per frame.** `PerfSystem.update` + `PerfCounters.sample` + `BurstSystem.update` contain no `new`, no `{}`/`[]` literal, no closure creation, no string concat, no `Array.prototype` call -- verified by reading the three bodies and by a Chrome Performance recording over 60 s in burst mode showing no minor-GC sawtooth attributable to the frame lane.
4. **Exports well-formed.** All three files download non-empty: `JSON.parse(json).nodes.length === readState().nodeCount`; the DOT text starts with `digraph` and its node count equals `nodeCount`; `JSON.parse(trace)` has `displayTimeUnit === 'ns'` and `traceEvents.length === nodes + 2 * edges`, and the file loads in ui.perfetto.dev without an error toast.
5. **Feature-detect guards.** With `performance.memory` absent (Firefox/Safari): heap row reads `n/a`, no throw, no `0`. With `longtask` unsupported: long-task row reads `n/a` while `longTasks` stays `-1` internally.
6. **Memory flat.** Browser Task Manager JS memory delta minutes 2..10 within +/- 5 MB; `ringUse` saturates at `1.00` and stays there (a falling occupancy would mean the ring is being reallocated).

## 4. CROSS-SESSION DEPENDENCIES

- **Consumes S3.** `refs.stats` (`kernel.js:134`) must already be a container value; `perf` is registered the same way (task 4) so per-scope boots do not share counters. If S3 has not landed, task 4 lands first and S3 inherits the pattern. The S3 gate ("kill one feed, the other's frame delta never spikes") is *pinned by this session's p99* -- record it here.
- **Consumes S2.** tps is split into `quotes/s` + `trades/s`; the burst counter must increment the same `tickCount` (`kernel.js:399`) and the HUD must tag the value `(burst)` so a synthetic number is never read as wire throughput. S2's reused per-tag scratch object is the precedent `burstTick` follows.
- **Produces for S7.** The six-number perf table (fps, p99 idle, p99 burst, worst, long tasks, tps idle/burst) -- README seam is the new `## Perf & exports` section (task 15).
- **Produces for S10.** `handle.exportGraph(kind)` (task 8) is the single formatter seam; S10 replaces `toDOT` with `lite-devtools >= 1.5.0 toDot({labelResolver})` behind it without touching the buttons or the download helper.
- **Feeds S6.** `PerfCounters` is pure and DOM-free -- headless-testable under `node:test` (`sample()` + `computeP99()` against a scripted delta series), and the `ctx: null` headless boot must keep `perf` resolvable.

## 5. RISKS / OPEN

- **`performance.memory` is Chrome-only and coarse** (quantized, gated by cross-origin isolation in some builds) -- it can read "flat" for reasons unrelated to allocation behaviour. Mitigation: label it `heap (Chrome only, coarse)` in markup, and let the **Task Manager** number be the gate of record, not this row. Open: hide the row off-Chrome vs. show `n/a` (recommend `n/a` -- absence stated is stronger than absence hidden).
- **Chrome-Trace fidelity.** `toChromeTrace` maps a DI graph onto a *synthetic* timeline (ts = teardown rank, dur = 1, edges as `s`/`f` flow pairs) -- it is not a wall-clock profile. A reader who opens it in Perfetto expecting frame timings will call the "download a trace" beat a lie unless the README and the button tooltip both say "dependency graph as a trace, not a timeline". Open: whether a later session emits a *real* frame-timing trace from the p99 ring (out of scope here; ledger it).
- **Minor.** `PERF_RING = 1024` vs. the roadmap's literal "600": pow2 bitmask wrap is the house pattern; the percentile window stays exactly 600 samples. Record the deviation in the rationale doc.
