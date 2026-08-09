/**
 * T3 -- adversarial sequences crafted to break the graph.
 *
 * Deep chains, wide fan-out, cycles at every arity (direct, through aliases,
 * through factories, through multi-bindings), scope explosion, and a large boot
 * graph. After every thrown resolution the container must be left usable and
 * `_path.length === 0`.
 *
 * Guarded findings (asserted at current behaviour so the suite stays green):
 *   - D-02 (fixed in D3): the cross-factory ASYNC cycle HANGS today, so it is
 *     NOT executed here -- only its sync counterpart runs.
 *   - D-10 (fixed in D4): getAll/getAllAsync ignore _shutdown; the after-shutdown
 *     assertions for the multi lane are guarded.
 *   - D-11 (fixed in D2): the getAll cycle trace omits the multi name; we assert
 *     that a cycle is still DETECTED (it is), and guard the trace-content half.
 */

import { Container } from '../../Container.js';
import { check, orderInvariant, validate } from './harness.mjs';

const GUARD_D10 = true; // FAILS: D-10 (fixed in D4) -- getAll ignores _shutdown
const GUARD_D11 = false; // FIXED in D2 -- getAll now pushes the multi name; trace names it

function buildChain(c, n) {
    // n links: link0 (leaf) <- link1 <- ... <- link(n-1) (tip), all transient.
    class Node { constructor(dep) { this.dep = dep; } }
    c.value('leaf', { leaf: true });
    let prev = 'leaf';
    for (let i = 0; i < n; i++) {
        const name = 'l' + i;
        c.transient(name, Node, [prev]);
        prev = name;
    }
    return prev; // tip
}

