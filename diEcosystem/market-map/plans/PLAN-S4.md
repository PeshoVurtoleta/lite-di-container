# Session 4 -- Rendering depth

## 1. SPEC

Make the GPU path a product: a thick antialiased price polyline (lite-gl LINE) replaces the point cloud as the primary trace, points survive only for trades; the tick ring grows to 65536 behind a **measured** upload decision; a cumulative-depth curve sits behind the ladder in all three renderers; pinch gesture joins the slider as a zoom driver so touch users reach the 1.5x/2.2x gates (`kernel.js:468`); and coarse/detailed/GPU each draw tape + ladder + trades + depth curve.

**Acceptance gate (measurable).** With `RING=65536`, `LVL=20` (40 ladder rows), trades enabled, GPU renderer selected (zoom >= 2.2):
- dev machine (desktop Chrome, retina, DPR 2): 600-frame rolling p99 frame delta <= 16.6 ms, worst frame <= 25 ms, over a 60 s Binance session;
- iPhone Safari: page does not fall over; if `navigator.deviceMemory <= 4` the boot picks a degraded `RING` and emits exactly one log line `degrade: ring 65536 -> N (deviceMemory=D)`;
- retina crispness: GL canvas backing store is `W*dpr x H*dpr` after the S1 fix (today `index.html:447-448` sets `glc.width = W`, CSS px -- blurry);
- zero steady-state allocation on the render path (proof in ASSERTIONS).

## 2. TASKS

Ordered. **[HOT]** = runs per frame or per tick; preallocated buffers only, no literals, no closures, no layout reads.

**Phase A -- make RING a boot parameter (prerequisite for everything else)**

