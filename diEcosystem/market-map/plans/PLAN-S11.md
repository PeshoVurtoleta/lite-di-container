# Session 11 -- The strategy plane: candles + Ichimoku + lite-headless notifications

## 1. SPEC

**Goal.** A per-scope TA (technical-analysis) plane: fixed-timeframe OHLC candles aggregated
from `f.mid` at the existing dispatch seam, an Ichimoku Cloud evaluator selected by a
per-scope `StrategyRouter` (`lite-di-strategies` finally selecting a TRADING strategy --
tokens `ta:off | ta:ichimoku`, mode global, one strategy at a time, off-able), and
edge-triggered STRONG BUY / STRONG SELL signals surfaced through a new injectable
`{onSignal}` bootKernel sink into `@zakkster/lite-headless` `toast` + `notification-center`
in index.html. Strategies re-target on symbol switch BY CONSTRUCTION: the plane and the
evaluator are per-symbol scope bindings (`createSymbolScope`, `kernel.js:1049`), and
`streamUrl()` (`index.html:799`) already synthesizes the Binance combined stream for ANY
symbol. Signals are the textbook indicator definitions for a demo -- one README line says
so; this is not trade advice.

**Acceptance gate (headless, `--expose-gc`).** `applyMid` 1M iters: post-gc heap growth
< 64 KB, all four candle-ring `ArrayBuffer` identities stable. `roll` 200k warm bars on
flat mids in mode `ichimoku`: growth < 64 KB, ZERO signals emitted. Deterministic fixture
suite: exactly ONE buy signal on the ramp fixture (edge, correct payload), zero before 78
closed bars (WARMING), zero in mode `off`, zero on the negative-control fixture (chikou
violated), cooldown suppression proven, two scopes warm independently, a PARKED scope
still evaluates and emits without a vm read. Existing gates stay green: `npm run verify`
(test + torture + alloc + churn) with `teardown.test.mjs` UNCHANGED.

**The contract that bites (x3).**
1. A parked VM throws on EVERY accessor (S9). The TA plane must never read `vm` -- it owns
   its rings and is deliberately NOT `feedGate`-gated, so watchlist symbols keep evaluating
   while parked. Evaluators read the plane only.
2. Stale-edge false signals: an evaluator that did not run on bar `i-1` (mode was `off`)
   must RE-ARM SILENTLY on bar `i` -- resync `prevState` to the current state, no emission.
   Rule: `if (this.lastBar !== plane.barIndex - 1) { resync; }`. Fail closed: an edge
   computed against a stale prev is not an edge.
3. Wall-clock stalls (hidden tab throttling, laptop sleep -- the S5 lesson): `roll(now)`
   catch-up is BOUNDED. Behind by more than `TA_RING` bars -> reset rings, re-enter
   WARMING, `log('degrade', ...)` once. Honest re-warm beats fabricated flat bars.

**State at HEAD (verified).** Dispatch seam `kernel.js:1124` (TAG_DEPTH and TAG_QUOTE both
carry `f.mid`); burst seam `inject(mid,bid,ask)` at `:1157` drives the SAME dispatch (the
deterministic test pump); per-scope cron `scron` at `:1281` (tickMs 100, jobs poll/failover/
rate); eager resolves `:1292-1298`; scope handle return `:1307`; `state()` `:1317`;
`bootKernel` opts `:1408`; `?ring` param pattern `:1437-1442`; renderer StrategyRouter idiom
`:1665`. Bus systems are `constructor(deps) + handle(f)` classes (`:370-407`); cron jobs are
`constructor(dep) + run()` classes (`:428-508`). De-risked THIS session: `@zakkster/
lite-headless@1.11.0` is on npm; `https://esm.sh/@zakkster/lite-headless@1.11.0/toast?deps=
@zakkster/lite-signal@1.5.0` returns 200 and imports `/@zakkster/lite-signal@1.5.0/es2022/
lite-signal.mjs` -- the import map's own pin, so ONE lite-signal instance (the S8 mechanism);
both factories (`createToast`, `createNotificationCenter`) import clean under plain node.
`versions.test.mjs:18` asserts every package.json dep's `name@version` substring appears in
the import map -- a `?deps=`-suffixed entry still contains it.

