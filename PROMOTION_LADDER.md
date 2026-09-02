# PROMOTION LADDER -- @zakkster/lite-di-* alpha -> stable

Ten modules layer on `@zakkster/lite-di-container` (itself already stable at 2.2.0).
All ten are published at `1.0.0-alpha.1`, torture-green, and carded. This document
defines the ONE uniform gate a module must pass to drop `-alpha.1` and ship `1.0.0`,
records each module's status against it, and fixes the graduation ORDER.

Decision on cadence (ratified with the maintainer): **leaf-first, staged**. Modules
graduate in waves as each earns a real downstream proof -- pure read-path leaves
first, the process capstone last. This is NOT a single coordinated line-ship.

Standing law is unchanged: ASCII-only, MIT (c) Zahary Shinikchiev, zero runtime deps,
`node:test` only. commit / publish / sync-card / any version bump remain the
maintainer's explicit call. This session PLANS and DOCUMENTS the promotion; it drops
no version and edits no module source.

---

## The uniform gate (ratified)

A module ships `1.0.0` only when ALL of the following hold. Each is falsifiable.

1. **Torture-green + the 3 BREAK controls trip.** `node --expose-gc test/torture.mjs`
   prints its GATE line and exits 0; `DI_ASCII_BREAK`, `DI_ALLOC_BREAK`, and
   `DI_TORTURE_BREAK` each force a non-zero exit. (True for all ten today -- but see
   gate 2, which qualifies what "torture-green" is allowed to mean.)

2. **The retention gate must FAIL on a planted retained object.** A leak soak that
   `track()`s then immediately `untrack()`s and asserts `size() === 0` is a VACUOUS
   TAUTOLOGY: `size()` is a synchronous live counter, so `track`+`untrack` nets to 0
   every cycle even if the object is retained forever. The real gate tracks each
   object WITHOUT untracking (the cleanup fn + tag must capture nothing), settles hard
   (>= 8-10 `gc()`+tick passes), and asserts `size() <= RES = max(16, CYCLES/1000)`;
   `DI_TORTURE_BREAK` must retain the object in a module sink so `size()` stays
   ~CYCLES and trips the residual gate DIRECTLY -- not merely a heap backstop. A gate
   that cannot fail on a planted leak is not a retention gate. (See the audit below;
   this is the line's single most widespread blocker.)

3. **A published downstream consumer proves the API in anger.** A COOKBOOK-grade
   reference app, or one module consuming another as a shipped example -- not a torture
   harness. This is the real graduation bar: an API nobody has consumed is not frozen.

4. **API frozen with a written boundary.** A "What this is not" section that draws the
   1.0.0 line, so the module does not immediately need 1.1 to correct its own surface.

5. **Docs + card + changelog staged.** README on the LiteSepforge blueprint; the
   LiteCatalog card synced to the repo; a `## [1.0.0]` CHANGELOG entry drafted.

6. **Soak-ceiling honesty audited.** Each heap ceiling is anchored to THAT module's own
   churn, not a sibling's copied constant (the session-9 lesson), with a comment naming
   what it bounds and stating it is NOT the retention authority (gate 2 is).

---

## Anchor finding -- the retention gate is vacuous across the whole line

Audited every sibling's leak-soak source directly (the file with the most `.track()`
calls). Verdict, VERIFIED by reading each soak:

