# 0003 -- Lifecycle: teardown, release and scope ownership

- Status: accepted
- Session: D4 (v2.0.0-alpha.5)
- Findings: D-10, D-12, D-13, D-14
- Date: 2026-08-09

## Context

`shutdown()` as shipped through alpha.4 was three bugs in one method:

- it flipped `_shutdown = true` *before* running any teardown, so a teardown
  that resolves a collaborator threw `'Container shut down.'` (D-12);
- it swallowed every teardown failure to `console.error`, so the caller could
  not know anything failed -- and a zero-dependency library has no business
  writing to `console` (D-12);
- it released nothing: a shut-down container retained every instance it ever
  built, and a live child retained its whole parent chain (D-13).

Meanwhile `getAll` / `getAllAsync` ignored the shut-down flag entirely (D-10),
and the boot lock on `unregister` / `clear` (D-14) needed a recorded contract.

Law 3 (resolution order is the teardown contract) and law 4 (scope ownership is
strict and local) are the two invariants this session must not break.

## Four decisions

### 1. Drain rule (D-12): a three-state lifecycle, one hot comparison

The container carries one integer state field, `_state`, replacing the old
`_shutdown` boolean:

```
LIVE (0)      normal resolution
DRAINING (1)  the teardown window
SHUT_DOWN (2) terminal
```

The hot `get()` lane compares this field **exactly once**, in the same place the
single `_shutdown` boolean test lived:

```
get(name) {
    if (this._state === SHUT_DOWN) throw new Error('Container shut down.');
    if (this._singletons.has(name)) return this._singletons.get(name);
    ...cold from here...
}
```

`SHUT_DOWN` and `DRAINING` are bare module-scope integer constants (no property
load), so the cached-hit lane is byte-identical to alpha.4 and T6 lane 1 stays
at 0.000 B/call.

**The exact drain rule.** During `DRAINING`:

- a **cached hit** is always permitted -- the cache is not released until the
  walk finishes, so `_singletons.has(name)` still returns the collaborator. A
  teardown may therefore resolve any *already-resolved* collaborator. This is
  the D-12 requirement.
- a **VALUE** or **ALIAS** passthrough is permitted -- neither builds an
  instance nor pushes to `_resolutionOrder`.
- constructing a **NEW** instance (SINGLETON / TRANSIENT / FACTORY) or a **new
  multi** is rejected with a named `Container is draining: ...` error. Building
  during teardown would push a name onto `_resolutionOrder` *mid-walk* and
  resurrect a cache the walk is about to release. Fail closed.

The new-construction rejection lives strictly on the **cold** cache-miss path
(after the `_singletons.has` probe has already missed), so it costs the hot lane
nothing. The async lanes carry the identical rule via `_resolveAsync` /
`_resolveAllAsync`, plus one extra guard: `_buildAsync` re-checks `SHUT_DOWN`
before writing to `_singletons`, so a resolution still in flight when
`shutdown()` completes returns its value to the caller but does **not**
resurrect the released caches (the "shutdown while a resolution is in flight"
case).

### 2. Error reporting (D-12): collect, run all, then reject with AggregateError

`Container.js` never calls `console.*`. `shutdown()` runs **every** teardown
(error isolation preserved: a thrower does not stop its siblings), collecting
failures. After the walk:

- if any teardown threw and no hook was supplied, `shutdown()` rejects with an
  `AggregateError` whose `.errors` are the collected failures, after all
  teardowns have run and all state has been released;