## 2. TASKS

**T1 -- `kernel.js`: constants + `TaPlane` (plain class, NON-reactive -- zero new
lite-signal nodes, S8/S10 count gates untouched).**
Constants table (ASCII): `TA_RING = 128` (pow2), `TENKAN 9, KIJUN 26, SENB 52, DISP 26`,
`TA_WARM = SENB + DISP` (= 78 closed bars), `TA_COOLDOWN_BARS = 30`, `BAR_MS_DEFAULT =
1000`, `TA_MODES = ['off', 'ichimoku']` (S12 appends `'alligator'`).
Members: four `Float32Array(TA_RING)` rings `o/h/l/c` + `head` + `count` + `barIndex`
(monotonic, never wraps) + open-bucket scalars `bo/bh/bl/bc/bucketOpen/barStart` + `barMs`.
- `applyMid(mid)` **[HOT]**: bucket closed -> open it (`bo=bh=bl=bc=mid`); else 2 compares
  + 1 store. No time read here -- `barStart` is stamped by `roll`.
- `roll(now)` (cold lane, `run()`-driven AND test-callable with a synthetic clock): first
  call stamps `barStart`; then `while (now - barStart >= barMs)`: close the bucket into the
  rings (no ticks this bar -> carry-forward `o=h=l=c=` prev close), `count++`, `barIndex++`,
  `barStart += barMs`, reopen at prev close, fire the evaluator hook. Bounded: behind by
  > `TA_RING` bars -> ring reset + WARMING + one `degrade` log (contract 3).
- Rolling `max(h,n)`/`min(l,n)` by O(n) backward ring scan at bar close ONLY (<= 52 iters
  at ~1 Hz -- smallest bytes win; no deque).

**T2 -- `kernel.js`: `IchimokuEval` + `TaOffEval` + the per-scope router.**
`TaOffEval` = frozen no-op `{evaluate() {}}` VALUE. `IchimokuEval` (singletonFactory,
per-scope state: `prevState`, `lastBar`, `cooldown`, plus preallocated readout fields
`tenkan/kijun/spanA/spanB/state`). At bar `i` (latest CLOSED, all reads from the rings):
- `tenkan = (maxH(9) + minL(9)) / 2`; `kijun = (maxH(26) + minL(26)) / 2`
- cloud AT the price (computed `DISP` bars back): `spanA_now = (tenkan(i-26) +
  kijun(i-26)) / 2`; `spanB_now = (maxH(52 @ i-26) + minL(52 @ i-26)) / 2`
- forward cloud: `spanA_fwd = (tenkan + kijun) / 2`; `spanB_fwd = (maxH(52) + minL(52)) / 2`
- chikou: `c(i)` vs `c(i-26)`
STATE +1 (strong bull) = `c > max(spanA_now, spanB_now) && tenkan > kijun && c > c(i-26)
&& spanA_fwd > spanB_fwd`; STATE -1 mirrors ALL FOUR inverted; else 0. EMIT only on
transition INTO +1/-1 with `cooldown === 0`; emitting sets `cooldown = TA_COOLDOWN_BARS`
(decrement per evaluated bar). Contract-2 silent re-arm first. `count < TA_WARM` ->
readout state 'warming', prevState resync, NEVER a signal, NEVER zero-valued spans in the
readout (null is not zero: HUD shows '--' until warm).
Router, mirroring `:1665`: `new StrategyRouter(s, {strategies: {off: 'ta:off', ichimoku:
'ta:ichimoku'}, gate: () => taCtl.mode})`; the plane's bar-close hook runs
`router.resolve(taCtl.mode).evaluate(plane, emitSignal)`. `taCtl = {mode: 'off'}` is a
bootKernel CLOSURE object handed to every scope -- NOT a container binding (zero parent-
graph delta; fresh per boot for free).

