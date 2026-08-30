# Session 10 -- The labeled graph (Part 5, terminal)

## 1. SPEC

**Goal.** The whole kernel becomes ONE readable artifact: the DI graph (`lite-di-graph`, S5) plus, per live symbol scope, the reactive subgraph rendered by `lite-devtools@1.5.0` `toDot({ labelResolver })` where the resolver is the decorators' `labelOf` bound to **that scope's registry**. Every node prints its decorated member name (`SymbolVM.bid`, `SymbolVM.spread`, `SymbolVM#onMid`, `SymbolVM@anchor` -- the exact string forms built in `SignalDecorators.js:2568-2583`), so the DOT is self-describing.

**Acceptance gate (measurable).** For a live scope with `k` VM members, `toDot(graph(rootOf(vm)), { labelResolver })` yields `k+1` node lines (anchor included) and **zero** lines whose label body is the default value stringification -- i.e. `labelOf` returns a string for every rendered `n.id`. A senior read needs no legend beyond the caption; the only symbols are DOT's own shape vocabulary (ellipse = signal, box = computed, diamond = effect -- `Devtools.js:591`) plus the dashed/gray owner edge (`Devtools.js:599`), both named in one caption line.

**Part 5 DoD items S10 must close:**
- [ ] Labeled `toDot` export of a live scope on the graph page
- [ ] The combined claim in the README + launch post
- (S10 also re-affirms the pin line: `lite-signal-decorators >= 1.5.0` -- **SATISFIED**, 1.5.0 is the shipped version, `package.json:3`.)

## 2. TASKS

Ordered, atomic. Paths absolute.

**T1 -- Pin the two new import-map entries.**
`.../market-map/index.html:7-27` (import map) -- add `"@zakkster/lite-devtools": "https://esm.sh/@zakkster/lite-devtools@1.5.0"` and `"@zakkster/lite-signal-decorators": "https://esm.sh/@zakkster/lite-signal-decorators@1.5.0"`. S8/S9 already added the decorators entry; verify the version is `@1.5.0` exactly, not floating (Part 1 finding 1, roadmap:41-43). Devtools is new at S10.

**T2 -- Turn labels ON before any wiring (the ordering trap).**
`.../market-map/kernel.js` -- at **module top level**, immediately after the decorator imports and *before* `bootKernel` is ever called, call `enableLabels(true)` once, guarded by a `?labels=0` opt-out that sets it false. Labels register at wiring time inside `introspectWire` -> `registerLabels` (`SignalDecorators.js:2633-2634`, `2585-2617`); a VM wired while `LABELS_ON` is false registers nothing and `labelOf` returns `undefined` forever for those ids (`SignalDecorators.js:2682-2684`). S8's `SymbolVM` construction and S9's `createFleet` acquire both wire, so both are downstream of this call. Do **not** place it inside `bootKernel` after the first `scope()`.

**T3 -- Per-scope label resolver factory.**
`.../market-map/kernel.js:` new cold function `makeLabelResolver(registry)` returning `(id) => labelOf(id, registry)`. The registry argument is mandatory: `labelOf` defaults to the DEFAULT registry when the arg is `undefined`/`null` (`SignalDecorators.js:2671`), and the S8 contract keeps the default registry frozen -- so an omitted registry resolves **every** id to `undefined` and silently produces an unlabeled graph. One resolver per scope, built once at scope creation (cold path; the closure is created outside any tick).

**T4 -- The per-scope DOT export.**
`.../market-map/kernel.js:` new cold method on the scope record, `dotOf(symbol)`:
1. `rootOf(vm)` (`SignalDecorators.js:1931-1939`) -> the anchor handle; it throws `ReactiveDisposedError` for a disposed **or parked** VM (`:1936-1937`) -- catch and return `null` so a S9-parked watchlist entry is skipped, not fatal.
2. `graph(root, { owners: true })` -> `toDot(g, { name: 'scope_' + safe(symbol), labelResolver: makeLabelResolver(scope.registry) })`.
Cold-path only: called from the export button / graph page, never from `RenderSystem.update` (`kernel.js:353-362`) and never from the HUD interval.

