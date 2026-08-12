# market-map -- a `@zakkster/lite-di-*` skeleton demo

A **skeleton**, not a product: a real-time market-data / telemetry ingestion kernel
built from the actual `lite-di-*` packages, running **in the browser** with a thin
Canvas2D order-book viz. It is the "hybrid" demo -- the headless kernel does the real
work; the visualization is the `ticker`/render showcase on top.

## Run it -- two processes

**1. The tick feed** (a zero-dep Node WebSocket server streaming synthetic ticks):

```bash
cd /Users/zakkster/Work/Portfolio/LiteLibrariesSuite/LiteDiContainer/diEcosystem/market-map
node feed-server.mjs            # ws://127.0.0.1:8100
```

**2. The page** (served from the **suite root** -- the import map uses root-absolute paths):

```bash
cd /Users/zakkster/Work/Portfolio/LiteLibrariesSuite
python3 -m http.server 8099 --bind 127.0.0.1
```

Then open: `http://127.0.0.1:8099/LiteDiContainer/diEcosystem/market-map/index.html`
(If the feed server is down, `lite-ws` sits in `reconnecting` with backoff -- graceful.)

No build step, no bundler. Every package is zero-dep single-file ESM, resolved in-browser
by the import map (di-* mains directly; `lite-raf` / `lite-signal` from
`LiteDiTicker/node_modules/`; `lite-ws` / `lite-ring-buffer` / `lite-gl` from their repos).

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
| **`lite-ws`** | the **real WebSocket feed**: `onMessage` pipes each tick to the bus (0-GC), while `status` / `latency` / `reconnectAttempts` stay coarse reactive signals; built-in reconnect + backoff. Selectable at runtime between the local `feed-server` and a **live Binance `@bookTicker`** stream (real bid/ask over wss, no auth) |
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

- **Done:** real WebSocket transport (`lite-ws`, incl. a live Binance feed), GPU rendering
  of both the tick cloud and the order book (`lite-gl` point + quad sinks).
- Subscribe to a real DEPTH stream (e.g. `@depth20`) instead of `@bookTicker` (top-of-book
  only) to drive the full ladder from real levels, not a synthesized spread.
- Grow `RING` toward `lite-gl`'s ~1M; offer the `graph` JSON (`toJSON`) as a downloadable
  performance profile; add a WebGL LINE sink for a thick price polyline.

## Honest caveats

With **Binance** selected the transport AND the top-of-book (`bid` / `ask` / `mid`) are
**real, live data**; the multi-level ladder is still synthesized around that best quote
(`@bookTicker` carries only the top). With **local** selected, `feed-server.mjs` streams a
synthetic random walk. Either way it shows the **architecture and package composition** at
real firehose rates -- not a trading system.