| Module | Soak file | Pattern | Retention gate today |
| ------ | --------- | ------- | -------------------- |
| lite-di-event-bus  | `t7-soak.mjs` | `track; untrack; size()===0` (x3 lanes) | VACUOUS |
| lite-di-cron       | `t7-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-ticker     | `t7-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-graph      | `t7-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-supervisor | `t7-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-health     | `t7-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-lock       | `t6-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-orchestrator | `t6-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| lite-di-strategies | `t5-soak.mjs` | `track; untrack; size()===0` | VACUOUS |
| **lite-di-signal** | `t5-soak.mjs` | `track` WITHOUT untrack; settle; `residual <= RES`; BREAK pins in `sink` | **REAL** (fixed this cycle) |

So gate 2 is unmet for all NINE older siblings and met only by signal. Their retention
is still loosely bounded by a heap-peak backstop, but the `size() === 0` assertion is a
tautology -- it would pass even if every instance leaked. The fix is mechanical and
already proven once: port signal's `t5-soak.mjs` shape (track-without-untrack + hard
settle + `residual <= RES`, BREAK retains the object) into each sibling's soak, then
confirm `DI_TORTURE_BREAK` trips the residual gate, not just the heap bound.

This does not mean the modules leak -- it means their leak-freedom is currently
UNPROVEN by the gate that claims to prove it. Graduating any module to 1.0.0 on a
tautological gate would be exactly the "gate it or don't claim it" failure the line has
already learned twice (supervisor, health). Gate 2 blocks every sibling until fixed.

> **UPDATE -- gate-2 sweep COMPLETE.** All NINE siblings' leak gates are now ported to
> the real finalization residual and each is reviewer-APPROVED (plus signal, which was
> real from its build). The whole di-* line now has a retention gate that FAILS on a
> planted retained object -- every module's `DI_TORTURE_BREAK` trips the residual gate
> directly (proven per module, in isolation where an earlier tier trips first). Clean
> residuals are 0-1 against RES=16 (1e4-cycle soaks) or 0 against RES=100 (1e5-cycle
> soaks). Gate 2 is CLEARED for all ten modules; the remaining blockers are gate 3
> (a real downstream consumer per module) and gates 4-5 (frozen boundary + staged
> changelog). All nine `t*-soak.mjs` changes are green and uncommitted (maintainer's
> call). See the per-wave progress notes below.

> **UPDATE -- gates 3, 4, and 5 now COMPLETE for all TEN modules.** Gate 3 (downstream
> consumer) cleared across every wave. Gate 4 (frozen boundary) + gate 5 (staged
> `## [1.0.0] - 2026-08-11` changelog) are STAGED and each independently reviewer-
> APPROVED (an adversarial reviewer re-ran `npm run verify` per module and checked every
> empirical number, the frozen surface against the real exports, and that NO version
> const moved). The "Proven" sections were rewritten to the REAL finalization residual
> (the alpha.1 entries' `size()===0` phrasing was vacuous), with the honest observed
> numbers (residual 0-1 against RES=16 on 1e4-cycle soaks; 0 against RES=100 on 1e5-cycle
> soaks; pinned async lanes recorded, never claimed as 0). Two doc/code findings were
> settled by the maintainer first: ticker stop() (docs-follow-code) and supervisor
> reportFault (narrow-the-docs) -- both doc-only, tests still green. One REJECTED cycle
> (cron: the frozen list omitted the public `CronError` export -> enumerated -> re-cleared).
> **The ONLY remaining step for every module is the maintainer's release gate:** the
> three-place version bump `1.0.0-alpha.1 -> 1.0.0` (package.json + VERSION const +
> llms.txt), the LiteCatalog card sync, and commit/publish. Every change staged this
> sweep is uncommitted.

---

## The ladder (leaf-first, staged)

Ordered by how much behavioral surface must be frozen: pure read-path leaves are
cheapest to freeze; the process capstone that coordinates the others is last. Each row
lists the module's single most pressing blocker on top of the two universal ones
(gate 2 leak-gate port for every sibling; gate 3 downstream proof for every module).

### Wave 1 -- read path (pure, read-only; easiest to freeze)

| Rank | Module | Leak gate (gate 2) | Single blocker to 1.0.0 |
| ---- | ------ | ------------------ | ----------------------- |
| 1 | lite-di-strategies | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED) -> awaits version bump + card sync (maintainer) |
| 2 | lite-di-graph | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ ~~toJSON finding~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED) -> awaits version bump + card sync (maintainer) |

Read-only by construction, no lifecycle to freeze. Once gate 2 is ported and one
consumer exercises each, these are the first to graduate.

