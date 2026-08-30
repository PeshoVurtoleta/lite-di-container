# Session 8 -- The decorated symbol plane

## 1. SPEC

Every symbol child scope owns exactly one `SymbolVM` built by `defineReactive` on the scope's OWN `lite-signal` registry; the scope's `shutdown()` disposes VM and registry in one ordered pass and emits one log line. No transpiler, no decorator syntax, no new package beyond `@zakkster/lite-signal-decorators` pinned `1.5.0` in the import map (`index.html:7-26`).

**Acceptance gate (headless, `node --expose-gc`):** 256 open/use/shutdown cycles of a symbol scope with an attached VM; `lite-leak` tracker `size() === 0`; `stats()` of the DEFAULT lite-signal registry exact-equal (field-by-field, no tolerance) before and after; per-scope registry `activeNodes` rises by exactly `10` at VM construction and returns to its pre-VM floor after teardown, delta `0` summed over 256 scopes.

## 2. TASKS

Ordered. Hot-path touches flagged **[HOT]**.

1. **`index.html:7-26` importmap** -- add `"@zakkster/lite-signal-decorators": "https://esm.sh/@zakkster/lite-signal-decorators@1.5.0"`. Repin `@zakkster/lite-signal` to the exact version the decorators peer-resolve to; two lite-signal instances = two default registries = the frozen-stats assertion becomes vacuous.

2. **`kernel.js:SYMBOL_VM_SPEC`** -- one module-level frozen spec object, shared by all 256 scopes (every body is a module closure, allocated once at load). Sections per `SignalDecorators.d.ts:256-271`:
   - `signals: { bid: 0, ask: 0, last: 0, pinned: false, pinAnchor: 0 }` (5)
   - `deriveds: { mid: (self) => (self.bid + self.ask) / 2, spread: (self) => self.ask - self.bid }` (2)
   - `locals: { alert: { source: (self) => (self.pinned ? self.pinAnchor : self.mid) } }` (1). **No `initial`** -> the `@localCopy` flavor (`d.ts:228-233`): the threshold FOLLOWS live mid from wiring. Pinning freezes the tracked upstream to the constant `pinAnchor`, so the local override survives every mid move; unpinning swings upstream back to `mid`, which differs from the last adoption -> visible reset.
   - `effects: { onQuote: (self) => { self.mid; self.spread; self.alert; self.frameDirty = true; } }` (1). **[HOT]** Body is three tracked reads plus one plain-field store. `frameDirty` is a NON-reactive own field -- a reactive write here would re-enter the effect. Nothing in this body may touch `ctx`, `draw`, or the DOM.
   - Total per instance: `1 + 5 + 1 + 2 + 1 = 10` nodes.

3. **`kernel.js:makeSymbolVM(registry)`** (exported, cold, once per scope) -- `class SymbolVMBase { frameDirty = false; dispose() { disposeReactive(this); } }` declared FRESH inside the factory, then `return defineReactive(SymbolVMBase, { host: { registry }, ...SYMBOL_VM_SPEC })`. Two constraints, both load-bearing:
   - A fresh base class per call is REQUIRED: `defineReactive` installs on `Class.prototype` and a second call on the same prototype is `throwSpecCollision` (`SignalDecorators.js:1671-1678`).
   - The constructor takes **zero arguments** -- `costOf` probes with no args (`d.ts:415-427`); S9 depends on this.
   This is cookbook r10 (`COOKBOOK.md:1320-1356`): `host: { registry }` binds the whole chain, and `disposeReactive` routes teardown through the BOUND registry (`COOKBOOK.md:1371-1377`) instead of silently no-opping against the default.

4. **`kernel.js` symbol-scope setup (the S3 seam, today `kernel.js:383`)** -- inside the per-symbol scope, after `useScopedSignals(scope, {createRegistry, ...})` resolves the registry eagerly (`DiSignal.js:199-200`), register the VM with `reactiveService(scope, 'vm', (api) => new (makeSymbolVM(api.registry))())` (`DiSignal.js:369-396`). `reactiveService` auto-wires `onTeardown('vm', svc => svc.dispose())` because the base class exposes `dispose()`. Do NOT bind the VM on the parent container.

