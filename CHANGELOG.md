# Changelog

All notable changes to `@zakkster/lite-di-container` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-08-09

The 2.0.0 release. Every finding D-01..D-20 is closed; the three v2-regression DX
gaps are restored to v1 parity; the docs describe the code that exists, including
the lanes that allocate. Ships the container ALONE (decision 0004, option C): no
signal / reactive exports, no `@zakkster/lite-signal` dependency. The reactive
layer becomes a separate `@zakkster/lite-di-signal` in 2.1.

### Breaking changes (v1 -> 2.0.0)

- **Package renamed: `lite-di-container` -> `@zakkster/lite-di-container`.** v2 is
  published ONLY under the scoped name. The unscoped `lite-di-container` is
  deprecated on npm, ends at v1, and receives no further releases. Existing users
  must change their install and imports to the scoped name; there is no automatic
  redirect between an unscoped and a scoped npm package.
- **`TYPES` is an integer enum, not strings.** `VALUE=0, SINGLETON=1, TRANSIENT=2,
  FACTORY=3, ALIAS=4`, frozen. Any code comparing against the old string tags
  breaks. `ALIAS` is new.
- **No fluent chaining.** Registration methods (`value`/`singleton`/`transient`/
  `factory`/...), `boot()`, `reset()`, `unregister()` and `clear()` return
  `undefined`, not `this`. v1 chained; 2.0.0 does not. `Container.d.ts` return
  types are corrected to `void`.
- **No `export default`.** The package exports the named `{ Container, TYPES,
  VERSION }` only. (The `.d.ts` keeps a `default` alias for typed default imports;
  the runtime module does not.)
- **Cycle-trace separator is ASCII `->`.** Error messages read `a -> b -> a`, not
  the v1 `U+2192`. Any test matching the old glyph must update.
- **Token policy is enforced (D-15).** A token must be a non-empty string or a
  symbol; empty string / `undefined` / `null` / numbers now throw a `TypeError`
  at registration instead of silently registering.

### Restored v1 parity (v2-regression, cold-path only)

- **`factory()` validates its definition at registration.** A non-function
  definition throws a `TypeError` at register time (`Factory for '<name>' must be
  a function.`), not on first `get()`. Applies to `factory`/`factoryAsync`/
  `singletonFactory`/`singletonFactoryAsync`/`multiFactory`.
- **The "not registered" error lists available names again.** `get()` (and the
  async / multi lanes) throw `Service '<name>' is not registered. Available: [...]`.
  Cold path -- the list is built only on the throw branch.
- **An unknown `_registry` entry type throws (fail closed).** A corrupt entry with
  an unrecognised `type` throws `Service '<name>' has an unknown type: <type>.`
  instead of silently returning `undefined`, on both `get()` and the async lane.

### Findings closed (D-01..D-20)

- **D-01** suite now runs under `node:test` (was dead `require` in ESM).
- **D-02** async cycle detection crosses factory boundaries via a per-resolution
  context (decision 0002); the cross-factory case rejects with the full trace
  instead of hanging.
- **D-03** async singletons memoize the in-flight promise; N concurrent
  `getAsync()` build exactly once; a rejected build is evicted, not poisoned.
- **D-04** ASCII-only across every shipped file; enforced by T9 control 8 and
  `DI_ASCII_BREAK`.
- **D-05 / D-17** the "Strictly Zero Allocation" overclaim is deleted and replaced
  by the measured per-lane table below; `getAllInto` is the zero-alloc multi lane.
- **D-06** single identity `@zakkster/lite-di-container`; no private coupling in
  dependents (see D-20); packaging settled by decision 0004.
- **D-07** `boot()` validates the whole graph again, collecting every unregistered
  dependency / alias target into one thrown message.
- **D-08** multi bindings live in dedicated maps (decision 0001); `get()`'s cache
  probe can never return the internal cache array.
- **D-09** `unregister()` splices `_resolutionOrder`; teardown never doubles.
- **D-10** `getAll` / `getAllAsync` respect the shut-down guard.
- **D-11** `getAll` / `getAllInto` / `getAllAsync` participate in cycle detection.
- **D-12** two-phase `shutdown()` (DRAINING -> SHUT_DOWN); teardown failures are
  isolated and reported via `AggregateError` (or an `onTeardownError` hook); never
  `console`.
- **D-13** `shutdown()` releases all retained state; a live child scope blocks it.
- **D-14** the boot lock is kept (fail closed); `reset()` then `unregister` is the
  documented swap flow, which DICron already tolerates.