> gate-4 + gate-5 progress -- **Wave 1 STAGED (both reviewer-APPROVED).** The
> freeze-gate recipe, established here as the template for the other waves:
> - **gate 4 (freeze the boundary):** both modules already carried a blueprint "What
>   this is not" section AND a deliberately minimal, complete surface, so no README
>   surgery was needed -- the freeze is RECORDED, not invented. strategies has no
>   deferred/1.1 surface at all (`StrategyRouter` + `VERSION`, "no bind helper, no
>   default export, no frozen enum" by design); graph's ONE open boundary defect (the
>   toJSON dangling-edge discrepancy) was already RESOLVED at `ac34b5e`, so its
>   fail-closed contract now matches reality across all three exporters. Each freeze is
>   written down as an "### API frozen at 1.0.0" block in the changelog naming what is
>   deliberately excluded (a post-1.0.0 change, never a silent 1.0.x slip).
> - **gate 5 (stage the changelog):** a `## [1.0.0] - 2026-08-11` entry drafted at the
>   TOP of each CHANGELOG (graph folds in its `[Unreleased]` toJSON Fixed block). The
>   "Proven" section was rewritten to the REAL post-gate-2 reality -- the finalization
>   residual (`size() <= 16`, clean 0/16), NOT the old vacuous `size()===0` phrasing the
>   alpha.1 entries still carry -- with every empirical number (0.000 B/op lanes, 1e6
>   ops, mutator spies 0, break switches, node:test counts) VERIFIED against a live
>   `npm run verify` + `npm test` by an adversarial reviewer, not copied from this
>   ladder. strategies 136/136 + residual 0/16; graph 53/53 + residual 0/16 (formatter
>   allocates by construction -- honest, no 0 B/op claim).
> - **NOT done here (maintainer's explicit call, the release gate):** the three-place
>   version bump alpha.1 -> 1.0.0 (package.json + VERSION const + llms.txt), the
>   LiteCatalog card sync, and the commit/publish. The `[1.0.0]` heading is staged AHEAD
>   of the const bump on purpose; the entries make no false claim that the const already
>   reads 1.0.0. Reviewers flagged the sync as the one remaining step for each.

> gate-3 progress -- **strategies CLEARED** (reviewer-APPROVED). Shipped
> `examples/billing-dispatch.mjs`: a self-verifying billing-dispatch service that routes
> each request's tenant tier to one of three registered plan impls, exercises the ENTIRE
> public surface (`select` / `resolve` / `.keys` / `.size` / `VERSION`), proves the
> fail-closed throw on an undeclared key (a strict router beside the explicit-default one),
> and proves the composition hinge: a live `container.rebind('plan:pro', VALUE V2)` beside
> the router flips the next `resolve()` to the V2 instance with ZERO router API calls
> (selection + swap compose without merging, decision 0001). Every claim asserted with
> `node:assert`; wired into `files[]` + a new `example` script folded into `verify` /
> `prepublishOnly`, so it is a HARD gate (a broken invariant exits non-zero -- proven by
> tampering: identical V2 pricing -> ERR_ASSERTION, exit 1). Reviewer confirmed surface
> coverage complete, assertions load-bearing (not vacuous), no fail-open contradiction,
> ASCII + zero-dep clean. Uncommitted (maintainer's call).

> gate-3 progress -- **graph CLEARED** (reviewer-APPROVED after one REJECTED cycle).
> Shipped `examples/export-graph.mjs`: boots a real container with ONE of every
> registration kind (value / singleton / transient / factory / alias, wired with real
> deps -> real resolve edges), snapshots it via `fromContainer`, renders all three
> exporters (`toJSON` / `toDOT` / `toChromeTrace`) plus `nodeKind` / `KIND_NAMES` /
> `VERSION`, and asserts round-trip determinism (endpoint content + byte-identical
> re-serialize), the integer->label mapping, and fail-closed throws. Wired into `files[]`
> + an `example` script folded into `verify` / `prepublishOnly` (hard gate; tamper ->
> non-zero exit, proven). **The REJECTED cycle surfaced a real LIBRARY defect, not just
> an example bug:** `toJSON` validates edge SHAPE but NOT referential integrity -- a
> dangling edge (`to` a token absent from `nodes`) is EMITTED silently, while `toDOT` and
> `toChromeTrace` throw a named TypeError. That contradicts graph's own `llms.txt`
> fail-closed contract ("checked per exporter ... a dangling edge is an error"). The
> example was corrected to route the dangling edge through the exporters that ACTUALLY
> enforce it (never teaching a false `toJSON` guarantee); the `toJSON`-vs-doc discrepancy
> is flagged as its own maintainer decision (fix `toJSON`, or narrow the doc) and is a
> **gate-4 blocker for graph** -- the 1.0.0 fail-closed boundary must match reality before
> the API freezes.
> **RESOLVED (option A, committed `ac34b5e`):** `toJSON` now applies the same
> dangling-reference guard as `toDOT` / `toChromeTrace`, so all three fail closed on a
> dangling edge with the same message; a `node:test` case was added in BOTH the behaviour
> and boundary suites ("a dangling edge endpoint fails closed in EVERY exporter", from AND
> to endpoints), closing the coverage gap. `llms.txt`'s "checked per exporter" is now
> true; the example teaches uniform enforcement. `verify` green, all 3 BREAK controls trip.
> Graph's gate-4 is no longer blocked by this. Wave 1 committed + pushed.

> gate-2 progress -- **Wave 1 leak-gate ports COMPLETE** (both reviewer-APPROVED):
> - **strategies** `t5-soak.mjs`: vacuous `track+untrack -> size()===0` -> real
>   finalization residual (track-without-untrack, 10-pass hard settle, `residual <= 16`);
>   `DI_TORTURE_BREAK` pins the router, trips `AUTHORITY residual size()=11000 > 16`
>   directly; clean exit 0, 136/136 node:test, heap secondary 2 MB over ~774 KB plateau.
> - **graph** `t7-soak.mjs`: same port; tracked object is the `describe()` snapshot;
>   the retention lane had NO break control before -- now `DI_TORTURE_BREAK` pins the
>   snapshot and the soak residual trips `size()=10000 > 16` (proven in isolation, since
>   this is a whole-suite control and an earlier tier trips first in a full run); clean
>   exit 0, all 3 controls exit 1, 53/53 node:test, heap 620 KB stable under 2 MB.
> Both reviewers traced lite-cleanup internals: `size()` drops ONLY on real GC finalize
> or unregister, and the FR-held value never references the tracked object -- so the
> residual is a true finalization counter, not the old synchronous tautology.

### Wave 2 -- lifecycle cadence

| Rank | Module | Leak gate (gate 2) | Single blocker to 1.0.0 |
| ---- | ------ | ------------------ | ----------------------- |
| 3 | lite-di-event-bus | **REAL (ported + reviewer-APPROVED)** | ~~consumer fan-out~~ ~~gate 3~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED) -> awaits version bump + card sync (maintainer) |
| 4 | lite-di-cron | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ ~~schedule surface~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED, 1 REJECTED cycle -> CronError enumerated) -> awaits version bump + card sync (maintainer) |
| 5 | lite-di-ticker | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ ~~stop() doc mismatch~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED; stop() RESOLVED docs-follow-code) -> awaits version bump + card sync (maintainer) |

