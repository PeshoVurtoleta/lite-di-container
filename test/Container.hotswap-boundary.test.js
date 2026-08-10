/**
 * invalidate() / rebind() -- QA boundary matrix (decision 0005, v2.2.0).
 *
 * This file is QA-authored, additive to test/Container.rebind.test.js. It closes
 * the gaps the reviewer/QA pass identified that were NOT yet locked into
 * node:test:
 *
 *   - invalidate()/rebind() throw on a DRAINING container (distinct from
 *     SHUT_DOWN), observed by blocking a real teardown mid-flight.
 *   - the third-build async interleave (settle order != creation order): only
 *     the LIVE build caches, no duplicate _resolutionOrder push, no orphaned
 *     _pending memo.
 *   - the multi-async interleave (getAllAsync -> invalidate -> getAllAsync):
 *     no double push, the live _multiSingletons slot holds the newest build
 *     BY IDENTITY (not by a numeric id that races).
 *   - rebind() to an ALIAS entry (target present succeeds, target missing
 *     throws with the registry untouched).
 *   - _pending has no orphaned entry once an invalidated in-flight build settles.
 *   - the boundary matrix: 0 / 1 / N-1 / N / N+1 (multi-binding cardinality,
 *     since tokens are string/symbol only -- D-15 -- so a numeric 0/1 boundary
 *     does not apply to the token itself), empty string / null / undefined /
 *     NaN / -0 tokens, duplicate (concurrent) dispose, dispose-during-iteration
 *     (a re-entrant invalidate() fired from inside its own multi teardown loop),
 *     a re-entrant WRITE (rebind of an unrelated name fired from inside another
 *     name's in-progress synchronous factory), and one adversarial case: rebind()
 *     with the literal SAME entry object still forces a flush.
 *
 * Every assertion below is measured against an actual observable (an id, an
 * object identity, a Map/array size, a rejection message) -- never a bare
 * "did not throw" tautology.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container, TYPES } from '../Container.js';

// -- DRAINING (distinct from SHUT_DOWN) --------------------------------------

test('invalidate() on a DRAINING container throws (distinct from SHUT_DOWN)', async () => {
    const c = new Container();
    class A {}
    c.singleton('a', A);
    c.boot();
    c.get('a');

    let releaseTeardown;
    const gate = new Promise((resolve) => { releaseTeardown = resolve; });
    c.onTeardown('a', async () => { await gate; });

    const shutdownPromise = c.shutdown(); // flips to DRAINING, then blocks on `gate`
    await Promise.resolve();
    await Promise.resolve();

    // decision 0003: LIVE=0 / DRAINING=1 / SHUT_DOWN=2. Observe DRAINING for real.
    assert.equal(c._state, 1, 'setup did not actually reach DRAINING before the probe');

    await assert.rejects(() => c.invalidate('a'), /not live/i);
    assert.equal(c._state, 1, 'the container was already SHUT_DOWN when invalidate() rejected -- DRAINING was not observed');

    releaseTeardown();
    await shutdownPromise;
    assert.equal(c._state, 2, 'shutdown() never completed to SHUT_DOWN after the gate was released');
});

test('rebind() on a DRAINING container throws; registry untouched (distinct from SHUT_DOWN)', async () => {
    const c = new Container();
    class A {}
    class X {}
    c.singleton('a', A);
    c.singleton('x', X); // registered, never resolved -- unaffected by teardown order
    c.boot();
    c.get('a');

    let releaseTeardown;
    const gate = new Promise((resolve) => { releaseTeardown = resolve; });
    c.onTeardown('a', async () => { await gate; });

    const shutdownPromise = c.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(c._state, 1, 'setup did not actually reach DRAINING before the probe');

    const before = c._registry.get('x');
    await assert.rejects(
        () => c.rebind('x', { type: TYPES.SINGLETON, Class: X, deps: [], isAsync: false, isCached: true }),
        /not live/i);
    assert.equal(c._registry.get('x'), before, 'a rejected DRAINING rebind() mutated the registry');
    assert.equal(c._state, 1, 'the container was already SHUT_DOWN when rebind() rejected -- DRAINING was not observed');

    releaseTeardown();
    await shutdownPromise;
});

// -- Third-build async interleave (settle order != creation order) ----------

test('third-build interleave: getAsync -> invalidate -> getAsync -> invalidate -> getAsync (settle order != creation order)', async () => {
    const c = new Container();
    let builds = 0;
    const delays = [30, 5, 15]; // build1=30ms(last), build2=5ms(first), build3=15ms(middle, LIVE)
    const torn = [];
    c.singletonFactoryAsync('x', async () => {
        const id = ++builds;
        await new Promise((r) => setTimeout(r, delays[id - 1]));
        return { id };
    });
    c.onTeardown('x', (inst) => { torn.push(inst.id); });
    c.boot();

    const pA = c.getAsync('x');  // build 1, settles LAST
    await c.invalidate('x');     // drops build 1's memo
    const pB = c.getAsync('x');  // build 2, settles FIRST
    await c.invalidate('x');     // drops build 2's memo
    const pC = c.getAsync('x');  // build 3, settles MIDDLE -- the live build

    const [a, b, cc] = await Promise.all([pA, pB, pC]);
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(cc.id, 3);

    assert.equal(c._singletons.get('x').id, 3, 'only the live (last-standing) build must end up cached');
    assert.deepEqual(c._resolutionOrder.filter((n) => n === 'x'), ['x'], '_resolutionOrder must contain the name exactly once');
    assert.equal(c._pending.has('x'), false, '_pending must have no orphaned entry once every build has settled');

    await c.shutdown();
    assert.deepEqual(torn, [3], 'only the cached (live) instance may be torn down; the two detached builds must not appear');
});

// -- Multi-async interleave ---------------------------------------------------

test('multi-async interleave: getAllAsync -> invalidate -> getAllAsync does not double-push _resolutionOrder; live slot holds the newest build', async () => {
    const c = new Container();
    const torn = [];
    class E1 {}
    class E2 {}
    c.multiFactory('m', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return new E1();
    });
    c.multiFactory('m', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return new E2();
    });
    c.onTeardown('m', (inst) => { torn.push(inst); });
    c.boot();

    const pA = c.getAllAsync('m');   // build A, in flight
    await c.invalidate('m');         // flush A's map slot + splice 'm' out of _resolutionOrder
    const pB = c.getAllAsync('m');   // build B -- the live one

    const a = await pA;
    const b = await pB;

    assert.equal(a.length, 2);
    assert.equal(b.length, 2);
    // A and B are entirely distinct instance sets (no accidental sharing).
    assert.equal(a.includes(b[0]), false);
    assert.equal(a.includes(b[1]), false);

    assert.deepEqual(c._resolutionOrder.filter((n) => n === 'm'), ['m'], 'no double-push of the multi name');

    // Identity, not a racy numeric id: the live map slot IS build B's array
    // content, element for element.
    const live = c._multiSingletons.get('m');
    assert.equal(live[0], b[0], 'live multi slot index 0 is not the newest (B) build');
    assert.equal(live[1], b[1], 'live multi slot index 1 is not the newest (B) build');

    await c.shutdown();
    // Only B's two instances (the live/managed ones) are torn down; A's two are
    // DETACHED (the mid-invalidate in-flight-caller edge, decision 0005) and must
    // NOT appear.
    assert.equal(torn.length, 2);
    assert.equal(torn.includes(b[0]), true);
    assert.equal(torn.includes(b[1]), true);
    assert.equal(torn.includes(a[0]), false);
    assert.equal(torn.includes(a[1]), false);
});

// -- rebind() to an ALIAS entry -----------------------------------------------

test('rebind() to an ALIAS entry: target registered succeeds and get() resolves through it', async () => {
    const c = new Container();
    class A { constructor() { this.v = 'a'; } }
    class Svc { constructor() { this.v = 'svc'; } }
    c.singleton('a', A);
    c.singleton('svc', Svc);
    c.boot();
    assert.equal(c.get('svc').v, 'svc');

    await c.rebind('svc', { type: TYPES.ALIAS, target: 'a' });
    assert.equal(c.get('svc').v, 'a', 'get() did not resolve through the rebound alias');
    assert.equal(c.get('svc'), c.get('a'), 'an alias must resolve to the SAME cached instance as its target');
});

test('rebind() to an ALIAS entry with a missing target throws; registry untouched', async () => {
    const c = new Container();
    class Svc { constructor() { this.v = 'svc'; } }
    c.singleton('svc', Svc);
    c.boot();
    const before = c._registry.get('svc');
    await assert.rejects(
        () => c.rebind('svc', { type: TYPES.ALIAS, target: 'ghost' }),
        /not registered/i);
    assert.equal(c._registry.get('svc'), before, 'a failed alias rebind mutated the registry');
    assert.equal(c.get('svc').v, 'svc', 'the old registration must still resolve after the failed rebind');
});

// -- _pending: no orphaned memo after settle ---------------------------------

test('_pending has no entry for the name after invalidate() and the in-flight build settles', async () => {
    const c = new Container();
    c.singletonFactoryAsync('x', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {};
    });
    c.boot();
    const p = c.getAsync('x');
    assert.equal(c._pending.has('x'), true, 'the in-flight build was not memoized in _pending');
    await c.invalidate('x');
    assert.equal(c._pending.has('x'), false, 'invalidate() did not drop the in-flight memo');
    await p; // let the racing build settle
    assert.equal(c._pending.has('x'), false, 'a stale settle re-populated _pending (orphaned memo)');
});

// -- Boundary matrix: multi cardinality (0 / 1 / N-1 / N / N+1) --------------
// Tokens are non-empty string/symbol only (D-15), so a numeric 0/1 TOKEN
// boundary does not apply; the meaningful cardinality axis for invalidate() is
// how many of a multi's N entries are actually cached at flush time.

test('boundary(0 of N): invalidate() on a registered multi that was NEVER resolved is a safe no-op', async () => {
    const c = new Container();
    class P {} class Q {} class R {}
    c.multi('m', P); c.multi('m', Q); c.multi('m', R);
    c.boot();
    await c.invalidate('m'); // 0 of 3 built -- nothing cached
    assert.equal(c._multiSingletons.has('m'), false);
    assert.equal(c._resolutionOrder.length, 0);
    const built = c.getAll('m');
    assert.equal(built.length, 3, 'the multi must still resolve fully after a no-op invalidate');
});

test('boundary(N=1): invalidate() on a single-entry multi tears down exactly once and rebuilds', async () => {
    const c = new Container();
    const torn = [];
    let n = 0;
    class Only { constructor() { this.id = ++n; } }
    c.multi('only', Only);
    c.onTeardown('only', (inst) => { torn.push(inst.id); });
    c.boot();
    assert.deepEqual(c.getAll('only').map((x) => x.id), [1]);
    await c.invalidate('only');
    assert.deepEqual(torn, [1]);
    assert.deepEqual(c.getAll('only').map((x) => x.id), [2]);
});

test('boundary(N-1 of N): invalidate() on a PARTIALLY resolved multi tears down only what was built', async () => {
    const c = new Container();
    const torn = [];
    class P { constructor() { this.tag = 'p'; } }
    class Q { constructor() { this.tag = 'q'; } }
    c.multi('m', P);
    c.multi('m', Q);
    c.multiFactory('m', () => { throw new Error('third entry build fails'); });
    c.onTeardown('m', (inst) => { torn.push(inst.tag); });
    c.boot();

    assert.throws(() => c.getAll('m'), /third entry build fails/);
    const cacheArr = c._multiSingletons.get('m');
    assert.equal(cacheArr.filter(Boolean).length, 2, 'expected exactly 2 of 3 entries cached before the throw');

    await c.invalidate('m');
    assert.deepEqual(torn.slice().sort(), ['p', 'q'], 'invalidate() must tear down only the (N-1) resolved instances');
    assert.equal(c._multiSingletons.has('m'), false);
});

test('boundary(N of N): invalidate() on a fully resolved multi tears down every instance', async () => {
    const c = new Container();
    const torn = [];
    class P {} class Q {} class R {}
    c.multi('m', P); c.multi('m', Q); c.multi('m', R);
    c.onTeardown('m', (inst) => { torn.push(inst); });
    c.boot();
    const built = c.getAll('m');
    assert.equal(built.length, 3);
    await c.invalidate('m');
    assert.equal(torn.length, 3, 'all N cached instances must be torn down');
    for (const inst of built) assert.equal(torn.includes(inst), true);
});

test('boundary(N+1): repeated invalidate()/getAll() cycles do not grow the multi flags array past N', async () => {
    const c = new Container();
    class P {} class Q {} class R {}
    c.multi('m', P); c.multi('m', Q); c.multi('m', R);
    c.boot();
    c.getAll('m');
    const initialBytes = c._resolvedFlags.get('m').buffer.byteLength;
    for (let i = 0; i < 5; i++) {
        await c.invalidate('m');
        c.getAll('m');
        assert.equal(c._resolvedFlags.get('m').buffer.byteLength, initialBytes, `flags array regrew on cycle ${i}`);
        assert.equal(c._resolvedFlags.get('m').length, 3);
    }
});

// -- Boundary matrix: degenerate tokens (empty / null / undefined / NaN / -0) -

test('boundary: invalidate("") and rebind("") on an unregistered empty-string token fail closed (D-15 token policy)', async () => {
    const c = new Container();
    c.boot();
    await assert.rejects(() => c.invalidate(''), /not registered/i);
    await assert.rejects(() => c.rebind('', { type: TYPES.VALUE, value: 1, isAsync: false }), /not registered/i);
});

test('boundary: invalidate()/rebind() on null, undefined, NaN, and -0 all fail closed as "not registered", never crash', async () => {
    const c = new Container();
    c.boot();
    const badTokens = [null, undefined, NaN, -0];
    for (const bad of badTokens) {
        await assert.rejects(() => c.invalidate(bad), /not registered/i,
            `invalidate(${String(bad)}) did not reject cleanly`);
        await assert.rejects(
            () => c.rebind(bad, { type: TYPES.VALUE, value: 1, isAsync: false }),
            /not registered/i,
            `rebind(${String(bad)}) did not reject cleanly`);
    }
});

// -- Duplicate dispose --------------------------------------------------------

test('boundary(duplicate dispose): two concurrent invalidate() calls on the same singleton tear down exactly once', async () => {
    const c = new Container();
    let n = 0;
    class Svc { constructor() { this.id = ++n; } }
    const torn = [];
    c.singleton('svc', Svc);
    c.onTeardown('svc', (inst) => { torn.push(inst.id); });
    c.boot();
    c.get('svc');

    const p1 = c.invalidate('svc');
    const p2 = c.invalidate('svc'); // fired before p1 settles
    await Promise.all([p1, p2]);

    assert.deepEqual(torn, [1], 'the flushed instance must be torn down exactly once, not twice');
    assert.equal(c.has('svc'), true);
    assert.equal(c.get('svc').id, 2);
});

// -- Dispose-during-iteration --------------------------------------------------

test('boundary(dispose-during-iteration): a re-entrant invalidate() fired from inside its own multi teardown loop is a safe no-op', async () => {
    const c = new Container();
    let n = 0;
    class P { constructor() { this.id = ++n; } }
    class Q { constructor() { this.id = ++n; } }
    class R { constructor() { this.id = ++n; } }
    c.multi('m', P); c.multi('m', Q); c.multi('m', R);
    const torn = [];
    let reentryResult = 'not-called';
    c.onTeardown('m', async (inst) => {
        torn.push(inst.id);
        if (inst.id === 1 && reentryResult === 'not-called') {
            // Re-entrant call WHILE the outer flush loop is still mid-iteration
            // over the remaining (already snapshotted-out-of-the-map) instances.
            try {
                await c.invalidate('m');
                reentryResult = 'resolved';
            } catch (e) { reentryResult = 'rejected:' + e.message; }
        }
    });
    c.boot();
    assert.deepEqual(c.getAll('m').map((x) => x.id), [1, 2, 3]);

    await c.invalidate('m'); // outer call

    assert.deepEqual(torn.slice().sort((x, y) => x - y), [1, 2, 3],
        'every one of the 3 instances must be torn down exactly once despite the re-entrant call');
    assert.equal(reentryResult, 'resolved', 'the re-entrant invalidate() during iteration must resolve, not throw');
    assert.equal(c._multiSingletons.has('m'), false);
    assert.equal(c.getAll('m').map((x) => x.id).length, 3);
});

// -- Re-entrant write ----------------------------------------------------------

test('boundary(re-entrant write): rebind() of an unrelated name fired from inside another name\'s in-progress sync factory completes', async () => {
    const c = new Container();
    class Other { constructor() { this.v = 'old-other'; } }
    class OtherNew { constructor() { this.v = 'new-other'; } }
    c.singleton('other', Other);
    let rebindPromise = null;
    let rebindSettled = 'pending';
    c.singletonFactory('a', (cc) => {
        // 'a' is mid-resolution (on _path); 'other' is NOT -- an unrelated
        // rebind must not be blocked by an unrelated in-flight resolution.
        rebindPromise = cc.rebind('other',
            { type: TYPES.SINGLETON, Class: OtherNew, deps: [], isAsync: false, isCached: true })
            .then(() => { rebindSettled = 'resolved'; }, (e) => { rebindSettled = 'rejected:' + e.message; });
        return { tag: 'a' };
    });
    c.boot();
    c.get('a');
    await rebindPromise;
    assert.equal(rebindSettled, 'resolved', 'a re-entrant rebind() of an unrelated name during another resolution was blocked: ' + rebindSettled);
    assert.equal(c.get('other').v, 'new-other', 'the re-entrant rebind did not actually take effect');
});

// -- Adversarial: the planner did not consider this one ------------------------

test('adversarial: rebind() with the EXACT SAME entry object still flushes and forces a fresh instance', async () => {
    const c = new Container();
    let n = 0;
    class Svc { constructor() { this.id = ++n; } }
    c.singleton('svc', Svc);
    c.boot();
    const first = c.get('svc');
    const sameEntry = c._registry.get('svc'); // the exact live registry entry object
    await c.rebind('svc', sameEntry); // rebind to literally itself
    assert.equal(c._registry.get('svc'), sameEntry, 'the registry entry identity should be preserved (it is the same object)');
    const second = c.get('svc');
    assert.notEqual(first, second, 'rebind() with an identical entry object must still flush the cached instance');
    assert.equal(second.id, 2, 'the factory must have run a second time');
});
