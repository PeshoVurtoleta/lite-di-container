/**
 * invalidate() / rebind() -- post-boot hot-swap (decision 0005, v2.2.0).
 *
 * Reading B: constrained post-boot re-registration. These tests pin the
 * fail-closed check order, the atomic "registry untouched on failure" contract,
 * the _pending flush that stops a racing async build from re-caching a stale
 * instance, the D-09 resolution-order splice, and the teardown ladder on a
 * flushed instance. The hot get() lane is proven byte-steady by the torture T6
 * gate; this file is behavior only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container, TYPES } from '../Container.js';

// -- invalidate -------------------------------------------------------------

test('invalidate() flushes a singleton; get() rebuilds; has() stays true', async () => {
    const c = new Container();
    let n = 0;
    class Svc { constructor() { this.id = ++n; } }
    c.singleton('svc', Svc);
    c.boot();
    const a = c.get('svc');
    assert.equal(a.id, 1);
    await c.invalidate('svc');
    assert.equal(c.has('svc'), true);
    const b = c.get('svc');
    assert.equal(b.id, 2);
    assert.notEqual(a, b);
});

test('invalidate() runs the teardown ladder on the flushed instance', async () => {
    const c = new Container();
    const torn = [];
    class Svc { constructor() { this.tag = 'x'; } }
    c.singleton('svc', Svc);
    c.onTeardown('svc', (inst) => { torn.push(inst.tag); });
    c.boot();
    c.get('svc');
    await c.invalidate('svc');
    assert.deepEqual(torn, ['x']);
});

test('invalidate() falls through to Symbol.dispose/close/destroy', async () => {
    const c = new Container();
    let closed = 0;
    class Svc { close() { closed++; } }
    c.singleton('svc', Svc);
    c.boot();
    c.get('svc');
    await c.invalidate('svc');
    assert.equal(closed, 1);
});

test('invalidate() splices _resolutionOrder -- no growth across a churn loop', async () => {
    const c = new Container();
    c.singletonFactory('x', () => ({}));
    c.boot();
    for (let i = 0; i < 100; i++) {
        c.get('x');
        await c.invalidate('x');
    }
    c.get('x');
    assert.equal(c._resolutionOrder.length, 1);
    assert.equal(c._resolutionOrder[0], 'x');
});

test('invalidate() on a registered-but-unresolved name is a safe no-op', async () => {
    const c = new Container();
    class Svc {}
    c.singleton('svc', Svc);
    c.boot();
    await c.invalidate('svc'); // never resolved -> nothing cached
    assert.equal(c._resolutionOrder.length, 0);
    assert.equal(c._singletons.size, 0);
});

test('invalidate() flushes a multi binding and tears each instance down', async () => {
    const c = new Container();
    const torn = [];
    let n = 0;
    class P { constructor() { this.id = ++n; } }
    class Q { constructor() { this.id = ++n; } }
    c.multi('m', P);
    c.multi('m', Q);
    c.onTeardown('m', (inst) => { torn.push(inst.id); });
    c.boot();
    const first = c.getAll('m').map((x) => x.id);
    assert.deepEqual(first, [1, 2]);
    await c.invalidate('m');
    assert.equal(c._multiSingletons.has('m'), false);
    assert.equal(c._resolvedFlags.has('m'), false);
    assert.equal(c._resolutionOrder.length, 0);
    assert.deepEqual(torn, [1, 2]);
    const second = c.getAll('m').map((x) => x.id);
    assert.deepEqual(second, [3, 4]);
});

test('invalidate() evicts the in-flight async build memo (no stale re-cache)', async () => {
    const c = new Container();
    let builds = 0;
    c.singletonFactoryAsync('slow', async () => {
        builds++;
        await new Promise((r) => setTimeout(r, 10));
        return { build: builds };
    });
    c.boot();
    const p = c.getAsync('slow');       // in-flight, memoized in _pending
    await c.invalidate('slow');         // must drop the memo
    assert.equal(c._pending.has('slow'), false);
    await p;                            // the racing build settles...
    // ...but must NOT have re-cached into the flushed slot.
    assert.equal(c._singletons.has('slow'), false);
    const fresh = await c.getAsync('slow');
    assert.equal(fresh.build, 2);
});

test('invalidate() + concurrent getAsync: the racing build cannot clobber the slot (identity, decision 0005)', async () => {
    // The exact fail-open interleaving: build A in flight -> invalidate drops A's
    // memo -> a fresh getAsync (B) repopulates _pending -> A settles. A must NOT
    // re-cache (identity, not presence), B must be the cached instance, and no
    // container-MANAGED instance may escape teardown.
    const c = new Container();
    let builds = 0;
    const torn = [];
    c.singletonFactoryAsync('slow', async () => {
        const id = ++builds;
        await new Promise((r) => setTimeout(r, 10));
        return { id };
    });
    c.onTeardown('slow', (inst) => { torn.push(inst.id); });
    c.boot();

    const pA = c.getAsync('slow');   // build A -> id 1
    await c.invalidate('slow');      // flush; A's memo dropped
    const pB = c.getAsync('slow');   // build B -> id 2, repopulates _pending
    const a = await pA;
    const b = await pB;

    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    // The flushed slot holds B (the fresh resolve), not A's stale instance.
    assert.equal(c._singletons.get('slow').id, 2);
    // The post-invalidate caller's value equals what is cached (no clobber).
    assert.equal(c._singletons.get('slow').id, b.id);

    await c.shutdown();
    // Every CONTAINER-MANAGED instance is torn down. Id 2 (cached) must be torn.
    assert.ok(torn.includes(2), 'the cached instance (id 2) must be torn down at shutdown');
    // Id 1 is the DETACHED instance the pA caller owns -- correctly NOT managed,
    // so it is not in the teardown ladder (documented mid-invalidate edge).
    assert.deepEqual(torn, [2]);
});

test('invalidate() throws when the container is not LIVE', async () => {
    const c = new Container();
    class Svc {}
    c.singleton('svc', Svc);
    c.boot();
    c.get('svc');
    await c.shutdown();
    await assert.rejects(() => c.invalidate('svc'), /not live/i);
});

test('invalidate() throws on an unregistered name', async () => {
    const c = new Container();
    c.boot();
    await assert.rejects(() => c.invalidate('ghost'), /not registered/i);
});

test('invalidate() throws when the name is mid-resolution', async () => {
    const c = new Container();
    // invalidate is async: its mid-resolution guard runs synchronously at call
    // time (while 'a' is on _path) but surfaces as a rejected promise. Capture it
    // and assert the rejection.
    let pending = null;
    c.singletonFactory('a', (cc) => {
        pending = cc.invalidate('a');
        return {};
    });
    c.boot();
    c.get('a');
    await assert.rejects(() => pending, /mid-resolution/i);
});

// -- rebind -----------------------------------------------------------------

test('rebind() swaps a singleton; the next get() builds from the new entry', async () => {
    const c = new Container();
    class Old { constructor() { this.v = 'old'; } }
    class New { constructor() { this.v = 'new'; } }
    c.singleton('svc', Old);
    c.boot();
    assert.equal(c.get('svc').v, 'old');
    await c.rebind('svc', { type: TYPES.SINGLETON, Class: New, deps: [], isAsync: false, isCached: true });
    assert.equal(c.get('svc').v, 'new');
    assert.equal(c._resolutionOrder.length, 1);
});

test('rebind() re-resolves through a new dependency wiring', async () => {
    const c = new Container();
    class Dep { constructor() { this.who = 'dep'; } }
    class Svc { constructor(d) { this.dep = d; } }
    class SvcNoDep { constructor() { this.dep = null; } }
    c.singleton('dep', Dep);
    c.singleton('svc', SvcNoDep);
    c.boot();
    assert.equal(c.get('svc').dep, null);
    await c.rebind('svc', { type: TYPES.SINGLETON, Class: Svc, deps: ['dep'], isAsync: false, isCached: true });
    assert.equal(c.get('svc').dep.who, 'dep');
});

test('rebind() with a missing dependency throws; registry is untouched', async () => {
    const c = new Container();
    class Old { constructor() { this.v = 'old'; } }
    class New {}
    c.singleton('svc', Old);
    c.boot();
    const before = c._registry.get('svc');
    await assert.rejects(
        () => c.rebind('svc', { type: TYPES.SINGLETON, Class: New, deps: ['missing'], isAsync: false, isCached: true }),
        /not registered/i);
    assert.equal(c._registry.get('svc'), before);
    assert.equal(c.get('svc').v, 'old');
});

test('rebind() that introduces a cycle throws; registry is untouched', async () => {
    const c = new Container();
    class A { constructor() {} }
    class B { constructor() {} }
    // a -> b (b has no deps). Rebinding b to depend on a closes a -> b -> a.
    c.singleton('a', A, ['b']);
    c.singleton('b', B, []);
    c.boot();
    const before = c._registry.get('b');
    await assert.rejects(
        () => c.rebind('b', { type: TYPES.SINGLETON, Class: B, deps: ['a'], isAsync: false, isCached: true }),
        /circular/i);
    assert.equal(c._registry.get('b'), before);
});

test('rebind() cannot change kind (single <-> multi)', async () => {
    const c = new Container();
    class P {}
    c.multi('m', P);
    c.boot();
    await assert.rejects(
        () => c.rebind('m', { type: TYPES.SINGLETON, Class: P, deps: [], isAsync: false, isCached: true }),
        /multi binding/i);
});

test('rebind() throws on an unregistered name', async () => {
    const c = new Container();
    c.boot();
    await assert.rejects(
        () => c.rebind('ghost', { type: TYPES.VALUE, value: 1, isAsync: false }),
        /not registered/i);
});

test('rebind() throws when the container is not LIVE', async () => {
    const c = new Container();
    class Svc {}
    c.singleton('svc', Svc);
    c.boot();
    c.get('svc');
    await c.shutdown();
    await assert.rejects(
        () => c.rebind('svc', { type: TYPES.SINGLETON, Class: Svc, deps: [], isAsync: false, isCached: true }),
        /not live/i);
});

test('rebind() throws when the name is mid-resolution; registry untouched', async () => {
    const c = new Container();
    class New {}
    // rebind is async: the mid-resolution guard runs synchronously at call time
    // (before the _registry.set), so the registry stays untouched and the promise
    // rejects. Capture and assert.
    let pending = null;
    c.singletonFactory('a', (cc) => {
        pending = cc.rebind('a', { type: TYPES.SINGLETON, Class: New, deps: [], isAsync: false, isCached: true });
        return { v: 'orig' };
    });
    c.boot();
    const before = c._registry.get('a');
    c.get('a');
    await assert.rejects(() => pending, /mid-resolution/i);
    assert.equal(c._registry.get('a'), before);
});

test('rebind() rejects a non-object entry (fail closed)', async () => {
    const c = new Container();
    class Svc {}
    c.singleton('svc', Svc);
    c.boot();
    await assert.rejects(() => c.rebind('svc', null), /registry entry object/i);
    await assert.rejects(() => c.rebind('svc', 42), /registry entry object/i);
    await assert.rejects(() => c.rebind('svc', [{}]), /registry entry object/i);
});

test('rebind() can swap a value binding', async () => {
    const c = new Container();
    c.value('cfg', { port: 3000 });
    c.boot();
    assert.equal(c.get('cfg').port, 3000);
    await c.rebind('cfg', { type: TYPES.VALUE, value: { port: 4000 }, isAsync: false });
    assert.equal(c.get('cfg').port, 4000);
});