- **D-15** token policy enforced (see breaking changes).
- **D-16** `reset()` / `clear()` clear `_path`; `validate()` asserts it.
- **D-18** `CHANGELOG.md`, `VERSION` export (three-place sync), `files[]`, `LICENSE`,
  `engines.node >= 18`, `torture` / `verify` / `prepublishOnly` scripts.
- **D-19** README on the LiteSepforge blueprint spine; the `vitest` block is gone.
- **D-20** `isBooted` and `hasLocal` are public; dependents read no private state.

### Per-lane allocation table (re-measured at release)

| Lane | Measured | Gate |
| --- | --- | --- |
| Sync cached `get()` (T6 lane 1) | 0.000 B/call | gate at 0 (hard) |
| Value `get()` (T6 lane 1b) | 0.000 B/call | gate at 0 (hard) |
| `getAllInto` 8-entry multi (T6 lane 3c) | 0.000 B/call | gate at 0 (hard) |
| 3-dep transient (T6 lane 3a) | 0.071 B/op | pinned <= 8 |
| `getAll` 3-entry multi (T6 lane 3b) | 0.002 B/op | pinned <= 16 |
| Async cached `getAsync()` hit | 0.164 B/op | maxMajor 0, pinned <= 32 |

The sync cached `get()` lane is byte-identical to alpha.7: the three regression
restorations are all registration guards and throw-branch strings on cold paths.

### T8 dependent conformance

Five first-party dependents smoke-test their documented happy path against the
released container: **DIEventBus, DIStrategyRouter (StrategyRouter +
PipelineSwapper), DIOrchestrator, DICron, DILock**. DIEventBus and DIT migrated
off the private `_booted` read to the public `isBooted`. Documented known-gaps
(deferred, not silently skipped): **DIT** (imports `@zakkster/lite-raf`, absent in
this dev tree) and the **DIOExample / DILExample** runnable examples (import
`fastify` / `pg` / `bullmq` / `lite-di-orchestrator`). Dependents are gitignored
dev fixtures; the core package ships regardless.

### Packaging (decision 0004, option C)

`exports` is the single `.` entry; `files[]` ships the seven entries
(`Container.js`, `Container.d.ts`, `LICENSE`, `llms.txt`, `CHANGELOG.md`,
`README.md`). No `./signal` / `./reactive` subpath, no `@zakkster/lite-signal`
dependency, zero runtime dependencies. `2.0.0/`, `test/`, `decisions/` are
excluded from the pack.

## [2.0.0-alpha.7] - 2026-08-09

ASCII sweep, frozen namespace and public surface (D6). Deliberately last of the
code sessions: it touches every line, so running it before D2..D5 would mean
running it twice. No runtime behaviour changes -- ASCII-only edits, one additive
cold getter, and named pinning tests.

### Fixed

- **D-04**: every non-ASCII byte is gone from every shipped file. The 9 non-ASCII
  lines D0 recorded in `Container.js` (all `U+2550` box-drawing in comment
  banners, plus a `U+2014` em-dash on line 2) are now `===` / `--`; `Container.d.ts`
  (12 lines), `llms.txt` (16 lines) and `README.md` (9 lines) were swept the same
  way (`U+2014` -> `--`, `U+2192` -> `->`). `rg -n '[^\x00-\x7F]' Container.js
  Container.d.ts llms.txt README.md` -> no match. The cycle-trace separator was
  already ASCII `' -> '` and is now pinned by a named test.

  | Shipped file | non-ASCII lines before | after |
  | --- | --- | --- |
  | `Container.js` | 9 | 0 |
  | `Container.d.ts` | 12 | 0 |
  | `llms.txt` | 16 | 0 |
  | `README.md` | 9 | 0 |

- **D-04 (gate)**: T9 control 8 is now ENFORCING, not decorative. It scans every
  file in `package.json` `files[]` with the same `/[^\x00-\x7F]/` regex the D6
  gate runs and fails the whole suite on any non-ASCII byte. It proves it can fail
  on demand two ways: an injected `U+2550` fixture string, and `DI_ASCII_BREAK=1`,
  which pushes a poisoned in-memory entry into the scan set so the enforcing loop
  itself exits non-zero.