- an optional `{ onTeardownError }` hook, when supplied, is invoked with
  `(error, name)` for each failing teardown and **suppresses** the
  `AggregateError` (the hook is the caller's chosen reporting). Isolation is
  unchanged: the walk still runs to completion.

`onTeardownError` must be a function; any other value, and any unknown option
key, is rejected at the door (fail closed, did-you-mean hint).

### 3. Release + child-scope tracking (D-13)

After the teardown walk, and after flipping to `SHUT_DOWN`, `shutdown()` clears
`_singletons`, `_multiSingletons`, `_resolvedFlags`, `_resolutionOrder`,
`_teardowns` and `_pending`. `retention(c)` returns to
`{ singletons: 0, order: 0, flags: 0, teardowns: 0 }` with `_pending` and
`_multiSingletons` empty. `_registry` is **kept** (a shut-down container's
wiring is still described; only its instances are gone). Double `shutdown()` is
a no-op: the first line returns unless `_state === LIVE`, so the walk never
re-runs.

**Child scopes: shutdown does NOT cascade** (law 4 -- a child owns its own
lifetime). Instead the parent tracks its live children and refuses to shut down
while one is still live, rather than leaving a child holding a dead parent
through `_parent`.

**Tracking mechanism: an integer live-child count, `_liveChildren`, not a
reference.** `scope()` increments `parent._liveChildren`; a child decrements it
exactly once when it drains (a `_detached` flag makes `shutdown()` +`clear()`
idempotent). `parent.shutdown()` throws
`Cannot shut down: N child scope(s) still live. Shut down children first.`
before flipping state or running any teardown, so the parent stays usable and
you can drain the child and retry.

Two mechanisms were rejected:

- **A strong `Set` of children** pins every scope ever created (T3 alone spins
  up 10k+ siblings) until the parent dies -- a retention regression.
- **A `Set` of `WeakRef<Container>`** was implemented first and *measured*: it
  blew the T7 heap gate at **~6.8 MB over 4096 cycles (~1.7 KB/cycle)** even
  though the set returned to size 0 each cycle. A `WeakRef` keeps its target
  alive across a synchronous run (the target is not eligible for collection
  until a microtask checkpoint clears the ref), so `globalThis.gc()` sampled at
  a synchronous cycle boundary still saw every child retained. Swapping to the
  bare integer count dropped the same soak to **~180 KB** (verified). A `WeakRef`
  is the wrong tool when the only question is "is any child live?" -- a count
  answers it with zero GC-visible footprint.

The count is fail-closed: a child dropped **without** draining
(`shutdown()`/`clear()`) leaves the count incremented, so a later
`parent.shutdown()` refuses -- exactly the contract ("shut down children
first"), and it never leaves a dead child holding a live parent through
`_parent`. A child that is genuinely garbage-collected without draining is a
usage error the count deliberately surfaces rather than papers over.

### 4. Boot-lock (D-14): keep the lock, fail closed

`unregister` and `clear` keep their `_checkBooted()` guard: a booted container
cannot swap a binding without `reset()` first. This is the v1-documented flow
(`boot -> reset -> unregister -> re-register -> boot`). The alternative --
dropping the lock so a booted container can mutate its own topology -- trades a
fail-closed guarantee for one dependent's convenience. DICron's per-job swap
flow (`DICron.js:446-455`) is the one caller that assumed it could `unregister`
while booted; it is fixed in X1 to call `reset()` first. The D-14 tests encode
the kept lock: `unregister` / `clear` on a booted container throw
`booted and locked`, and the same calls succeed after `reset()`.

## Hot-lane diff vs alpha.4

The sync `get()` cached-singleton lane is byte-identical. The only hot-body
change is the first line, `if (this._shutdown)` -> `if (this._state === SHUT_DOWN)`:
one boolean test becomes one compare-to-constant, still one comparison, still
zero allocation. Every new branch (the DRAINING new-construction guard, the
child-scope walk, the AggregateError machinery) lives on the cold cache-miss or
`shutdown()` path.

| Lane | alpha.4 | alpha.5 | Gate |
| --- | --- | --- | --- |
| Sync cached `get()` (T6 lane 1) | 0.000 B/call | 0.000 B/call | zero |
| Value `get()` (T6 lane 1b) | 0.000 B/call | 0.000 B/call | zero |

The context object and the AggregateError are allocated only on the async and
`shutdown()` cold paths; child tracking is a bare integer increment in `scope()`,
no allocation at all.