> gate-3 progress -- **Wave 2 CLEARED** (event-bus + cron + ticker all reviewer-APPROVED).
> Each ships a self-verifying
> `examples/*.mjs` wired into `files[]` + an `example` script folded into
> `verify`/`prepublishOnly` (hard gate; tamper -> non-zero exit, proven per module):
> - **event-bus** `examples/order-pipeline.mjs`: an order fan-out with DI-constructed
>   listeners, a NESTED sync emit (a handler emits a follow-up event), error-isolated
>   `emitSafe`, `emitAsync`, and every fail-closed path incl. the depth-8 runaway guard
>   and the DISTINCT post-shutdown ("Container shut down.") vs post-dispose ("bus has
>   been disposed.") errors. One REJECTED cycle: `dispose()` was uncalled under an
>   "ENTIRE surface" claim -> now exercised.
> - **cron** `examples/scheduled-jobs.mjs`: a scheduled-jobs service driven
>   DETERMINISTICALLY by an injected clock + explicit `tick(now)` (no real timers). Asserts
>   the exact firing sequence (interval / aligned-bucket / UTC-cron), `setEnabled`,
>   start/stop/running/tickCount, the pure `shouldRun`/`parseCronExpr`, `CronError` codes,
>   onError isolation AND the default loud re-throw, and `reset()` proven to unregister the
>   CONTAINER binding (`c.has('cron:job:hb')` false) + unlock the boot-lock. One REJECTED
>   cycle: the job()-after-start test hit the container boot-lock, not cron's
>   `ALREADY_STARTED` guard (stop() had cleared running) -> fixed to hit the real guard;
>   reset() proof strengthened from cron-state to container-binding.
> - **ticker** `examples/frame-loop.mjs`: a headless frame loop, three lanes
>   (pre->normal->post), driven by hand-called `tick(dt,time)` + a CAPTURING rAF shim for
>   one real `getDelta`/`getTime`-injected frame. Asserts lane order + `timeScale` scaling
>   (incl. the live setter), pause/enable gating, the stop-drops-resolution / re-start
>   re-resolves cycle (the ACTUAL code behavior -- llms.txt's "keep the resolved systems"
>   is WRONG, flagged as a gate-4 doc blocker, task_a6158d74), and the fail-closed guards.
>   Two REJECTED cycles: the `timeScale` accessor + valid `getDelta`/`getTime` injection
>   were unexercised under an "every method" claim -> both now proven (the latter via a
>   real captured rAF frame).

> gate-2 progress -- **Wave 2 leak-gate ports COMPLETE** (all three reviewer-APPROVED):
> - **event-bus** `t7-soak.mjs`: 3-sub-phase soak; all three now track the BUS
>   without untracking (was a throwaway `{cycle}` + two `size()===0` tautologies), one
>   hard settle + `residual <= 16`; BREAK pins every bus, isolation trips `size()=3000`;
>   field-null release + fail-closed proofs preserved; clean residual 1/16, 45/45 tests.
> - **cron** `t7-soak.mjs`: Phase 1 tracks the CRON instance (was `{cycle}`); Phase 2
>   (1e6-tick `maxMajor<=0`) untouched; isolation trips `size()=200`; residual 1/16,
>   70/70 tests. Reviewer traced arm()-not-start() (no global timer) + interval-type
>   (no cron-cache) -- no retention path escapes the witness.
> - **ticker** `t7-soak.mjs`: Phase 1 tracks the TICKER (was `{cycle}`); Phase 2
>   (1e6-frame) untouched; isolation trips `size()=500`; residual 1/16, 54/54 tests.
>   Reviewer confirmed the rafEffect arrow-closure captures `this`=ticker, so a leaked
>   effect keeps the ticker reachable -- the residual genuinely witnesses a dispose leak.

### Wave 3 -- reactivity

| Rank | Module | Leak gate (gate 2) | Single blocker to 1.0.0 |
| ---- | ------ | ------------------ | ----------------------- |
| 6 | lite-di-signal | **REAL (already ported)** | ~~downstream consumer~~ ~~gate 3~~ ~~freeze injection contract~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED; deferred-1.1 surface written down) -> awaits version bump + card sync (maintainer) |

