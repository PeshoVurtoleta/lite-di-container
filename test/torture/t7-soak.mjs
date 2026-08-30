/**
 * T7 -- soak and retention (D-09, D-13). The AUTHORITY is FINALIZATION, not a
 * counter trick.
 *
 * CYCLES scope build-up / tear-down cycles off one parent. Each cycle: create a
 * child scope, register 8 scoped bindings, resolve them, drain the scope, then
 * track the DRAINED CHILD with lite-leak WITHOUT untracking it (cleanup NOOP +
 * numeric tag capture NOTHING, held-value contract, so the child -- and anything
 * it closes over -- is held only WEAKLY by the tracker's FinalizationRegistry).
 * After the loop we settle HARD (>= 10 gc()+timer passes) and assert the
 * finalization residual tracker.size() <= RES = max(16, CYCLES/1000): a scope
 * that shutdown() really detached is collected (size--), one the parent still
 * pins is not. lite-leak is an independent witness -- a JS-object leak and a
 * container-state leak cannot hide behind each other.
 *
 * (An earlier track+immediate-untrack asserted size()===0 -- a VACUOUS TAUTOLOGY:
 * untrack decrements the live counter synchronously, netting to 0 every cycle even
 * if the parent retained the child forever, and it tracked a throwaway {cycle}
 * object rather than the scope. Fixed here per the promotion-ladder gate 2 -- a
 * retention gate must be able to FAIL on a retained object.)
 *
 * The parent-bleed invariants (law 4) are the real content of the loop: nothing a
 * child does may write into the parent's caches or resolution order. Heap is
 * sampled ONLY at cycle boundaries.
 *
 * Drain path (D-13 fixed in D4): shutdown() now RELEASES, so it is the primary
 * drain. Alternate by parity as ../LiteBvh's t7 does: odd cycles shutdown(),
 * even cycles shutdown() then clear(). retention 0 after shutdown() ALONE is the
 * D4 contract, asserted every cycle.
 *
 * Sub-phase 2 soaks the D-09 shape (get -> unregister -> re-register -> get):
 * _resolutionOrder must stay at its steady-state length 1, not grow linearly. It
 * tracks nothing (a structural growth check), so it needs no finalization gate.
 *
 * Sub-phase 3 soaks the invalidate/get shape (decision 0005) and tracks the
 * FLUSHED instance under the same AUTHORITY: after invalidate() the container must
 * hold no reference, so a released instance is finalized (size--).
 *
 * DI_TORTURE_BREAK=1 retains each tracked child/instance in a module sink ->
 * size() stays ~CYCLES and BLOWS RES, tripping the residual gate DIRECTLY.
 * (Whole-suite control; in a full run T6's control trips first -- prove the soak
 * gate in isolation:
 * DI_TORTURE_BREAK=1 node --expose-gc -e "import('./test/torture/t7-soak.mjs').then(m=>m.run())".)
 */

import { Container } from '../../Container.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { check, retention, orderInvariant, BREAK, STATS } from './harness.mjs';

const CYCLES = 4096;
const SCOPED = 8;
const NOOP = function () {};

/** AUTHORITY residual ceiling. Clean leaves single digits; a real leak leaves ~CYCLES. */
const RES = Math.max(16, (CYCLES / 1000) | 0); // 16

/** Coarse one-time-growth backstop. Loose: the tracker holds ~CYCLES leakRecords live. */
const HEAP_CEIL = 2 * 1024 * 1024; // 2 MB

const GUARD_D09 = false; // FIXED in D2 -- unregister() splices _resolutionOrder (stays at 1)

/**
 * BREAK: retains each tracked child/instance so it can NEVER be finalized ->
 * size() stays ~CYCLES and the residual gate trips.
 */
const sink = [];

