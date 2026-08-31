# LAUNCH -- market-map

Three ready-to-post write-ups of the same story, for three audiences. ASCII-only.
Each carries the live URL and the one-line claim so it stands alone if copied.

- **Live:** https://zakkster.github.io/LiteDiContainer/diEcosystem/market-map/
- **One-line claim:** A self-healing, zero-GC market-data kernel that runs in the
  browser -- 15 zero-dependency single-file ESM packages, no bundler.
- **Repo:** https://github.com/PeshoVurtoleta/lite-di-container (demo under
  `diEcosystem/market-map/`)

Note: the hero GIF (`./assets/kill-feed.gif`) and the filled-in perf numbers are
captured by the owner before posting; the r/javascript variant leads with the GIF.

---

## 1. Hacker News -- Show HN

**Title:** Show HN: A zero-GC, self-healing market-data kernel in the browser, no bundler

**Body (~150 words):**

market-map is a live order-book demo built from 15 zero-dependency single-file
ESM packages, wired together by a ~2 KB dependency-injection container and served
with nothing but a static file host -- no bundler, no build step, no node_modules.

It is really a test of the container. The tick firehose (real Binance depth +
trades over a WebSocket) lands in a pow2 ring buffer, fans out through an event
bus, and drives a WebGL2 renderer at 0 bytes allocated per tick. Click "Kill
feed" and a supervisor faults the feed, tears down the dead socket in
reverse-topological order, and re-resolves a fresh one -- while the viewport
never blanks. The whole kernel also boots headless under node:test, so the
self-healing and teardown order are proven, not asserted in prose.

Every data cell is labelled real or synthetic. Live URL, source, and the design
ledger (including what was rejected) are all one click in.

---

## 2. r/javascript

**Title:** I built a real-time market-data kernel from 15 single-file ESM
packages -- no bundler, zero GC, and it self-heals on screen

[Lead with the hero GIF: click Kill feed -> `fault -> restart -> fresh socket`,
the restarts counter ticks up, the chart never blanks.]

The demo runs entirely in the browser off a version-pinned import map -- open the
page and it paints a live BTCUSDT order book in about 3 seconds, no install. Under
it is a dependency-injection container composing 15 zero-dep ESM micro-libraries:
a ring buffer for the tick firehose, an event bus fanning out decoded frames, a
handful of reactive aggregate signals (not one per tick -- that would allocate),
a cron for housekeeping, a supervisor + health check for the self-heal, and a
WebGL2 renderer selected by zoom.

The interesting part is what it refuses to do to stay zero-GC: no per-tick
signals, no aliased-scratch replay, no direct ring upload where the API cannot
support it. It is all in the design ledger (`REJECTED.md`).

You can export the booted dependency graph as a Chrome trace and open it in
**ui.perfetto.dev** to see the kernel's shape as a timeline. Live URL and source:
https://zakkster.github.io/LiteDiContainer/diEcosystem/market-map/

One line: a self-healing, zero-GC market-data kernel in the browser, 15
zero-dependency single-file ESM packages, no bundler.

---

## 3. js-reactivity-benchmark / Andrii channel (3 sentences)

I put together a browser demo that stress-tests a tiny DI container by running a
real Binance order-book firehose through a ring buffer, an event bus, and a
handful of reactive aggregate signals at zero bytes allocated per tick -- and it
self-heals a killed WebSocket on screen without dropping a frame. The reactive
layer is deliberately a few aggregate signals over a ring, not one signal per
tick, precisely because per-message allocation is the trap this class of demo
usually falls into. Live, no install, no bundler:
https://zakkster.github.io/LiteDiContainer/diEcosystem/market-map/
