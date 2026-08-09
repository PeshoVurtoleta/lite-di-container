/**
 * ContainerAsync.test.js -- the v2 asynchronous resolution surface.
 *
 * node:test + node:assert/strict, importing ../Container.js (D-01: the original
 * 2.0.0 draft mixed a CommonJS loader into an ESM file and never executed; this
 * file runs under the ESM loader).
 *
 * The two async findings live in the `known-broken (v2 proposal)` block:
 *   - D-02 cross-factory async cycle: recurses without producing the asserted
 *     trace. Marked { todo: true, timeout: 2000 } so it can never wedge the run.
 *   - D-03 concurrent async singletons double-build.
 * Removing `todo` makes each case FAIL against today's code.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../Container.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('DI Container (async)', () => {
    let container;

    beforeEach(() => {
        container = new Container();
    });

    // -- happy paths (passing) ---------------------------------------------

    it('getAsync() resolves an async factory', async () => {
        container.factoryAsync('id', async () => { await tick(); return 'ok'; });
        assert.equal(await container.getAsync('id'), 'ok');
    });

    it('getAsync() resolves async class dependencies', async () => {
        class Config { constructor() { this.port = 3000; } }
        class DB { constructor(cfg) { this.port = cfg.port; } }
        container.singleton('config', Config);
        container.singleton('db', DB, ['config']);
        const db = await container.getAsync('db');
        assert.equal(db.port, 3000);
    });

    it('singletonFactoryAsync() caches across sequential calls', async () => {
        let n = 0;
        container.singletonFactoryAsync('db', async () => { await tick(); n++; return { id: n }; });
        const a = await container.getAsync('db');
        const b = await container.getAsync('db');
        assert.equal(a, b);
        assert.equal(n, 1);
    });

    it('getAllAsync() returns every async instance', async () => {
        container.multiFactory('plugins', () => ({ a: 1 }));
        container.multiFactory('plugins', () => ({ b: 2 }));
        const all = await container.getAllAsync('plugins');
        assert.equal(all.length, 2);
        assert.deepEqual(all[0], { a: 1 });
        assert.deepEqual(all[1], { b: 2 });
    });

    it('bootAsync() eagerly builds async cached bindings', async () => {
        let built = 0;
        container.singletonFactoryAsync('db', async () => { await tick(); built++; return {}; });
        await container.bootAsync();
        assert.equal(built, 1);
    });

    it('getAsync() rejects for an unregistered service', async () => {
        await assert.rejects(container.getAsync('ghost'), /not registered/);
    });

    // sync/async caching-of-undefined symmetry (D3): a sync singletonFactory
    // returning undefined is cached, so the async lane must match.
    it('singletonFactoryAsync() caches an undefined result exactly once', async () => {
        let n = 0;
        container.singletonFactoryAsync('u', async () => { await tick(); n++; return undefined; });
        const a = await container.getAsync('u');
        const b = await container.getAsync('u');
        assert.equal(a, undefined);
        assert.equal(b, undefined);
        assert.equal(n, 1);
    });

    // A rejected build must not be cached as a poisoned promise (D-03 eviction).
    it('a rejecting singletonFactoryAsync is not cached -- a retry rebuilds', async () => {
        let n = 0;
        container.singletonFactoryAsync('flaky', async () => {
            await tick(); n++;
            if (n === 1) throw new Error('boom');
            return { id: n };
        });
        await assert.rejects(container.getAsync('flaky'), /boom/);
        const ok = await container.getAsync('flaky');
        assert.equal(ok.id, 2);
        assert.equal(n, 2);
    });

    // getAsync honours _shutdown (regression guard for D-10's async sibling).
    it('getAsync() rejects after shutdown()', async () => {
        container.value('v', 1);
        await container.shutdown();
        await assert.rejects(container.getAsync('v'), /shut down/i);
    });

    // ======================================================================
    //  known-broken (v2 proposal) -- see Container.test.js for the contract.
    // ======================================================================

    describe('known-broken (v2 proposal)', () => {
        it('D-02: cross-factory async cycle rejects with the full trace', { timeout: 2000 }, async () => {
            // A per-resolution context (decision 0002) is now carried across the
            // factory boundary, so a1 -> a2 -> a3 -> a1 is on ONE path and
            // rejects with the trace instead of recursing forever.
            container.singletonFactoryAsync('a1', async (c) => c.getAsync('a2'));
            container.singletonFactoryAsync('a2', async (c) => c.getAsync('a3'));
            container.singletonFactoryAsync('a3', async (c) => c.getAsync('a1'));
            // An unrelated tree resolved in the SAME Promise.all: its tokens must
            // NOT leak into tree A's cycle trace (per-resolution context).
            container.singletonFactoryAsync('b1', async (c) => c.getAsync('b2'));
            container.singletonFactoryAsync('b2', async () => 'b2-val');

            const results = await Promise.allSettled([
                container.getAsync('a1'),
                container.getAsync('b1'),
            ]);
            assert.equal(results[0].status, 'rejected');
            assert.match(results[0].reason.message, /a1 -> a2 -> a3 -> a1/);
            assert.doesNotMatch(results[0].reason.message, /b1|b2/);
            assert.equal(results[1].status, 'fulfilled');
            assert.equal(results[1].value, 'b2-val');
        });

        it('D-03: concurrent getAsync() of a singleton builds exactly once', async () => {
            for (const N of [2, 8, 64]) {
                const c = new Container();
                let builds = 0;
                c.singletonFactoryAsync('db', async () => { await tick(); builds++; return { id: builds }; });
                const calls = new Array(N);
                for (let i = 0; i < N; i++) calls[i] = c.getAsync('db');
                const results = await Promise.all(calls);
                assert.equal(builds, 1, `N=${N} built ${builds} times`);
                for (let i = 1; i < N; i++) assert.equal(results[i], results[0], `N=${N} instance ${i}`);
            }
        });

        it('D-03: bootAsync() constructs a shared async singleton exactly once under concurrency', async () => {
            let dbBuilds = 0;
            container.singletonFactoryAsync('db', async () => { await tick(); dbBuilds++; return { id: dbBuilds }; });
            // Two async singletons that both resolve 'db'; bootAsync fires them
            // in one Promise.all, so both hit 'db' concurrently and miss the
            // post-await memoization -> 'db' is built twice.
            container.singletonFactoryAsync('a', async (c) => ({ db: await c.getAsync('db') }));
            container.singletonFactoryAsync('b', async (c) => ({ db: await c.getAsync('db') }));
            await container.bootAsync();
            assert.equal(dbBuilds, 1);
        });

        it('D-10: getAllAsync() rejects resolution after shutdown()', async () => {
            container.multiFactory('m', () => ({ live: true }));
            await container.shutdown();
            await assert.rejects(() => container.getAllAsync('m'), /shut down/i);
        });
    });
});