Signal already clears gate 2. Its remaining bar WAS freezing the injection contract
(decision 0001) as the stable API -- now DONE: the [1.0.0] entry freezes the nine
shipped exports and explicitly records the DEFERRED-to-1.1 surface (`reactiveClass` +
`multiSignal` / `multiComputed` / `multiEffect` / `startMultiEffects`) as staged-but-
unshipped, so a reader cannot mistake it for 1.0.0 API.

> gate-3 progress -- **Wave 3 CLEARED** (signal reviewer-APPROVED after one REJECTED
> cycle). Shipped `examples/live-cart.mjs`: a per-connection live pricing cart where every
> connection is a container SCOPE with its OWN isolated lite-signal registry (quantity
> signals, subtotal/total computeds, an audit effect, a receipt reactiveService). Proves
> all 9 exports incl. both `signal` initial forms (value + factory), `useScopedSignals`
> closures, `createSignalScope`, idempotency (valid post-boot -- the check precedes the
> boot lock), and the two headline claims NON-vacuously: scope ISOLATION (Bob's writes
> leave Alice's graph untouched -- separate registries) and DETERMINISTIC teardown (a
> spying createRegistry proves the log is `service:destroy -> registry:destroy`, registry
> LAST). REJECTED cycle: only 2 of the 4 registry-member guards were exercised (contract
> says EACH) -> a loop now drives all four signal/computed/effect/destroy, + computed
> non-function-setup + the dispose() fallback path. Wired into files[] + `example` folded
> into `verify` (hard gate). 54 tests + torture GATE ok + reference app OK, exit 0.

