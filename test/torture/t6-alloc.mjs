/**
 * T6 -- the zero-alloc gate, per lane (D-05, D-17).
 *
 * This is where the package stops overclaiming. Three structurally distinct
 * lanes are gated SEPARATELY, with the boundary written down rather than blurred:
 *
 *   Lane 1  cached singleton / value hit -- the literal "zero allocation" claim.
 *           measureAllocs at maxBytesPerCall:0 (RETAINED bytes, forced-collect).
 *   Lane 2  a mixed steady-state resolve loop -- pause + major + arrayBuffers
 *           budget via measureOps(stabilize:'deep') + checkNoGc.
 *   Lane 3  the honest boundary -- a 3-dep transient and getAll on a 3-entry
 *           multi allocate BY CONSTRUCTION. Their per-op RATE is PINNED (a
 *           reduction is fine, an increase fails), never claimed to be zero.
 *   Async   getAsync cached hit via measureOpsAsync. An async resolution
 *           allocates promise machinery per frame BY CONSTRUCTION and triggers a
 *           major GC, so it is PINNED on bytes-per-op, not gated at maxMajor:0
 *           (claiming zero here is the exact D-05 mistake). D3 tightens it.
 *
 * Plus structural assertions no heap gate can make: _path stays empty, the
 * singleton cache and resolution order are byte-steady, and the multi binding's
 * _resolvedFlags Uint8Array is allocated once and never regrown.
 *
 * DI_TORTURE_BREAK=1 injects a retained allocation into the Lane 2 hot body; the
 * gate must then reject the window. That is the whole-suite control.
 */

import { measureAllocs, checkAllocs, measureOps, checkOps, measureOpsAsync, checkOpsAsync }
    from '@zakkster/lite-gc-profiler';
import { Container } from '../../Container.js';
import { runOpsGate, BREAK, check, die, STATS } from './harness.mjs';

// Pinned per-op ceilings for the by-construction lanes. Measured baseline is far
// below each (see CHANGELOG alpha.2); the headroom absorbs sampling noise while
// still tripping on a real retention regression (a retained Array(3) is ~32 B/op).
const PIN_TRANSIENT = 8;   // B/op, 3-dep transient
const PIN_GETALL = 16;     // B/op, getAll on a 3-entry multi
const PIN_ASYNC = 32;      // B/op, getAsync cached hit (promise machinery)

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

