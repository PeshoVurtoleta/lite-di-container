/**
 * @zakkster/lite-di-container -- torture harness.
 *
 * One place for the discipline every tier obeys:
 *
 *   - All scratch (containers, class definitions, token arrays, instances) is
 *     allocated ONCE by the tier, outside every measured loop. This module hands
 *     out helpers, never per-call allocations on a hot path.
 *   - `check(cond, thunk)` builds its message string only on failure -- a
 *     template literal per iteration is an allocation and would fail the T6 gate.
 *   - The PRNG is a seeded xorshift32. On any thrown fault a tier prints the seed
 *     so the case replays with `TORTURE_SEED=... npm run torture`.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     SEQUENTIALLY, never nested. `runOpsGate` opens and closes one window.
 *
 * The DI analogues of lite-bvh's `conservation()` live here too:
 * `retention()`, `orderInvariant()` and the test-only `validate()`. They read
 * the container's internals (`_singletons`, `_resolutionOrder`, `_resolvedFlags`,
 * `_path`, `_registry`, `_parent`) from the harness side, so Container.js is not
 * touched and nothing invariant-related can leak onto the hot path.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';
import { TYPES } from '../../Container.js';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must never be seeded with 0
})();

/** Whole-suite control: inject a retained allocation into the T6 hot body. */
export const BREAK = process.env.DI_TORTURE_BREAK === '1';

/** Base zero-GC rules. `maxArrayBuffersGrowth` needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Cross-tier stats, written by T6 (gc + alloc) and T7 (leak), read by the runner
 * to emit one machine-readable GATE line on stderr. stdout stays exactly "ok".
 */
export const STATS = {
    leakSize: 0,
    leakTarget: 0,
    findings: 0,
    warnings: 0,
    gcMajor: 0,
    gcMinor: 0,
    gcMaxMs: 0,
    allocBytesPerOp: 0,
};

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg +
        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * measureOps with `stabilize:'deep'` makes the `maxArrayBuffersGrowth` rule
 * resolvable (ArrayBuffer backing stores live outside the V8 heap). Returns the
 * checkNoGc report, the raw summary, and the measured bytes-per-op rate.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return {
        report: checkNoGc(res.summary, RULES),
        summary: res.summary,
        bytesPerOp: res.bytesPerOp,
    };
}

// -- DI-specific invariant helpers (the analogues of conservation()) ----------

/** Snapshot of the container's owned state. O(1). Test only. */
export function retention(c) {
    return {
        registry: c._registry.size + c._multiRegistry.size,
        singletons: c._singletons.size + c._multiSingletons.size,
        order: c._resolutionOrder.length,
        flags: c._resolvedFlags.size,
        teardowns: c._teardowns.size,
    };
}

/**
 * The one invariant that catches four findings at once:
 *   _singletons.size === new Set(_resolutionOrder).size
 *   AND every name in _resolutionOrder is a key of _singletons
 *   AND _resolutionOrder has no duplicates.
 * O(n). Test only -- never call this from a hot path.
 */
export function orderInvariant(c) {
    const order = c._resolutionOrder;
    const single = c._singletons;
    const multi = c._multiSingletons;
    const seen = new Set();
    for (let i = 0; i < order.length; i++) {
        const name = order[i];
        if (seen.has(name)) return false;                          // duplicate
        if (!single.has(name) && !multi.has(name)) return false;   // order entry with no cache
        seen.add(name);
    }
    return (single.size + multi.size) === seen.size;
}

/** Walk the parent chain looking for `name`'s registry entry. undefined if absent. */
function lookupEntry(c, name) {
    let x = c;
    while (x) {
        if (x._registry.has(name)) return x._registry.get(name);
        if (x._multiRegistry.has(name)) return x._multiRegistry.get(name);
        x = x._parent;
    }
    return undefined;
}

/**
 * Test-only structural validator, called BETWEEN phases, never in a measured
 * window and never from a hot path. Throws on the first violation.
 *   orderInvariant + _path.length === 0
 *   + no alias chain longer than registry.size
 *   + every ALIAS target registered locally or in a parent.
 */
export function validate(c) {
    if (!orderInvariant(c)) throw new Error('validate: orderInvariant violated');
    if (c._path.length !== 0) throw new Error('validate: _path not empty (len=' + c._path.length + ')');

    const bound = c._registry.size;
    for (const [name, entry] of c._registry) {
        if (Array.isArray(entry)) continue;
        if (entry.type !== TYPES.ALIAS) continue;
        let hops = 0;
        let cur = entry.target;
        for (;;) {
            if (hops++ > bound) {
                throw new Error('validate: alias chain from ' + String(name) +
                    ' exceeds registry size ' + bound + ' (cycle?)');
            }
            const e = lookupEntry(c, cur);
            if (e === undefined) {
                throw new Error('validate: alias target ' + String(cur) +
                    ' (from ' + String(name) + ') not registered locally or in a parent');
            }
            if (Array.isArray(e) || e.type !== TYPES.ALIAS) break;
            cur = e.target;
        }
    }
    return true;
}
