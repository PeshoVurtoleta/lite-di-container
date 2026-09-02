# S10 RECONCILIATION -- coordinator brief (READ THIS BEFORE PLAN-S10.md)

De-risk-first probed the ACTUAL lite-devtools@1.5.0 + lite-signal-decorators@1.5.0 +
lite-signal@1.5.0 contract (the versions the demo pins). PLAN-S10.md has load-bearing
drift; the corrections below OVERRIDE the plan wherever they conflict. Every fact here
is empirically proven (scratch probe under the demo's exact pinned versions), not read
off source comments.

## C1 -- graph() and toDot() are lite-devtools exports, NOT decorators
decorators@1.5.0 exports: `enableLabels`, `labelOf`, `rootOf`, `forEachReactive`,
`releaseReactive`, `reinitReactive`, `costOfInstance`, `snapshotOf`, `defineReactive`,
`disposeReactive`, `costOf`, `capacityFor`, ... (NO `graph`, NO `toDot`).
`graph` and `toDot` come from `@zakkster/lite-devtools`. PLAN T4 conflated them.

## C2 -- THE BLOCKER: devtools graph() walks the DEFAULT registry only
Root cause (proven): module-level `SIG.describe(handle)` delegates to
`defaultRegistry.describe(handle)` (Signal.js:2006-2008). devtools `graph()` imports
`describe`/`nodeId`/`forEachObserver`/`forEachSource`/`forEachOwned` from SIG at module
load -- all bound to the DEFAULT registry. The demo's VMs live on PER-SCOPE registries
(S8 isolation contract), so `graph(rootOf(vm), {owners:true})` for a scoped VM returns
`{nodes:[], edges:[]}` -- an EMPTY graph. The plan's whole T4 recipe silently produces a
node-less DOT.

`setDefaultRegistry(reg)` DOES make devtools graph() walk the scope -- BUT it returns
`undefined` (NOT the previous registry) and there is NO getter (`createRegistry`,
`setDefaultRegistry` are the only registry exports). Restoring with `undefined`/`null`
NUKES the default registry -> subsequent `SIG.describe` throws. There is no safe
capture/restore. **setDefaultRegistry is REJECTED** (global-mutation, unrestorable,
fail-open). Do not use it.

### FIX (mandatory) -- Approach B: cold registry-explicit BFS + devtools toDot
The scope registry exposes its OWN introspection as own methods (proven):
`reg.describe`, `reg.nodeId`, `reg.forEachObserver`, `reg.forEachSource`,
`reg.forEachOwned`. Build the `{nodes, edges}` yourself with a cold BFS over the SCOPE
registry, then render with devtools `toDot({name, labelResolver})`. Zero global
mutation, registry-explicit, fail-closed. The DoD item ("labeled toDot export of a live
scope") is satisfied -- toDot IS the devtools surface; the walk is the demo's
registry-explicit adapter over lite-signal's per-registry introspection.

Proven-working reference walk (dedupe edges with a seen-set; cold path only):
```
function reactiveGraphOf(reg, vm) {           // COLD. never per-frame.
  const root = rootOf(vm);                    // throws ReactiveDisposedError if parked/disposed
  const nodes = new Map(), edges = [], eseen = new Set(), seen = new Set(), q = [];
  const roots = []; forEachReactive(vm, (h) => roots.push(h)); roots.push(root);
  for (const h of roots) { const d = reg.describe(h); if (d && !nodes.has(d.id)) { nodes.set(d.id, d); q.push(h); } }
  const link = (f, t, k) => { const key = f + '>' + t + (k ? ':' + k : ''); if (!eseen.has(key)) { eseen.add(key); edges.push(k ? {from:f,to:t,kind:k} : {from:f,to:t}); } };
  let head = 0;
  while (head < q.length) {
    const h = q[head++]; const id = reg.nodeId(h);
    if (id === undefined || seen.has(id)) continue; seen.add(id);
    reg.forEachObserver(h, (d) => { if (!nodes.has(d.id)) nodes.set(d.id, d); link(id, d.id); q.push(d); });
    reg.forEachSource(h,   (d) => { if (!nodes.has(d.id)) nodes.set(d.id, d); link(d.id, id); q.push(d); });
    reg.forEachOwned(h,    (d) => { if (!nodes.has(d.id)) nodes.set(d.id, d); link(id, d.id, 'owner'); q.push(d); });
  }
  return { nodes: [...nodes.values()], edges };
}
```
`reg.forEachOwned` yields the anchor's owned children (deriveds + effect) as owner edges
(HAS_OWNERS is true at 1.5.0 -- `SIG.forEachOwned`/`ownerOf` exist). Owner edges render
dashed/gray by toDot -- keep them; they carry the "anchor owns its members" story.

## C3 -- node count is the LIVE reachable closure, NOT the static 10
PROVEN counts for SymbolVM via the walk above:
- UNPINNED construction floor: **7 nodes** -- anchor, bid, ask, pinned, mid, spread, onQuote.
- PINNED (pinned=true, pinAnchor set): **8 nodes** (+pinAnchor joins via alert's upstream).
- `alert` (the @localTo localCopy) is NEVER a graph node -- it is a per-instance local
  copy, not a shared reactive node. `last` is NEVER reachable -- no reactive reader
  (state() reads it plainly). So the walk NEVER shows all 10 static members.

`costOf(vm).nodes === 10` (allocation cost, static) and the graph node count (7/8, live
topology) are DIFFERENT metrics. PLAN Assertion 1's `count == 1+signals+locals+deriveds+
effects (=10)` is WRONG. Corrected assertion:
- **THE REAL GATE: `unlabeled === 0`** -- every RENDERED node's `labelOf(id, reg)` is a
  string (proven: 0 unlabeled in both pinned/unpinned). This is state-independent.
- Deterministic count: fix the pre-render state (unpinned construction floor) and assert
  `nodes.length === 7` for SymbolVM. State-dependence is a DOCUMENTED property, not a bug
  -- note it in the caption/README (the graph is the live dependency closure, not the
  static member manifest; `alert`/`last`/`pinAnchor` join only when a reader activates them).
- Every label matches `/^SymbolVMBase([.#@]\w+)$/` (see C4).

## C4 -- class prefix is `SymbolVMBase`, not `SymbolVM`
The demo class is `class SymbolVMBase` (kernel.js:147). Labels are therefore
`SymbolVMBase@anchor`, `SymbolVMBase.bid`, `SymbolVMBase.mid`, `SymbolVMBase#onQuote`,
etc. (proven). PLAN's `/^SymbolVM.../` regex must be `/^SymbolVMBase.../`.
DO NOT rename the class to `SymbolVM` -- it is referenced across S8/S9 error strings and
tests; renaming is out-of-scope churn. Accept the `SymbolVMBase` prefix in labels.

## C5 -- the enableLabels ordering trap is REAL (confirmed)
A VM wired while `enableLabels` is OFF registers NO labels and `labelOf` returns
`undefined` for its ids FOREVER (proven). `enableLabels(true)` MUST run at MODULE TOP
LEVEL, before ANY VM is wired -- INCLUDING the module-load `_ProbeVM` at kernel.js:160.
Put the call immediately after the decorator imports, before the `_probeReg`/`_ProbeVM`
block. Guard `?labels=0` -> `enableLabels(false)` for the opt-out (read the flag at
module top; do not defer into bootKernel). PLAN T2 is correct; just ensure it precedes
line 160, not merely "before bootKernel".

## C6 -- rootOf throws on a parked/disposed VM (confirmed)
`rootOf(parkedVM)` throws `ReactiveDisposedError` (proven). `dotOf(symbol)` must
try/catch `rootOf` (or the whole walk) and return `null` so a S9-parked watchlist entry
is skipped, never fatal. PLAN Assertion 5 stands.

## C7 -- packaging: add lite-devtools to deps + regenerate the (now-tracked) lockfile
- `lite-devtools@1.5.0` IS published on npm (proven: `npm view` + install). The esm.sh
  pin `https://esm.sh/@zakkster/lite-devtools@1.5.0` will resolve (T1).
- T10's headless node test imports lite-devtools -> ADD `"@zakkster/lite-devtools": "1.5.0"`
  to market-map `package.json` dependencies, then `npm install` to regenerate
  `package-lock.json`, and COMMIT the lockfile (it is now tracked -- the S9-followup
  gitignore fix removed `/package-lock.json` from market-map/.gitignore).
- devtools declares `@zakkster/lite-time >=1.0.0` as a peer. npm 7+ auto-installs it; the
  regenerated lockfile will capture it. For the BROWSER import map (T1), esm.sh resolves
  devtools' peers automatically, but pin `@zakkster/lite-time` in the import map too if
  the page errors on an unresolved bare specifier (verify in the browser gate).

## C8 -- the toDOT / toDot naming collision (readability trap)
The demo already imports `toDOT` (capital, from lite-di-graph -- the DI container graph)
at kernel.js:21. devtools' export is `toDot` (camelCase). They differ only by case ->
alias the devtools one on import, e.g.
`import { toDot as rxToDot } from '@zakkster/lite-devtools';`
Never leave bare `toDot` next to `toDOT` in the same file.

## Seams (verified line numbers, may drift as you edit)
- Decorator import: kernel.js:24-25 (extend with `rootOf, labelOf, enableLabels,
  forEachReactive`; add the devtools import line).
- Module-load probe VM: kernel.js:159-164 (enableLabels(true) must precede this).
- bootKernel capability assert: kernel.js:1292-1297 (S9 park/revive assert; extend it to
  require `rootOf`/`labelOf`/`enableLabels`/`forEachReactive` + devtools `toDot`).
- Scope handle (where `registry`/`feedGate` are exposed): kernel.js:~1183.
- S5 export surface: `exportGraph(kind)` kernel.js:1631-1636; the `'dot'` branch (1635)
  uses di-graph `toDOT(snap)`. T5 extends THIS branch: emit di-graph `toDOT(snap)` then,
  per LIVE scope, one `subgraph cluster_<safe(symbol)> { ... }` block built by stripping
  the `digraph <name> {` prefix + trailing `}` from `rxToDot(reactiveGraphOf(reg,vm),
  {...})` and re-wrapping as `subgraph cluster_<sym>` with a one-line `label=` caption.
  Skip parked/absent scopes (dotOf returns null).
- `graphNodeCount()` kernel.js:1644 -- parent-container node count (di-graph), unchanged.

## Cold-path law (demo-audit)
`reactiveGraphOf` + `dotOf` + the combined export ALLOCATE (Maps, arrays, strings) --
they are COLD ONLY: the export button / graph page. They MUST NOT appear in
`RenderSystem.update` (kernel.js:353-362), the HUD interval, or any tick consumer. qa
asserts this by static grep (PLAN Assertion 5).

## Tooling
`dot` (graphviz) is NOT installed here. T6's rendered SVG artifact is OWNER-MANUAL (like
the S7 GIF) -- write the HTML section + the DOT source in a `<pre class="code">`, and the
checked-in SVG is produced by the owner running `dot -Tsvg`. Assertion 4 uses the
structural fallback (balanced braces + `digraph` prefix + one `digraph`/N `subgraph
cluster_` + every byte < 0x80), which is PROVEN working -- no Graphviz dependency.

## What stays as PLAN-S10 wrote it
T2 placement (with C5's precise "before line 160" refinement), Assertion 2 (ordering both
ways), Assertion 3 (registry scoping: `labelOf(id)` no-reg -> undefined; `labelOf(id,
reg)` -> string), Assertion 5 (parked null + cold-path grep), Assertion 6 (Part 5 DoD).
The stretch `reactiveClass` item is OUT (owner ledger, not S10).
