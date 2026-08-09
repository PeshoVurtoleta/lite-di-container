# 0001 -- Single-vs-multi binding shape

- Status: accepted
- Session: D2 (v2.0.0-alpha.3)
- Findings: D-07, D-08, D-09, D-11, D-15, D-16
- Date: 2026-08-08

## Context

`_registry` and `_singletons` each held two incompatible value shapes at once: a
single entry object, or an array of entries (a multi binding). Nothing validated
which shape a given operation received. The consequences were four findings with
one root:

- **D-08**: `get()` probes `_singletons` (line 135) *before* the
  `Array.isArray(entry)` guard (line 144), so once `getAll('m')` had cached its
  result array under `m`, `get('m')` returned the container's live internal cache
  array by reference. The guard was order-dependent, not structural.
- **D-09**: `_resolutionOrder` was never repaired by `unregister()`, so
  re-register + resolve doubled the teardown contract.
- **D-11**: `getAll()`/`getAllAsync()` never pushed the multi name onto the
  resolution path, so a cycle re-entering through a multi name omitted that name
  from the trace.

The shape question has to be settled once, in one place, or fixing D-08 in
`get()` and D-09 in `unregister()` is the same edit twice.

## Options

The roadmap (section 5, D2 brief) analyses three:

- **A. Separate maps.** `_multiRegistry` / `_multiSingletons` hold arrays;
  `_registry` / `_singletons` hold only single bindings. `get()`'s cache probe
  can then *never* see an array, so the D-08 guard becomes
  unreachable-by-construction rather than order-dependent. Cost: two more Map
  fields per container; `has()` checks two maps (both cold).
- **B. Tagged single shape.** Every `_singletons` value becomes `{ v, multi }`.
  Cost: one property load on *every* cached hit -- exactly the byte the hot-path
  law forbids adding to `get()`.
- **C. Probe-order swap.** Move the `Array.isArray(entry)` guard above the
  `_singletons` probe. Cost: a `_registry.get()` on *every* cached hit -- a
  second Map lookup in the hot body, to police a case that never fires.

## Decision

**Option A (separate maps).** It is the only option that keeps the cached-hit
lane at exactly one Map lookup. B taxes the hot body with a property load
forever; C taxes it with a second Map lookup forever. Both pay a permanent
hot-path cost to police a cold mistake. A moves the entire multi-binding shape
question off the `get()` hot body: since `_singletons` structurally never holds
an array, the D-08 guard is deleted, not relocated.

## Hot-lane diff vs alpha.2

The `get()` cached-singleton lane is byte-identical to the D1 baseline:

```
get(name) {
    if (this._shutdown) throw new Error('Container shut down.');   // 1 boolean test
    if (this._singletons.has(name)) return this._singletons.get(name);  // 1 has + 1 get, return
    ...cold from here...
}
```

Every guard added by D2 lives strictly in the cold path:

- token validation (D-15) -> `_register` only;
- the "is multi" throw (D-08) -> the `entry === undefined` cold branch of
  `get()`, reached only on a *cache miss*, never on a cached hit;
- boot wiring validation (D-07) -> `boot()` / `_validateWiring()`;
- `_resolutionOrder` splice (D-09) -> `unregister()`;
- multi-name cycle push (D-11) -> `getAll()` / `getAllAsync()`;
- `_path` reset (D-16) -> `reset()` / `clear()`.

The only change to the resolution path of `get()` is a *removal*: the
`if (Array.isArray(entry)) throw ...` line is gone, because with separate maps a
single-lane entry is never an array. The cached-hit lane above it is untouched.

## Measurement

Lane 1 -- `measureAllocs(() => c.get('leaf'), { maxBytesPerCall: 0 })`, cached
singleton hit, the literal "zero allocation" claim:

| Build | Lane-1 cached `get()` |
| --- | --- |
| D1 baseline (alpha.2) | **0.000 B/call** |
| D2 (alpha.3, option A) | **0.000 B/call** |

Within noise of the baseline (identical: zero). Option A adds no allocation and
no instruction to the hot body. Had the number moved off zero, that would be
option B's failure mode leaking in, and the design would be wrong.
