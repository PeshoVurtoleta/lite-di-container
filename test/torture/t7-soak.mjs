/**
 * T7 -- soak and retention (D-09, D-13).
 *
 * CYCLES scope build-up / tear-down cycles off one parent. Each cycle: create a
 * child scope, register 8 scoped bindings, resolve them, track a per-cycle
 * resource with lite-leak, then drain the scope. lite-leak is an independent
 * witness -- a JS-object leak and a container-state leak cannot hide behind each
 * other. Heap is sampled ONLY at cycle boundaries.
 *
 * The parent-bleed invariants (law 4) are the real content here: nothing a child
 * does may write into the parent's caches or resolution order.
 *
 * Drain path (D-13 fixed in D4): shutdown() now RELEASES, so it is the primary
 * drain. Alternate by parity as ../LiteBvh's t7 does: odd cycles shutdown(),
 * even cycles shutdown() then clear(). retention 0 after shutdown() ALONE is the
 * D4 contract, asserted every cycle.
 *
 * Sub-phase 2 soaks the D-09 shape (get -> unregister -> re-register -> get):
 * _resolutionOrder must stay at its steady-state length 1, not grow linearly.
 */

import { Container } from '../../Container.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, retention, orderInvariant, STATS } from './harness.mjs';

const CYCLES = 4096;
const SCOPED = 8;
const NOOP = function () {};

const GUARD_D09 = false; // FIXED in D2 -- unregister() splices _resolutionOrder (stays at 1)