**Signal 1.1 candidates (deferred surface, tracked -- do NOT let this get lost).** The
1.0.0-alpha.1 surface is deliberately minimal: the lifetime core
(`registerSignalRegistry` / `useScopedSignals` / `createSignalScope`) plus the
single-binding factories (`signal` / `computed` / `effect` / `reactiveService`). The
staged `DIReactive.js` also carried a WIDER surface that was DEFERRED, not shipped
(and must not be cited as existing): `reactiveClass`, and the multi-binding factories
`multiSignal` / `multiComputed` / `multiEffect` / `startMultiEffects`. Each returns to
scope only if a torture tier proves it earns its place -- a post-1.0.0 (1.1) addition,
never a silent 1.0.x slip. Freezing 1.0.0 (gate 4) means writing this boundary down so
1.0.0 does not immediately need 1.1 to be usable.

### Wave 4 -- resilience + process capstone (largest surface; last)

| Rank | Module | Leak gate (gate 2) | Single blocker to 1.0.0 |
| ---- | ------ | ------------------ | ----------------------- |
| 7 | lite-di-lock | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ ~~freeze Store adapter~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED; 3-method Store adapter + single grant shape frozen) -> awaits version bump + card sync (maintainer) |
| 8 | lite-di-health | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED) -> awaits version bump + card sync (maintainer) |
| 9 | lite-di-supervisor | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ ~~reportFault mismatch~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED; reportFault sync-throw RESOLVED narrow-the-docs) -> awaits version bump + card sync (maintainer) |
| 10 | lite-di-orchestrator | **REAL (ported + reviewer-APPROVED)** | ~~consumer~~ ~~gate 3~~ **gate 4 MET + gate 5 STAGED** (reviewer-APPROVED, composed capstone / SIGTERM drain) -> awaits version bump + card sync (maintainer) |

Orchestrator graduates last: it coordinates supervisor, health, and the container, so
its downstream proof presupposes theirs.

> gate-3 progress -- **Wave 4 CLEARED (all four proven in COMPOSITION), reviewer-APPROVED
> after one REJECTED cycle.** Per the ratified HYBRID form, the resilience four are proven
> by ONE composed reference service, NOT four isolated examples (they are only provable
> together). Artifact: `LiteDiOrchestrator/examples/service-kernel.mjs` -- a self-healing
> service kernel: container graph (db<-cache<-api) + supervisor (rest-for-one heal) +
> health (watchSupervisor readyz/livez) + a leader-only fencing lock (bindLock) +
> orchestrator (the SIGTERM drain). Every claim asserted with node:assert/strict; wired
> into files[] + an `example` script folded into `verify` (hard prepublish gate). It
> HOSTS in the orchestrator (the capstone) and required adding `@zakkster/lite-di-lock`
> as the 5th workspace dev dep there (symlink + package.json). The narrative proves, non-
> vacuously (each verified by tamper -> exit 1): the push-vs-poll split (health polls and
> SEES a break; the supervisor is push-based and does NOT act until reportFault); rest-
> for-one + one-for-all rebuild the right set to FRESH instances; the restart budget
> ESCALATES instead of hot-looping; the fencing lock's mutual exclusion + fence advance +
> fail-closed heartbeat (LOST); and the ratified teardown ORDER drain -> supervisor.
> shutdown -> steps -> container(lock disposed) -> exit(OK) exactly once, liveness staying
> UP through the drain. REJECTED-cycle lesson: the "lock disposed via container.shutdown"
> claim was VACUOUS -- section 2's RAII run() already left the lock RELEASED, so the
> post-shutdown state assert was green regardless. Fixed by re-acquiring the lock HELD
> before shutdown (a HELD lease reaches RELEASED ONLY via the container-driven dispose)
> AND tapping its dispose into the order log; the reviewer's own tamper (bindLock -> plain
> factory) now exits 1. Deliberate coverage gaps (NOT false claims, left to each module's
> own torture): REASONS.TIMER_UNARMABLE/FENCE_REGRESSED/STORE_ERROR (only a THROWING
> setTimeout arms TIMER_UNARMABLE -- a falsy handle stays HELD, so teaching it would be
> false) and EXITS.FORCED (needs racing real signals -> fragile).