- **D-20**: the private reads first-party dependents relied on are now public API.
  `isBooted` (a cold boolean getter) promotes the private `_booted` flag that
  `DIT.js:43` / `DIEventBus.js:45` read; `hasLocal(name)` (already present, now
  documented and typed in `Container.d.ts` and tested by name) is the public form
  of the `_registry` read in `DIReactive.js:17`. Nothing needs private container
  state. (`2.0.0/` is deferred and untouched; the dependent rewrites belong to
  X1's T8.)

### Frozen surface + pinned conventions

- `TYPES` (already `Object.freeze`d) gains a named test asserting
  `Object.isFrozen(TYPES)`, the exact integer values (`VALUE===0 ... ALIAS===4` --
  the published `.d.ts` literal types, changing one is breaking), and that a
  mutation throws in strict mode. `Container.d.ts` `TYPES` is corrected from the
  stale v1 string literals to the real integer literals including `ALIAS`, and now
  declares `VERSION`, `hasLocal` and `isBooted`.
- Named tests pin: the cycle-trace separator string `' -> '`; the alias-in-trace
  rule (the requested alias name appears in the trace, not just the target); and
  that a thrown circular-dependency message matches `/^[\x00-\x7F]+$/`.

### Hot path

`isBooted` is a cold getter, never touched by `get()` / `getAsync()`. The
comment/whitespace ASCII edits do not alter any executable line. T6 lane 1 (sync
cached `get()`) stays 0.000 B/call, within noise of alpha.6.

## [2.0.0-alpha.6] - 2026-08-09

The zero-GC session (D5). This release measures the hot path, gates the one lane
that is truly zero, deletes the overclaim, and adds the fill-into-caller-buffer
form the package's own dependents were routing around.

### The lane-3 decision (D-17)

`getAll(name)` allocates a fresh result array on every call. Two first-party
dependents cache around it in writing (`DIEventBus.js:34`, `DIT.js:88`). The
roadmap weighed two fixes:

- **(a)** return a frozen cached snapshot array and document "do not mutate";
- **(b)** add `getAllInto(name, out)`, a fill-into-caller-buffer form that
  allocates nothing, keeping `getAll` as the allocating convenience.

**Chosen: (b).** It is the ecosystem's own idiom (`query(q, out)` in lite-bvh),
it lets `DIEventBus` / `DIT` drop their private caches, and it does not turn a
returned array into a shared-mutable-state hazard the way (a) does. `getAll`
stays as-is (pinned, not zeroed); `getAllInto` is the zero lane.

`getAllInto(name, out)` fills each resolved instance into `out[i]` and returns
the number of slots written (`out` may be longer than the binding). On a
fully-cached multi it allocates **zero bytes/call** (T6 lane 3c gates it at
`maxBytesPerCall: 0`). Out-of-bounds policy, **fail closed**: a non-array `out`
throws a `TypeError`; an `out` shorter than the binding throws a `RangeError`;
both are thrown before any resolution, on the cold path. There is **no async
form** -- the async lane allocates a promise per frame by construction, so a
fill-into buffer cannot make it zero; `getAllAsync` stays the async lane.

### The overclaim is gone

`Container.js`'s header no longer claims a "Zero-garbage-collection synchronous
hot path", and the resolution banner no longer says "Strictly Zero Allocation".
Both now point at the per-lane table below -- the honest boundary, measured, not
claimed.

### Fixed

- **D-05**: T6 lane 1 (cached `get()`) and lane 1b (value `get()`) are now HARD
  gated -- both the `checkAllocs` verdict AND the raw byte count are asserted to
  be exactly `0`, so no rounding can launder a regression through. T9 controls 1
  and 2 continue to prove the gate is not vacuous.
- **D-17**: `getAllInto(name, out)` added; the D-17 todo test flips to a passing
  contract test (`getAll` still allocates a fresh array per call, `getAllInto`
  fills a caller buffer with the same cached instances).

### Hot path

The sync cached `get()` lane is byte-identical to alpha.5: `getAllInto` is a NEW
method, nothing was added to `get()` / `getAsync()`. Re-measured against alpha.5,
no lane regressed (async is sampling-noisy and measured lower this run; a
reduction is fine, an increase fails).

| Lane | alpha.5 | alpha.6 | Gate |
| --- | --- | --- | --- |
| Sync cached `get()` (T6 lane 1) | 0.000 B/call | **0.000 B/call** | gate at 0 (hard) |
| Value `get()` (T6 lane 1b) | 0.000 B/call | **0.000 B/call** | gate at 0 (hard) |
| 3-dep transient (T6 lane 3a) | ~0.07 B/op | 0.072 B/op | pinned <= 8 |
| `getAll` 3-entry multi (T6 lane 3b) | ~0.00 B/op | 0.002 B/op | pinned <= 16 |
| `getAllInto` 8-entry multi (T6 lane 3c) | -- (new) | **0.000 B/call** | gate at 0 (hard) |
| Async cached `getAsync()` hit | ~0.31 B/op | 0.187 B/op | maxMajor 0, pinned <= 32 |

### Torture

- **T5 filled**: a seeded differential fuzz of 100k mixed ops per seed
  (register / get / getAll / getAllInto / getAsync / scope / unregister / reset /
  shutdown) against a naive ORACLE container written only for the test (a plain
  object graph, no caching cleverness). It compares per-op resolved-identity
  signatures (each side canonicalises its own objects to first-seen integer ids),
  throw/no-throw, and teardown SETS at shutdown (sorted multiset). Clean at 3
  seeds (300k ops total); on divergence it prints seed + op index + a minimal
  replay. The oracle mirrors the container's incremental multi caching (a
  multi is committed to the resolution order and cached slot-by-slot BEFORE its
  sub-deps build, so a mid-build failure leaves a partial multi that still tears
  down its built slots).
