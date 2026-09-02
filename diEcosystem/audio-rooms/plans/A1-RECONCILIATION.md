# audio-rooms A1 RECONCILIATION -- coordinator brief (READ BEFORE AUDIO-ROOMS-EXPANSION.md)

Goal of A1: turn audio-rooms from a browser-only skeleton into a PROVEN demo -- prove the
Web-Audio scoped-teardown + self-heal claims HEADLESS under node:test, non-vacuously. This
brief carries the de-risk facts I verified live so the coder implements with confidence.

## DE-RISK FACTS (verified live -- do not re-derive, confirm by running)
- ALL 14 specifiers the kernel imports resolve + import cleanly in NODE (di-* x8, lite-signal,
  lite-raf, lite-gl/backend, lite-audio, lite-audio-pool). `@zakkster/lite-audio` imports with
  NO AudioContext at module top -- so importing kernel.js headless is SAFE.
- `kernel.js` MODULE LOADS headless and `bootKernel({ctx:{}, c2d:null, gl:null, w:0,h:0,
  onEvent(){}, onMode(){}})` SUCCEEDS headless (root scope + ticker boot fine).
- `enterRoom('A')` then fails at EXACTLY `this._ctx.createGain is not a function` -- real
  LiteAudio.init(ctx) hitting a stub ctx. This is the ONLY headless blocker; the makeEngine
  seam + a mock engine fixes it and enterRoom will complete headless.
- Single engine construction site: kernel.js:480 `const e = new LiteAudio();`.
- Census model: `censusOf(engineLive, voices) = engineLive ? 6 + voices*3 : 0`
  (ENGINE_BASE_NODES=6, VOICE_NODES=3). ROOM 'A' has N emitters (<= MAXE=8).

## THE SEAM (one change)
`bootKernel({ctx, makeEngine = () => new LiteAudio(), c2d, gl, w, h, onEvent, onMode})`.
Line 480 becomes `const e = makeEngine();`. Everything else (e.init(ctx)/createBus/
defineSounds/layoutOf/play/setPosition/activeCount/destroy) stays -- called on whatever
makeEngine returns. Browser path UNCHANGED (default builds real LiteAudio). Keep the
module-top `import {LiteAudio}` (it imports fine in node; the default factory uses it).
makeEngine is a bootKernel param -> in scope for the engine factory closure at 479-489.

## THE MOCK ENGINE (test/helpers/harness.mjs) -- faithful, S9 lesson
Implement the FULL surface the kernel calls: `init(ctx)` (async; RECORD the ctx -- heal
identity gate reads it), `createBus(name, opts)`, `defineSounds(sounds)` (async),
`layoutOf()` (return a string e.g. 'stereo'), `play(id, vol, x, y)` (return a numeric
handle), `setPosition(h,x,y,z)` (no-op; the hot-path stamp), `activeCount(bus)` (return the
live voice count), `destroy()` (release).
- CRITICAL (market-map S9 harness-faithfulness lesson): the mock must track its OWN live
  audio-node count. `createBus` -> +ENGINE_BASE_NODES(6); each `play` -> +VOICE_NODES(3);
  `destroy()` -> set it to 0 AND drop the ctx ref. A mock whose destroy() does not release
  is the confounding-fixture bug -- the census gate must measure the mock's REAL post-destroy
  state, not a fixture that never frees.
- Provide `makeFakeEngine()` returning a fresh mock each call (heal builds a NEW engine ->
  the seam is called again). Track every engine built (an array) so the heal gate can assert
  a FRESH instance + SAME ctx.
- Also export `installRaf()` (setTimeout-backed rAF shim + cancelAF -- the ticker/lite-raf
  fails closed without a global rAF; cancelAF lets handle.stop() exit) and a `mockCtx` (a
  plain object; the mock engine never calls real ctx methods, so `{}` suffices -- but give it
  an identity so the heal gate can assert ctx stability).

## PACKAGING (prereq -- node:test resolves bare specifiers)
Add `package.json` (private, type module) with deps at the versions I probed working, and
a COMMITTED `package-lock.json` (market-map CI-lockfile lesson: `npm ci` needs a tracked
lockfile; do NOT gitignore it). Proven-importable versions:
`@zakkster/lite-di-container@2.2.0, lite-di-event-bus@1.1.0, lite-di-strategies@1.0.0,
lite-di-cron@1.0.0, lite-di-ticker@1.0.0, lite-di-supervisor@1.0.0, lite-di-health@1.0.0,
lite-di-graph@1.0.0, lite-di-signal@1.0.0, lite-signal@1.5.0, lite-raf@1.2.0, lite-gl@2.0.0,
lite-audio@2.5.1, lite-audio-pool@1.4.0`. devDeps: `lite-gc-profiler@^1.15.0, lite-leak@^1.8.1`
(only if the alloc/leak gate is added). Scripts: `test`, and a `verify`/`churn` for any
--expose-gc gate. VERIFY the kernel BOOTS + enterRoom COMPLETES headless with the mock (the
real integration proof) before writing the gates -- if a di-* version is API-incompatible it
surfaces here.

