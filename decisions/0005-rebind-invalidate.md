# 0005 -- Post-boot hot-swap: invalidate() and rebind()

- Status: ratified
- Session: Session 4 (v2.2.0)
- Reading: B (constrained post-boot hot-swap) -- RATIFIED
- Date: 2026-08-10

## Context

The container's core safety property is the boot lock: `boot()` validates the
WHOLE graph (every dependency and alias target is registered, the graph is
acyclic), then freezes topology. Every registrar routes through `_register()`,
which calls `_checkBooted()`, so today ALL topology mutation is boot-locked.

The golden-niche capstone -- `lite-di-supervisor` (GAP-1) -- needs a post-boot
restart primitive: flush a live singleton and rebuild it, or swap a strategy
registration atomically, WITHOUT tearing the whole container down and re-booting.
Live reconfiguration (config reload, flag flip, blue/green) needs the same. This
record decides how those two operations -- `invalidate(name)` and
`rebind(name, entry)` -- punch a CONSTRAINED, written-down hole in the boot lock
without forfeiting graph validity.

## The boot-lock exception

`boot()` freezes topology because an unvalidated graph is a production-time
foot-gun. `invalidate` and `rebind` do NOT reopen registration wholesale; they
deliberately punch a narrow post-boot hole and re-prove -- at the door, per call
-- exactly the slice of the boot invariant their mutation could break:

- `invalidate` changes NO topology. It flushes a cached instance so the next
  `get()` rebuilds from the SAME registration. The boot invariant is untouched by
  construction, so the only fail-closed checks it needs are liveness, existence,
  and "not mid-resolution".
- `rebind` DOES change one node's registration. So it re-proves the three graph
  properties boot proved, restricted to the single token being swapped (below),
  BEFORE it mutates anything -- and mutates atomically so a rejected rebind leaves
  the registry byte-identical to before the call.

## Reading B, RATIFIED

The Session 4 brief carried a contradiction: one banked assertion read "rebind on
a booted container throws" (Reading A: rebind is pre-boot-only sugar), while the
brief header and the entire supervisor rationale demand a POST-BOOT atomic
re-registration (Reading B). **Reading B is ratified.** It is the only reading
that delivers the "blue/green swap" and "true hot-swap" the strategy and the
supervisor depend on, and it does so WITHOUT breaking graph validity because it
re-proves the graph slice it touches. The "throws" assertion is treated as stale
pre-reprioritization wording.

## invalidate(name) -> Promise<void>

The restart primitive. Async because a teardown may be async and the supervisor
must `await` the flush before re-resolving. Single-token. Check order, each
fail-closed with a clear Error:

1. `_state !== LIVE` -> throw (a draining or shut-down container is not swappable).
2. `name` registered as neither a single nor a multi binding -> throw (lists the
   available tokens, like every other not-registered error).
3. `_path.indexOf(name) !== -1` (mid-resolution) -> throw (the active resolve
   frame would re-cache into the slot we just cleared).

On pass it flushes the cached instance(s): remove from `_singletons` (or
`_multiSingletons` + `_resolvedFlags`), splice `name` out of `_resolutionOrder`
exactly once (D-09 -- a re-resolution re-pushes, so a stale entry would double the
teardown contract), and run the shared teardown ladder (`_teardownOne`) on the
flushed instance(s). Invalidating a registered-but-never-resolved name is a safe
no-op that still returns a resolved Promise (nothing is cached to flush).

### The `_pending` flush (CRITICAL)

`_pending` memoizes in-flight async cached builds so N concurrent `getAsync()`
callers share one construction; the entry is evicted on settle. If `invalidate`
flushed the singleton caches but NOT `_pending`, a racing in-flight build already
memoized there would settle AFTER the flush and re-cache a STALE instance into the
slot we just cleared. So `invalidate` (and therefore `rebind`) `delete`s `name`
from `_pending` FIRST. The next `getAsync()` finds no memo and rebuilds from the
current registration.

### Identity, not presence (the fail-open the flush ALONE leaves)

Dropping `_pending[name]` is necessary but NOT sufficient. `_buildAsync` writes to
`_singletons` unconditionally while LIVE, so an already in-flight build settling
after the flush would still re-cache. The first fix attempt gated that write on
"does ANY memo exist for `name`?" (`_pending.has(name)`) -- a fail-OPEN under this
interleaving:

1. `getAsync('x')` -> build A in flight, `_pending[x] = pA`.
2. `await invalidate('x')` -> `_pending.delete('x')`, slot flushed.
3. `getAsync('x')` (before A settles) -> build B in flight, `_pending[x] = pB`
   (re-populated).
4. A settles -> `_pending.has('x')` is true (it is `pB`!) -> A re-caches its STALE
   instance, clobbering the slot; B's instance then escapes the teardown ladder.

