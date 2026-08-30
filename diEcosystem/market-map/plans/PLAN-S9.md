# Session 9 -- The pooled watchlist

## 1. SPEC

**Goal.** Subscribe/unsubscribe churn at zero GC. Watchlist *remove* PARKS the symbol's VM (`releaseReactive`, `SignalDecorators.js:1791`); *re-add* REVIVES the same object (`reinitReactive`, `:1835`) with fresh initials pulled from the live feed. The child scope, its registry, and its `defineReactive` wrapper class all SURVIVE the park -- `scope.shutdown()` stays the S8 death story and is never fired by a watchlist remove. Plus: a `costOfInstance` row per symbol in the perf panel, and `snapshotOf` as a JSON share/save.

**Acceptance gate (headless, `--expose-gc`).** 8 symbols x 512 = **4096** add/remove cycles:
`poolGrowths` delta **0**; `activeNodes` and `activeLinks` back to the **exact** pre-loop baseline; `totalAllocations` delta **=== `totalDisposals` delta** (conservation); major GC **0**; VM identity `===` stable across all 4096 revivals; the exported snapshot round-trips **after the signal/local filter**.

**The one contract that bites.** `snapshotOf` INCLUDES derived members (`:2019-2020`); `reinitReactive` REJECTS any initials key that is not `@reactive`/`@localTo` (`:1848-1852` -> throw at `:454`). Round-trip without a filter throws. The roadmap gate text at `ROADMAP-DEMO.md:352-353` does not say this. Planned explicitly as T6.

**State at HEAD (verified).** `market-map/` holds exactly `index.html`, `kernel.js`, `feed-server.mjs`, `README.md`. There is **no** `test/`, **no** `package.json`, **no** perf panel (only the "Kernel" group, `index.html:390-399`), and **no** `@zakkster/lite-signal-decorators` in the import map (`index.html:7-26`). S5/S6/S8 are unlanded; every S9 task below names the seam it needs.

## 2. TASKS

**T1 -- `index.html:7-26` (importmap): pin the decorators.**
Add `"@zakkster/lite-signal-decorators": "https://esm.sh/@zakkster/lite-signal-decorators@1.5.0"`. Note every existing entry (`:10-24`) is **version-less** -- an unpinned esm.sh can serve a pre-1.5.0 build with no `releaseReactive`. DoD `ROADMAP-DEMO.md:377` requires the pin. ASCII-only.

**T2 -- `kernel.js:bootKernel` (cold, boot): capability assert.**
Before wiring the watchlist, check `typeof releaseReactive/reinitReactive/costOfInstance/snapshotOf === 'function'`; on failure throw a named error that surfaces in the existing `#err` block (`index.html:485-490`). Fail closed at boot, not on first click.

**T3 -- NEW `market-map/watchlist.js`: the park/revive plane. HAND-ROLL, not `createFleet`.**
Export `createWatchlist({ scopes, SymbolVMOf, lastTickOf, capacity })`.

*Decision -- hand-roll. Three grounds:*
1. `createFleet` **owns its own registry** (`createRegistry` at `:2454`) and **destroys it** in `dispose()` (`:2547`). That collides head-on with the S8 law "one scope = one scoped registry" (`ROADMAP-DEMO.md:328-330`) and with `scope.shutdown()` as the single teardown line (`:335`) -- two owners, ambiguous teardown.
2. Capacity is **fixed at construction with eager prefill of every member** (`:2449-2450`, `:2465-2472`); the watchlist is user-driven and sparse.
3. The fleet keys identity by an opaque slot `STAMP` (`:2455`, `:2467`); the demo keys by ticker symbol and must expose *that* identity to S10's `labelOf`.

*What we reuse verbatim:* `capacityFor` (`:2308`) to size each scope registry, and `fleetAcquire`'s fail-closed ordering (`:2497-2505`) -- run the fallible `reinitReactive` FIRST, mutate the index only after it returns.

Members:
- `RESET_KEYS` -- module-frozen array of the SymbolVM **signal + local** keys only (`bid`, `ask`, `last`, `alertThreshold` per `ROADMAP-DEMO.md:326-333`); deriveds `mid`/`spread` excluded. Derived from the SAME spec literal S8 hands `defineReactive` -- one source of truth, not a second hand-typed list.
- `initialsScratch` -- ONE preallocated object whose own keys are exactly `RESET_KEYS`. `reinitReactive` reads via `hasOwnProperty` (`:1865`, `:1886`), so overwriting the scratch in place is zero-alloc per revive. **Hot path.**
- `add(sym)` -- first sighting: cold-construct scope + wrapper + VM (S8 seam). Thereafter: fill scratch from `lastTickOf(sym)`, `reinitReactive(vm, scratch)`, then flip the live flag. **Hot path.**
- `remove(sym)` -- `releaseReactive(vm)`; entry, scope, registry, wrapper class all retained. `false` return is the idempotent park->park signal (`:1795`) and means "already parked", NOT an error. **Hot path.**

**T4 -- `kernel.js`: wire the watchlist + a `lastTick` per symbol.**
Register the watchlist as a container value beside `agg` (`kernel.js:384-390`); feed initials from the existing `bus.on('tick', ...)` fan-out (`:394`) into a preallocated per-symbol tick record. Do not add a `c.get()` to `RenderSystem.update` (`:353-362`) -- mirror the `activeSock` cached-ref discipline at `:415-425`.