## THE GATES (node:test only; each MUST be able to go RED)
**G1 -- census -> 0 (the headline).** boot(mock) -> enterRoom('A') -> assert the mock's live
node count == 6 + N*3 AND `readState().audioNodes` == same AND engineLive true. Then
leaveRoom() -> assert mock live nodes == 0 AND `readState().audioNodes` == 0 AND engineLive
false. NON-VACUOUS canary: a mock whose `destroy()` is a NO-OP leaves live nodes > 0 after
leaveRoom -> RED (prove it). Repeat enter/leave over many cycles -> stays 0 (no growth).

**G2 -- self-heal identity.** enterRoom -> capture engine#1 + its recorded ctx. killAudio()
(sup.reportFault('engine')); await the restart to settle. Assert: `readState().restarts`
incremented; a FRESH engine instance (engine#2 !== engine#1); engine#2.init was called with
the SAME ctx object (identity stable -- the "same shared ctx" claim); census restored to
6 + N*3; voices re-stamped (activeCount back to N). A heal that reused the dead engine or a
new ctx -> RED.

**G3 -- fail-closed.** (a) With no room / no engine, `readState().readyz` is NOT ready
(health source `world.engine ? 0 : 1`); after enterRoom, readyz ready. (b) The ROOT refuses
to shut down while a room child scope is live -- drive `shutdownRoot()` with a live room and
assert the fail-closed guard fires (the container child-guard rejects; capture via the
onEvent 'escalate' log or the root's still-live state). null is not zero.

**G4 -- reverse-topo teardown ORDER (genuine, S6 lesson).** Prove the room tears down in
reverse resolution order. Observe ACTUAL fires -- do NOT narrate by iterating a hardcoded
list (the market-map S6 VACUOUS-ORDER-GATE: comparing a copy to itself always passes). Add
the MINIMAL seam needed: e.g. expose the live `roomScope` as `handle._roomScope` (test-only,
like market-map's handle._scopes) so the test can read the container's teardown, OR have the
kernel push token names into a `handle._teardownWalk` array inside its real onTeardown hooks.
Derive the EXPECTED order independently (from resolution order) and RED-prove by perturbation.
If a genuine cross-token order proves to need more seam than A1 warrants, SCOPE IT DOWN
honestly to: assert engine.destroy() is observed during leaveRoom() and the scoped signal
registry is disposed after -- two ordered, observed fires -- and say so; never ship a vacuous
order gate.

**T5 (optional, stretch) -- no-alloc stamp.** RenderSystem.update() stamps
`eng.setPosition(h,x,0,z)` per voice every frame (kernel.js:375). If feasible headless
(construct RenderSystem(world) with the mock engine + a null-safe renderer/router, or drive
handle's render path), gate ~0 B/op with lite-gc-profiler. Portable byte ceiling, not a
tight absolute (market-map A1 lesson: heapUsed deltas are noise; the deterministic thing is
the gate). Skip if the RenderSystem/renderer coupling makes it flaky -- G1-G4 are the core.

## FIDELITY CAVEAT (state plainly, do not overclaim)
Web Audio has no AudioContext in node. These gates prove the DI LIFECYCLE (scope teardown,
census MODEL -> 0, self-heal identity, fail-closed) against a MOCK engine -- NOT real
AudioNode disconnection. This is the SAME boundary as market-map's fake socket. The browser
demo shows the real graph; the node gates prove the contract + census model.

## HOUSE LAW
node:test only; ASCII-only source (U+00D7, U+00B5 excepted); zero alloc on the hot path
(setPosition stamp); fail closed on unverified state (null is not zero); NO vacuous gate
(every gate RED-provable); no dead code. Do NOT git commit. Report: the seam diff, the mock,
each gate + its RED-proof, and all gate outputs verbatim (npm test; + churn/alloc if added).

## OUT OF SCOPE (A2 or never)
Browser import-map version reconciliation, CI, README updates -> A2. GPU/observability
(S4/S5) and the reactive-VM/watchlist/labeled-graph plane (S8-S10) -> never (no per-voice
reactive by design).
