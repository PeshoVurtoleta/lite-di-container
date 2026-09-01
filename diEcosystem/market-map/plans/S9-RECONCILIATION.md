# S9 coordinator reconciliation (READ BEFORE PLAN-S9.md)

PLAN-S9.md's "State at HEAD (verified)" section is STALE (written pre-S3). S5/S6/S8
have all LANDED and are committed. Its API line-anchors into SignalDecorators.js are
also from the dev repo and are NOT authoritative. The items below are EMPIRICALLY
verified against the installed `@zakkster/lite-signal-decorators@1.5.0` and the ACTUAL
current tree. Where this brief and PLAN-S9.md disagree, THIS brief wins.

## A. Verified decorator contract (probed live, 1.5.0 -- treat as ground truth)

- `releaseReactive(vm)` parks: returns `true` on a live->parked transition, `false` on
  an already-parked call (idempotent park->park; this `false` is T3 remove()'s
  "already parked" signal, NOT an error).
- `reinitReactive(vm, initials)`:
  - THROWS if `vm` is LIVE: "the instance is live; call releaseReactive() to park it
    before reinitReactive() revives it." => every revive/import path MUST park first;
    a FIRST-sighting cold-constructed vm is live and must NOT be reinit'd (just built).
  - On a PARKED vm, REVIVES THE SAME OBJECT (identity `=== vm` -- assertion 3 holds).
  - REJECTS any key that is not a signal or localTo member, THROWING and naming the
    key: e.g. `mid` -> "key `mid` that is not a @reactive signal or @localTo member ...
    Resettable keys: bid, ask, last, pinned, pinAnchor, alert." (assertion 5 negative
    is achievable EXACTLY -- the message names `mid`.)
  - TOLERATES a subset (missing keys keep default/upstream); accepts the local `alert`.
- `costOfInstance(vm)` on LIVE returns a frozen row; `.nodes === 10` (== costOf(Class).nodes)
  both before and after deriveds are read (this spec's alert floor is data-independent,
  so the "read every derived once for parity" step is a harmless no-op here -- keep it
  anyway for A1 parity robustness). Uncached: allocates one frozen object per call =>
  COLD ONLY, never in readState()'s 120ms poll.
- `costOfInstance(vm)` and `snapshotOf(vm)` on a PARKED vm both THROW `ReactiveDisposedError`.
- `snapshotOf(vm)` on LIVE returns ALL members INCLUDING deriveds:
  keys = `bid,ask,last,pinned,pinAnchor,alert,mid,spread`. mid/spread MUST be filtered
  before reinit (T6). The filter is load-bearing, confirmed.

## B. Node-count reconciliation (PLAN-S9 assertion 4 is WRONG)

The landed S8 `SYMBOL_VM_SPEC` (kernel.js:117-129) is 10 nodes, NOT 8:
`1 anchor + 5 signals(bid,ask,last,pinned,pinAnchor) + 1 local(alert) + 2 deriveds(mid,spread) + 1 effect(onQuote)`.
- costOfInstance(vm).nodes === 10 (not 8).
- A full 8-symbol watchlist reads **80** nodes (not 64).
- Wherever PLAN-S9 says 8 / 64, use **10 / 80**.

## C. RESET_KEYS reconciliation (PLAN-S9 T3 is WRONG on the list)

PLAN-S9 says `[bid, ask, last, alertThreshold]`. The AUTHORITATIVE resettable set
(the decorator enumerates it in its own reject message) is exactly:
`[bid, ask, last, pinned, pinAnchor, alert]` -- 6 keys. The local is named `alert`,
NOT `alertThreshold`. pinned/pinAnchor are signals and MUST be included.
Derive RESET_KEYS from the SAME spec literal (one source of truth), as T3 already
instructs: `Object.freeze([...Object.keys(SYMBOL_VM_SPEC.signals), ...Object.keys(SYMBOL_VM_SPEC.locals)])`.
`SYMBOL_VM_SPEC` is exported from kernel.js:130.