The gate must be IDENTITY: `_buildAsync` caches ONLY if `_pending.get(name)` is
STILL `this` build's own promise. Each build carries a tiny identity cell
(`ref.p`, set in `_resolveAsync` before any awaited continuation runs) and caches
iff `this._pending.get(name) === ref.p`. The `evict` closure is identity-gated the
SAME way (`if (_pending.get(name) === p) delete`), or A's settle would delete B's
freshly-set memo and make B fail its own identity check -- the symmetric fail-open.
The identity cell is allocated only on a cold build (a cached HIT returns before
`_buildAsync`), so the T6 async-hit lane stays byte-steady.

**Detached-instance boundary (the one unavoidable edge).** Build A, orphaned by a
mid-flight invalidate, STILL returns its instance to ITS caller (`pA`) -- you
cannot un-return a resolved promise, and the caller is about to use the value. The
fix is only that A must not re-cache and must not clobber B. A's instance is then a
DETACHED instance: the caller owns it, the container no longer manages it, and it
is NOT torn down at `shutdown()`. This is the mid-invalidate in-flight-caller edge,
the same family as the stale-dependent hazard -- surfaced, not papered over. A is
NOT torn down before being returned (the caller needs it live).

### The multi async lane is safe by construction

`_resolveAllAsync` (the multi async lane) does NOT use `_pending`. It sets
`_multiSingletons[name] = cacheArr` synchronously, then fills that captured array
after its awaits. If `invalidate(name)` runs mid-flight it `delete`s
`_multiSingletons[name]`; the orphaned build keeps writing into its now-DETACHED
local array, never re-setting the map slot, so the flushed slot stays flushed and
the next `getAllAsync` rebuilds fresh. No identity fix is needed there -- only the
single async lane re-set the map slot unconditionally after an await.

## rebind(name, entry) -> Promise<void>

The topology swap (Reading B). `entry` is an internal registry-entry object -- the
shape `_register` stores. ALL FIVE checks run BEFORE any mutation; the registry is
ATOMICALLY UNTOUCHED on any failure:

1. `_state === LIVE` else throw.
2. `name` NOT mid-resolution (`_path`) else throw.
3. Same kind: the existing registration is a single binding (`_registry.has(name)`
   and NOT `_multiRegistry.has(name)`). A single cannot become a multi or
   vice-versa; an unregistered name has no kind to keep. Else throw.
4. Every dependency (or alias target) of the NEW entry is already registered
   (`has()`) -- a single-token slice of `_validateWiring`, NOT a whole-graph
   re-validation. Else throw.
5. No cycle introduced -- a single-token slice of the `_detectCycles` traversal
   SHAPE, run as a pure LOCAL walk (`_checkRebindCycle`) that substitutes the new
   entry for `name` and mutates no container state, exactly as `describe()` reuses
   the traversal shape read-only. Because boot proved the existing graph acyclic
   and a rebind only adds edges OUT of `name`, any new cycle must pass back through
   `name`; starting the DFS there and detecting a revisit on the active stack is
   sufficient. Else throw.

On ALL pass -- and only then is any state touched -- `_registry.set(name, entry)`
then `await this.invalidate(name)`, so the next `get()` re-resolves from the NEW
registration (and `invalidate`'s `_pending` flush covers the async race for the
freshly-rebound slot too).

**Atomicity caveat (the boundary of the "untouched" guarantee).** "Registry
atomically untouched on failure" covers the FIVE PRE-mutation checks: any of them
throwing leaves `_registry` exactly as it was. It does NOT extend past the swap: if
`_teardownOne` on the OLD instance throws inside the awaited `invalidate` (i.e.
AFTER `_registry.set` has already applied the new entry and flushed the old slot),
`rebind` rejects with the swap ALREADY applied and the old slot ALREADY flushed.
That state is forward-consistent (the new registration is live, the old instance is
gone) and the failure PROPAGATES (it is not swallowed) -- but it is not
"untouched". Callers that must observe a teardown failure without the swap having
happened should `invalidate` (and handle its rejection) BEFORE `rebind`.

## The stale-dependent hazard (documented, NOT auto-cascaded)

A service already built with `name` as a dependency still holds the OLD instance
after `invalidate(name)` / `rebind(name, ...)`. 2.2 does NOT cascade: `invalidate`
and `rebind` are SINGLE-TOKEN. Transitive restart ordering (one-for-one,
one-for-all, rest-for-one) is the future `lite-di-supervisor`'s responsibility;
the container gives it the atomic per-token primitive and stays out of policy.
This hazard is surfaced here loudly rather than papered over with a half-cascade.

## Hot-lane guarantee

Both methods are cold-path only. The sync `get()` cached-hit lane is
BYTE-IDENTICAL to 2.1.0: no new bytes, no new branch, no new instance field read
by any resolve lane. `_teardownOne` is extracted from `shutdown()`'s existing
per-instance ladder (shutdown now calls it -- the ladder is not duplicated), so
invalidate and shutdown tear an instance down through the IDENTICAL sequence.
T6 lane 1 (cached `get()`) stays 0.000 B/call.

## Out of scope for 2.2

- Transitive / subtree cascade invalidation (supervisor owns ordering -- later).
- `lite-di-supervisor` itself (a separate session; this is only its primitive).
- Cross-container / parent-chain rebind. Record/replay.
- Any change to a hot resolve lane.
