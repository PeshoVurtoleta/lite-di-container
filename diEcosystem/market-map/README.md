# market-map -- a `@zakkster/lite-di-*` skeleton demo

A **skeleton**, not a product: a real-time market-data / telemetry ingestion kernel
built from the actual `lite-di-*` packages, running **in the browser** with a thin
Canvas2D order-book viz. It is the "hybrid" demo -- the headless kernel does the real
work; the visualization is the `ticker`/render showcase on top.

## Run it

**Live (nothing to install):** https://zakkster.github.io/LiteDiContainer/diEcosystem/market-map/

It opens cold and paints a moving price trace + order-book ladder within ~3s. The default
feed is a **live Binance BTCUSDT** stream; if that socket is unreachable, a supervised
watchdog degrades to an **in-page simulation** within ~5s (watch the event log) -- so the
demo is never a blank canvas.

**Run locally** -- serve *this directory* over any static server:

```bash
python3 -m http.server 8099 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8099/` from within this folder. The import map is pinned to
published packages on a CDN, so no `node_modules` and no build step are needed -- just a
static file server.

**Optional local feed** -- a zero-dep Node WebSocket server streaming synthetic ticks, for
offline work against a controllable source:

```bash
node feed-server.mjs            # ws://127.0.0.1:8100
```

Then pick **local (feed-server)** in the feed selector.

No build step, no bundler. Every package is zero-dep single-file ESM, resolved in-browser
by a version-pinned import map (see the comment above the map in `index.html` for the
pin-bump procedure).

## What each package does here

| Package | Role in the demo |
| --- | --- |
| `lite-di-container` | the graph: scopes, values, singletons, boot-time validation (17 nodes) |
| `lite-di-event-bus` | 0 B/emit fan-out of each decoded tick to book / tape / aggregate handlers; **records** the session for replay |
| `lite-di-signal` | the reactive control surface -- a **handful** of aggregates (mid / bid / ask / spread), NOT one signal per tick |
| `lite-di-ticker` | the rAF render loop driving the repaint |
| `lite-di-strategies` | selects the renderer by zoom: coarse Canvas2D -> detailed Canvas2D (price labels) -> **lite-gl GPU** past 2.2x -- read-path, 0 B/op |
| `lite-di-cron` | wall-clock housekeeping: rolling aggregation, stale-array prune, heartbeat ping |
| `lite-di-supervisor` | watches the feed subsystem; on a fault it re-resolves a **fresh socket** without dropping the render loop |
| `lite-di-health` | `readyz` / `livez` over the feed + supervisor |
| `lite-di-graph` | exports the booted dependency graph (node count / a JSON profile) |
| **`lite-ws`** | the **real WebSocket feed**: `onMessage` pipes each decoded frame to the bus (0-GC), while `status` / `latency` / `reconnectAttempts` stay coarse reactive signals; built-in reconnect + backoff. Selectable at runtime between a **live Binance combined stream** (default; `@depth20@100ms` + `@aggTrade` + `@bookTicker` over wss, no auth), an **in-page simulation** (synthetic random walk, the supervised failover), and the local `feed-server` |
| **`lite-ring-buffer`** | the pow2, bitmask-wrap `Float32Array` tick ring -- the 0-GC hot data the firehose lands in |
| **`lite-gl`** | instanced WebGL2 renderer: the tick cloud via `createPointSink` **and the depth ladder via `createQuadSink`** (the whole order book on the GPU); scales to ~1M primitives |

The headline beat: click **Kill feed** -- the supervisor faults the feed subsystem, tears
down the old `lite-ws` socket, and re-resolves a fresh one (restarts++, transport
`reconnecting` -> `open`) while the viewport keeps rendering. That is the golden niche in
miniature: self-healing, fail-closed, zero-GC steady state -- over a real socket.

## Corrected architecture (vs the naive mapping)

- The tick **firehose lands in a `lite-ring-buffer`** (pow2 `Float32Array`, bitmask wrap)
  -- 0-GC hot data. `lite-di-signal` holds only aggregates. One signal per tick would
  allocate and defeat the whole pitch (`lite-ws` exists precisely to avoid that trap).
- `strategies` **selects** a pre-registered renderer; it does not hot-swap (that is
  `container.rebind`). `event-bus` **fans out** already-decoded ticks; the socket read is
  `lite-ws`'s `onMessage` pipe upstream.

