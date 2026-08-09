/**
 * T0 -- metamorphic resolution laws.
 *
 * Properties that must hold for ANY graph, checked over a seeded corpus. These
 * are the DI analogues of lite-bvh's geometric laws. Every law here is one that
 * holds on TODAY's (still-buggy) code; findings that break a law are guarded in
 * the tier that owns them (T3/T4/T7), not asserted green here.
 */

import { Container } from '../../Container.js';
import { makePrng, SEED, check, retention, orderInvariant, validate } from './harness.mjs';

export async function run() {
    const prng = makePrng(SEED);

    // -- Law 1: singleton idempotence, constructor runs exactly once ----------
    {
        const c = new Container();
        let ctor = 0;
        class S { constructor() { ctor++; } }
        c.singleton('s', S);
        const first = c.get('s');
        for (let i = 0; i < 100; i++) {
            check(c.get('s') === first, () => `T0.singleton: get('s') not idempotent at ${i}`);
        }
        check(ctor === 1, () => `T0.singleton: constructor ran ${ctor} times, expected 1`);
        check(validate(c), () => 'T0.singleton: validate failed');
    }

    // -- Law 2: transient distinctness, ctor count == get count ---------------
    {
        const c = new Container();
        let ctor = 0;
        class T { constructor() { ctor++; } }
        c.transient('t', T);
        const gets = 50;
        let prev = c.get('t');
        for (let i = 1; i < gets; i++) {
            const cur = c.get('t');
            check(cur !== prev, () => `T0.transient: two gets returned the same instance at ${i}`);
            prev = cur;
        }
        check(ctor === gets, () => `T0.transient: ctor ${ctor} != get count ${gets}`);
    }

    // -- Law 3: value identity for null / 0 / '' / false ----------------------
    {
        const c = new Container();
        const refs = { a: null, b: 0, c: '', d: false, e: { obj: 1 } };
        c.value('a', refs.a); c.value('b', refs.b); c.value('c', refs.c);
        c.value('d', refs.d); c.value('e', refs.e);
        check(c.get('a') === refs.a, () => 'T0.value: null identity lost');
        check(c.get('b') === refs.b, () => 'T0.value: 0 identity lost');
        check(c.get('c') === refs.c, () => 'T0.value: empty-string identity lost');
        check(c.get('d') === refs.d, () => 'T0.value: false identity lost');
        check(c.get('e') === refs.e, () => 'T0.value: object identity lost');
    }

    // -- Law 4: alias transitivity, chain length is irrelevant ----------------
    {
        const c = new Container();
        c.value('target', { v: 7 });
        const t = c.get('target');
        c.alias('a1', 'a2');
        c.alias('a2', 'a3');
        c.alias('a3', 'target');
        check(c.get('a1') === t, () => 'T0.alias: transitive chain did not reach the target');
        check(c.get('a3') === t, () => 'T0.alias: single-hop alias did not reach the target');
        check(validate(c), () => 'T0.alias: validate failed');
    }

    // -- Law 5: diamond sharing on a singleton leaf ---------------------------
    {
        const c = new Container();
        class D {}
        class B { constructor(d) { this.d = d; } }
        class Cc { constructor(d) { this.d = d; } }
        class A { constructor(b, cc) { this.b = b; this.cc = cc; } }
        c.singleton('d', D);
        c.transient('b', B, ['d']);
        c.transient('cc', Cc, ['d']);
        c.transient('a', A, ['b', 'cc']);
        const a = c.get('a');
        check(a.b.d === a.cc.d, () => 'T0.diamond: singleton leaf not shared across branches');
    }

    // -- Law 6: scope override isolation --------------------------------------
    {
        const parent = new Container();
        class S1 {}
        class S2 {}
        parent.singleton('svc', S1);
        const parentInst = parent.get('svc');
        const parentOrderLen = parent._resolutionOrder.length;
        const parentSize = parent._singletons.size;

        const child = parent.scope();
        child.singleton('svc', S2); // override
        const childInst = child.get('svc');

        check(childInst !== parentInst, () => 'T0.scope-override: child shares the parent instance');
        check(childInst instanceof S2, () => 'T0.scope-override: child did not use its own binding');
        check(parent.get('svc') === parentInst, () => 'T0.scope-override: parent instance changed');
        check(parent._resolutionOrder.length === parentOrderLen,
            () => 'T0.scope-override: child mutated parent._resolutionOrder');
        check(parent._singletons.size === parentSize,
            () => 'T0.scope-override: child wrote into parent._singletons');
    }

    // -- Law 7: scope inheritance records in the PARENT's order ---------------
    {
        const parent = new Container();
        class S {}
        parent.singleton('svc', S);
        const child = parent.scope();
        const inst = child.get('svc');
        check(inst === parent.get('svc'), () => 'T0.scope-inherit: child got a different instance');
        check(parent._resolutionOrder.indexOf('svc') !== -1,
            () => 'T0.scope-inherit: parent order did not record the inherited resolution');
        check(child._singletons.size === 0,
            () => 'T0.scope-inherit: child cached an inherited parent instance');
    }

    // -- Law 8: resolution order == reverse teardown order --------------------
    // For a clean graph (no unregister churn) teardown fires in exactly
    // _resolutionOrder.reverse(), and a dependency tears down after its dependents.
    {
        const c = new Container();
        const torn = [];
        class Leaf {}
        class Mid { constructor(l) { this.l = l; } }
        class Root { constructor(m) { this.m = m; } }
        c.singleton('leaf', Leaf);
        c.singleton('mid', Mid, ['leaf']);
        c.singleton('root', Root, ['mid']);
        c.onTeardown('leaf', () => { torn.push('leaf'); });
        c.onTeardown('mid', () => { torn.push('mid'); });
        c.onTeardown('root', () => { torn.push('root'); });
        c.get('root');
        const expected = c._resolutionOrder.slice().reverse();
        await c.shutdown();
        check(torn.length === expected.length,
            () => `T0.teardown: fired ${torn.length}, expected ${expected.length}`);
        for (let i = 0; i < expected.length; i++) {
            check(torn[i] === expected[i],
                () => `T0.teardown: order[${i}] ${torn[i]} != reverse-resolution ${expected[i]}`);
        }
        // leaf was resolved first, so it must be torn down last.
        check(torn[torn.length - 1] === 'leaf',
            () => 'T0.teardown: the leaf dependency was not torn down last');
    }

    // -- Law 9: boot() idempotence --------------------------------------------
    {
        const c = new Container();
        class A {}
        c.value('cfg', {});
        c.singleton('a', A, []);
        c.boot();
        const before = retention(c);
        c.boot();
        const after = retention(c);
        check(before.registry === after.registry && before.singletons === after.singletons &&
            before.order === after.order,
            () => 'T0.boot: second boot() mutated container state');
    }

    // -- Law 10: reset() round trip -------------------------------------------
    {
        const c = new Container();
        let ctor = 0;
        class Counter { constructor() { this.id = ++ctor; } }
        c.singleton('counter', Counter);
        c.multiFactory('m', () => ({}));
        c.get('counter');
        c.getAll('m');
        const registryN = retention(c).registry; // single + multi registrations
        c.reset();
        const r = retention(c);
        check(r.registry === registryN, () => `T0.reset: registry ${r.registry} != ${registryN}`);
        check(r.singletons === 0, () => `T0.reset: singletons ${r.singletons} != 0`);
        check(r.order === 0, () => `T0.reset: order ${r.order} != 0`);
        check(r.flags === 0, () => `T0.reset: flags ${r.flags} != 0`);
        // A subsequent resolve rebuilds identically (fresh instance, same shape).
        const rebuilt = c.get('counter');
        check(rebuilt.id === 2, () => `T0.reset: rebuild id ${rebuilt.id} != 2`);
        check(orderInvariant(c), () => 'T0.reset: orderInvariant broken after rebuild');
    }

    // -- Law 11: concurrent getAsync of one singletonFactoryAsync builds once -
    // N concurrent callers of a cached async binding share ONE construction
    // (D-03: the in-flight promise is memoized in _pending before the await).
    for (const N of [2, 8, 64]) {
        const c = new Container();
        let builds = 0;
        c.singletonFactoryAsync('db', async () => { await Promise.resolve(); builds++; return { id: builds }; });
        const calls = new Array(N);
        for (let i = 0; i < N; i++) calls[i] = c.getAsync('db');
        const results = await Promise.all(calls);
        check(builds === 1, () => `T0.async-dedupe: N=${N} built ${builds} times, expected 1`);
        for (let i = 1; i < N; i++) {
            check(results[i] === results[0], () => `T0.async-dedupe: N=${N} instance ${i} differs from 0`);
        }
        check(c._pending.size === 0, () => `T0.async-dedupe: N=${N} left _pending non-empty`);
        check(orderInvariant(c), () => `T0.async-dedupe: N=${N} broke orderInvariant`);
    }

    // -- A seeded random DAG corpus, every law re-checked structurally --------
    for (let g = 0; g < 40; g++) {
        const c = new Container();
        const depth = 1 + (prng() % 8);
        const names = [];
        for (let d = 0; d < depth; d++) {
            const name = 'n' + d;
            names.push(name);
            const fanout = d === 0 ? 0 : 1 + (prng() % Math.min(d, 5));
            const deps = [];
            for (let k = 0; k < fanout; k++) deps.push(names[prng() % d]);
            const lifetime = prng() % 3;
            const Klass = class { constructor() {} };
            if (lifetime === 0) c.singleton(name, Klass, deps);
            else if (lifetime === 1) c.transient(name, Klass, deps);
            else c.singletonFactory(name, () => ({ name }));
        }
        c.boot();
        c.get(names[names.length - 1]);
        check(orderInvariant(c), () => `T0.corpus: orderInvariant broke on graph ${g} (seed=${SEED})`);
        check(validate(c), () => `T0.corpus: validate broke on graph ${g} (seed=${SEED})`);
    }
}
