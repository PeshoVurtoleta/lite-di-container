# REJECTED -- market-map design ledger

Every entry is a design that was seriously considered for the market-map demo and
turned down, with the reason and what shipped instead. This is the skeptic's
read: the demo makes claims about zero-GC and self-healing, and the fastest way
to trust a claim is to see which tempting shortcuts were refused to keep it true.

House format: **Design.** / **Rejected because.** / **Chosen instead.** ASCII-only.
The measured numbers referenced below are recorded in `WHY-market-map.md`.

---

### 1. One reactive signal per tick

**Design.** Model the feed the "obvious reactive" way -- create a signal per
instrument field per tick and let subscribers recompute, so the whole UI is a
pure function of a signal graph.

**Rejected because.** The feed is a ~50 Hz firehose. A signal (or a boxed
payload) allocated per tick allocates on the hot path, which defeats the single
claim the whole demo exists to prove: zero-GC steady state under a real socket.
It would also make the GC, not the code, decide the frame budget.

**Chosen instead.** The tick firehose lands in a `lite-ring-buffer` (pow2
`Float32Array`, bitmask wrap) -- 0-GC hot data. `lite-di-signal` holds only a
handful of aggregate signals (mid / bid / ask / spread), recomputed from the
ring, never one per tick. `lite-ws` exists precisely to avoid the per-message
allocation trap, and the demo uses it that way.

---

### 2. Hot-swapping the renderer through `lite-di-strategies`

**Design.** Treat the GPU-vs-Canvas2D renderer choice as a strategy swap: when
the "Swap renderer build" button is pressed, ask `lite-di-strategies` to select a
different renderer, reusing the same mechanism that picks a renderer by zoom.

**Rejected because.** It conflates two different jobs. `lite-di-strategies` is a
read-path *selector* over bindings that already exist -- it chooses which
pre-registered renderer to read on each frame (the zoom tiers: coarse Canvas2D ->
detailed Canvas2D -> lite-gl GPU past 2.2x), 0 B/op. Replacing a binding with a
different implementation *after boot* is a different capability entirely:
`container.rebind` (GAP-3).

**Chosen instead.** Each tool does exactly its job. `strategies` selects the
renderer by zoom band on the read path. The "Swap renderer build (rebind, GAP-3)"
button calls `container.rebind` and the log narrates
`rebind: renderer:gpu -> v2 (post-boot hot-swap, GAP-3)` -- a genuine post-boot
binding replacement, not a strategy selection.

---

### 3. Playwright / headless-browser end-to-end tests

**Design.** Prove the demo the way a web app is usually proven -- drive the real
page in a headless browser with Playwright, click Kill feed, assert the DOM heals.

**Rejected because.** House law is `node:test` only, zero test dependencies. A
browser-automation stack is a large dependency tree and a second toolchain, and
it proves the *page*, not the *kernel* -- the thing worth proving is that the DI
kernel boots, heals, and tears down deterministically, independent of any canvas.

**Chosen instead.** S6 added a headless `bootKernel({ ctx: null, socketFactory,
glSinks })` seam -- pure DI applied to the DI demo. `node:test` boots the real
kernel with a fake socket factory and cold GL sinks and asserts heal, reverse-topo
teardown order, and scope-churn leak-freedom under `lite-leak`; an inverted
break-gate keeps those gates honest. The GL draw path is left to `lite-gl`'s own
smoke test, and the on-screen soak is a documented owner-manual protocol -- a
stated coverage boundary, not a hidden gap.

---

### 4. Uploading the ring's backing store directly to the GPU (Path B)

**Design.** For the price polyline, skip the per-frame `copyTo` (ring -> scratch)
and hand the ring's `Float32Array` backing store straight to the line sink as two
segment draws (`[head..cap)` then `[0..head)`), saving a copy every frame.

**Rejected because.** Two reasons, and the API one is decisive independent of the
numbers. `@zakkster/lite-gl@2.0.0`'s `createLineSink` uses a fully interleaved
vertex layout `(x0, y0, x1, y1, width, r, g, b, a)` per segment -- there is no
index-generated-x mode, so a price-only ring cannot be uploaded raw; the vertex
build loop is still required. And the copy Path B would remove was measured at
RING = 65536 to cost `copyTo` p99 = 0.10 ms -- an order of magnitude under the
0.8 ms trigger set for the rewrite. Path B buys effectively nothing.

**Chosen instead.** Path A: keep `copyTo`, ship the true full-resolution polyline
at RING = 65536. Total per-frame render work measured ~1 ms against the 16.6 ms
budget. `pickRing()` still degrades the ring on low-`deviceMemory` devices,
fail-closed when the API is absent.

---

### 5. Column-decimation for the price trace (Path C)

**Design.** Reduce N ring samples into `<= plotW` min/max columns before building
vertices, bounding upload and vertex work by screen width instead of ring depth.

**Rejected because.** It changes what the line *means* -- a min/max envelope is
not the true trace -- and the measurement showed no benefit to pay for that
change: at RING = 65536 on unified-memory hardware the full-resolution path is
already ~1 ms/frame. Trading trace fidelity for a speedup that is not needed is a
bad deal on this class of machine.

**Chosen instead.** Ship Path A (true trace). Path C is ledgered, not deleted:
it is the contingency for low-end / high-fill-rate devices, to be gated behind
`pickRing()`'s existing degrade tiering if a real device ever needs it. Deferred,
not built.

---

### 6. Recording the live object bus for replay

**Design.** Reuse `lite-di-event-bus`'s `record` to tape the live tick bus, then
replay the recording for the trace / soak view -- one bus, one recorder.

**Rejected because.** `EventBus.record` stores payloads by reference. The live
tick bus carries reused scratch objects (that reuse is what makes it 0-GC), so
taping it would record aliased scratch -- every replayed frame would read the
same mutated object, honest-looking and wrong.

**Chosen instead.** A dedicated numeric `traceBus` records unboxed mid scalars
only, so a replay reads the values that actually flowed. Its record size is
decoupled from the tape ring (2048, not 65536) because a replay window and a hot
ring have different lifetimes.

---

### 7. Renaming the demo out of `diEcosystem/`

**Design.** Give the demo a product name and its own top-level folder / repo now,
so the launch write-up points at a clean home.

**Rejected because.** It currently lives under `diEcosystem/` and is deployed as a
subtree of the container repo's Pages site; a rename would break the live URL the
launch materials depend on and split the demo from the kernel it showcases before
the combined story (Session 10) is even told.

**Chosen instead.** Keep it under `diEcosystem/market-map/` while it is a
showcase of the container. Deferred until the demo stands as its own artifact.

---

### 8. Shipping more scope now: replay scrubbing, a second exchange, in-browser SPP

**Design.** Broaden the demo before launch -- a replay scrubber over the trace,
a second exchange feed for cross-venue depth, an in-browser structured-price
pipeline.

**Rejected because.** Each is a feature, not a proof; none of them strengthens
the core claim (self-healing, zero-GC, no-bundler DI kernel), and each adds
surface to keep honest. Scope before the claim is proven is how a skeleton turns
into an unfinished product.

**Chosen instead.** Ship the proven kernel and its honest provenance now; each
of the three is deferred, one line in the roadmap, to be added only once it earns
its place against the core claim.
