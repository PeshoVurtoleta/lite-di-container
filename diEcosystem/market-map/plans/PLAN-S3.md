# Session 3 -- Container flagship features on screen

## 1. SPEC

**Goal.** `scope()`, `rebind()` and `shutdown()` each get a button, a visible effect, and a log line. Multi-symbol via child scopes (each symbol owns feed/book/tape/agg + its own `lite-di-signal` registry); post-boot renderer hot-swap via `rebind`; full reverse-topological kernel teardown + re-boot; `refs.stats` (kernel.js:134) moves into the container as a value so two boots never share counters.

**Acceptance gate (measurable).**
- G1: two symbol tabs open, `Kill feed` on the active tab only -- the *other* tab's ingest continues (its `tickCount` keeps rising) and the shared render loop's frame delta stays under **2x median** for the whole heal window (eyeball via DevTools Performance until S5 pins it).
- G2: open+close one symbol tab **50x**; JS heap after a manual GC returns to within **+5%** of the post-first-close baseline; graph nodes (`readState().nodeCount`) returns to the exact pre-open integer each cycle.
- G3: `Shutdown kernel` logs the teardown lines in reverse resolution order, canvases show `SHUT_DOWN`, `Boot` restores a live kernel with `restarts=0` and cron counters back at `0` (proves G4).
- G4: `?faultyTeardown` produces one `teardown-error:` line **and** the remaining teardown lines still fire (isolation), then `AggregateError` is reported, not thrown into the console.

## 2. TASKS

Ordered, atomic. `[HOT]` = touches a per-frame body; those must stay allocation-free.

**A. Container-owned stats (finding 12)**

1. `kernel.js:134` -- delete the module-level `const refs = {...}`. In `bootKernel`, register `c.value('stats', {pruned: 0, aggregations: 0, heartbeats: 0})` next to `c.value('viz', viz)` (kernel.js:381-382).
2. `kernel.js:135-152` -- `AggregateJob` / `PruneJob` / `HeartbeatJob` take `stats` as a constructor dep (`this.stats = stats`); `run()` increments `this.stats.*`. Register via `cron.job('aggregate', AggregateJob, interval(5000), {deps: ['stats']})` -- *coder to verify the deps-in-opts signature against lite-di-cron (memory note: "Cron.job deps go in opts")*.
3. `kernel.js:516` -- `readState()` returns `jobs: c.get('stats')` resolved **once** into a local `const stats` before the return-object closure (no `get` per HUD tick).

**B. Per-symbol child scopes (finding 7)**

4. `kernel.js` -- new `createSymbolScope(parent, {symbol, url, bus? , log})` cold factory. Body, in order:
   - `const s = createSignalScope(parent, {createRegistry})` (DiSignal.js:231) -- the registry resolves eagerly to `_resolutionOrder[0]`, so it is torn down **LAST**. Do **not** use `parent.scope()` + manual registry.
   - `s.value('symbol', symbol)`, `s.singletonFactory('tape', () => new RingBuffer(RING))`, `s.singleton('book', OrderBook)`, `s.singletonFactory('agg', (sc) => new Aggregates(rxOf(sc)))`.
   - **Do not use `s.value()` for tape/agg.** Confirmed at Container.js:237 -- `TYPES.VALUE` returns before the `isCached` block (Container.js:255-258), so a value is *never* pushed to `_resolutionOrder` and is **never torn down or logged**. Every per-scope binding that must appear in the teardown log has to be `singleton` / `singletonFactory`.
   - Per-scope `EventBus(s)` with `on('tick', BookApply,['book']).on('tick', TapeApply,['tape']).on('tick', AggApply,['agg'])`, then `s.boot(); bus.boot();` (EventBus.js:157 refuses `on()` after boot -- topology is boot-locked per scope).
   - Per-scope `createSocketFactory(scopeRegistry)`, `s.value('makeSocket', ...)`, `s.singleton('feed', Feed, ['makeSocket'])`, `s.onTeardown('feed', f => {scope.activeSock = null; f.dispose();})` (mirrors kernel.js:426-432).
   - Per-scope `Supervisor(s, {children:['feed'], ...})` + `Health` source, so `killFeed()` faults **one scope only**.