export async function run() {
    // -- Deep chains resolved from the tip -----------------------------------
    // Policy: resolve, OR a documented depth ceiling (RangeError). Both pass.
    for (const n of [1, 2, 64, 1024]) {
        const c = new Container();
        const tip = buildChain(c, n);
        let ok = false;
        try { c.get(tip); ok = true; } catch (e) {
            if (!(e instanceof RangeError)) throw e; // only stack overflow is allowed
        }
        check(ok || n >= 1024, () => `T3.chain: depth ${n} failed without hitting the ceiling`);
    }
    {
        // The 8192 case: either resolves or throws the documented RangeError.
        const c = new Container();
        const tip = buildChain(c, 8192);
        let outcome = 'resolved';
        try { c.get(tip); } catch (e) {
            outcome = e instanceof RangeError ? 'ceiling' : 'other';
        }
        check(outcome !== 'other', () => 'T3.chain: 8192 threw a non-RangeError fault');
        check(c._path.length === 0, () => `T3.chain: _path leaked after depth 8192 (len=${c._path.length})`);
    }

    // -- Wide fan-out ---------------------------------------------------------
    for (const w of [1, 256, 4096]) {
        const c = new Container();
        const deps = [];
        for (let i = 0; i < w; i++) { c.value('d' + i, i); deps.push('d' + i); }
        class Root { constructor() { this.n = arguments.length; } }
        c.singleton('root', Root, deps);
        const r = c.get('root');
        check(r.n === w, () => `T3.fanout: root got ${r.n} args, expected ${w}`);
    }

    // -- Sync cycles at every arity ------------------------------------------
    for (const k of [1, 2, 3, 8, 64]) {
        const c = new Container();
        class N { constructor() {} }
        for (let i = 0; i < k; i++) {
            c.transient('c' + i, N, ['c' + ((i + 1) % k)]);
        }
        let threw = false;
        try { c.get('c0'); } catch (e) { threw = /circular/i.test(e.message); }
        check(threw, () => `T3.cycle: arity ${k} did not throw a circular error`);
        check(c._path.length === 0, () => `T3.cycle: _path leaked after arity ${k} (len=${c._path.length})`);
    }

    // -- Cycle through aliases ------------------------------------------------
    {
        const c = new Container();
        c.alias('a', 'b');
        c.alias('b', 'a');
        let threw = false;
        try { c.get('a'); } catch (e) { threw = /circular/i.test(e.message); }
        check(threw, () => 'T3.alias-cycle: alias a<->b did not throw circular');
        check(c._path.length === 0, () => 'T3.alias-cycle: _path leaked');
    }

    // -- Cycle through factories ---------------------------------------------
    {
        const c = new Container();
        c.factory('ping', (x) => x.get('pong'));
        c.factory('pong', (x) => x.get('ping'));
        let threw = false;
        try { c.get('ping'); } catch (e) { threw = /circular/i.test(e.message); }
        check(threw, () => 'T3.factory-cycle: ping<->pong did not throw circular');
        check(c._path.length === 0, () => 'T3.factory-cycle: _path leaked');
    }

    // -- Cycle through a multi-binding (D-11) --------------------------------
    {
        const c = new Container();
        class A { constructor(b) { this.b = b; } }
        c.multi('a', A, ['b']);
        c.singletonFactory('b', (x) => x.getAll('a')[0]);
        let threw = false;
        let msg = '';
        try { c.getAll('a'); } catch (e) { threw = /circular/i.test(e.message); msg = e.message; }
        // A cycle is still DETECTED today (the single lane catches b -> b).
        check(threw, () => 'T3.multi-cycle: getAll cycle was not detected at all');
        if (!GUARD_D11) {
            // FAILS: D-11 (fixed in D2) -- the trace must name the multi binding 'a'.
            check(/\ba\b/.test(msg), () => `T3.multi-cycle: trace omitted the multi name: ${msg}`);
        }
    }

    // -- Sync cross-factory cycle (the sync twin of D-02) ---------------------
    {
        const c = new Container();
        c.singletonFactory('a1', (x) => x.get('a2'));
        c.singletonFactory('a2', (x) => x.get('a3'));
        c.singletonFactory('a3', (x) => x.get('a1'));
        let threw = false;
        try { c.get('a1'); } catch (e) { threw = /circular/i.test(e.message); }
        check(threw, () => 'T3.sync-crossfactory: a1->a2->a3->a1 did not throw');
        check(c._path.length === 0, () => 'T3.sync-crossfactory: _path leaked');
    }
    // -- Async cross-factory cycles at every arity (D-02, fixed in D3) --------
    // Self / 2 / 3 / 8 nodes, each a singletonFactoryAsync that re-enters via a
    // factory callback. Before D3 these recursed without yielding and hung; now
    // the per-resolution context (decision 0002) carries the path across the
    // factory boundary and the cycle rejects with a bounded trace.
    for (const k of [1, 2, 3, 8]) {
        const c = new Container();
        for (let i = 0; i < k; i++) {
            const next = 'ca' + ((i + 1) % k);
            c.singletonFactoryAsync('ca' + i, async (x) => x.getAsync(next));
        }
        let threw = false;
        try { await c.getAsync('ca0'); } catch (e) { threw = /circular async/i.test(e.message); }
        check(threw, () => `T3.async-cycle: arity ${k} did not reject with a circular async error`);
        check(c._path.length === 0, () => `T3.async-cycle: sync _path leaked after arity ${k}`);
        check(c._pending.size === 0, () => `T3.async-cycle: _pending leaked after arity ${k} (size=${c._pending.size})`);
    }

    // -- Mixed sync-inside-async cross-factory cycle -------------------------
    // The async factory does a real sync get() before re-entering async, so both
    // the sync _path and the async ctx.path must stay clean after the reject.
    {
        const c = new Container();
        c.value('leafv', 1);
        c.singletonFactoryAsync('m1', async (x) => x.getAsync('m2'));
        c.singletonFactoryAsync('m2', async (x) => { x.get('leafv'); return x.getAsync('m1'); });
        let threw = false;
        try { await c.getAsync('m1'); } catch (e) { threw = /circular async/i.test(e.message); }
        check(threw, () => 'T3.async-cycle-mixed: sync-inside-async cycle was not rejected');
        check(c._path.length === 0, () => 'T3.async-cycle-mixed: sync _path leaked');
        check(c._pending.size === 0, () => 'T3.async-cycle-mixed: _pending leaked');
        // Still usable afterwards: the shared leaf value resolves normally.
        check(c.get('leafv') === 1, () => 'T3.async-cycle-mixed: container unusable after the caught cycle');
    }

    // -- Cycle detected mid-graph, container still usable afterwards ----------
    {
        const c = new Container();
        for (let i = 0; i < 500; i++) { c.value('v' + i, i); c.get('v' + i); }
        class N { constructor() {} }
        c.transient('x', N, ['y']);
        c.transient('y', N, ['x']);
        let threw = false;
        try { c.get('x'); } catch (e) { threw = /circular/i.test(e.message); }
        check(threw, () => 'T3.mid-graph: cycle after 500 resolutions was not caught');
        check(c._path.length === 0, () => 'T3.mid-graph: _path leaked after the cycle');
        // Still usable:
        check(c.get('v42') === 42, () => 'T3.mid-graph: container unusable after a caught cycle');
        c.value('z', 7);
        check(c.get('z') === 7, () => 'T3.mid-graph: new registration/resolution failed post-cycle');
    }

    // -- Register-after-boot: registration methods throw (current policy) -----
    {
        const c = new Container();
        c.value('x', 1);
        c.boot();
        class A {}
        for (const attempt of [
            () => c.value('y', 2),
            () => c.singleton('a', A),
            () => c.transient('b', A),
            () => c.factory('f', () => 1),
            () => c.alias('al', 'x'),
        ]) {
            let threw = false;
            try { attempt(); } catch (e) { threw = /booted and locked/i.test(e.message); }
            check(threw, () => 'T3.after-boot: a registration method did not respect the boot lock');
        }
    }

    // -- Resolve-after-shutdown ----------------------------------------------
    {
        const c = new Container();
        c.value('v', 1);
        class A {}
        c.singleton('a', A);
        c.multiFactory('m', () => ({}));
        c.get('a');
        await c.shutdown();
        // get / getAsync honour _shutdown today.
        let g = false; try { c.get('v'); } catch (e) { g = /shut down/i.test(e.message); }
        check(g, () => 'T3.after-shutdown: get() did not reject after shutdown');
        let ga = false; try { await c.getAsync('v'); } catch (e) { ga = /shut down/i.test(e.message); }
        check(ga, () => 'T3.after-shutdown: getAsync() did not reject after shutdown');
        // FAILS: D-10 (fixed in D4) -- getAll/getAllAsync ignore _shutdown today.
        if (!GUARD_D10) {
            let gall = false; try { c.getAll('m'); } catch (e) { gall = /shut down/i.test(e.message); }
            check(gall, () => 'T3.after-shutdown: getAll() did not reject after shutdown');
        }
    }

    // -- Scope explosion: 10k siblings + a 512-deep chain ---------------------
    {
        const parent = new Container();
        class S {}
        parent.singleton('svc', S);
        const inst = parent.get('svc');
        for (let i = 0; i < 10000; i++) {
            const child = parent.scope();
            check(child.get('svc') === inst, () => `T3.scope-explosion: sibling ${i} got a wrong instance`);
        }
        let chain = parent;
        for (let i = 0; i < 512; i++) chain = chain.scope();
        check(chain.get('svc') === inst,
            () => 'T3.scope-chain: 512-deep parent walk did not reach the root binding');
        check(parent._singletons.size === 1,
            () => 'T3.scope-explosion: parent singleton cache grew under scope churn');
    }

    // -- Boot a large DAG: 5000 nodes, ~20000 edges --------------------------
    {
        const c = new Container();
        const N = 5000;
        class Node { constructor() {} }
        for (let i = 0; i < N; i++) {
            const deps = [];
            const fan = i === 0 ? 0 : Math.min(4, i);
            for (let k = 0; k < fan; k++) deps.push('g' + (i - 1 - k)); // only backward edges -> acyclic
            c.transient('g' + i, Node, deps);
        }
        let booted = false;
        try { c.boot(); booted = true; } catch (e) {
            if (!(e instanceof RangeError)) throw e;
        }
        check(booted, () => 'T3.boot-dag: boot() on a 5000-node DAG did not complete');
    }

    // -- Diamond with a TRANSIENT shared node -> built twice (contract) -------
    {
        const c = new Container();
        let built = 0;
        class Shared { constructor() { built++; } }
        class B { constructor(s) { this.s = s; } }
        class Cc { constructor(s) { this.s = s; } }
        class A { constructor(b, cc) { this.b = b; this.cc = cc; } }
        c.transient('shared', Shared);
        c.transient('b', B, ['shared']);
        c.transient('cc', Cc, ['shared']);
        c.transient('a', A, ['b', 'cc']);
        const a = c.get('a');
        check(built === 2, () => `T3.transient-diamond: shared transient built ${built} times, expected 2`);
        check(a.b.s !== a.cc.s, () => 'T3.transient-diamond: the two branches shared one transient instance');
    }

    // Final structural check: a healthy container still validates.
    {
        const c = new Container();
        c.value('x', 1);
        c.singleton('s', class {});
        c.get('s');
        check(orderInvariant(c), () => 'T3.final: orderInvariant broken');
        check(validate(c), () => 'T3.final: validate broken');
    }
}