> **gate-4 item for supervisor -- RESOLVED (narrow-the-docs, maintainer's call).** The
> THIRD doc/code finding (after graph's toJSON and ticker's stop()): `reportFault(token,
> err?)` is typed `Promise<void>` but its not-running / unknown-token guards `throw`
> SYNCHRONOUSLY (Supervisor.js:291-301), before any promise, so `sup.reportFault(tok)
> .catch(...)` lets the guard error escape `.catch()`. The maintainer chose NARROW-THE-DOCS
> (the sync guard-throw is the intended fail-closed behavior -- a dead/mis-addressed
> supervisor rejects loud + early): documented at llms.txt:81-83, README.md:238-239,
> Supervisor.d.ts:96-98 (use try/catch or `run()`, never a bare `.catch`). No code change.
> Recorded in the supervisor `## [1.0.0]` entry's "Fixed" + "API frozen" blocks; reviewer-
> APPROVED. Supervisor is unblocked.
>
> **Companion resolution -- ticker stop() (the SECOND doc/code finding) RESOLVED
> docs-follow-code.** `stop()` DROPS the resolution deliberately (the D2 hazard: a
> container torn down between stop() and start() must never re-bind torn-down instances);
> llms.txt:66 + Ticker.d.ts:72 (which had said "keep the resolved systems") are corrected
> to match the code. README already described the drop. No code change. Choosing the docs'
> "keep" side would have REVERTED a fail-closed guard -- caught and surfaced before
> implementing. Recorded in ticker's `## [1.0.0]` "Fixed" block; reviewer-APPROVED.

> gate-2 progress -- **Wave 4 leak-gate ports COMPLETE** (all four reviewer-APPROVED):
> - **lock** `t6-soak.mjs`: tracks the Lock (was track+untrack); store-drain + timer
>   census preserved; residual 0/16, isolation trips `size()=11000`, 164/164 tests.
> - **orchestrator** `t6-soak.mjs`: tracks the Orchestrator; SIGTERM/SIGINT listener
>   census preserved and runs before the residual read (dispose() before the pin);
>   residual 0/16, isolation trips `size()=11000`, 113/113 tests.
> - **health** `t7-soak.mjs`: Phase 1 tracks the Health (1e5 cycles, RES=100); Phase 2
>   (1e6 poll `maxMajor<=0`) untouched; residual 0/100, isolation trips `size()=100000`,
>   126/126 tests; 16 MB secondary honest at ~1.94x the 8.26 MB working set.
> - **supervisor** `t7-soak.mjs`: the non-trivial witness -- Phase 1 tracks the
>   RE-RESOLVED CHILD `c.get('svc')` each cycle (was a throwaway `{cycle}`; the
>   supervisor is long-lived). Reviewer confirmed ONE_FOR_ONE does invalidate+re-resolve
>   so each cycle is a distinct child (proven 5/5 distinct); residual read after
>   sup.shutdown() so even the last child releases; residual 0/100, isolation trips
>   `size()=100000`, ring/SoA-no-realloc structural invariants preserved, 103/103 tests.

---

## What promotion does NOT include (this session)

- No version bump, no source edit, no republish. This document is the plan.
- No commit / publish / sync-card without the maintainer's explicit go.
- The leak-gate port (gate 2) is a real code change per module -- it is the FIRST task
  of each module's own promotion session, run through the full pipeline
  (planner -> coder -> reviewer -> qa), not batched blindly here. The BREAK control must
  be re-proven to trip the residual gate after each port.