5. `kernel.js:365` `bootKernel` -- replace the single global feed/book/tape/agg registrations (kernel.js:383-394, 398-432, 444-459) with: parent keeps `viz`, `stats`, the three renderers, ticker, cron, graph; a `scopes = new Map()` of symbol -> scope handle; `activeSymbol`.
6. `kernel.js:344-363` `RenderSystem` **[HOT]** -- deps become `['viz']` only. Add `viz.active` = a **single pre-allocated holder object** `{book, tape, agg, feedPoll, sock}` mutated on tab switch (cold). `update()` reads `const a = this.viz.active; if (!a) return;` then `a.feedPoll()`, `a.tape.count`, `a.tape.copyTo(...)`, `r.draw(v, a.book, v.scratch, n)`. **No `c.get` per frame, no object literal, no closure allocation in `update()`.**
7. `kernel.js:470-478` `viz.feedPoll` -- move into `viz.active.feedPoll`, one closure per scope created at scope open (cold), never per frame.
8. Handle API: `addSymbol(sym, url)`, `closeSymbol(sym)`, `setActive(sym)`, `symbols()`. `closeSymbol` = `await scope.shutdown({onTeardownError})` then `scopes.delete(sym)`; if it was active, `setActive` to the first remaining (or `null` -> `viz.active = null`, render loop idles). Container.js:956 refuses a parent shutdown while a child is live, so `closeSymbol` MUST run before kernel shutdown; sequence children first in task 12.
9. `index.html` -- symbol tab strip above the stage (`BTC | ETH | +add`), `+add` prompts for a symbol, each tab a close `x`. Reuse tab DOM elements from a pool; never rebuild the strip wholesale.

**Log lines (exact):**
```
scope: BTCUSDT opened -- child scope + own signal registry (5 bindings)
scope: BTCUSDT closed -- teardown: feed -> agg -> tape -> book -> signal-registry
scope: BTCUSDT registry destroyed -- 4 reactive nodes released
```

**C. Rebind hot-swap (finding 8)**