**T5 -- Combined export artifact.**
`.../market-map/kernel.js:` extend the S5 export surface so the download emits **one** `.dot` file: the `lite-di-graph` DOT of the booted container followed by one `subgraph cluster_<symbol> { ... }` block per live scope, each carrying a one-line `label=` caption (`"BTCUSDT -- reactive scope (ellipse=signal, box=derived, diamond=effect, dashed=owner)"`). Concatenation must strip the inner `digraph name {` / trailing `}` from each `toDot` result (`Devtools.js:593`, `:601`) and re-emit as `subgraph`. ASCII-only; the caption is the whole legend.

**T6 -- Graph-page integration.**
`/Users/zakkster/Work/Portfolio/LiteLibrariesSuite/LiteDiContainer/diEcosystem/index.html` is the ecosystem graph page (companion assets `ecosystem-graph.svg` / `.png` sit beside it). Attach the per-scope reactive subgraphs as a **new `<section>` inserted after the eleven-cards section (ends `index.html:1107`) and before the laws section (`:1109`)**, mirroring the existing `.diagram-shell` + `.legend` structure (`:844-911`). Content: the rendered labeled subgraph of one representative scope (checked-in SVG produced by Graphviz from T5's output, plus the DOT source in a `pre.code` block reusing the existing class, `:653-681`), eyebrow "The reactive plane", and a copy column stating one scope = one registry = one VM fleet. Reuse existing CSS tokens; add no new color variables. No forced reflow, no new script.

**T7 -- Caption + no-legend proof.**
Same section: exactly one caption line under the diagram naming the four shape/edge conventions. Delete any temptation to add a second swatch legend -- the gate is "no legend beyond the caption" (roadmap:365-366).

**T8 -- README combined claim.**
`.../market-map/README.md` -- in the package table (`:34-46`) add rows for `lite-devtools` (labeled `toDot` of a live scope) and `lite-signal-decorators` (the decorated VM plane), and add a short "The combined claim" paragraph: *a DI kernel whose every scope owns a disposable, measured, zero-GC reactive class layer* -- with the three receipts inline (S8 retention 0, S9 pool delta 0, S10 labeled DOT).

**T9 -- Launch-post edit.**
The S7 launch write-up + `WHY-market-map.md` (roadmap:264-277; not yet on disk -- S7 creates them under `.../market-map/`). Add the combined claim as the closing beat and the labeled DOT as a second downloadable closer beside the Perfetto trace. One sentence in the container README Ecosystem cross-link (roadmap:268-269) noting the reactive plane.

**T10 -- Test.**
`.../market-map/test/` new `node:test` file (node:test only, house law). Headless boot (S6 `ctx: null` seam, roadmap:227-229), open one scope, assert the four checks in section 3. No browser test.

**T11 -- Roadmap tick.**
`.../ROADMAP-DEMO.md:380-382` -- check the two Part 5 DoD boxes; note the `>= 1.5.0` pin as satisfied.

## 3. ASSERTIONS

1. **Every node labeled.** For a live scope, parse T4's DOT: node-line count `== 1 + signals + locals + deriveds + effects` for `SymbolVM`, and for each node id `labelOf(id, scope.registry)` returns a `string` (not `undefined`). Zero unlabeled nodes. Each label matches `/^SymbolVM([.#@]\w+|@anchor)$/`.
2. **Ordering is load-bearing (falsifiable both ways).** Wire a VM with `enableLabels(false)` first -> assert **0** labeled nodes; then `enableLabels(true)`, wire a second VM -> assert **all** its nodes labeled. Proves T2's placement is necessary, not decorative.
3. **Registry scoping.** `labelOf(id)` with the registry argument omitted returns `undefined` for every id of a scoped VM (default registry stays frozen, S8 contract) while `labelOf(id, scope.registry)` returns the string. Asserts T3's mandatory argument.
4. **DOT validates + ASCII.** T5's combined artifact parses with `dot -Tsvg` (or a balanced-brace + `digraph`-prefix structural check in CI where Graphviz is absent), contains exactly one `digraph` and `N` `subgraph cluster_` blocks for `N` live scopes, has no dangling edge endpoint, and every byte is `< 0x80`.
5. **Cold path only.** A disposed or parked VM's `dotOf` returns `null` and does not throw (`rootOf` throws `ReactiveDisposedError`, `SignalDecorators.js:1936-1937`); and no `toDot`/`graph`/`labelOf` call appears in `RenderSystem.update` or the HUD interval -- static grep assertion in the test file.
6. **Part 5 DoD.** All six boxes green: S8 (SymbolVM plane, `@localTo` + ABA caveat), S9 (4096-cycle pool delta 0, `costOfInstance` HUD, `snapshotOf` export), S10 (labeled `toDot` on the page, combined claim in README + launch post).

## 4. CROSS-SESSION DEPENDENCIES

- **Consumes S5** (roadmap:211-213): the `lite-di-graph` JSON/DOT/Chrome-Trace export buttons. **Seam:** the existing `fromContainer(c)` / `toJSON` call site, `kernel.js:484-490`, and S5's download handler -- T5 extends the DOT branch only; JSON and Trace are untouched.
- **Consumes S8** (roadmap:322-336): the decorated `SymbolVM` and the per-scope registry from `useScopedSignals(c, { createRegistry })`. **Seam:** `kernel.js:383` (`rx`) -- S8 moves this per-scope; T3 reads `scope.registry` from exactly that object. Label *strings* come from the decorated member names S8 declared.
- **Consumes S9** (roadmap:343-350): the fleet + `snapshotOf`. **Seam:** the fleet's `at(i)` / `size()` enumeration is T4's iteration source; parked slots are the reason T4 must catch `ReactiveDisposedError`.
- **Extends S7** (roadmap:270-274): the launch write-up and `WHY-market-map.md`. **Seam:** T9 appends the combined claim; it does not rewrite S7's hook (kill-feed GIF) or closer structure -- the labeled DOT becomes a *second* downloadable artifact.
- **Version pin:** the Part 5 DoD line `lite-signal-decorators pinned >= 1.5.0` (roadmap:376-377) is **SATISFIED** -- `LiteSignalDecorators/package.json:3` is `1.5.0`. New this session: `lite-devtools@1.5.0` (`LiteDevtools/package.json:3`, `toDot` labelResolver at `Devtools.js:587-601`).

## 5. RISKS/OPEN

- **[HIGH] The enableLabels ordering trap.** Labels register at wiring time; a VM wired before `enableLabels(true)` is permanently unlabeled and `labelOf` returns `undefined` **silently** -- an introspection miss is by contract never an error (`SignalDecorators.js:2666`, `:2682-2684`). Combined with `toDot`'s silent fall-through on non-string returns (`Devtools.js:596`), a mis-ordered demo produces a *plausible-looking but unlabeled* DOT and the gate fails only on a careful read. Mitigated by T2 (module top level) and assertion 2. This is the session's one real defect surface.
- **[MED] Per-registry resolution.** Omitting the registry argument silently targets the frozen default registry -> all-`undefined`. Same silent-degradation shape. Assertion 3 pins it.
- **[MED] esm.sh availability.** `@zakkster/lite-devtools@1.5.0` must actually be published to npm before the page can resolve it; verify before T1, or the cold URL breaks (Part 1 finding 1/3 territory).
- **[LOW] Graphviz in CI.** `dot -Tsvg` may be absent; assertion 4 falls back to a structural parse. Do not add a Graphviz dependency.
- **Stretch, FLAGGED NOT PLANNED:** `reactiveClass` (registering decorated classes as DI bindings) is **not shipped** and is out of scope. The roadmap Note (`ROADMAP-DEMO.md:368-372`) assigns the admission decision to the LiteDiSignal ledger, not this file. It is owner-elective, category-A; this demo is its first named consumer candidate. Raise it as a post-launch ledger item -- do not let it enter S10.