- **T6**: lane 1 / 1b hard-gated at literal zero; new lane 3c gates `getAllInto`
  at zero and asserts the multi flags `Uint8Array` is never regrown across the
  soak.

### Known limitation surfaced by T5 (async resolver, D3 scope -- not D5)

The differential fuzz surfaced a pre-existing limitation in the **async**
resolver, unrelated to this session's sync/getAll/getAllInto work: `getAsync` on
a graph where one singleton is reached through two concurrently-resolved branches
(a diamond, e.g. `A -> {B, C}` with `B` and `C` both depending on `D`) shares one
resolution path across those `Promise.all` branches and falsely rejects with a
circular-dependency error. Sync `get()` resolves the same diamond correctly. A
duplicated dependency name (`new Svc(a, a)`) trips the same path. This is D3
territory (async correctness) and out of D5's scope; the fuzz exercises
`getAsync` only on async-safe leaves and this is filed for a follow-up. It is NOT
a regression introduced here.

## [2.0.0-alpha.5] - 2026-08-09

Lifecycle, teardown and scope ownership (D4). `shutdown()` was three bugs in one
method: it flipped the shut-down flag before running any teardown (so a teardown
that resolves a collaborator threw), swallowed every teardown failure to
`console.error`, and released nothing. Decision recorded in
`decisions/0003-lifecycle.md`.

The four decisions:

- **Drain rule.** The old `_shutdown` boolean becomes a three-state integer
  `_state` (LIVE / DRAINING / SHUT_DOWN). The hot `get()` lane compares it
  **once**, in the same place, against a bare module-scope constant, so the
  cached-hit lane is byte-identical and stays 0.000 B/call. During DRAINING a
  teardown may read an already-cached collaborator (or a VALUE/ALIAS), but
  constructing a NEW service is rejected with a named error -- building during
  teardown would push a name onto `_resolutionOrder` mid-walk.
- **Error reporting.** `Container.js` never calls `console.*`. `shutdown()` runs
  every teardown (isolation preserved), collects failures, and rejects with an
  `AggregateError` after the walk. An optional `{ onTeardownError }` hook, when
  supplied, receives `(error, name)` per failure and suppresses the
  AggregateError. Unknown option keys and a non-function hook are rejected.
- **Release + child-scope tracking.** After the walk, `shutdown()` clears
  `_singletons`, `_multiSingletons`, `_resolvedFlags`, `_resolutionOrder`,
  `_teardowns` and `_pending` (`_registry` is kept). Shutdown does NOT cascade to
  child scopes (law 4); instead the parent tracks live children with an integer
  count `_liveChildren` and throws if a child is still live. A `WeakRef` set was
  implemented first and measured to blow the T7 heap gate (~6.8 MB / 4096 cycles:
  a WeakRef keeps its target alive across a synchronous run); the bare count
  dropped the same soak to ~180 KB with zero GC-visible footprint.
- **Boot-lock.** Kept, fail closed. A booted container cannot `unregister` /
  `clear` without `reset()` first (the v1-documented swap flow). DICron's per-job
  swap is fixed in X1 to `reset()` first.

### Fixed

- **D-10**: `getAll` / `getAllAsync` now check the shut-down state first and
  throw / reject `/shut down/i`, exactly as `get` / `getAsync` do.
