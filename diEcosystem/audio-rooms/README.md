# audio-rooms -- a `@zakkster/lite-di-*` skeleton demo

> The self-healing scoped lifecycle the leaky Web Audio graph was missing.

A **skeleton**, not a product: a spatial "audio rooms" kernel built from the actual
`lite-di-*` packages driving a real `@zakkster/lite-audio` Web Audio graph, running
**in the browser** with a thin top-down Canvas2D / lite-gl stage. It is the sibling of
the `../market-map/` demo and obeys the same demo Law -- the headless kernel does the
real work; the visualization is the `ticker`/render showcase on top.

The golden niche in miniature: **scoped construction + fail-closed teardown of Web
Audio**. A room is a container child scope; leaving it tears the whole audio graph down
in reverse-topo order; a fault heals the engine on the same shared context without
dropping the viewport.

## Run it -- ONE process

**Live:** https://peshovurtoleta.github.io/lite-di-container/diEcosystem/audio-rooms/

There is no feed server and no build step. The import map resolves every package to a
**version-pinned esm.sh URL** (CDN-absolute and host-independent, so the page loads
identically on Pages or from a local static host -- it needs a network, not a suite
checkout). To run it locally, serve this directory and open the page:

```bash
cd /Users/zakkster/Work/Portfolio/LiteLibrariesSuite/LiteDiContainer/diEcosystem/audio-rooms
python3 -m http.server 8099 --bind 127.0.0.1
```

Then open: `http://127.0.0.1:8099/index.html`

Click **to start** (that first gesture unlocks the shared `AudioContext` -- lite-audio
auto-unlocks on `mousedown`/`keydown`). No bundler. Every package is zero-dep single-file
ESM, resolved in-browser by the import map.

## What each package does here

