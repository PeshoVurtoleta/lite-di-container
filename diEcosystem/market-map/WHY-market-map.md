# WHY market-map

Design rationale and the rejection ledger for the market-map demo. House
convention: record what was measured, what was decided, and -- just as
important -- what was rejected and why. ASCII-only.

---

## The RING-upload decision (Session 4)

The roadmap posed a "measure first, decide second" question for growing the tick
ring to 65536: is the per-frame `copyTo` (ring -> scratch) a bottleneck worth a
rewrite? Three candidate upload paths were pre-named:

- **Path A** -- keep `copyTo`: scratch stays; no ring-internals coupling.
- **Path B** -- read the tape's backing `Float32Array` directly and upload it as
  two segment draws (`[head..cap)` then `[0..head)`), skipping the copy.
- **Path C** -- pixel-column min/max decimation: reduce N samples into `<= plotW`
  columns, bounding the vertex build + upload by screen width instead of ring
  depth.

### What was measured

Instrument: a flag-gated three-stage timer inside `RenderSystem.update` +
`GLRenderer.draw` (S1 = `tape.copyTo`, S2 = interleaved vertex build, S3 =
`sink.upload` + `sink.draw`), driven by a synchronous `pump(iters)` so the
numbers do not depend on `requestAnimationFrame` (paused when the render surface
is backgrounded). The GPU upload path was cross-checked in isolation against the
real `@zakkster/lite-gl@2.0.0` `createLineSink` at capacity 65535, serialized
with `gl.finish()` per frame to remove synchronous-loop queue backpressure.

Device: Apple Silicon (macOS, Darwin 25.5), Chromium in-app browser, WebGL2,
canvas backing store ~1600x900. Note: Apple Silicon has UNIFIED memory, so a
`bufferSubData` upload is a shared-memory memcpy rather than a PCIe transfer --
the upload numbers below are a near-floor and will be higher on discrete GPUs.

At `n = 65536`, `LVL = 20`:

| Stage                              | p50      | p99      | Budget     | Verdict |
|------------------------------------|----------|----------|------------|---------|
| S1 `copyTo` (256 KB memcpy)        | < 0.1 ms | 0.10 ms  | <= 0.8 ms  | PASS    |
| S2 vertex build (~0.5M float stores)| 0.3 ms  | 0.5-1.8 ms | (part of 8.0) | PASS |
| S3 line upload (2.36 MB bufferSubData)| 0.1 ms | 0.3 ms   | (part of 8.0) | PASS |
| S3 full upload+draw+`finish()`     | 0.1 ms   | 0.3 ms   | (part of 8.0) | PASS |
| S2 + S3 combined                   | --       | ~0.8 ms  | <= 8.0 ms  | PASS    |

Total per-frame render work is ~1 ms against a 16.6 ms (60 fps) budget.

Caveat on the synchronous pump: measuring S3 by running the point sink 300-600
uploads back-to-back with no vsync produced a recurring ~200 ms p99 spike while
p50 stayed at 0. That is GPU implicit-sync backpressure (overwriting a buffer the
GPU is still reading), an artifact of the pump -- NOT a per-frame cost. The
real per-frame figure is the `gl.finish()`-serialized line-sink number above
(0.3 ms). The one-upload-per-vsync-frame cadence of the real loop never
accumulates that backpressure.

### The decision: Path A, full RING = 65536

The measurement invalidated the question's own framing, exactly as the roadmap
anticipated it might: `copyTo` is NOT the bottleneck. S1 p99 = 0.10 ms, an order
of magnitude under the 0.8 ms trigger for the rewrite. So:

- **Path A is chosen.** Keep `copyTo`; ship the true full-resolution polyline at
  RING = 65536. `pickRing()` still shrinks the ring on low-`deviceMemory`
  devices (fail-closed to the smaller tier when the API is absent), logged once.
- **Path B is rejected -- on API grounds, independent of the numbers.**
  `createLineSink` uses a fully interleaved layout `(x0, y0, x1, y1, width, r,
  g, b, a)` per segment; there is no index-generated-x mode, so the ring's
  price-only backing array cannot be uploaded raw. Path B would still require the
  S2 build loop and saves only the (negligible) S1 copy. It buys nothing.
- **Path C is ledgered for S7, not built.** Decimation would trade the true
  trace for a min/max envelope -- a change in what the line MEANS -- for zero
  measured benefit at 65536 on this class of machine. It is the contingency for
  low-end / high-fill-rate devices, gated behind `pickRing()`'s degrade tiering.

### Not measured (owner-manual, pre-S6 headless seam)

`navigator.deviceMemory` is Chromium-only and absent on iOS Safari -- the device
the acceptance gate names. The iPhone fill-rate and low-memory ring path were not
measurable here (no device; rAF paused in a backgrounded surface). `pickRing()`
degrade tiering + the once-only `degrade:` log line are the safety net. The 60 s
DevTools Performance p99 gate and the Memory-panel retention gate remain
owner-manual.

---

## Rejection ledger

Real design choices that were considered and rejected, with the reason.

- **Reading the ring directly on GPU upload (Path B above)** -- rejected: the
  LINE sink's interleaved vertex layout has no index-generated x, so the
  price-only ring cannot be uploaded raw; the build loop is still required.
- **Column-decimation for the price trace (Path C above)** -- deferred to S7:
  changes the line's meaning to a min/max envelope for no measured gain at
  RING = 65536 on unified-memory hardware; kept as the low-end contingency.
- **One reactive signal per tick** -- rejected: allocates on the 50 Hz hot path.
  The bus carries reused scratch; the recorder tapes numeric scalars only.
- **Hot-swapping the renderer via lite-di-strategies** -- rejected: strategies
  SELECTS a renderer by zoom band; swapping the binding is `rebind`'s job. The
  demo uses each for what it is (strategies for read-path selection, rebind for
  the post-boot GPU hot-swap).
- **Playwright / browser end-to-end tests** -- rejected: house law is
  `node:test` only. Browser behavior is covered by the headless parse/book seams
  (`Frames.js` under `test/`) plus manual soak; the GL draw path is
  browser-validated by lite-gl's own smoke test.
- **Recording the live object bus for replay** -- rejected: `EventBus.record`
  stores payloads by reference, so a live bus tapes aliased scratch. A dedicated
  numeric `traceBus` records unboxed mid scalars for honest replay; its record
  size is decoupled from the tape ring (2048, not 65536).