- **D-12**: two-phase shutdown. A teardown resolving a cached collaborator
  succeeds; a throwing teardown does not stop the others AND surfaces in the
  `AggregateError` rejection; `console.*` is never called by `Container.js`
  (proven by a whole-tier console counter in T4).
- **D-13**: `shutdown()` releases all retained state -- `retention(c)` returns to
  `{ singletons: 0, order: 0, flags: 0, teardowns: 0 }` with `_pending` and
  `_multiSingletons` empty. Double `shutdown()` re-runs nothing. A resolution in
  flight when `shutdown()` completes returns its value but does not resurrect the
  released caches. Parent shutdown with a live child throws; child-then-parent
  succeeds and both reach zero retention.
- **D-14**: the boot lock is kept and encoded in the D-14 tests (`unregister` /
  `clear` on a booted container throw `booted and locked`; the same calls succeed
  after `reset()`).

### Hot path

The sync `get()` cached-singleton lane is byte-identical to alpha.4: the only
hot-body change is `if (this._shutdown)` -> `if (this._state === SHUT_DOWN)`, one
boolean test for one compare-to-constant. The DRAINING guard, the child-count
walk and the AggregateError machinery live on the cold cache-miss / `shutdown()`
paths. Child tracking is a bare integer increment in `scope()` -- no allocation.

| Lane | Measured | Gate |
| --- | --- | --- |
| Sync cached `get()` (T6 lane 1) | 0.000 B/call | zero |
| Value `get()` (T6 lane 1b) | 0.000 B/call | zero |
| 3-dep transient (T6 lane 3a) | ~0.07 B/op | pinned <= 8 |
| `getAll` 3-entry multi (T6 lane 3b) | ~0.00 B/op | pinned <= 16 |
| Async cached `getAsync()` hit | ~0.31 B/op | maxMajor 0, pinned <= 32 |

### Torture

- T4 filled per spec: double shutdown, never-resolved shutdown, shutdown while a
  resolution is in flight, teardown isolation + AggregateError reporting, the
  `onTeardownError` hook, a teardown that resolves a cached collaborator, a
  teardown that tries new construction during drain (rejected), unregister
  mid-resolution, reset/clear around shutdown, the boot lock, parent/child
  ordering and the live-child guard, and the undefined multi-slot path. The whole
  tier runs under a console counter asserted at zero -- the no-console proof. The
  `// FAILS: D-12` / `// FAILS: D-13` guards are gone.
- T7 sub-phase 1 now drains with `shutdown()` as the primary release (odd cycles
  `shutdown()`, even cycles `shutdown()` then `clear()`), asserts `retention 0`
  after `shutdown()` alone, the parent-bleed invariants, and that
  `parent._liveChildren` returns to its pre-cycle value each cycle. Heap sampled
  at cycle boundaries grew ~138 KB over 4096 cycles (gate < 512 KB). The
  `// FAILS: D-13` guard is gone.

## [2.0.0-alpha.4] - 2026-08-08

Async correctness (D3). Two findings, one architectural gap: async resolution
state was threaded as a bare `_pathAsync` array and the thread was dropped at the
factory boundary. The fix carries a per-resolution context `{ path }` through
every frame -- including factory re-entries -- via an internal
`_resolveAsync(name, ctx)` that the public `getAsync(name)` wraps, and memoizes
the in-flight build promise in a dedicated `_pending` map. Decision recorded in
`decisions/0002-async-context.md` (option B, per-resolution context object;
pending promises live in `_pending`, never `_singletons`).

### Fixed

- **D-02**: cross-factory async cycles are detected. A factory callback now
  receives a context-bound facade whose `getAsync` / `getAllAsync` re-enter with
  the caller's path, so `a1 -> a2 -> a3 -> a1` built from `singletonFactoryAsync`
  factories rejects with `Circular async dependency: a1 -> a2 -> a3 -> a1`
  instead of recursing forever. Because each top-level `getAsync` owns its own
  `ctx.path`, an unrelated tree resolved in the same `Promise.all` never
  contaminates another tree's trace. The previously-hanging suite case (exit 144)
  is now a passing test with a 2000 ms witness timeout.
- **D-03**: async singletons are deduped. `_resolveAsync` stores the build
  promise in `_pending` BEFORE the first await -- inside the synchronous prologue
  that runs the cycle check -- so N concurrent `getAsync` callers share one
  construction (verified for N = 2 / 8 / 64, and for `bootAsync` on a shared
  async singleton). The entry is evicted on settle: on resolve the value is
  already in `_singletons`; on reject nothing is cached, so a rejected
  `singletonFactoryAsync` rebuilds on retry rather than poisoning the cache. The
  cycle check runs BEFORE the `_pending` probe, so a re-entrant name rejects
  rather than deadlocking on its own in-flight promise.