| Package | Version | Role in the demo |
| --- | --- | --- |
| `lite-di-container` | 2.2.0 | the graph: ROOT scope holds the shared ctx; each room is a **child scope** (`scope()`); leaving = `roomScope.shutdown()` reverse-topo teardown; the parent refuses to shut down while a room is live |
| `lite-di-signal` | 1.0.0 | the reactive control surface -- a **handful** of ROOM-LEVEL aggregates (listener facing, reverb tag, live emitter count, housekeeps), NOT per-voice position |
| `lite-di-ticker` | 1.0.0 | the rAF render loop; each frame it advances game state and calls `engine.setPosition(handle,x,y,z)` -- the stamp, nothing param-related |
| `lite-di-strategies` | 1.0.0 | selects the VISUAL renderer by `view`: coarse Canvas2D -> detailed Canvas2D (labels + facing) -> lite-gl point cloud past 2.2x -- read-path, 0 B/op |
| `lite-di-supervisor` | 1.0.0 | watches the room `engine`; on a fault it `invalidate`s + re-resolves a **fresh engine on the same shared ctx** without dropping the render loop |
| `lite-di-health` | 1.0.0 | `readyz` / `livez` over the engine + supervisor (fail-closed: no engine -> not ready) |
| `lite-di-graph` | 1.0.0 | exports the booted room-scope dependency graph (node count / a JSON profile) |
| `lite-di-event-bus` | 1.1.0 | 0 B/emit fan-out of a room event: **footstep -> retrigger** every emitter |
| `lite-di-cron` | 1.0.0 | wall-clock housekeeping tick per room |
| `lite-audio` | 2.5.1 | the real Web Audio engine: ONE per room scope, all sharing ONE `AudioContext`; `createBus('world',{spatial:'positional'})`, `defineSounds` (procedural WAV `data:` URIs), `play` -> positioned voices, `setPosition` (zero-alloc caller stamp; the engine's own ~10Hz monitor does the throttled param write), `destroy()` (disconnects every node, does NOT close the ctx) |
| `lite-audio-pool` | 1.4.0 | lite-audio's per-bus voice pool (the PannerNode-per-voice spatial nodes) |
| `lite-signal` | 1.5.0 | lite-di-signal's + lite-audio's reactive core |
| `lite-raf` | 1.2.0 | lite-di-ticker's frame source |
| `lite-gl` | 2.0.0 | instanced WebGL2 point sink for the emitter cloud past 2.2x |

## The two headline beats

- **Room switch -> node census to baseline.** Enter room A/B/C: the child scope builds a
  LiteAudio engine, positioned emitters, aggregates, a supervisor, health, cron, and an
  event bus. Click **Leave room**: `roomScope.shutdown()` fires the reverse-topo teardown
  (`onTeardown('engine', e => e.destroy())` disconnects every node; the signal registry
  disposes) and the **live audio-node census returns to baseline (0)**.
- **Kill audio -> self-heal.** Click **Kill audio**: the supervisor `reportFault`s the
  engine -> teardown disposes it -> a fresh engine re-resolves on the **same shared ctx**
  -> `onRestart` re-caches the engine ref and re-stamps the voice handles (restarts++).
  The listener state stays live and the viewport never stops. Mirror of market-map's
  Kill-feed.

## Proven headless

The two beats above are not just a browser demo -- they are pinned by **21 `node:test`
gates** (`npm test`) over a headless `bootKernel` seam (inject a mock engine, no
AudioContext required):

- **census -> 0 on leave.** enterRoom stamps the live-node census (`6 + N*3`); leaveRoom
  fires `roomScope.shutdown()` and the census returns to baseline `0`. Repeated
  enter/leave never grows it.
- **self-heal identity.** a fault builds a **fresh** engine on the **same shared ctx** --
  the gate asserts a new instance is handed to `init(ctx)` with the ctx object unchanged.
- **fail-closed parent + health.** the root refuses to shut down while a room is live;
  `readyz` fails closed (no engine -> not ready).
- **reverse-topo teardown.** the teardown order is asserted from the engine's **observed**
  `onTeardown` fires, not a hardcoded list.

**Fidelity boundary (honest):** these gates prove the DI **lifecycle** + the census
**model** against a MOCK engine -- NOT real `AudioNode` disconnection. This is the same
boundary as `../market-map/`'s fake socket. The census is MODELED from engine state
(`censusOf`; see the **Real node census** seam below); the browser demo drives the real
`@zakkster/lite-audio` graph. An armed canary (`AR_BREAK=1`, a no-op engine destroy)
makes the census gate go RED on demand, so the gate is falsifiable, not a tautology.

## Corrected architecture (vs the naive mapping)

An external LLM proposed the INVERTED version of every one of these. This is the honest one:

1. **Room = container child scope.** `root.scope()`; per-room services live in the child;
   leaving = `roomScope.shutdown()` -> reverse-topo teardown. The parent refuses to shut
   down while a child scope is live.
2. **Per-room engine on ONE shared ctx.** ONE `LiteAudio` per room scope, every engine
   `init(sharedCtx)`-ed against a single `AudioContext` created once in the ROOT scope.
   `destroy()` disconnects every node but does NOT close the ctx. There is **no
   `destroyBus()`** -- granularity is the per-room ENGINE.
3. **Signals = aggregates, not per-voice.** lite-di-signal holds room-level aggregates
   only (facing / reverb tag / emitter count). Per-voice `[x,y,z]` is the `setPosition`
   stamp, never a signal.
4. **Ticker stamps `setPosition`, never ramps.** The render system calls
   `engine.setPosition(handle,x,y,z)` and nothing param-related. No `setTargetAtTime`, no
   `linearRampToValueAtTime`, no PannerNode from demo code -- that is lite-audio's SP-03
   red control. The engine's ~10Hz monitor does the throttled param write.
5. **Mode = rebind, not strategies.** Output mode (stereo/HRTF/discrete) is frozen at bus
   construction; a mode switch would be `container.rebind` / a rebuilt bus, never
   `lite-di-strategies`. Strategies here SELECTS the visual renderer only, 0 B/op.
   `layoutOf()` is read once at engine build and cached.

## Seams to turn this into a product (grep `SEAM:` in `kernel.js`)

- **Real room geometry / occlusion** and a measured reverb impulse response per room
  (the reverb tag is a label today).
- **Real HRIR set:** switch the bus to `{spatial:'hrtf'}` (frozen at construction) for
  per-voice binaural convolution on headphones.
- **`destroyBus`** when lite-audio ships per-bus teardown (today the granularity is the
  per-room engine).
- **Per-emitter assets:** the emitter sounds are procedural WAV `data:` URIs
  (`makeToneWav`); swap in real per-emitter files via `defineSounds`.
- **Headset re-detect:** `layoutOf()` resolves once at init and does NOT re-detect a
  mid-session device change (documented lite-audio behavior); a productized kernel would
  rebuild the bus on a headset swap.
- **Real node census:** the live-node count is MODELED from engine state
  (`censusOf`); a product would wrap the shared ctx's `create*` factories with a live
  counter that decrements on the pool's disconnect at voice steal / destroy.

## What this is not

- **Not a game engine.** It is a lifecycle showcase; the "game state" is a listener that
  slowly turns and a few orbiting emitters.
- **Not true 5.1/7.1 over a 2ch sink.** The bus is `positional` (a StereoPanner/Panner
  graph); discrete surround only renders on a real multi-channel sink.
- **Not per-voice reactive.** Per-voice position is a zero-alloc `setPosition` stamp, not
  a signal -- one signal per voice would allocate and defeat the whole pitch.

## Ecosystem

The `lite-di-*` line is a self-healing, zero-GC backend/service kernel: `container` is the
graph, `supervisor` the self-heal, `health` the readout, `signal` the reactive surface,
`ticker`/`cron` the two clocks, `event-bus` the fan-out, `strategies` the read-path
selector, `graph` the introspection. This demo hosts a real `@zakkster/lite-audio` graph
inside that kernel. See `../market-map/` for the ingestion-firehose sibling.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