1. `kernel.js:28` -- demote `const RING = 2048` to `const RING_MAX = 65536` + `const RING_MIN = 4096`. Add `pickRing()`: reads `navigator.deviceMemory` (feature-detected; `undefined` -> assume 4) and `navigator.hardwareConcurrency`, returns a **power of two** (RingBuffer contract) clamped to `[RING_MIN, RING_MAX]`. Fail closed: unknown memory -> the smaller tier, logged.
2. `kernel.js:365 bootKernel` -- accept `{ringSize}` in the options bag, default `pickRing()`. Log the degrade line once when `ringSize < RING_MAX`.
3. Thread `ringSize` through every site that hard-codes `RING`: `viz.scratch` (`kernel.js:368`), `createPointSink(gl, {capacity: RING})` (`kernel.js:373`), `new RingBuffer(RING)` (`kernel.js:386`), `bus.record(RING, ...)` (`kernel.js:480`), and `new GLRenderer()` -> `new GLRenderer(ringSize)` (`kernel.js:390`), whose `this.pts = new Float32Array(RING*8)` (`kernel.js:268`) becomes capacity-derived. Decouple the recorder size from the tape size -- 65536 recorded frames is a separate memory decision; keep `bus.record` at 2048.
4. `kernel.js:29` -- `LVL` 16 -> 20 (S2 makes it the stream's level count). Quad sink capacity at `kernel.js:374` becomes `LVL*2 + DEPTH_QUADS`.

**Phase B -- MEASURE before choosing the upload path (this is the gate for task 8)**

5. `kernel.js:353 RenderSystem.update` **[HOT]** -- add a temporary, flag-gated three-stage timer (`viz.measure` boolean; when false the branches never execute and cost only their bytes). Sample `performance.now()` around exactly three spans and accumulate into a preallocated `Float64Array(600)` ring per stage, reported at 1 Hz:
   - **S1 copy**: `this.tape.copyTo(v.scratch, 0)` (`kernel.js:358`) -- one memcpy of `ringSize` floats;
   - **S2 vertex build**: the interleaved write loop in `GLRenderer.draw` (`kernel.js:327-337`) -- `n*8` float stores;
   - **S3 upload+draw**: `sink.upload` + `sink.draw` (`kernel.js:338-339`) -- `n*8*4` bytes to the GPU.
   Run at `n = 65536` on the dev machine and on the iPhone. **Record all three p50/p99 numbers in the rationale doc** -- the roadmap's "measure first, decide second" (`ROADMAP-DEMO.md:182-184`).
6. Decide from the numbers, not from taste. Expected shape: S1 (a single 256 KB memcpy) is the *cheap* stage; S2+S3 (524 288 float stores + a 2 MB `bufferSubData` per frame) dominate. If that holds, **the ring-vs-scratch question is not the bottleneck** and the head/tail-split rewrite is a rejection, not a win -- ledger it for S7.
   - **Path A (keep `copyTo`)**: scratch stays; no ring-internals coupling; chosen if S1 p99 <= 0.8 ms.
   - **Path B (two segment draws)**: read the tape's backing `Float32Array` directly, upload `[head..cap)` then `[0..head)` as two `sink.upload`/`sink.draw` pairs. **Blocker to verify first**: the LINE sink must accept a layout where x is generated (from vertex/instance index) rather than interleaved -- the ring stores price only. If it cannot, Path B still requires the S2 build loop and saves only S1, i.e. buys nothing. Confirm against lite-gl's `llms.txt` before writing a line.
   - **Path C (the likely real answer, name it explicitly in the doc)**: column decimation -- min/max reduce `n` samples into `<= plotW` columns written to a preallocated `Float32Array(2 * MAX_COLS)`, bounding S2/S3 by pixel width instead of ring depth. Ledger A/B/C with the measured numbers whichever wins.
7. Delete or permanently flag-gate the timers before ship; if kept, they belong to S5's perf panel, not to S4's hot body.

**Phase C -- the line pipeline**

8. `kernel.js:26` -- add the LINE sink export to the `@zakkster/lite-gl/backend` import (confirm the exact name and its vertex layout/`width`/`join` options from lite-gl's `llms.txt`; do not guess).
9. `kernel.js:371-375` -- create `viz.glLineSink` beside `glSink`/`glQuadSink`, capacity from the chosen path (task 6): `ringSize` under A/B, `MAX_COLS` under C. Keep the existing `try/catch` -> `log('down', ...)` fail-closed shape (`kernel.js:376-378`); a missing line sink must degrade to the point cloud, not throw.
10. `kernel.js:265 GLRenderer` -- constructor allocates `this.line = new Float32Array(cap * LINE_STRIDE)` and `this.tradePts = new Float32Array(TRADE_CAP * 8)` **once**, alongside `this.quads` (`kernel.js:269`).
11. `kernel.js:313-340 GLRenderer.draw` **[HOT]** -- replace the point-cloud block: the same lo/hi scan and x/y mapping now writes line vertices; `sink.draw(n)` for points is retained **only** for trades. Order: quads (ladder + depth curve) -> line -> trade points, blend state already set at `kernel.js:277-278`.

**Phase D -- cumulative depth curve**

12. `kernel.js:50 OrderBook` -- constructor adds `this.bidCum = new Float32Array(LVL)`, `this.askCum = new Float32Array(LVL)`, `this.maxCum = 0`.
13. `kernel.js:59 OrderBook.apply` **[HOT, per-tick via `BookApply.handle` at `kernel.js:108`]** -- extend the existing single pass to carry two running sums into the preallocated arrays and track `maxCum`. Computing here rather than per frame keeps the frame budget clean and needs no `draw()` signature change; both are in-place writes, zero allocation.
14. `kernel.js:174 drawFrame` **[HOT]** -- draw the curve **behind** the ladder bars (before the `fillRect` loop at `kernel.js:224-231`) as one `beginPath`/`lineTo` sweep per side with a translucent fill, scaled by `book.maxCum`. Reuse the existing `ladderX`/`ladderW`/`rowH` locals (`kernel.js:223`); do not recompute.
15. `kernel.js:284-311 GLRenderer.draw` **[HOT]** -- emit the curve as a translucent quad strip into the same `this.quads` array ahead of the bar quads, one quad per level per side; bump the loop bound and the single `qsink.upload(q, 0, count*9, 0, 9)` / `qsink.draw(count)` pair (`kernel.js:309-310`) -- still one upload, one draw.

**Phase E -- trades + parity**

16. `kernel.js:345 RenderSystem` -- add the S2 `trades` ring to `deps` (`kernel.js:436`) and a preallocated `v.tradeScratch`; **[HOT]** one `copyTo` per frame, same shape as `kernel.js:358`.
17. `drawFrame` (`kernel.js:174`) -- draw buy/sell trade dots on the price trace, colored by the maker flag. This one function backs both `CoarseRenderer.draw` (`kernel.js:246`) and `DetailedRenderer.draw` (`kernel.js:257`), so both gain trades in a single edit; the only coarse/detailed difference stays the `labels` argument (`kernel.js:247` vs `258`).
18. `GLRenderer.draw` -- fill `this.tradePts` and issue the second point draw (task 11).

**Phase F -- pinch-to-zoom**

19. `index.html:85-99` `.stage` CSS -- add `touch-action: none` so pointer events are not stolen by the browser's native pinch; keep buttons on `click` untouched (`index.html:504-506`).
20. `index.html:440-450 size()` -- cache the stage rect into a module-level `stageRect` object (mutate its fields, do not reassign a new object) and refresh it on `resize` (`index.html:494-497`). **This is the anti-reflow seam**: the pointermove handler must never call `getBoundingClientRect`.
21. `index.html` script -- add a fixed two-slot pointer table: `Int32Array(2)` for ids (`-1` = empty) and `Float64Array(4)` for x/y. `pointerdown` claims the first free slot; `pointerup`/`pointercancel`/`pointerout` releases by id. **No `Map`, no array of objects.**
22. `pointermove` **[HOT -- up to 120 Hz on ProMotion]** -- when both slots are filled, compute squared distance (`dx*dx+dy*dy`, one `Math.sqrt`), `zoom = pinchBaseZoom * (dist / pinchStartDist)` clamped to `[0.5, 3]` to match the slider bounds (`index.html:409`). Zero allocation: all scalars, all handlers installed once.
23. Single source of truth for zoom: the pinch path calls the *same* apply function the slider input calls (`index.html:499-503`) -- set `handle.setZoom(z)` (`kernel.js:520`), write `$('zoom').value`, write `$('zoomv').textContent`. Guard the label write behind a 0.1-quantized change check so a 120 Hz gesture does not touch the DOM 120 times per second.
24. `index.html:409` -- relabel the slider row to note pinch as the touch equivalent (closes audit finding 13, `ROADMAP-DEMO.md:76`).

**Phase G -- record**

25. Write the RING-upload measurement + the A/B/C decision into the rationale doc with the actual p50/p99 numbers and the device they came from. This is the S7 rejection-ledger entry the roadmap pre-names: *"reading the ring directly on GPU upload if measurement said no"* (`ROADMAP-DEMO.md:267-268`).

## 3. ASSERTIONS

Each is falsifiable with a stated method.

1. **FPS.** GPU mode, `RING=65536`, `LVL=20`, trades on, 60 s Binance session, desktop Chrome at DPR 2: p99 of the last 600 frame deltas <= **16.6 ms** and worst frame <= **25 ms**. Method: the task-5 preallocated `Float64Array(600)` delta ring, percentile computed at 1 Hz; cross-checked against DevTools Performance (no frame marked "dropped" beyond warm-up). Fails if p99 > 16.6 ms.
2. **Upload budget, per stage.** At `n = 65536`: S1 `copyTo` p99 <= **0.8 ms**; S2 vertex build + S3 upload/draw combined p99 <= **8.0 ms**. If S2+S3 exceed 8.0 ms, Path C (decimation) is mandatory and Path A-vs-B is moot -- record the numbers either way.
3. **Zero-alloc render proof.** DevTools Memory -> Allocation sampling, 30 s in GPU mode with the feed live: **zero** allocation samples attributed to `RenderSystem.update`, `GLRenderer.draw`, `drawFrame`, `OrderBook.apply`, or the `pointermove` handler. Corroborate with a flat sawtooth-free JS heap in the browser task manager.
4. **Retention across zoom churn.** Drive zoom across all three strategy bands 500 times (slider + synthetic pointer sequence): renderer instance identity is stable (`===` on the three `c.get('renderer:*')` values before and after), `viz.scratch`/`this.pts`/`this.quads`/`this.line` are the **same** typed-array objects (identity check, not length), and heap after forced GC returns to within **2%** of the pre-churn baseline.
5. **Parity.** For each of the three renderers, a headless-friendly draw-call assertion (S6 seam) or a recorded-call counter proves **all four** layers execute per frame: ladder bars > 0, tape trace > 0 vertices, trade dots >= 0 with the array populated when trades exist, depth curve > 0. Coarse and detailed both route through `drawFrame` (`kernel.js:247`, `kernel.js:258`) so the only permitted divergence is `labels`; GPU issues exactly **3** draw calls (quads, line, trade points).
6. **Degrade is logged, not silent.** Boot with `deviceMemory` stubbed to 2: `ringSize < 65536`, exactly one `degrade:` log line, and the demo still renders. Boot with `deviceMemory` `undefined`: fail closed to the smaller tier, also logged.

## 4. CROSS-SESSION DEPENDENCIES

**Consumes S1 (DPR).** Assertion 1's "retina crisp" is meaningless until `index.html:447-448` sizes the GL backing store at device pixels while the sink keeps drawing in CSS px. **Seam:** `size()` in `index.html:440-450` is the single writer of both canvases' backing stores; `sink.resize(w, h)` (`kernel.js:276`, `kernel.js:285`) is the single writer of the GL viewport. S4 must not fork a second DPR path.

**Consumes S2 (book/tape/trades).** Tasks 4, 12-13, 16-18 all assume real 20-level `bidSz`/`askSz` and a second trades ring on a `trade` bus channel. **Seams:** `OrderBook.apply` (`kernel.js:59`); `bus.on('tick', ...)` (`kernel.js:394`); `RenderSystem` `deps` (`kernel.js:436`). A cumulative curve over synthesized sizes is a lie on screen -- if S2 slips, ship Phases A-C+F and hold D-E.

**Consumes S3 (renderers on parent scope).** S3 keeps renderers + `viz` on the parent while per-symbol state moves to child scopes. S4's renderers hold the big preallocations -- if they were per-scope, every tab open would allocate megabytes. **Seam:** `c.value('renderer:*', ...)` (`kernel.js:388-390`) and the `StrategyRouter` (`kernel.js:466-469`) stay parent-scope singletons. S3's `rebind` of `renderer:gpu` must survive a renderer that owns typed arrays -- the rebound v2 allocates its own; the old one must be released (assertion 4's identity check across a rebind).

**Feeds S5.** The task-5 timers are S5's perf-panel skeleton; hand them over rather than deleting them twice.
**Feeds S6.** `pickRing()` and the `ringSize` boot option are directly unit-testable; the parity assertion wants the `ctx: null` headless seam.
**Feeds S7.** Task 25's rationale entry is the pre-named rejection-ledger item; the measured numbers populate the README perf table.

## 5. RISKS / OPEN

- **The measure-first RING decision may invalidate its own framing.** The roadmap poses copyTo-vs-split, but the dominant per-frame cost at 65536 is almost certainly the 524 288-float interleaved build plus a 2 MB `bufferSubData` -- not the 256 KB memcpy. Both roadmap options pay that cost. Path B may be *impossible* with the LINE sink's vertex layout (ring stores y only; x from index). **Open for maintainer:** if measurement confirms, is Path C (pixel-column min/max decimation) in scope for S4, or does S4 ship at a smaller `RING` with C ledgered? Decimation changes what the line *means* (min/max envelope) -- belongs in honest-caveats. Do not write either path before task 5's numbers exist.
- **Device-memory degrade is a guess dressed as a measurement.** `navigator.deviceMemory` is Chromium-only, absent on iOS Safari -- the device the gate names. Fallback (`undefined` -> smaller tier) means iPhone *always* degrades: safe but may under-serve a modern iPhone. **Open:** conservative static tiering, or a one-time post-boot adaptive step? Log line is mandatory either way.
- **Secondary:** `bus.record(RING, ...)` (`kernel.js:480`) silently inherits RING growth -- 65536 recorded frames is a separate budget, decoupled in task 3.
- **Secondary:** `touch-action: none` on the stage disables native page scroll over the canvas on mobile; verify the panel stays reachable on iPhone, or scope the rule to the canvas elements only.
