/**
 * Container.describe.test.js -- dedicated describe() BOUNDARY suite (2.1.0).
 *
 * The happy-path describe() assertions (A-DESC-1..4) live in Container.test.js.
 * This file COVERS THE GAPS the happy path misses: snapshot isolation/retention,
 * lifecycle edges (post-shutdown / empty / re-entrant-during-teardown), order
 * truthfulness under richer shapes (singletonFactory + async factory + alias
 * chain + multi + diamond), node/edge fidelity, and the fail-closed pre-boot
 * message. node:test + node:assert/strict only -- no external dependency.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Container, TYPES } from '../Container.js';

class A {}
class B { constructor(a) { this.a = a; } }
class C { constructor(a) { this.a = a; } }
class D { constructor(b, c) { this.b = b; this.c = c; } }

describe('describe() boundary suite', () => {
    let container;
    beforeEach(() => { container = new Container(); });

    // =====================================================================
    //  Snapshot isolation (retention / corruption)
    // =====================================================================
    describe('snapshot isolation', () => {
        it('mutating the returned nodes array (splice) does not affect the container or a later call', () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();

            const snap = container.describe();
            const nodesBefore = snap.nodes.length;
            snap.nodes.splice(0, snap.nodes.length); // wipe the caller's copy
            assert.equal(snap.nodes.length, 0);

            const snap2 = container.describe();
            assert.equal(snap2.nodes.length, nodesBefore); // container unaffected
            assert.equal(container._registry.size, 2);     // registry unaffected
        });

        it('mutating the returned edges array (push) does not leak into a later call', () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();

            const snap = container.describe();
            const edgesBefore = snap.edges.length;
            snap.edges.push({ from: 'GHOST', to: 'GHOST' });

            const snap2 = container.describe();
            assert.equal(snap2.edges.length, edgesBefore);
            assert.equal(snap2.edges.some((e) => e.from === 'GHOST'), false);
        });

        it("mutating a node's deps array (push) does not corrupt the container or a later call", () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();

            const snap = container.describe();
            const bNode = snap.nodes.find((n) => n.token === 'b');
            bNode.deps.push('INJECTED');
            assert.deepEqual(bNode.deps, ['a', 'INJECTED']);

            // The container's registry entry is untouched...
            assert.deepEqual(container._registry.get('b').deps, ['a']);
            // ...and a fresh describe() returns the pristine deps.
            const snap2 = container.describe();
            assert.deepEqual(snap2.nodes.find((n) => n.token === 'b').deps, ['a']);
        });

        it('two describe() calls return independent object graphs (fresh arrays, deep-equal content)', () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();

            const s1 = container.describe();
            const s2 = container.describe();

            assert.notEqual(s1, s2);
            assert.notEqual(s1.nodes, s2.nodes);
            assert.notEqual(s1.edges, s2.edges);
            assert.notEqual(s1.order, s2.order);
            // deps arrays are per-call copies too.
            assert.notEqual(
                s1.nodes.find((n) => n.token === 'b').deps,
                s2.nodes.find((n) => n.token === 'b').deps
            );
            assert.deepEqual(s1, s2); // but identical content
        });

        it('ADVERSARIAL: mutating the live registry deps AFTER a snapshot does not retro-corrupt that snapshot (point-in-time copy)', () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();

            const s1 = container.describe();
            const bDepsBefore = s1.nodes.find((n) => n.token === 'b').deps.slice();

            // Reach into the container and mutate the SAME array the entry holds.
            container._registry.get('b').deps.push('LATE');

            // The already-returned snapshot is frozen at its call time.
            assert.deepEqual(s1.nodes.find((n) => n.token === 'b').deps, bDepsBefore);
            // A fresh describe() reflects the new live state (proves it reads live,
            // yet each snapshot is an isolated copy).
            const s2 = container.describe();
            assert.deepEqual(s2.nodes.find((n) => n.token === 'b').deps, ['a', 'LATE']);
        });
    });

    // =====================================================================
    //  Lifecycle edges
    // =====================================================================
    describe('lifecycle edges', () => {
        it('empty booted container returns {nodes:[],edges:[],order:[]}', () => {
            container.boot();
            const snap = container.describe();
            assert.deepEqual(snap, { nodes: [], edges: [], order: [] });
        });

        it('single registration (N=1) yields exactly one node and an empty order for a VALUE', () => {
            container.value('cfg', 1);
            container.boot();
            const snap = container.describe();
            assert.equal(snap.nodes.length, 1);
            assert.equal(snap.nodes[0].token, 'cfg');
            assert.deepEqual(snap.order, []); // value is never cached/torn down
        });

        it('post-shutdown describe() does NOT crash and stays consistent with the retained registry (recompute contract)', async () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();
            container.get('b');
            await container.shutdown();

            // shutdown() releases instances + _resolutionOrder but KEEPS _registry
            // (the wiring is still described). _booted stays true, so describe()
            // fails closed only pre-boot -- here it returns the pristine wiring.
            assert.equal(container.isBooted, true);
            assert.equal(container._resolutionOrder.length, 0);

            const snap = container.describe();
            assert.equal(snap.nodes.length, 2);
            // order is RECOMPUTED from the wiring (not read from the now-empty
            // _resolutionOrder) -- same as post-boot/pre-resolve. This is the
            // documented recompute contract, not a lie about live instances.
            assert.deepEqual(snap.order, ['a', 'b']);
            assert.ok(snap.order.indexOf('a') < snap.order.indexOf('b'));
        });

        it("RE-ENTRANT: describe() called from inside a teardown hook (state DRAINING) returns a valid snapshot and does not corrupt shutdown", async () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();
            container.get('b');

            let reentrantOrder = null;
            let reentrantNodes = -1;
            container.onTeardown('b', () => {
                // _booted is still true and _state is DRAINING here.
                const snap = container.describe();
                reentrantOrder = snap.order.slice();
                reentrantNodes = snap.nodes.length;
            });

            await container.shutdown();
            assert.equal(reentrantNodes, 2);
            assert.deepEqual(reentrantOrder, ['a', 'b']);
            // shutdown still completed and released state.
            assert.equal(container._singletons.size, 0);
            assert.equal(container._resolutionOrder.length, 0);
        });
    });

    // =====================================================================
    //  Order truthfulness under richer shapes
    // =====================================================================
    describe('order truthfulness', () => {
        it('singletonFactory (cached) is in order; plain factory and async factory are NOT; order == _resolutionOrder', async () => {
            container.singletonFactory('sf', () => ({ kind: 'sf' })); // cached
            container.factoryAsync('fa', async () => ({ kind: 'fa' })); // async, not cached
            container.factory('pf', () => ({ kind: 'pf' }));            // plain, not cached
            container.alias('a2', 'sf');                               // alias chain a1->a2->sf
            container.alias('a1', 'a2');
            container.multi('m', A);                                   // multi, always cached
            container.multi('m', B, ['sf']);
            container.boot();

            // Resolve the whole graph.
            container.get('sf');
            await container.getAsync('fa');
            container.get('pf');
            container.get('a1'); // resolves through the alias chain to cached sf
            container.getAll('m');

            const snap = container.describe();
            assert.deepEqual(snap.order, container._resolutionOrder);

            assert.equal(snap.order.includes('sf'), true);   // cached factory
            assert.equal(snap.order.includes('m'), true);    // multi always cached
            assert.equal(snap.order.includes('fa'), false);  // async factory not cached
            assert.equal(snap.order.includes('pf'), false);  // plain factory not cached
            assert.equal(snap.order.includes('a1'), false);  // alias never torn down
            assert.equal(snap.order.includes('a2'), false);
        });

        it('alias chain (a1 -> a2 -> a3 -> value) emits one edge per hop and no alias appears in order', () => {
            container.value('real', 7);
            container.alias('a3', 'real');
            container.alias('a2', 'a3');
            container.alias('a1', 'a2');
            container.boot();

            const snap = container.describe();
            for (const [from, to] of [['a1', 'a2'], ['a2', 'a3'], ['a3', 'real']]) {
                const hops = snap.edges.filter((e) => e.from === from && e.to === to);
                assert.equal(hops.length, 1, `exactly one ${from}->${to} edge`);
            }
            assert.equal(snap.order.includes('a1'), false);
            assert.equal(snap.order.includes('a2'), false);
            assert.equal(snap.order.includes('a3'), false);
            assert.equal(snap.order.includes('real'), false); // value, never cached
        });

        it('DIAMOND (A->B, A->C, B->D, C->D) yields a valid topo order with D exactly once, no throw', () => {
            container.singleton('D', A);          // leaf, no deps
            container.singleton('B', B, ['D']);   // B -> D
            container.singleton('C', C, ['D']);   // C -> D (shared)
            container.singleton('A', D, ['B', 'C']); // A -> B, A -> C
            container.boot();

            let snap;
            assert.doesNotThrow(() => { snap = container.describe(); });
            const order = snap.order;

            assert.equal(order.filter((t) => t === 'D').length, 1, 'D appears exactly once');
            // A dependency precedes its dependents.
            assert.ok(order.indexOf('D') < order.indexOf('B'));
            assert.ok(order.indexOf('D') < order.indexOf('C'));
            assert.ok(order.indexOf('B') < order.indexOf('A'));
            assert.ok(order.indexOf('C') < order.indexOf('A'));
            // Every diamond node is cached -> all four are present.
            assert.deepEqual(order.slice().sort(), ['A', 'B', 'C', 'D']);
        });
    });

    // =====================================================================
    //  Node / edge fidelity
    // =====================================================================
    describe('node/edge fidelity', () => {
        it('every ALIAS emits exactly one edge to its target and carries target', () => {
            container.value('real', 1);
            container.singleton('svc', A);
            container.alias('n1', 'real');
            container.alias('n2', 'svc');
            container.boot();

            const snap = container.describe();
            for (const [aliasTok, target] of [['n1', 'real'], ['n2', 'svc']]) {
                const node = snap.nodes.find((n) => n.token === aliasTok);
                assert.equal(node.kind, TYPES.ALIAS);
                assert.equal(node.target, target);
                assert.deepEqual(node.deps, []);
                const edges = snap.edges.filter((e) => e.from === aliasTok);
                assert.equal(edges.length, 1);
                assert.equal(edges[0].to, target);
            }
        });

        it('every VALUE and FACTORY node has opaqueDeps:true and empty deps, and emits no edge', () => {
            container.value('v', { any: 'thing' });
            container.factory('f', () => ({}));
            container.singletonFactory('sf', () => ({}));
            container.boot();

            const snap = container.describe();
            for (const tok of ['v', 'f', 'sf']) {
                const node = snap.nodes.find((n) => n.token === tok);
                assert.equal(node.opaqueDeps, true, `${tok} opaqueDeps`);
                assert.deepEqual(node.deps, [], `${tok} deps empty`);
                assert.equal(snap.edges.some((e) => e.from === tok), false, `${tok} no edges`);
            }
        });

        it('VALUE nodes for null / undefined / NaN / -0 values do not choke describe() (opaque, absent from order)', () => {
            container.value('vnull', null);
            container.value('vundef', undefined);
            container.value('vnan', NaN);
            container.value('vnegzero', -0);
            container.boot();

            let snap;
            assert.doesNotThrow(() => { snap = container.describe(); });
            for (const tok of ['vnull', 'vundef', 'vnan', 'vnegzero']) {
                const node = snap.nodes.find((n) => n.token === tok);
                assert.equal(node.kind, TYPES.VALUE);
                assert.equal(node.opaqueDeps, true);
                assert.equal(snap.order.includes(tok), false);
            }
        });

        it('every edge endpoint references a real node token (no dangling from/to)', () => {
            container.value('cfg', 1);
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.singleton('d', D, ['a', 'b']);
            container.alias('nick', 'a');
            container.boot();

            const snap = container.describe();
            const tokens = new Set(snap.nodes.map((n) => n.token));
            assert.ok(snap.edges.length > 0);
            for (const e of snap.edges) {
                assert.ok(tokens.has(e.from), `edge.from ${String(e.from)} is a node`);
                assert.ok(tokens.has(e.to), `edge.to ${String(e.to)} is a node`);
            }
        });

        it('a multi with several entries (N=3) emits exactly N nodes for that token', () => {
            container.multi('plugins', A);
            container.multi('plugins', B, ['x']);
            container.multi('plugins', C, ['x']);
            container.value('x', 1);
            container.boot();

            const snap = container.describe();
            const pluginNodes = snap.nodes.filter((n) => n.token === 'plugins');
            assert.equal(pluginNodes.length, 3);
            // node count == _registry.size + multi entries.
            let multiEntries = 0;
            for (const [, entries] of container._multiRegistry) multiEntries += entries.length;
            assert.equal(snap.nodes.length, container._registry.size + multiEntries);
        });
    });

    // =====================================================================
    //  Fail closed
    // =====================================================================
    describe('fail closed', () => {
        it('pre-boot describe() throws with the documented "boot() first" message', () => {
            container.value('cfg', 1);
            assert.equal(container.isBooted, false);
            assert.throws(() => container.describe(), (err) => {
                assert.match(err.message, /not booted/i);
                assert.match(err.message, /boot\(\) first/);
                return true;
            });
        });

        it('a forced-past-boot cycle fails closed with a throw (never hangs)', () => {
            container.singleton('x', B, ['y']);
            container.singleton('y', C, ['x']);
            assert.throws(() => container.boot(), /circular/i);
            container._booted = true; // force past the boot guard
            assert.throws(() => container.describe(), /circular/i);
        });
    });
});
