# 0002 -- Async resolution context

- Status: accepted
- Session: D3 (v2.0.0-alpha.4)
- Findings: D-02, D-03
- Date: 2026-08-08

## Context

Two async findings share one architectural gap: async resolution state was
threaded as a bare `_pathAsync` array parameter, and the thread was dropped at
the factory boundary.

- **D-02 (hang).** `getAsync(name, _pathAsync = [])` threaded `_pathAsync`
  through the ALIAS branch and the class-dep loop, but the FACTORY branch called
  `entry.factory(this)`. The factory then re-entered via `c.getAsync('x')` with
  a *fresh default* `_pathAsync = []`, so a cross-factory cycle
  `a1 -> a2 -> a3 -> a1` was never on one path. It recursed until the process
  stopped responding: a hang, not an error. The asserted trace was never
  produced.
- **D-03 (double build).** `getAsync` memoized the *resolved value* into
  `_singletons` only *after* the `await`. Two concurrent `getAsync('db')` on a
  `singletonFactoryAsync` both missed the `_singletons` probe and both built.
  `bootAsync` fires every async cached binding into one `Promise.all`, so
  concurrency is the normal case, not the edge.

Law 6: async resolution state is per-resolution, never per-container. Any field
holding a path across an `await` is scrambled by a second concurrent
resolution.

## Options

- **A. Thread the path across the factory boundary via a second argument.** The
  factory signature grows, or every factory call allocates a facade. Seven
  first-party dependents already call `factory(c)`; a second argument they must
  opt into does not help, because they call `c.getAsync(...)` on the plain
  container, which starts a fresh path.
- **B. Per-resolution context object.** One `{ path }` context is created at the
  entry point of each top-level `getAsync` / `getAllAsync` and carried through
  every frame -- including factories -- by an internal `_resolveAsync(name, ctx)`
  that the public `getAsync(name)` wraps. A factory receives a *context-bound
  facade* only when it is actually invoked; the facade's `getAsync` /
  `getAllAsync` re-enter with the caller's `ctx`, so a cross-factory call
  inherits the caller's path. Cost: one context object per top-level async call
  (async already allocates a promise per frame -- one more object is in the
  noise) plus one facade per *factory* invocation (cold for `singletonFactory
  Async`, once per name; the uncached `factoryAsync` lane pays per call and is
  pinned, not zeroed). Zero effect on the sync `get()` lane.
- **C. AsyncLocalStorage.** Correct across any await with no API change, but it
  adds a `node:async_hooks` runtime dependency (the zero-runtime-deps law) and a
  measured per-resolution store cost. Rejected on the dependency alone.

## Decision

**Option B (per-resolution context object).** It is the only option that leaves
the sync `get()` body byte-identical, keeps the public factory signature seven
dependents already use, and puts the whole async-state question on one object
per top-level call rather than on a per-container field that concurrency
scrambles. The context is `{ path }`: a plain array, cycle-checked with
`indexOf`, whose `join(' -> ')` is the trace. A separate `seen` Set was
considered and dropped -- async resolution depth is small and bounded, `indexOf`
over the path is the same order as a Set probe at these sizes, and the ordered
array is exactly what the trace needs, so a second structure would allocate for
nothing.

Because each top-level `getAsync` owns its own `ctx.path`, an unrelated tree
resolved concurrently in the same `Promise.all` can never contaminate another
tree's cycle trace. That is the D-02 "must not contain `b1`" guarantee, for free.

## Where the pending promise lives

**A dedicated `_pending` Map**, not `_singletons`. Storing the in-flight promise
in `_singletons` would corrupt the sync lane: `get()` probes `_singletons` and
returns before its `isAsync` check, so it would hand a caller a raw Promise. A
separate map keeps the sync hot lane's single `_singletons` lookup meaning
exactly "a resolved value".

For a cached async binding, `_resolveAsync` stores the build promise in
`_pending` *before the first await*, in the same synchronous prologue that does
the cycle check -- so N concurrent callers observe one promise and share one
construction. On settle (resolve *or* reject) the entry is evicted:

- resolve: `_buildAsync` has already written the value into `_singletons`, so
  the next caller hits the resolved-value probe; the `_pending` eviction just
  releases the promise.
- reject: eviction means no poisoned promise is cached -- a later `getAsync`
  rebuilds. (Asserted: a `singletonFactoryAsync` that throws once builds again
  on retry.)

### The one ordering that matters

The cycle check runs **before** the `_pending` probe. A name already on this
resolution's `ctx.path` is a cycle even though its own in-flight promise sits in
`_pending`; returning that promise instead of rejecting would *deadlock* the
chain (the promise awaits a subtree that awaits the promise) -- a hang wearing a
different hat. Path first, pending second.

## Undefined caching symmetry

A sync `singletonFactory` returning `undefined` is cached (`_singletons.set(name,
undefined)`; `has` is true, `get` is `undefined`). The async lane matches:
`_buildAsync` caches `undefined` the same way, so a second `getAsync` returns the
cached `undefined` and the factory runs exactly once. Asserted in
`ContainerAsync.test.js`.

## Hot-lane diff vs alpha.3

The sync `get()` body is untouched -- byte-identical to alpha.3. The context
object, the `_pending` map and the facade are allocated only on the async lane,
which is gated at `maxMajor: 0` with a **pinned** bytes-per-op (a promise per
frame is unavoidable; claiming zero here is the D-05 mistake). No async
allocation reaches any sync path: the T6 async lane measures a cached
`getAsync('leaf')` hit, which returns through the `_singletons` probe without
allocating a context path frame, a facade, or a pending entry.

## Measurement

| Lane | alpha.3 | alpha.4 | Gate |
| --- | --- | --- | --- |
| Sync cached `get()` (lane 1) | 0.000 B/call | 0.000 B/call | zero |
| Async cached `getAsync()` hit | pinned <= 32 B/op | pinned <= 32 B/op | maxMajor 0, pinned |

The sync lane stays at exactly zero; the context object never lands on it. The
async cached-hit rate is unchanged within noise: a cache hit returns before any
per-resolution allocation.
</content>
