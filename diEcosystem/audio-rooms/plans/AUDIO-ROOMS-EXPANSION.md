# audio-rooms -- targeted 2-session expansion (NOT the full market-map S1-S10 arc)

## Thesis
Turn audio-rooms from a browser-only SKELETON into a PROVEN second demo. Its unique,
memorable claim -- **scoped teardown of a leak-prone Web Audio graph -> live node census
back to 0** -- is currently only asserted in prose. This plan proves it headless
(node:test) and gates it in CI, the exact step (market-map S6) that turned market-map
from skeleton to credible. It deliberately SKIPS the redundant parts of the market-map
arc.

## Explicitly OUT of scope (redundant or non-applicable)
- S4 GPU pipeline, S5 observability panel -- near-identical to market-map; polish, not new proof.
- S8-S10 decorated-VM / watchlist pool / labeled reactive graph -- built on per-symbol
  reactive view-models; audio-rooms has NO per-voice reactive state BY DESIGN
  ("one signal per voice would defeat the pitch"). No analog to expand.

## De-risk FIRST (before either session -- market-map S6 lesson)
1. **No AudioContext in node.** The headless test proves the DI LIFECYCLE (scope teardown
   ORDER, census MODEL -> baseline, self-heal identity) against a MOCK engine + mock ctx,
   NOT real AudioNode disconnection. This is the SAME fidelity boundary as market-map's
   fake socket -- be honest about it in docs. Prereq: the engine is currently hardcoded
   (`new LiteAudio()` at kernel.js:480); it must become an injectable `engineFactory`
   (the `ctx` is already injected via bootKernel, kernel.js:386/399).
2. **Version skew.** Pins are stale vs market-map: lite-signal 1.4.4, lite-gl 1.5.0,
   lite-raf 1.1.0 (market-map: 1.5.0 / 2.0.0 / 1.2.0). Reconcile to a coherent import map;
   scratch-probe npm-publication + node-importability of every specifier BEFORE the
   pipeline (market-map S6 de-risk). Add a package.json + COMMITTED lockfile (the
   market-map CI-lockfile lesson: `npm ci` fails without a tracked package-lock.json;
   do NOT gitignore it).

## Session A1 -- the headless seam + node:test (the credibility core)
**T1 -- engineFactory seam.** `bootKernel({ctx, engineFactory, c2d, gl, w, h, onEvent,
onMode})`. Default `engineFactory = () => new LiteAudio()`; tests inject a mock. Browser
path UNCHANGED. Mirror market-map's `socketFactory`.

**T2 -- mock engine + mock ctx (test/helpers/harness.mjs).** Faithful to LiteAudio's
surface (init/createBus/defineSounds/play/setPosition/destroy/onRestart). Its `destroy()`
must DECREMENT the census model -- a mock whose teardown does not release is the
market-map S9 harness-faithfulness bug (a fixture that never frees confounds every
retention gate). Also a headless rAF shim (market-map S6: lite-raf fails closed without a
global requestAnimationFrame; setTimeout-backed, cancelAF lets shutdown exit).

**T3 -- node:test suite (the four gates).** node:test only.
- **G1 census-to-baseline (the headline).** Enter N rooms, then leave each ->
  `censusOf` returns to 0. NON-VACUOUS: a `BREAK` canary that no-ops `engine.destroy()`
  leaves census > 0 -> RED. (Falsifiable, not a tautology -- the house cardinal rule.)
- **G2 reverse-topo teardown ORDER.** Assert the order from OBSERVED `onTeardown` fires
  (push into a walk array inside the real hooks), with the EXPECTED order derived
  INDEPENDENTLY -- never by iterating a hardcoded constant (the market-map S6
  VACUOUS-ORDER-GATE lesson: comparing a copy to itself always passes). RED-prove by
  perturbing a registration order.
- **G3 self-heal identity.** `reportFault` -> engine re-resolved on the SAME ctx:
  `ctx` identity stable, engine object FRESH (!==), restarts++, voices re-stamped. The
  render loop/listener state never drops.
- **G4 fail-closed parent.** The ROOT refuses to shut down while a room child scope is
  live (Container child-guard); and no-engine -> health `readyz` not-ready (null is not
  zero).

**T4 -- hot-path alloc gate.** The ticker's `engine.setPosition(handle,x,y,z)` stamp is
the hot path. An alloc gate (lite-gc-profiler) proving ~0 B/op per frame stamp, mirroring
market-map's alloc gate. (torture-equivalent optional: room open/close churn -> census 0
over many cycles, WeakRef scope reclaim.)

### A1 assertions (all must be able to go RED)
1. census -> 0 after leaving every room; BREAK (skip destroy) -> census > 0 (RED).
2. teardown order == the reverse-topo order, derived independently; a reordered
   registration -> mismatch (RED).
3. heal: ctx stable, engine fresh, restarts incremented; a heal that reuses the dead
   engine -> RED.
4. setPosition stamp allocates <= a small absolute byte budget per frame (portable
   ceiling -- market-map A1 lesson: heapUsed byte-deltas are noisy; assert the
   deterministic thing, keep any byte check a coarse backstop).

## Session A2 -- CI + reconciliation + polish
**T5 -- packaging.** package.json (private, exact pins matching the import map) +
regenerated, COMMITTED lockfile. Reconcile the import map versions (T's de-risk).

**T6 -- ci.yml.** A test matrix (node 20/22/24) running `npm test`, plus a
"teardown/leak" job running the census + alloc gates and an inverted break-gate (armed
canary must exit non-zero -> CI red). Mirror market-map's ci.yml MINUS the GPU bits.
Pages deploy stays the suite-level workflow (already deploys the whole tree).

**T7 -- docs/version reconciliation.** README: bump the version table to the reconciled
pins; add a "Proven headless" section with the census gate as the receipt (honest about
the mock-engine fidelity boundary from de-risk #1); fix the live URL to the ACTUAL Pages
host (see the market-map URL-mismatch finding -- peshovurtoleta.github.io/lite-di-container,
not zakkster.github.io/LiteDiContainer, unless the canonical host is changed).

**T8 -- ecosystem cross-link (optional, cheap).** Add audio-rooms beside market-map on
`../index.html` (a second card / one line) as "the scoped-teardown-over-Web-Audio sibling,
proven headless." No new script; reuse existing section CSS.

### A2 assertions
- `npm ci` succeeds from the committed lockfile (every specifier resolves from public npm).
- CI: test matrix green; teardown/leak job green; break-gate armed-canary exits non-zero.
- README version table mirrors the import map key-for-key; the live URL returns 200.

## Risks
- **[HIGH] Web Audio is browser-only.** Headless proves the DI lifecycle + census MODEL,
  not real AudioNode disconnection. Same boundary as market-map's fake socket -- state it
  plainly; do not overclaim.
- **[MED] Census fidelity.** `censusOf` is modeled from engine state; the gate asserts the
  model returns to 0. A real create*-factory counter (README's "real census" SEAM) is
  owner-elective, NOT in this plan.
- **[MED] Version/lockfile.** Reconcile + commit the lockfile before the pipeline, or CI's
  `npm ci` fails (the exact market-map CI break).

## Effort
Two focused sessions via the house pipeline (planner-reconciliation -> coder -> reviewer
-> qa), NOT ten. A1 is the value (proven teardown/heal); A2 is the shipping wrapper (CI +
docs). If time-boxed to ONE session, do A1 only -- the headless census gate is the whole
point; CI/docs can follow.