5. **Teardown order (assert, do not assume)** -- the registry token sits at `_resolutionOrder` index 0 (`DiSignal.js:99`, `:199-200`), so the reverse walk destroys it LAST: `vm.dispose()` runs while the registry is still live, then `registry.destroy()` drains the remainder. Add a test that pins this order; reversed, `disposeReactive` would touch a destroyed registry.

6. **`kernel.js:AggApply.handle` (`kernel.js:123-131`)** **[HOT]** -- write `vm.bid`/`vm.ask`/`vm.last` as three plain accessor stores. No object literal, no batch array, no `snapshotOf`. The existing `Aggregates` (`kernel.js:71-85`) either becomes the VM or is deleted; two truths for one quote is a defect.

7. **`kernel.js:RenderSystem.update` (`kernel.js:353-362`)** **[HOT]** -- read and clear `vm.frameDirty` (`if (vm.frameDirty) { vm.frameDirty = false; ... }`). The renderer is called from the ticker only. The effect never renders; the frame never reads a signal.

8. **Registry sizing** -- `capacityFor([[ProbeVM, 1]])` (`d.ts:479-482`) plus the measured kernel-signal constant (lite-ws lifecycle + tps), forwarded through `useScopedSignals`' passthrough config (`DiSignal.js:69-77`, which forwards every non-bridge key verbatim). Yields `prealloc: "eager"` + `onCapacityExceeded: "throw"` -- fail closed per scope.

9. **`index.html` pin/unpin UI** -- an `alert threshold` row plus a `Pin threshold` / `Unpin (follow mid)` toggle. Pin: `vm.pinAnchor = vm.mid; vm.pinned = true; vm.alert = <value>`. Unpin: `vm.pinned = false`. Log the reset line on the next quote: `localTo: upstream moved -> alert threshold reset to mid (upstream-keyed)`. Cold path, one click per intent.

10. **`README.md` "Honest caveats" (`README.md:71`)** -- append VERBATIM from `SignalDecorators.d.ts:127-130`:
    > The ABA contract (shipped, documented): the reset requires the upstream to change relative to the last adoption, not to have merely moved -- upstream A -> local write X -> upstream B -> upstream back to an equals-A value shows the STALE local X.
    Then one demo-specific sentence: unpinning while mid has returned to an `Object.is`-equal value keeps the stale pinned threshold -- visible, documented, not a bug.

11. **One-line shutdown** -- `closeSymbol(sym)` records `activeNodes` before, runs `scope.shutdown()`, emits exactly one event: `teardown[BTCUSDT]: SymbolVM disposed (10 nodes) + scoped registry destroyed -- scope gone`. Cold.

12. **Tests** -- `test/08-symbol-vm.test.mjs` (node:test): spec shape, node count, pin/unpin lattice, the ABA case as contract, teardown order, effect-never-renders. Extend the S6 churn gate to `test/scope-churn.mjs` at 256 scopes with the VM attached. `MM_TORTURE_BREAK=1` skips step 5's `dispose()` wiring and MUST exit non-zero.

## 3. ASSERTIONS