**T5 -- `kernel.js`: `readWatchlist(out)` -- the `costOfInstance` HUD row. COLD ONLY.**
`costOfInstance` is **uncached by design** (`:2197`) and allocates one frozen object per call (`:2252`). Do NOT call it from `readState()` (index.html polls that every 120ms at `:518`). Sample at 1 Hz or on add/park transitions only, writing into a preallocated per-entry row record. A PARKED vm **throws** (`:2218`) -- gate on the entry's own live flag and render `parked`; never try/catch into a blank.

**T6 -- `watchlist.js`: `exportWatchlist()` + `importWatchlist(json)` + the MANDATORY filter.**
Export: `snapshotOf(vm)` per LIVE entry (`:2031`; throws on parked at `:2037` -- emit `{parked:true}` instead), `JSON.stringify`. Import: `toInitials(snap, scratch)` copies **only** `RESET_KEYS` into the scratch, dropping `mid`/`spread`; then `releaseReactive` (if live) -> `reinitReactive(vm, filtered)`. The filter is a named exported function so the test can assert the unfiltered path throws.

**T7 -- `index.html`: watchlist panel + perf rows.**
List rows with an x button; perf rows `wl-cycles`, `wl-poolgrowths`, `wl-nodes-delta`, and per-symbol `nodes/links`. Cache every row element ONCE at row creation, mirroring the `el` cache at `:509-515`. No `innerHTML` in a loop; no `offsetWidth`/`getBoundingClientRect` read inside the update (no forced reflow).

**T8 -- NEW `market-map/test/09-watchlist.test.mjs`** (`node:test`, `node --expose-gc`): the gate below. Needs the S6 seam (`test/` + resolvable bare specifiers); if S6 has not landed, T8 also adds a private `package.json` with the devDeps -- the import map does not exist in Node.

**T9 -- `README.md` caveats.** Park-vs-dispose (`releaseReactive` is reversible, `disposeReactive` terminal, `:1788-1789`); snapshot-includes-deriveds -> filter; the `costOfInstance` live-vs-probe link delta (`:2181-2190`) stated as a feature, verbatim.

## 3. ASSERTIONS

1. **Churn / GC budget.** Over 4096 cycles: `poolGrowths` delta `=== 0`; `activeNodes` `===` baseline **exactly**; `activeLinks` `===` baseline; `totalAllocations` delta `=== totalDisposals` delta. `maxMajor === 0`; heap delta / 4096 `<= 64` bytes-per-cycle with `gc()` at both fences.
2. **Retention, non-vacuous.** `tracker.size() === 0` after 4096 cycles + `scope.shutdown()`, and -- the anti-vacuity step -- `tracker.size() >= 8` asserted **mid-run** while the watchlist is full. A gate that only tracks then untracks is a tautology.
3. **Identity.** `watchlist.vmOf('BTCUSDT')` is `===` to the object captured before cycle 1, at cycles 1, 2048, and 4096. Wrapper class identity also `===` (no per-revive `defineReactive`).
4. **Cost row is a live number.** `costOfInstance(vm).nodes === costOf(Class).nodes` after every derived is read once (A1 parity, `:2188`), and equals `P+L+D+E+1` (`:2132`) -- with S8's spec that is `3+1+2+1+1 = 8`; a full 8-symbol watchlist reads 64 nodes. `costOfInstance` on a PARKED vm **throws** `ReactiveDisposedError` (`:2218`).
5. **Round-trip.** `importWatchlist(exportWatchlist())` restores every signal/local value bit-identically and leaves `activeNodes` unchanged; and the negative: `reinitReactive(vm, rawSnapshot)` **throws** with a message naming `mid` (`:454`), proving the filter is load-bearing and not decorative.

## 4. CROSS-SESSION DEPENDENCIES

- **Consumes S8** -- seams: the per-scope `defineReactive` wrapper class (must be created once at first sighting and **retained across park/revive**; a class per revive would re-probe `costOf` and churn), the scope's own registry from `useScopedSignals(c, {createRegistry})` (`kernel.js:383`), and the frozen-default-registry invariant. S9 must not fire `scope.shutdown()` on remove.
- **Consumes S5** -- the perf panel rows. **Does not exist at HEAD**; nearest anchor is the "Kernel" group (`index.html:390-399`) and the `el` cache (`:509-515`). If S5 slips, T7 adds the group itself.
- **Consumes S6** -- the leak-gate harness + `test/`. **Does not exist at HEAD**; T8 carries the fallback.
- **Produces for S10** -- a stable `symbol -> {vm, scope, registry, live}` map, which is exactly the label source `toDot({labelResolver})` + `labelOf` (`:2670`) needs, plus the snapshot JSON as the dot caption.

## 5. RISKS / OPEN

- **The snapshot filter is the one real roadmap-text gap** (`ROADMAP-DEMO.md:352-353` says only "round-trips"). Without T6 the gate is unachievable as written. Recommend the roadmap line be amended to "round-trips through the signal/local filter".
- **`capacityFor` vs `costOfInstance` sizing.** `capacityFor` -> `costOf` **forces every derived** to report the ceiling (`:2090`); `costOfInstance` reports what has actually formed and reads **below** it until the graph is exercised (`:2186-2190`). Sizing a registry from the HUD's `costOfInstance` number would under-size and trip `onCapacityExceeded: "throw"` mid-session. Size from `capacityFor` only; the HUD number is display, never config. If a fixed capacity is wanted, add `headroom: 1.25` (`:2317-2321`) -- never derive it from the live probe.
- **Unpinned esm.sh specifiers** (`index.html:10-24`) make the whole demo version-drift-prone; T1+T2 close it for decorators only. Pinning the other 14 is out of S9 scope but worth a ticket.