export async function run() {
    // Everything the hot bodies touch is built ONCE here, outside every window.
    const c = new Container();
    class Cfg { constructor() { this.p = 1; } }
    class D1 {} class D2 {} class D3 {}
    class Svc { constructor(a, b, d) { this.a = a; this.b = b; this.d = d; } }
    class P {} class Q {} class R {};
    c.value('v', { cfg: true });
    c.singleton('leaf', Cfg);
    c.singleton('d1', D1); c.singleton('d2', D2); c.singleton('d3', D3);
    c.transient('t3', Svc, ['d1', 'd2', 'd3']);
    c.multi('m', P); c.multi('m', Q); c.multi('m', R);

    // An 8-entry multi for the getAllInto zero-alloc lane (D-17).
    class E0 {} class E1 {} class E2 {} class E3 {}
    class E4 {} class E5 {} class E6 {} class E7 {}
    c.multi('m8', E0); c.multi('m8', E1); c.multi('m8', E2); c.multi('m8', E3);
    c.multi('m8', E4); c.multi('m8', E5); c.multi('m8', E6); c.multi('m8', E7);
    // Caller-owned output buffer, allocated ONCE outside every window.
    const out8 = new Array(8);

    // Warm every cache so the measured windows see the steady state.
    c.get('leaf'); c.get('v'); c.get('d1'); c.get('d2'); c.get('d3');
    c.get('t3'); c.getAll('m'); c.getAllInto('m8', out8);
    await c.getAsync('leaf');

    // ---- Lane 1: cached singleton hit -- the literal claim, HARD-gated at 0 --
    // D-05: this is the one lane that must be exactly zero retained bytes. The
    // gate fails if it is ever non-zero -- not "small", zero. Both the
    // checkAllocs verdict AND the raw byte count are asserted so no rounding can
    // launder a regression through.
    const a1 = measureAllocs(() => c.get('leaf'), { iterations: 5000, batches: 12, warmup: 5000 });
    const r1 = checkAllocs(a1, { maxBytesPerCall: 0 });
    check(r1.verdict === 'pass' && a1.bytesPerCall === 0,
        () => `T6.lane1: cached get() must be 0 B/call, measured ${a1.bytesPerCall} (verdict=${r1.verdict})`);

    // ---- Lane 1b: value hit -- also HARD-gated at zero ----------------------
    const av = measureAllocs(() => c.get('v'), { iterations: 5000, batches: 12, warmup: 5000 });
    const rv = checkAllocs(av, { maxBytesPerCall: 0 });
    check(rv.verdict === 'pass' && av.bytesPerCall === 0,
        () => `T6.lane1b: value get() must be 0 B/call, measured ${av.bytesPerCall} (verdict=${rv.verdict})`);

    // ---- Lane 2: mixed steady-state -- major/pause/arrayBuffers budget -------
    const singletonsBefore = c._singletons.size;
    const orderBefore = c._resolutionOrder.length;
    const flagBytesBefore = c._resolvedFlags.get('m').buffer.byteLength;

    const hot = (i) => {
        c.get('leaf');   // cached hit  -> zero
        c.get('t3');     // transient   -> garbage, collected
        c.getAll('m');   // fresh array -> garbage, collected
        if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
    };
    const { report, summary, bytesPerOp } = runOpsGate(hot, { ops: 200000, warmup: 5000 });

    // Structural assertions no heap gate can make.
    check(c._path.length === 0, () => `T6.struct: _path leaked (len=${c._path.length})`);
    check(c._singletons.size === singletonsBefore,
        () => `T6.struct: singleton cache grew ${singletonsBefore} -> ${c._singletons.size}`);
    check(c._resolutionOrder.length === orderBefore,
        () => `T6.struct: resolution order grew ${orderBefore} -> ${c._resolutionOrder.length}`);
    check(c._resolvedFlags.get('m').buffer.byteLength === flagBytesBefore,
        () => `T6.struct: multi flags array regrew ${flagBytesBefore} -> ${c._resolvedFlags.get('m').buffer.byteLength}`);

    STATS.gcMajor = summary.gc.major;
    STATS.gcMinor = summary.gc.minor;
    STATS.gcMaxMs = summary.gc.maxMs;
    STATS.allocBytesPerOp = bytesPerOp;

    if (!report.ok) {
        const g = summary.gc;
        die('T6 lane2 alloc gate rejected -- verdict=' + report.verdict +
            ' source=' + summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
            ' abGrowth=' + summary.arrayBuffers.growthBytes +
            (BREAK ? ' (DI_TORTURE_BREAK control -- expected)' : ''));
    }
    // In BREAK mode the gate was SUPPOSED to reject; reaching here is the fault.
    if (BREAK) die('T6: DI_TORTURE_BREAK injected allocations but the gate passed');

    // ---- Lane 3a: 3-dep transient -- rate PINNED, not zeroed -----------------
    const t3 = measureOps(() => { c.get('t3'); }, { ops: 200000, warmup: 5000, stabilize: 'deep' });
    const ct3 = checkOps(t3, { maxBytesPerOp: PIN_TRANSIENT });
    check(ct3.verdict === 'pass',
        () => `T6.lane3a: transient rate ${t3.bytesPerOp.toFixed(3)} B/op > pin ${PIN_TRANSIENT}`);

    // ---- Lane 3b: getAll on a 3-entry multi -- rate PINNED -------------------
    const ga = measureOps(() => { c.getAll('m'); }, { ops: 200000, warmup: 5000, stabilize: 'deep' });
    const cga = checkOps(ga, { maxBytesPerOp: PIN_GETALL });
    check(cga.verdict === 'pass',
        () => `T6.lane3b: getAll rate ${ga.bytesPerOp.toFixed(3)} B/op > pin ${PIN_GETALL}`);
    // The multi flags array is still the same buffer after the getAll soak.
    check(c._resolvedFlags.get('m').buffer.byteLength === flagBytesBefore,
        () => 'T6.lane3b: getAll soak regrew the multi flags array');

    // ---- Lane 3c: getAllInto on a fully-cached 8-entry multi -- HARD-gated 0 -
    // D-17: the fill-into-caller-buffer form. The caller owns `out8`, so a
    // fully-cached multi resolves with ZERO bytes/call -- unlike getAll, which
    // allocates a fresh result array every call (lane 3b, pinned). This is the
    // lane that lets DIEventBus / DIT drop their private caches.
    const flagBytesM8 = c._resolvedFlags.get('m8').buffer.byteLength;
    const gi = measureAllocs(() => { c.getAllInto('m8', out8); },
        { iterations: 5000, batches: 12, warmup: 5000 });
    const cgi = checkAllocs(gi, { maxBytesPerCall: 0 });
    check(cgi.verdict === 'pass' && gi.bytesPerCall === 0,
        () => `T6.lane3c: getAllInto must be 0 B/call, measured ${gi.bytesPerCall} (verdict=${cgi.verdict})`);
    check(c._resolvedFlags.get('m8').buffer.byteLength === flagBytesM8,
        () => 'T6.lane3c: getAllInto soak regrew the multi flags array');

    // ---- Async lane: getAsync cached hit -- rate PINNED (promise machinery) --
    const as = await measureOpsAsync(async () => { await c.getAsync('leaf'); },
        { ops: 50000, warmup: 5000 });
    const cas = checkOpsAsync(as, { maxBytesPerOp: PIN_ASYNC });
    check(cas.verdict === 'pass',
        () => `T6.async: getAsync hit rate ${as.bytesPerOp.toFixed(3)} B/op > pin ${PIN_ASYNC}`);

    // Diagnostic line (stderr): the honest per-lane baseline this run measured.
    process.stderr.write(
        'T6 lanes: cachedGet=' + a1.bytesPerCall.toFixed(3) + ' B/call' +
        ' value=' + av.bytesPerCall.toFixed(3) + ' B/call' +
        ' transient3=' + t3.bytesPerOp.toFixed(3) + ' B/op' +
        ' getAll3=' + ga.bytesPerOp.toFixed(3) + ' B/op' +
        ' getAllInto8=' + gi.bytesPerCall.toFixed(3) + ' B/call' +
        ' asyncHit=' + as.bytesPerOp.toFixed(3) + ' B/op' +
        ' | lane2 major=' + summary.gc.major + ' maxMs=' + summary.gc.maxMs.toFixed(3) +
        ' abGrowth=' + summary.arrayBuffers.growthBytes + '\n');
}