- **A1 (retention).** 256 open/use/shutdown cycles, `lite-leak` tracker `size() === 0` after 3 forced `global.gc()`; RSS delta over the last 128 cycles `<= 0`.
- **A2 (default registry frozen).** `stats()` from `@zakkster/lite-signal` captured before scope 1 and after scope 256: every field EXACT-equal (`activeNodes`, `poolGrowths`, links). Not a range. Any nonzero delta means a VM landed on the default registry.
- **A3 (node conservation).** `costOf(makeSymbolVM(reg)).nodes === 10` (`1 + 5 signals + 1 local + 2 deriveds + 1 effect`); per-scope `activeNodes` delta `+10` at construction, exactly `0` net after `shutdown()`, per scope, all 256.
- **A4 (GC budget).** `lite-gc-profiler` over the churn: `maxMajor === 0`, `maxPauseMs <= 4.0`; the quote path (`AggApply.handle` -> 3 signal writes -> effect -> `frameDirty`) `<= 0.5 B/op` over 1e6 ticks.
- **A5 (effect dirty-flags, never renders).** With the ticker stopped, 1e5 quote applies produce `renderer.draw` call count `=== 0` and `vm.frameDirty === true`; the effect body's source contains zero occurrences of `draw`, `ctx`, or `document`.
- **A6 (pin/unpin observable).** Pinned: `vm.alert` unchanged across 1000 distinct mid values. Unpin: exactly one reset log line, `vm.alert === vm.mid`. ABA: `mid = A` -> write `X` -> `mid = B` -> `mid = A` asserts `vm.alert === X` (stale local, as contract).
- **A7 (one line, both stories).** `scope.shutdown()` emits log length delta `=== 1`; teardown order asserts VM dispose strictly before `registry.destroy()`; a post-shutdown `vm.mid` read throws `ReactiveDisposedError`.

## 4. CROSS-SESSION DEPENDENCIES

- **Consumes S3** -- the per-symbol child scope and its `useScopedSignals` registration. Seam: the scope-setup function around `kernel.js:383`; S8 inserts task 4 immediately after the registry resolves and before `c.boot()` (registration after boot is a named throw, `DiSignal.js:138-150`).
- **Consumes S6** -- the headless boot seam (`{socketFactory, glSinks, now}`, `ctx: null`) and the `--expose-gc` scope-churn harness at 256 scopes; S8 attaches the VM inside the existing loop and adds A2/A3 to the same gate. Also consumes S6's `MM_TORTURE_BREAK` break control.
- **Consumes S1** -- pinned import map; S8 adds one entry and repins lite-signal.
- **Produces for S9** -- `makeSymbolVM(registry)` (zero-arg ctor, `costOf`-probeable) is the `bind` argument of `createFleet` (`d.ts:542-546`); `SYMBOL_VM_SPEC`'s declared initials are what `reinitReactive` resets to.
- **Produces for S10** -- the per-scope wrapper class and its bound registry are what `enableLabels(true)` + `labelOf(id, registry)` (`d.ts:556-566`) resolve; `rootOf(vm)` is the subgraph entry point for the labeled `toDot`.

## 5. RISKS / OPEN

- **Per-scope class retention -- confirmed safe.** Every decorator-side cache keyed by the class or its plan is a `WeakMap`: `PLANS` (`SignalDecorators.js:64`), `COST_CACHE` (`:143`), `LABEL_MAPS` (`:134`), `LABEL_STRINGS` (`:137`), `SIG_INITIAL` (`:100`), `LOCAL_INITIAL` (`:107`). `claimPlan` builds `own` as a local and splices `PENDING` empty (`:1065`), so no module-level strong array survives a definition. 256 classes collect with their scopes. A1 must still WITNESS this rather than trust it.
- **`PENDING` poisoning (real, mitigable).** `defineReactive` pushes recs at `:1682` and only `applyReactiveHost` drains them (`:1065`). A throw between those points leaves recs in the module array -- retained, and the NEXT scope's claim inherits them. Mitigation: validate the spec ONCE at module load by building a throwaway probe class, so a per-scope failure is structurally impossible; assert `costOf(probe).nodes === 10` at boot as the validation.
- **Open:** `costOf` requires two probes to agree (`d.ts:415-427`), and the `alert` source is a branch (`pinned ? pinAnchor : mid`). The probe always takes the unpinned branch, so it should agree -- confirm empirically in task 12 before S9 leans on `costOf`; `costOfInstance` is uncached and unaffected either way.