**T3 -- `kernel.js:createSymbolScope`: wiring.**
`s.singletonFactory('ta', () => new TaPlane(barMs))`; `s.value('ta:off', TA_OFF_EVAL)`;
`s.singletonFactory('ta:ichimoku', () => new IchimokuEval())`. `CandleApply {handle(f) {
this.ta.applyMid(f.mid); }}` as a FOURTH `bus.on('tick', CandleApply, ['ta'])` (`:1094`)
-- runs for depth AND quote frames, live, sim, and inject alike. `BarJob {run() {
this.ta.roll(performance.now()); }}` on `scron` at `interval(250)` (`:1281-1284`). Eager-
resolve `ta` right after `vm` (`:1294`). NO `onTeardown` for any ta binding: the plane is
passive state, not a disposable -- `teardown.test.mjs:52`'s `SCOPE_TEARDOWN` deepEqual
stays byte-identical (verify by RUNNING it, not by assumption). `emitSignal(side)` (cold,
edge+cooldown-bounded -- allocation permitted OFF the hot path): builds `{symbol, strategy,
side, price, bar, at}`, calls the scope's `signal()` forwarder AND `log('signal', msg)`.
Scope handle (`:1307`) gains `ta` (the plane) and `taEval` (the ichimoku instance) as test
seams; `state()` (`:1317`) gains `taState/taWarm/tenkan/kijun/spanA/spanB/taBars` read from
the plane + evaluator readout fields (gate readouts on warm -- contract 'null is not
zero').

**T4 -- `kernel.js:bootKernel`: opts + handle.**
New opts: `onSignal` (optional callback; absent = log-only, normal headless) and `barMs`
(explicit option wins; else `?bar=N` URL param mirroring the `?ring` pattern `:1437-1442`,
clamped `[250, 60000]`, else `BAR_MS_DEFAULT`; non-default logged once). Thread `barMs` +
`taCtl` + the `signal` forwarder through `createSymbolScope` opts (`:1626`). Handle
(`:1672`) gains `setTaMode(mode)` (validate against `TA_MODES`, else named throw -- fail
closed on a mis-shaped mode with the REAL cause; sets `taCtl.mode`; `log('heal',
'ta: strategy -> ' + mode)`) and `taMode()`. `readState()` (`:1688`) forwards the active
scope's T3 fields plus global `taMode`.

**T5 -- `package.json` + `index.html` import map: the headless pin.**
`"@zakkster/lite-headless": "1.11.0"` in dependencies + `npm i` (lockfile is TRACKED --
the S10 CI lesson). Import map (`index.html:21-37`) gains TWO subpath keys, both
`?deps=@zakkster/lite-signal@1.5.0`:
`"@zakkster/lite-headless/toast"` and `"@zakkster/lite-headless/notification-center"`.
`versions.test.mjs` passes via substring (verified). Factories only -- never the
`/element` wrappers (lite-element peer stays untouched).

**T6 -- `index.html`: strategy control + TA readout + toast/center hosts.**
(a) Segmented control `OFF | ICHIMOKU` -> `handle.setTaMode(...)`; reflect current mode.
(b) HUD row: `taState` ('off'/'warming n%'/'neutral'/'bull'/'bear'), tenkan/kijun/spanA/
spanB ('--' until warm), bar count. Cache nodes ONCE in the `el` map (`:805`); change-gate
the WHOLE line (the session-13 lesson); no forced reflow.
(c) `createToast({placement: 'top-right'})` viewport + dark-theme CSS; `createNotification-
Center()` behind a bell button with unread badge; `onSignal: (sig)` -> `toast.show(text,
{urgent: true, duration: 6000})` + `center.add({id: sig.symbol + '-' + sig.strategy + '-'
+ sig.side + '-' + sig.bar, title, body, kind: side === 'buy' ? 'success' : 'warning'})`.
(d) `pushLog` gets a 'signal' kind style. ASCII-only source throughout.

**T7 -- gates shipped by coder.** NEW `test/alloc-ta.mjs` (the `alloc-applydepth.mjs`
pattern verbatim: warm, gc-fence, 1M `applyMid` + 200k warm `roll` on flat mids, growth +
buffer-identity + zero-signals asserts, PASS/FAIL line) wired into the `alloc` script.
NEW `test/11-ta-ichimoku.test.mjs` happy path: fake-clock roll, ramp fixture -> exactly one
buy edge. qa owns the boundary suite (S3 ASSERTIONS below). `npm run verify` green.

**T8 -- `README.md`: one tight section.** The strategy plane (per-scope, router-selected,
off by default), the `?bar` override, warm-up arithmetic (78 bars), the notification path,
and the one-liner: textbook indicator math for a demo, not trading advice.

## 3. ASSERTIONS

1. **Alloc.** `applyMid` x 1M: post-gc growth < 65536 B; `o/h/l/c` buffer identities
   stable. `roll` x 200k warm flat bars, mode `ichimoku`: growth < 65536 B; signals 0.
2. **Warm fail-closed.** 77 closed bars of maximal ramp: state 'warming', signals 0,
   readout spans absent ('--' / NaN-gated), never 0-valued. Bar 78: state computes.
3. **Edge + payload.** Ramp fixture: EXACTLY ONE buy signal; payload fields symbol/
   strategy='ichimoku'/side='buy'/price/bar all correct; continued ramp adds ZERO.
4. **Negative control (non-vacuity).** Fixture true on THREE conditions with chikou
   deliberately violated -> ZERO signals. This is the gate's RED-provability.
5. **Cooldown + re-arm.** Buy -> neutral -> buy inside 30 bars: suppressed; after: fires.
   Mode off->on across a state flip: NO emission on the re-arm bar (contract 2).
6. **Off + router.** Mode 'off' on the ramp fixture: zero signals. `setTaMode('bogus')`
   throws named. Router resolves `ta:ichimoku` only when selected.
7. **Per-symbol independence.** Two scopes: warm counts and signals independent; each
   payload names its own symbol; closing one scope leaves the other's evaluator state
   intact (bitcoin -> link -> any other).
8. **Park.** `parkSymbol(sym)` then keep injecting: candles fill, a due signal still
   emits, and NO ReactiveDisposedError (the plane never touches vm).
9. **Blast radius zero.** `teardown.test.mjs` passes UNCHANGED; 08/09/09b/10/10b pass
   UNCHANGED; scope-churn retention 0 with the plane tracked mid-run (non-vacuous).

## 4. CROSS-SESSION DEPENDENCIES

- **Consumes S2** (dispatch seam + `f.mid` on both tags), **S3** (per-scope scron + scope
  lifecycle), **S5** (`inject()` as the deterministic pump), **S6** (fake socketFactory +
  headless boot; `roll(now)` is the di-ticker headless-tick idiom), **S9** (feedGate
  contract -- honored by NOT gating the plane and never reading vm).
- **Produces for S12** (Alligator): the candle plane, the router token slot
  (`ta:alligator`), the signal seam, the fixtures harness. S12 = one evaluator + one
  binding + one token + fixtures; NO new plumbing.
- **Non-goals, explicit:** no cloud/alligator-line RENDERING on the chart (separate visual
  session); no kline REST backfill (short bars instead; ledger for later); no Web
  Notification API (lite-headless toast IS the surface); no per-scope mode (global, one
  strategy at a time -- the user's semantic).

## 5. RISKS / OPEN

- **Float32 mid at 6-figure prices** (~0.01 quantum): same posture as the tape ring
  (`kernel.js:7`); indicator comparisons are relative -- fine for the demo; README notes it.
- **`interval(250)` BarJob under a throttled hidden tab** stretches bars; contract 3
  bounds the damage (re-warm) and the S5 memory says timers throttle too -- accepted.
- **Signal allocation** is cold by construction (edge + cooldown); if a reviewer finds a
  path where `emitSignal` can fire per-tick, that is a REJECT-grade defect.
- **lite-signal 1.5.1 exists on npm**; the map pins 1.5.0 everywhere including both new
  `?deps` -- do NOT drift one entry (dual-instance regression).
- **`?bar=250` is the browser-verification hook** (warm in ~20 s, then burst-inject a ramp
  through the S5 burst seam to force a live toast). Coordinator owns that check post-qa.