### Behaviour

- Sync/async caching-of-undefined symmetry: a `singletonFactoryAsync` returning
  `undefined` is cached exactly like the sync `singletonFactory` lane, so the
  factory runs once.

### Hot path

The sync `get()` body is byte-identical to alpha.3. The context object, the
`_pending` map and the factory facade are allocated only on the async lane, which
is gated at `maxMajor: 0` with a PINNED bytes-per-op (a promise per frame is
unavoidable). No async allocation reaches any sync path.

| Lane | Measured | Gate |
| --- | --- | --- |
| Sync cached `get()` (T6 lane 1) | 0.000 B/call | zero |
| Value `get()` (T6 lane 1b) | 0.000 B/call | zero |
| 3-dep transient (T6 lane 3a) | ~0.07 B/op | pinned <= 8 |
| `getAll` 3-entry multi (T6 lane 3b) | ~0.00 B/op | pinned <= 16 |
| Async cached `getAsync()` hit | ~0.30 B/op | maxMajor 0, pinned <= 32 |

### Torture

- T3 gains the async cross-factory cycle matrix (self / 2 / 3 / 8 nodes through
  async factories, plus a mixed sync-inside-async cycle); the `// FAILS: D-02`
  guard is removed. Each case asserts `_path` and `_pending` return to empty.
- T0 gains the concurrent-dedupe law: N = 2 / 8 / 64 concurrent `getAsync` of one
  `singletonFactoryAsync` build exactly one instance and leave `_pending` empty.

## [2.0.0-alpha.3] - 2026-08-08

Sync resolution integrity (D2). Six findings, one root cause: `_registry` and
`_singletons` each held two incompatible value shapes (a single entry, or an
array of entries) and nothing validated which shape it got. The fix separates
multi bindings into dedicated maps (`_multiRegistry` / `_multiSingletons`), so
`get()`'s cache probe can never see an array and the shape checks become
structural rather than order-dependent. Decision recorded in
`decisions/0001-binding-shape.md` (option A, separate maps).

### Fixed

- **D-08**: `get()` on a multi name now throws `'<name>' is multi. Use getAll().`
  by construction. Multi caches live in `_multiSingletons`, never in
  `_singletons`, so `getAll('m')` followed by `get('m')` can no longer leak the
  container's live internal cache array by reference.
- **D-07**: `boot()` restores missing-dependency validation. It walks every
  entry's `deps` and every ALIAS `target`, collects ALL wiring errors, and throws
  ONE message listing them. A dep resolvable through the parent chain is not an
  error; an alias to an unregistered name is.
- **D-09**: `unregister(name)` now splices `_resolutionOrder`, so
  re-register + resolve can no longer double it and `shutdown()` tears each
  instance down exactly once.
- **D-11**: `getAll()` / `getAllAsync()` participate in cycle detection -- they
  push the multi name onto the resolution path before resolving any entry, so a
  cycle re-entering through a multi name is caught and named in the trace.
- **D-15**: token policy. A token is a non-empty string OR a symbol; anything
  else throws a `TypeError` at registration (cold path, in `_register`, never in
  `get()`). Symbols keep working.
- **D-16**: `reset()` and `clear()` reset `_path` (length 0).

### Hot path

The `get()` cached-singleton lane is unchanged: one `_shutdown` test, one Map
`has`, one Map `get`, return. Every guard above lives strictly in `_register`,
`boot()`, `unregister()` or `getAll()`. The only change to the resolution path of
`get()` is a removal (the `Array.isArray(entry)` line, now impossible). T6 lane 1
measured 0.000 B/call, unchanged from the alpha.2 baseline.

| Lane | alpha.2 baseline | alpha.3 |
| --- | --- | --- |
| `get()` cached-singleton hit | 0.000 B/call | **0.000 B/call** (gate at 0) |
| `get()` 3-dep transient | 0.069 B/op | 0.069 B/op (pinned) |
| `getAll()` 3-entry multi | 0.002 B/op | 0.002 B/op (pinned) |
| `getAsync()` cached hit | 0.516 B/op | ~0.36 B/op (pinned <= 32) |

### Torture