## D. Stale-anchor / already-done reconciliation vs the ACTUAL tree

- **T1 (pin decorators in import map): ALREADY DONE.** index.html:32 already pins
  `@zakkster/lite-signal-decorators@1.5.0?deps=@zakkster/lite-signal@1.5.0` (S8).
  Verify-only; do NOT re-add. (The `?deps` is the browser two-instance dedup -- keep it.)
- **T2 (boot capability assert): REAL, add it.** In `bootKernel` (kernel.js:1259+),
  cold, assert `typeof {releaseReactive,reinitReactive,costOfInstance,snapshotOf} === 'function'`
  and throw a NAMED error before wiring the watchlist. It surfaces via index.html's
  `#err` block (id="err", index.html:603; the boot catch at :870-874 already writes
  e.stack there). makeSymbolVM already imports defineReactive/disposeReactive/costOf;
  add the four S9 fns to the kernel.js import at line 23.
- **T4 anchor "beside `agg` (kernel.js:384-390)": STALE.** There is NO `agg` anymore --
  S8 replaced Aggregates with the per-scope reactiveService 'vm' (kernel.js:939). The
  per-symbol VM is `scopes.get(sym).vm`. Wire the watchlist against the existing
  `scopes` Map (kernel.js:1436) and the existing `bus.on('tick', ...)` fan-out
  (kernel.js:950). `lastTickOf(sym)` = the last tick record for that symbol, captured
  into a PREALLOCATED per-symbol record (no per-tick alloc).
- **T5/T7 perf panel: EXISTS (S5).** "Perf & soak" group is index.html:561; the `el`
  cache is index.html:736. ADD watchlist rows to the existing panel + cache them once
  at row creation. Do NOT create the panel.
- **T8 test/ + package.json: EXIST (S6/S8).** test/ has 08-symbol-vm.test.mjs,
  scope-churn.test.mjs, helpers/harness.mjs (installRaf, makeFakeFactory), versions.test.mjs.
  Just ADD test/09-watchlist.test.mjs. NO fallback package.json needed (the plan's T8
  fallback clause is moot). package-lock.json is GITIGNORED (S6) -- decorators is in
  package.json deps; do not fight the lockfile.

## E. Structural shape (settle against the real handle)

`createSymbolScope(c, {...})` returns a handle `h` with: `h.start()`, `h.close(onTeardownError)`,
`h.state()`, `h.scope`, `h.vm`, `h.inject(...)`, `h.nodeCount`. The kernel keeps them in
`scopes` (Map<sym,h>, kernel.js:1475 `_scopes`). Tabs = scope OPEN/SHUTDOWN (addSymbol/
closeSymbol, :1429/:1443). The S9 watchlist = VM PARK/REVIVE over a RETAINED scope:
`remove` calls `releaseReactive(h.vm)` and must NEVER call `h.close()`/`scope.shutdown()`.
`add` first-sighting cold-constructs the scope (reuse addSymbol's path or its seam), then
subsequent add = park-guarded reinitReactive revive. `SymbolVMOf(sym)=scopes.get(sym).vm`.

The `_scopes`/watchlist map S9 produces (symbol -> {vm, scope, registry, live}) is S10's
label source -- expose it as a stable test seam on the handle (e.g. `handle._watchlist`).

## F. Gates (unchanged in spirit; numbers corrected)

Assertion 1 conservation, assertion 2 non-vacuous (mid-run `tracker.size() >= 8`),
assertion 3 identity `=== `, assertion 4 costOfInstance `.nodes === 10` live / throws
parked / full watchlist = 80, assertion 5 round-trip + the `mid`-naming negative.
Every retention/conservation gate MUST be RED-provable under a canary (the house
vacuous-gate law); reuse the `MM_TORTURE_BREAK=1` env canary pattern from
08-symbol-vm.test.mjs and scope-churn.test.mjs. A gate that runs only under
`--expose-gc` SKIPS silently under plain `npm test` -- put GC-dependent asserts under
the churn harness and RUN THEM THERE before claiming green.