## Seams to turn this into a product (grep `SEAM:` in `kernel.js` / `feed-server.mjs`)

- **Done:** real WebSocket transport (`lite-ws`, incl. a live Binance combined feed); a REAL
  20-level depth ladder (`@depth20@100ms`) and a REAL trade tape (`@aggTrade`) off the wire,
  driving the full ladder from real levels instead of a synthesized spread; GPU rendering of
  the tick cloud, the trades and the order book (`lite-gl` point + quad sinks).
- Grow `RING` toward `lite-gl`'s ~1M; offer the `graph` JSON (`toJSON`) as a downloadable
  performance profile; add a WebGL LINE sink for a thick price polyline.

## Honest caveats

With **Binance** selected the transport, the top-of-book (`bid` / `ask` / `mid`), the
**20-level ladder** (`@depth20@100ms`) and the **trade tape** (`@aggTrade`) are all **real,
live data** -- the ladder is drawn from real depth levels and every trade dot is a real
aggregated trade off the wire. The dense price trace comes from the combined `@bookTicker`
quote; a live quote never overwrites the real depth ladder -- the ladder is fabricated only
when no real depth is arriving (the simulation). `@depth20` is consumed as a
**partial-book snapshot**: each frame replaces the top 20 levels wholesale, with no `U`/`u`
diff-sequence maintenance or resync (that is what keeps the apply zero-allocation).

The **simulation** source is fully synthetic and fabricates its ladder from a single quote,
so the HUD `ladder` row reads **SYNTH** -- it is the labeled in-page failover used when the
live socket is unreachable, never presented as real data. With **local** selected,
`feed-server.mjs` streams synthetic depth + trade frames in the exact Binance shape, so the
ladder is driven from real depth arrays (HUD reads **WIRE**) even though the underlying
numbers are synthetic; only the live Binance feed is real market data. Either way it shows
the **architecture and package composition** at real firehose rates -- not a trading system.

## Perf & exports

The **Perf & soak** HUD group makes the zero-GC / self-healing claims measurable on
screen: `fps`, frame `p99` (a histogram over the newest 600 frame deltas at 0.25 ms
bucket resolution -- no per-frame sort, no allocation), `worst frame`, `long tasks`
(via a `longtask` `PerformanceObserver`; reads `n/a` where the API is unsupported),
`ring` occupancy (saturates at `100%` and stays there -- a falling number would mean the
firehose ring is being reallocated), `uptime`, `restarts`, and an optional `heap` row
(Chrome-only, coarse; `n/a` elsewhere). The footer narrates a live soak line. **`Burst
x100 (10s)`** pumps 100 synthetic ticks per frame straight into the active scope's real
pipeline (tape + `signal` aggregates + `event-bus` + trace recorder), bypassing the
socket, so you can watch `p99` hold flat under two orders of magnitude more throughput;
the `quotes / s` row is tagged `(burst)` so a synthetic number is never read as wire rate.

Measured soak (desktop Chrome, GPU mode, 10-min Binance -- **pending the owner's DevTools
run; cells below are placeholders, not fabricated numbers**):

| metric | idle | under burst |
| --- | --- | --- |
| fps | _pending_ | _pending_ |
| frame p99 | _pending_ | _pending_ |
| worst frame | _pending_ | _pending_ |
| long tasks (> 50 ms, after 30 s warm-up) | _pending_ | _pending_ |
| tps (quotes+depth / s) | _pending_ | _pending_ |

The **graph export** row downloads the top-level kernel dependency graph via
`@zakkster/lite-di-graph` in three formats: `JSON` (`toJSON`), `DOT` (`toDOT`, Graphviz),
and `Chrome-Trace` (`toChromeTrace`). Load the trace at **ui.perfetto.dev** or
**chrome://tracing** (`market-map-graph.trace.json`). Note: the Chrome-Trace is
`lite-di-graph`'s documented **synthetic-timeline** mapping of the DI dependency graph
(`ts` = teardown rank, each edge a matched `s`/`f` flow pair) -- it visualizes the graph as
a trace, **not** a wall-clock frame profile. The export covers the parent container only;
each symbol tab is a separate child scope with its own graph.