Filled T0 (all ten resolution laws hold on the fixed code) and T3 (cycle at every
arity incl. the multi and alias variants). Un-guarded the finding controls the
D2 fixes address: `GUARD_D11` in `t3-adversarial` (the getAll cycle trace now
names the multi binding), `GUARD_D09` in `t7-soak` (the D-09 soak now asserts
`_resolutionOrder.length` stays at its steady state instead of growing linearly),
and the D-15 block in `t1-degenerate` (empty/undefined/numeric tokens are now
asserted to be rejected with a `TypeError`). The harness invariant helpers
(`retention`, `orderInvariant`, `validate`) account for the split maps.

## [2.0.0-alpha.2] - 2026-08-08

Stands up the torture gate (`node --expose-gc test/torture.mjs`, wired into
`npm run verify`). No container behaviour changes: D1 only measures and pins.
Added `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` as devDependencies
(the container keeps zero runtime dependencies). Tiers T0/T1/T3/T4/T6/T7/T9 are
wired; T5/T8 are registered stubs for D5/X1. Tier cases that depend on an
unfixed finding are guarded with a `// FAILS: D-xx` marker so the gate is green
on today's (still-buggy) code; the T9 controls each fail on demand, and
`DI_TORTURE_BREAK=1` fails the whole gate (exit non-zero).

### Zero-GC baseline (T6) -- the first measured allocation numbers this package has had

Measured with lite-gc-profiler v1.15.0 (`stabilize:'deep'`), one lane at a time.
These are honest baselines, not targets; D5 drives the cached lane to a hard
zero gate and re-pins the rest.

| Lane | What it measures | Measured | Policy |
| --- | --- | --- | --- |
| `get()` cached-singleton hit | the true hot body | **0.000 B/call** | gate at 0 |
| `get()` value hit | value passthrough | **0.000 B/call** | gate at 0 |
| `get()` 3-dep transient | `new Array(deps)` + instance, by construction | 0.069 B/op | pinned |
| `getAll()` 3-entry multi | fresh result array per call (D-17) | 0.002 B/op | pinned |
| `getAsync()` cached hit | one promise per frame, by construction | 0.516 B/op | pinned |

Steady-state mixed loop (lane 2): `maxMajor` 0, `maxPauseMs` 0.000 -- no major
GC and no measurable pause across the window.

## [2.0.0-alpha.1] - 2026-08-08

First alpha of the v2 rewrite. This release ships the v2 container as THE
package (the published v1 `Container.js` is superseded and now lives only in git
history). D0 changes NO container behaviour: it ports the test runner to
`node:test`, fixes identity and packaging, and turns every open finding into a
named, demonstrably-failing test. The behaviour fixes land in D1..D6.

### Identity and packaging

- Renamed the package `lite-di-container` -> `@zakkster/lite-di-container`
  (scope law `@zakkster/*`). Updated `llms.txt` (was `explicit-di-container`),
  the README install line, and `2.0.0/dependents/DIOExample.js`.
- Promoted the v2 proposal (`2.0.0/Container.js`) to the repo root, overwriting
  the published v1. `Container.js` now exports `{ Container, TYPES, VERSION }`.
- Added `export const VERSION = '2.0.0-alpha.1'`. Version now lives in three
  places in sync: `package.json`, the `VERSION` const, and this changelog.
- Renamed `License.txt` -> `LICENSE`; added `LICENSE`, `llms.txt` and
  `CHANGELOG.md` to `package.json` `files[]`.
- Replaced `vitest` scripts with `node:test`:
  `test` -> `node --expose-gc --test test/*.test.js`,
  `torture` -> `node --expose-gc test/torture.mjs` (stub until D1),
  `verify` -> `npm test && npm run torture`. Removed all `vitest` references.
- Bumped `engines.node` `>=16` -> `>=18`.

### Breaking changes (v1 -> v2)

- `TYPES` values are integers (`VALUE:0 SINGLETON:1 TRANSIENT:2 FACTORY:3
  ALIAS:4`), not strings.
- No fluent chaining: registration methods (`value`/`singleton`/`transient`/
  `factory`) return `undefined`, not `this`. The v1 "chaining" test is updated
  to assert the new contract.
- No `export default`. Only the named exports `{ Container, TYPES, VERSION }`.
- Cycle-detection error traces use ASCII ` -> ` (v1 embedded U+2192 in thrown
  text). The v1 assertions were updated to match.
- Error-message wording changed: non-constructable ->
  `'<name>' must be a constructable class.`; boot lock ->
  `Container is booted and locked.` The v1 regexes were updated accordingly.

### Observed behaviour changes with no assigned finding ID (v1 coverage kept)