/** Hard settle: run FinalizationRegistry callbacks to ground before reading size(). */
async function settleHard() {
    for (let i = 0; i < 10; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 15));
    }
}

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

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const scope = parent.scope();
        for (let i = 0; i < SCOPED; i++) {
            scope.singleton('s' + i, class { constructor() {} });
        }
        for (let i = 0; i < SCOPED; i++) scope.get('s' + i);

        // Un-overridden parent binding still resolves to the parent instance.
        check(scope.get('rootSvc') === rootInst,
            () => `T7: cycle ${cyc} lost the inherited parent instance`);

        // Drain (D-13 fixed in D4): shutdown() now RELEASES, so it is the primary
        // drain every cycle. Even cycles also clear() (drops _registry too), as
        // ../LiteBvh's t7 alternates the drain path by parity.
        await scope.shutdown();
        if ((cyc & 1) === 0) scope.clear();

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

        // AUTHORITY: track the DRAINED CHILD without untracking; finalization
        // decides its fate. Neither NOOP nor the numeric tag closes over the scope
        // (held-value contract). A scope shutdown() truly detached is collectable;
        // one the parent still pins is not, and size() witnesses the difference.
        tracker.track(scope, NOOP, cyc);
        if (BREAK) sink.push(scope); // pin -> can NEVER be finalized -> size() stays high.
    }

    await settleHard();
    const residual = tracker.size();
    const findings = tracker.audit();
    STATS.leakSize = residual;
    STATS.leakTarget = RES;
    STATS.findings = findings.length;

    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);
    // AUTHORITY: finalization residual. A real leak would leave ~CYCLES.
    check(residual <= RES,
        () => `T7: AUTHORITY finalization residual size()=${residual} > ${RES} -- a scope outlived its shutdown`);

    // SECONDARY (NOT the authority): coarse one-time-growth backstop.
    globalThis.gc();
    const grewKB = (process.memoryUsage().heapUsed - heapBefore) / 1024;
    check(grewKB < HEAP_CEIL / 1024,
        () => `T7: (secondary) heap grew ${grewKB.toFixed(1)} KB over ${CYCLES} cycles`);

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
    // grow -- and no flushed instance may be retained (lite-leak witnesses it under
    // the same AUTHORITY: track the flushed instance, never untrack, settle, gate
    // the finalization residual).
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
        const heapBefore3 = process.memoryUsage().heapUsed;

        for (let cyc = 0; cyc < CYCLES; cyc++) {
            const inst = c.get('svc'); // cold rebuild every cycle (prev was flushed)
            await c.invalidate('svc');

            check(c._resolutionOrder.length === 0,
                () => `T7.invalidate-soak: cycle ${cyc} resolution order is ${c._resolutionOrder.length} after invalidate, expected 0`);
            check(c._singletons.has('svc') === false,
                () => `T7.invalidate-soak: cycle ${cyc} left a stale cached instance after invalidate()`);
            check(orderInvariant(c),
                () => `T7.invalidate-soak: cycle ${cyc} broke orderInvariant`);

            // AUTHORITY: track the FLUSHED instance without untracking. After
            // invalidate() the container holds no reference, so a truly released
            // instance is finalized (size--); one the container still pins is not.
            // Tag/cleanup must NOT close over it (held-value contract).
            tracker3.track(inst, NOOP, cyc);
            if (BREAK) sink.push(inst); // pin -> can NEVER be finalized -> size() stays high.
        }

        await settleHard();
        const residual3 = tracker3.size();
        const findings3 = tracker3.audit();
        STATS.leakSize = residual3 > STATS.leakSize ? residual3 : STATS.leakSize;
        STATS.findings += findings3.length;

        check(findings3.length === 0,
            () => `T7.invalidate-soak: lite-leak reported ${findings3.length} findings`);
        check(residual3 <= RES,
            () => `T7.invalidate-soak: AUTHORITY finalization residual size()=${residual3} > ${RES} -- an instance outlived its invalidate`);

        // SECONDARY (NOT the authority): coarse one-time-growth backstop.
        globalThis.gc();
        const grewKB3 = (process.memoryUsage().heapUsed - heapBefore3) / 1024;
        check(grewKB3 < HEAP_CEIL / 1024,
            () => `T7.invalidate-soak: (secondary) heap grew ${grewKB3.toFixed(1)} KB over ${CYCLES} invalidate cycles`);
        check(built === CYCLES,
            () => `T7.invalidate-soak: expected ${CYCLES} rebuilds, got ${built}`);
    }
}