10. `kernel.js:390` -- keep `renderer:gpu` a `value` and add `class GLRendererV2 extends GLRenderer` with a different point size / palette (or wire a `parser` variant). Handle gains:
```js
async swapRenderer() {
  await c.rebind('renderer:gpu', {type: TYPES.VALUE, value: new GLRendererV2(), isAsync: false});
  log('rebind', 'rebind: renderer:gpu -> v2 (post-boot hot-swap, GAP-3)');
}
```
Import `TYPES` from `@zakkster/lite-di-container` (exported, Container.js:1184). Entry shape confirmed against `test/Container.rebind.test.js:196`. No router change needed: `StrategyRouter.resolve()` is `container.get(select(input))` (Strategies.js:207-208), so the next frame picks up the new instance -- **flag: zoom must be >= 2.2 for the swap to be visible**; the button should log a hint if `viz.zoom < 2.2`.
11. `index.html` -- `Swap renderer build` button in `.controls` (near kernel.js:411's kill button block).

**D. Kernel shutdown + boot (finding 9)**

12. `kernel.js` handle -- `async shutdown()`: (a) `ticker.stop(); cron.stop(); clearInterval(tpsTimer)`; (b) `for (const sym of scopes.keys()) await closeSymbol(sym)` -- children first (Container.js:956); (c) `await c.shutdown({onTeardownError: (err, name) => log('escalate', 'teardown-error: ' + String(name) + ' -- ' + err.message)})`; (d) `onMode('shut')` -> overlay. Wrap each parent teardown hook to `log('down', 'teardown: ' + name)` so the walk narrates itself; the walk is reverse `_resolutionOrder` (Container.js:963).
13. `index.html` -- `Shutdown kernel` / `Boot` buttons (one toggling pair), plus a `SHUT_DOWN` overlay div over the stage (CSS only; do not clear the canvas mid-frame -- the loop is already stopped).
14. `index.html` boot flow -- extract the IIFE body into `async function boot()` so `Boot` re-invokes `bootKernel` with the same `ctx/gl`; the HUD interval must null-guard `handle`.
15. `kernel.js` -- `?faultyTeardown` (read `new URLSearchParams(location.search)` **once**, at boot, cold): when set, register `c.onTeardown('book', () => { throw new Error('injected teardown fault (?faultyTeardown)'); })` on one parent binding. Dev-only, never on the hot path.

**Log lines (exact):**
```
shutdown: kernel draining -- children first
teardown: feed[BTCUSDT]
teardown: ticker -> cron -> feed[BTCUSDT] -> book -> signal-registry
teardown-error: book -- injected teardown fault (?faultyTeardown)
shutdown: complete -- 1 of 7 teardowns failed (AggregateError, isolated)
boot: kernel re-registered -- N graph nodes wired
```

## 3. ASSERTIONS

1. **Teardown order is reverse resolution order.** With one symbol open and `?faultyTeardown` off, the `teardown:` lines appear in exactly the reverse of the order the names were first resolved, and the child's `signal-registry` line is **last within its scope** -- because `registerSignalRegistry` eagerly `get`s the token (DiSignal.js:200), pinning it at `_resolutionOrder[0]`, and `shutdown()` walks `i = length-1 -> 0` (Container.js:963).
2. **AggregateError isolation is observable.** Under `?faultyTeardown`, exactly one `teardown-error:` line appears AND the count of `teardown:` lines is unchanged versus a clean run (Container.js:980-991 catches per instance). With `onTeardownError` supplied, `shutdown()` resolves (no throw) -- Container.js:1006.
3. **`refs.stats` is no longer module-global.** `grep -n "^const refs" kernel.js` returns nothing; two `bootKernel()` calls in one page yield independent counters -- after `Shutdown` + `Boot`, `aggregations` reads `0`, not the pre-shutdown value.
4. **Values are not torn down.** Any binding expected in the teardown log is `singleton`/`singletonFactory`; `c.value('viz'|'stats'|'renderer:*')` produce **zero** `teardown:` lines (Container.js:237 returns before Container.js:255).
5. **Rebind is atomic and visible in one frame.** After `swapRenderer()`, `c.get('renderer:gpu') instanceof GLRendererV2` is true and the router needs no reconfiguration (Strategies.js:13-17). A failed rebind (bad entry) leaves `c.get('renderer:gpu')` as the v1 instance (Container.js:1139-1175, all checks before any mutation).
6. **Zero-alloc render loop.** `RenderSystem.update()` contains no object/array/closure literal and no `container.get`; `viz.active` is one holder mutated only on tab switch.

## 4. CROSS-SESSION DEPENDENCIES

**Consumes**
- **S1 seam**: `makeSocket` / `SOURCES` / `sim://random-walk` duck-typed socket -- now created *per scope*, so the S1 failover path must be re-armed per symbol (each scope's supervisor escalates independently). S1's `pushLog` element-based rewrite is a prerequisite for the higher log volume this session produces.
- **S2 book/tape**: `parseFrame` + real `depth20`/`aggTrade` -- per-scope `book` and `tape` (and the S2 second `trade` bus channel) are registered inside `createSymbolScope`, one stream URL per symbol.

**Produces (seams other sessions attach to)**
- `createSymbolScope(parent, opts)` -- the child-scope factory. **S8 attaches its `SymbolVM` (`defineReactive`) to THIS session's per-symbol scope**, bound to the scope's own registry via `useScopedSignals`/`createRegistry` (DiSignal.js:211) so the DEFAULT registry stays frozen; `scope.shutdown()` then proves registry-destroy + `disposeReactive` in one line -- the log line from task B/9 is the one S8 extends.
- `viz.active` holder -- S5's per-scope perf rows read frame deltas through it; S4's GPU line/depth-curve draws from `a.tape` unchanged.
- `handle.shutdown()/boot()` -- S6's headless teardown-order test and the 256-scope churn gate call exactly these, with `ctx: null`.
- `stats` container value -- required by S6 for parallel headless boots.

## 5. RISKS / OPEN (coder must have these decided)

1. **Bus placement.** Plan says one object `EventBus` per scope (topology is boot-locked, EventBus.js:157, and per-symbol handlers need per-symbol deps). The RECORDER is the S1 numeric `traceBus`, not the object `bus` (settled: live object bus is never recorded). Decide `traceBus` ownership: **one `traceBus` per scope** (recommended -- each symbol's price line replays independently; `readState().recorded` reports the active scope only), with `setActive` swapping which scope's `traceBus.replay()` the Replay button drives. Each per-scope `traceBus` needs `onTeardown -> dispose()` so the 50x churn gate (G2) stays clean.
2. **Ticker/cron ownership.** Single parent ticker driving `viz.active` (chosen: one render loop, no per-scope RAF). Non-active scopes still ingest (their `feedPoll` must be pumped) -- either poll all scopes' sockets in `update()` (a small bounded loop over a preallocated array, still zero-alloc) or give each scope its own cron-driven poll. **Decide before task 6; this is the G1 gate.**
3. **Supervisor per scope vs one parent supervisor with `children: ['feed@BTC', ...]`** -- per-scope chosen (kill-feed must be scope-local), but restart budgets then multiply; confirm `Supervisor` accepts a child scope container. *Coder to verify against lite-di-supervisor 1.0.0.*
4. **`EventBus.dispose()`** (EventBus.js:487) is not automatically wired to scope teardown -- register `s.onTeardown` for it explicitly or it leaks the recorder ring across the 50x churn gate (G2).
5. **GL sinks stay on the parent** (`viz.glSink`, capacity `RING`/`LVL*2`) and are shared across symbols -- correct while only the active scope draws; revisit if S4 draws two symbols at once.
6. **`rebind` on a `VALUE`**: `invalidate()` is a no-op for values (nothing cached), so the swap is instant, but the OLD `GLRendererV2` instance is never torn down -- if the v2 renderer ever owns GL resources, register it as `singletonFactory` + `onTeardown` instead.