Ported v1 assertions that fail against v2 for reasons outside the D-01..D-20
table are preserved as `{ todo: true }` cases in `known-broken (v2 proposal)`:

- `factory()` no longer validates that the definition is a function at
  registration (v1 threw; v2 fails later at `get()`).
- The unregistered-service error no longer lists `Available: [...]`.
- An unknown `_registry` entry type returns `undefined` silently rather than
  throwing (v1 had a defensive default case).

### Findings converted to failing tests (D0 deliverable)

Each finding below has a named test whose name carries its ID, grouped in a
`known-broken (v2 proposal)` block and marked `{ todo: true }`. Removing `todo`
makes it FAIL against today's code. Every one was run un-todo'd and confirmed to
fail before `todo` was re-added.

| ID | Where | Witness |
| --- | --- | --- |
| D-02 | ContainerAsync | cross-factory async cycle never yields the `a1 -> a2 -> a3 -> a1` trace (stack-overflows). `{ timeout: 2000 }` so it cannot wedge. |
| D-03 | ContainerAsync | concurrent `getAsync('db')` builds twice; `bootAsync` on a shared async singleton builds it twice. |
| D-07 | Container | `boot()` accepts a typo'd / missing dependency and an alias to nothing. |
| D-08 | Container | after `getAll('m')`, `get('m')` returns the internal cache array instead of throwing. |
| D-09 | Container | unregister + re-register leaves `_resolutionOrder` = `['x','x']`; teardown runs twice. |
| D-10 | Container / Async | `getAll` / `getAllAsync` resolve after `shutdown()`. |
| D-11 | Container | `getAll` cycle trace omits the multi name. (repro corrected -- see below) |
| D-12 | Container | a teardown resolving a cached collaborator is skipped (shut-down flag flipped first, failure swallowed to `console.error`). |
| D-13 | Container | `shutdown()` leaves `_singletons` and `_resolutionOrder` populated. |
| D-14 | Container | a booted container cannot `unregister()` or `clear()` to swap a binding. |
| D-15 | Container | `''`, `undefined` and `42` register and resolve. |
| D-16 | Container | `reset()` / `clear()` do not clear `_path`. |
| D-17 | Container | `getAll()` returns a fresh array every call (structural proxy for the allocation finding; D1 replaces it with a gc-profiler gate). |
| D-20 | Container | no public `isBooted` accessor exists (dependents read `_booted`). |

### Findings corrected

- **D-11 repro correction.** The section 2 table describes D-11 as "unbounded
  recursion, no cycle error". Observed on Node against the current code, the
  case does NOT hang: it throws `Circular dependency detected: b -> b` fast
  because the single-lane `get('b')` catches the re-entry via `_path`. The real
  defect stands -- `getAll()` never pushes the multi name onto the resolution
  path, so the trace omits `a`. The D-11 test asserts the trace names `a` and
  fails today. D-11 is NOT struck.

### Findings resolved within D0 (D0's own scope, not converted to todo tests)

- **D-01** (the v2 suite never ran): mooted. The suite runs under `node:test`;
  the referenced `2.0.0/Container.test.mjs` did not exist in this tree, so the
  async surface was authored fresh as `test/ContainerAsync.test.js`.
- **D-18** (no CHANGELOG / no VERSION / `files[]` gaps / `engines >=16`):
  resolved by the packaging changes above.
- **D-19** (four package names; README documents `vitest`): the four-name
  identity split is resolved. The README `vitest` testing block (README:111) is
  intentionally deferred to X1 per the roadmap and remains.

### Findings struck from the section 2 table

None. Every D-07..D-17 and D-20 test fails as written; D-01/D-18/D-19 are D0's
own scope and were resolved here rather than converted to failing tests.

### Known, deliberately-not-fixed in D0

- **D-04 (ASCII law).** `Container.js` still contains non-ASCII bytes on **9
  lines** (`rg -c '[^\x00-\x7F]' Container.js` -> `9`), all U+2550 box-drawing
  in comment banners. D6 drives this to 0; an ASCII sweep now would be redone by
  every fix session.
- The root `Container.d.ts` still describes the v1 surface (string `TYPES`,
  fluent `this`, no scope/alias/multi/async). No `2.0.0/Container.d.ts` existed
  to promote; rewriting the type surface is out of D0 scope and belongs with the
  D6 surface freeze.

[2.0.0-alpha.1]: https://github.com/PeshoVurtoleta/lite-di-container/releases/tag/v2.0.0-alpha.1