export async function run() {
    // ---- Sub-phase 1: scope churn + parent-bleed + lite-leak retention ------
    const parent = new Container();
    class Root {}
    parent.singleton('rootSvc', Root);
    const rootInst = parent.get('rootSvc');
    const parentSize = parent._singletons.size;
    const parentOrder = parent._resolutionOrder.length;

    const tracker = createLeakTracker({
        name: 'di-soak',
        onWarning: () => { STATS.warnings++; },
    });

    const liveChildrenBefore = parent._liveChildren;

    globalThis.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeakKB = 0;

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const scope = parent.scope();
        for (let i = 0; i < SCOPED; i++) {
            scope.singleton('s' + i, class { constructor() {} });
        }
        for (let i = 0; i < SCOPED; i++) scope.get('s' + i);

        // Un-overridden parent binding still resolves to the parent instance.
        check(scope.get('rootSvc') === rootInst,
            () => `T7: cycle ${cyc} lost the inherited parent instance`);

        // Track a per-cycle external resource. The cleanup/tag must NOT close
        // over the tracked target (held-value contract).
        const h = tracker.track({ cycle: cyc }, NOOP, cyc);

        // Drain (D-13 fixed in D4): shutdown() now RELEASES, so it is the primary
        // drain every cycle. Even cycles also clear() (drops _registry too), as
        // ../LiteBvh's t7 alternates the drain path by parity.
        await scope.shutdown();
        if ((cyc & 1) === 0) scope.clear();
        tracker.untrack(h);

        // retention 0 after shutdown() ALONE is the D4 contract.
        const r = retention(scope);
        check(r.singletons === 0 && r.order === 0 && r.flags === 0,
            () => `T7: cycle ${cyc} scope not drained (singletons=${r.singletons} order=${r.order})`);
        check(orderInvariant(parent), () => `T7: cycle ${cyc} broke parent orderInvariant`);
        // Parent-bleed (law 4): nothing a child did touched the parent's state.
        check(parent._singletons.size === parentSize,
            () => `T7: cycle ${cyc} parent singleton cache bled ${parentSize} -> ${parent._singletons.size}`);
        check(parent._resolutionOrder.length === parentOrder,
            () => `T7: cycle ${cyc} parent resolution order bled ${parentOrder} -> ${parent._resolutionOrder.length}`);
        // The live-child count returns to its pre-cycle value: a drained scope
        // detaches from the parent, so the tracking never accumulates.
        check(parent._liveChildren === liveChildrenBefore,
            () => `T7: cycle ${cyc} live-child count bled ${liveChildrenBefore} -> ${parent._liveChildren}`);

        // Sample heap at the cycle BOUNDARY with a forced collection, so a lazily
        // released structure cannot read as growth mid-cycle.
        if ((cyc & 511) === 0) {
            globalThis.gc();
            const kb = (process.memoryUsage().heapUsed - heapBefore) / 1024;
            if (kb > heapPeakKB) heapPeakKB = kb;
        }
    }

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);
    const findings = tracker.audit();
    STATS.leakSize = tracker.size();
    STATS.leakTarget = 0;
    STATS.findings = findings.length;
    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);

    globalThis.gc();
    const grewKB = (process.memoryUsage().heapUsed - heapBefore) / 1024;
    if (grewKB > heapPeakKB) heapPeakKB = grewKB;
    check(heapPeakKB < 512, () => `T7: heap grew ${heapPeakKB.toFixed(1)} KB over ${CYCLES} cycles`);

    // ---- Sub-phase 2: the D-09 shape ---------------------------------------
    // get -> unregister -> re-register -> get, repeated. The steady-state
    // resolution order SHOULD stay at length 1; today it grows linearly.
    {
        const c = new Container();
        const obj = {};
        c.singletonFactory('x', () => obj);
        c.get('x');
        const ITER = CYCLES;
        for (let i = 0; i < ITER; i++) {
            c.unregister('x');
            c.singletonFactory('x', () => obj);
            c.get('x');
        }
        if (GUARD_D09) {
            // FAILS: D-09 (fixed in D2). unregister() never splices
            // _resolutionOrder, so it accumulates one duplicate per iteration.
            // Pin the current linear growth so the fix's flip to 1 is visible.
            check(c._resolutionOrder.length === ITER + 1,
                () => `T7.D-09: expected the current linear growth ${ITER + 1}, got ${c._resolutionOrder.length}`);
        } else {
            check(c._resolutionOrder.length === 1,
                () => `T7.D-09: resolution order grew to ${c._resolutionOrder.length}, expected 1`);
        }
    }

    // ---- Sub-phase 3: the invalidate/get soak (decision 0005) --------------
    // The banked 4096-cycle restart soak. get -> invalidate, repeated on a booted
    // container: each invalidate flushes the cached instance and splices it out of
    // _resolutionOrder, and the next get() re-pushes exactly one. The steady-state
    // _resolutionOrder length must return to its baseline (1) every cycle, never
    // grow -- and no flushed instance may be retained (lite-leak witnesses it).
    {
        const c = new Container();
        let built = 0;
        c.singletonFactory('svc', () => ({ id: ++built }));
        c.boot();
        // No pre-loop get(): each of the CYCLES iterations rebuilds exactly once,
        // so built === CYCLES with no fudge. After each invalidate() the slot is
        // flushed and spliced, so the steady-state _resolutionOrder length is 0.

        const tracker3 = createLeakTracker({
            name: 'di-invalidate-soak',
            onWarning: () => { STATS.warnings++; },
        });

        globalThis.gc();
        const heapBefore = process.memoryUsage().heapUsed;
        let peakKB = 0;

        for (let cyc = 0; cyc < CYCLES; cyc++) {
            const inst = c.get('svc'); // cold rebuild every cycle (prev was flushed)
            // Track the per-cycle instance; the tag/cleanup must NOT close over it.
            const h = tracker3.track(inst, NOOP, cyc);
            await c.invalidate('svc');
            tracker3.untrack(h);

            check(c._resolutionOrder.length === 0,
                () => `T7.invalidate-soak: cycle ${cyc} resolution order is ${c._resolutionOrder.length} after invalidate, expected 0`);
            check(c._singletons.has('svc') === false,
                () => `T7.invalidate-soak: cycle ${cyc} left a stale cached instance after invalidate()`);
            check(orderInvariant(c),
                () => `T7.invalidate-soak: cycle ${cyc} broke orderInvariant`);

            if ((cyc & 511) === 0) {
                globalThis.gc();
                const kb = (process.memoryUsage().heapUsed - heapBefore) / 1024;
                if (kb > peakKB) peakKB = kb;
            }
        }

        check(tracker3.size() === 0,
            () => `T7.invalidate-soak: lite-leak tracker leaked ${tracker3.size()} instances`);
        const findings3 = tracker3.audit();
        check(findings3.length === 0,
            () => `T7.invalidate-soak: lite-leak reported ${findings3.length} findings`);

        globalThis.gc();
        const grewKB = (process.memoryUsage().heapUsed - heapBefore) / 1024;
        if (grewKB > peakKB) peakKB = grewKB;
        check(peakKB < 512,
            () => `T7.invalidate-soak: heap grew ${peakKB.toFixed(1)} KB over ${CYCLES} invalidate cycles`);
        check(built === CYCLES,
            () => `T7.invalidate-soak: expected ${CYCLES} rebuilds, got ${built}`);
    }
}
