/**
 * T4 -- lifecycle and handle abuse (D-10, D-12, D-13, D-14).
 *
 * Double shutdown, shutdown of a never-resolved container, shutdown while a
 * resolution is in flight, teardown isolation + reporting (AggregateError, never
 * console), a teardown that resolves a cached collaborator during DRAINING,
 * onTeardown for unknown / doubly-registered names, unregister mid-resolution,
 * reset()/clear() around shutdown, the boot lock (D-14), parent/child scope
 * teardown ordering and the live-child guard, and the undefined multi-slot path.
 *
 * The whole tier runs under a console counter: Container.js must NEVER call
 * console.* (D-12). The counter is asserted zero at the end -- that is the
 * no-console proof.
 *
 * After every case: validate(c) passes and retention(c) matches the pinned
 * expectation. The D4 fixes land here, so the earlier `// FAILS: D-1x` guards
 * are gone.
 */

import { Container, TYPES } from '../../Container.js';
import { check, retention, validate } from './harness.mjs';

export async function run() {
    // Container.js must never touch console. Stub the whole surface and count.
    const _err = console.error, _warn = console.warn, _log = console.log,
        _info = console.info, _debug = console.debug;
    let consoleCalls = 0;
    const bump = () => { consoleCalls++; };
    console.error = bump; console.warn = bump; console.log = bump;
    console.info = bump; console.debug = bump;

    try {
        // -- Double shutdown is a no-op --------------------------------------
        {
            const c = new Container();
            let torn = 0;
            class A {}
            c.singleton('a', A);
            c.onTeardown('a', () => { torn++; });
            c.get('a');
            await c.shutdown();
            await c.shutdown();
            check(torn === 1, () => `T4.double-shutdown: teardown ran ${torn} times, expected 1`);
            const r = retention(c);
            check(r.singletons === 0 && r.order === 0 && r.teardowns === 0,
                () => 'T4.double-shutdown: state not released');
        }

        // -- Shutdown of a never-resolved container --------------------------
        {
            const c = new Container();
            class A {}
            c.singleton('a', A); // registered, never resolved
            let ok = true;
            try { await c.shutdown(); } catch { ok = false; }
            check(ok, () => 'T4.never-resolved: shutdown() on an unresolved container threw');
        }

        // -- Shutdown while an async resolution is in flight -----------------
        {
            const c = new Container();
            c.singletonFactoryAsync('slow', async () => {
                await new Promise((r) => setTimeout(r, 15));
                return { ok: true };
            });
            const p = c.getAsync('slow');   // in flight
            await c.shutdown();             // completes before the 15ms timer
            let val; try { val = await p; } catch (e) { val = e; }
            const r = retention(c);
            check(r.singletons === 0 && r.order === 0,
                () => `T4.in-flight: shutdown() while resolving resurrected state ${JSON.stringify(r)}`);
        }

        // -- Teardown isolation + reporting (D-12): a thrower does not block --
        // its siblings AND surfaces in an AggregateError. Never console.
        {
            const c = new Container();
            const torn = [];
            class A {} class B {} class D {}
            c.singleton('a', A); c.singleton('b', B); c.singleton('d', D);
            c.onTeardown('a', () => { torn.push('a'); });
            c.onTeardown('b', () => { throw new Error('b fails'); });
            c.onTeardown('d', () => { torn.push('d'); });
            c.get('a'); c.get('b'); c.get('d');
            let rejected = null;
            try { await c.shutdown(); } catch (e) { rejected = e; }
            check(torn.indexOf('a') !== -1 && torn.indexOf('d') !== -1,
                () => 'T4.isolation: a sibling teardown was skipped when one threw');
            check(rejected instanceof AggregateError,
                () => 'T4.isolation: shutdown() did not reject with an AggregateError (D-12)');
            check(rejected !== null && rejected.errors.length === 1 &&
                /b fails/.test(rejected.errors[0].message),
                () => 'T4.isolation: the failing teardown did not surface in the AggregateError');
            const r = retention(c);
            check(r.singletons === 0 && r.order === 0 && r.teardowns === 0,
                () => 'T4.isolation: a rejecting shutdown() still must release state');
        }

        // -- onTeardownError hook suppresses the AggregateError --------------
        {
            const c = new Container();
            class A {} class B {}
            c.singleton('a', A); c.singleton('b', B);
            c.onTeardown('a', () => { throw new Error('a boom'); });
            c.get('a'); c.get('b');
            const seen = [];
            let threw = false;
            try {
                await c.shutdown({ onTeardownError: (err, name) => seen.push(name + ':' + err.message) });
            } catch { threw = true; }
            check(!threw, () => 'T4.hook: shutdown() rejected despite an onTeardownError hook');
            check(seen.length === 1 && seen[0] === 'a:a boom',
                () => `T4.hook: onTeardownError not invoked correctly (${JSON.stringify(seen)})`);
        }

        // -- A teardown that resolves a cached collaborator (D-12) -----------
        {
            const c = new Container();
            class Logger { flush() { this.flushed = true; } }
            c.singleton('logger', Logger);
            const logger = c.get('logger');
            class Svc {}
            c.singleton('svc', Svc);
            c.get('svc');
            let ran = false;
            c.onTeardown('svc', () => { c.get('logger').flush(); ran = true; });
            await c.shutdown();
            // DRAINING permits the cached hit, so the collaborator resolves.
            check(ran === true,
                () => 'T4.collaborator: teardown could not resolve its cached collaborator during drain');
            check(logger.flushed === true,
                () => 'T4.collaborator: the cached collaborator was not flushed');
        }

        // -- A teardown that tries NEW construction during drain is rejected --
        {
            const c = new Container();
            class Svc {}
            class Fresh {}
            c.singleton('svc', Svc);
            c.singleton('fresh', Fresh); // registered, NEVER resolved
            c.get('svc');
            c.onTeardown('svc', () => { c.get('fresh'); }); // build during teardown
            let rejected = null;
            try { await c.shutdown(); } catch (e) { rejected = e; }
            check(rejected instanceof AggregateError,
                () => 'T4.drain-construct: building during teardown was not reported');
            check(/draining/i.test(rejected.errors[0].message),
                () => 'T4.drain-construct: expected a draining error, got ' + rejected.errors[0].message);
        }

        // -- onTeardown for an unregistered name is a documented no-op -------
        {
            const c = new Container();
            c.onTeardown('ghost', () => { throw new Error('should never fire'); });
            let ok = true;
            try { await c.shutdown(); } catch { ok = false; }
            check(ok, () => 'T4.unknown-teardown: a teardown for an unresolved name fired or threw');
        }

        // -- onTeardown registered twice: last one wins ----------------------
        {
            const c = new Container();
            const fired = [];
            class A {}
            c.singleton('a', A);
            c.get('a');
            c.onTeardown('a', () => { fired.push('first'); });
            c.onTeardown('a', () => { fired.push('second'); });
            await c.shutdown();
            check(fired.length === 1 && fired[0] === 'second',
                () => `T4.double-teardown: expected only 'second', got ${JSON.stringify(fired)}`);
        }

        // -- unregister mid-resolution from inside a factory -----------------
        {
            const c = new Container();
            class A {}
            c.value('tmp', 1);
            c.singletonFactory('a', (cc) => { cc.unregister('tmp'); return new A(); });
            let ok = true;
            try { c.get('a'); } catch { ok = false; }
            check(ok, () => 'T4.unregister-mid: unregister() from inside a factory threw');
            check(c.has('tmp') === false,
                () => 'T4.unregister-mid: the mid-resolution unregister did not take effect');
            check(validate(c), () => 'T4.unregister-mid: validate() broke after a mid-resolution unregister');
        }

        // -- reset() between get() and shutdown() ----------------------------
        {
            const c = new Container();
            let torn = 0;
            class A {}
            c.singleton('a', A);
            c.onTeardown('a', () => { torn++; });
            c.get('a');
            c.reset(); // drops the singleton cache and resolution order
            await c.shutdown();
            check(torn === 0, () => `T4.reset-shutdown: teardown ran ${torn} times after reset(), expected 0`);
            check(retention(c).order === 0, () => 'T4.reset-shutdown: resolution order not cleared by reset()');
        }

        // -- clear() after shutdown() ----------------------------------------
        {
            const c = new Container();
            class A {}
            c.singleton('a', A);
            c.get('a');
            await c.shutdown();
            let ok = true;
            try { c.clear(); } catch { ok = false; }
            check(ok, () => 'T4.clear-after-shutdown: clear() threw after shutdown()');
            const r = retention(c);
            check(r.registry === 0 && r.singletons === 0 && r.order === 0,
                () => 'T4.clear-after-shutdown: clear() did not release state');
        }

        // -- Boot lock (D-14): keep the lock, fail closed --------------------
        {
            const c = new Container();
            c.value('x', 1);
            c.boot();
            let unregLocked = false;
            try { c.unregister('x'); } catch (e) { unregLocked = /booted and locked/i.test(e.message); }
            check(unregLocked, () => 'T4.boot-lock: unregister() on a booted container was not locked');
            let clearLocked = false;
            try { c.clear(); } catch (e) { clearLocked = /booted and locked/i.test(e.message); }
            check(clearLocked, () => 'T4.boot-lock: clear() on a booted container was not locked');
            // The documented swap flow: reset() first.
            c.reset();
            let ok = true;
            try { c.unregister('x'); c.value('x', 2); c.boot(); } catch { ok = false; }
            check(ok && c.get('x') === 2, () => 'T4.boot-lock: reset()-then-swap flow did not work');
        }

        // -- Child scope shut down before its parent -------------------------
        {
            const parent = new Container();
            class S {}
            parent.singleton('svc', S);
            parent.get('svc');
            const child = parent.scope();
            class C {}
            child.singleton('cs', C);
            child.get('cs');
            let ok = true;
            try {
                await child.shutdown();   // child first -> detaches from parent
                await parent.shutdown();  // then parent -> no live child
            } catch { ok = false; }
            check(ok, () => 'T4.scope-teardown: child-then-parent shutdown threw');
            check(retention(child).singletons === 0 && retention(parent).singletons === 0,
                () => 'T4.scope-teardown: child-then-parent did not reach zero retention');
        }

        // -- Parent shut down while a child is live (D-13): named throw ------
        {
            const parent = new Container();
            class S {}
            parent.singleton('svc', S);
            parent.get('svc');
            const child = parent.scope();
            class C {}
            child.singleton('cs', C);
            child.get('cs');
            let guarded = false;
            try { await parent.shutdown(); } catch (e) { guarded = /child scope\(s\) still live/i.test(e.message); }
            check(guarded, () => 'T4.parent-first: parent.shutdown() with a live child did not throw the live-child guard');
            // Parent stayed usable: drain child, then parent, both reach zero.
            await child.shutdown();
            await parent.shutdown();
            check(retention(parent).singletons === 0 && retention(parent).order === 0,
                () => 'T4.parent-first: parent did not release after the child drained');
        }

        // -- Teardown of an undefined multi-binding slot (flags path) --------
        {
            const c = new Container();
            c.multiFactory('m', () => undefined);
            c.getAll('m');
            let ok = true;
            try { await c.shutdown(); } catch { ok = false; }
            check(ok, () => 'T4.undef-slot: shutdown() tripped on an undefined multi slot');
            const r = retention(c);
            check(r.singletons === 0 && r.flags === 0 && r.order === 0,
                () => 'T4.undef-slot: multi state not released on shutdown');
        }

        // -- invalidate(): flush + rebuild, has() stays true (decision 0005) --
        {
            const c = new Container();
            let n = 0;
            class Svc { constructor() { this.id = ++n; } }
            const torn = [];
            c.singleton('svc', Svc);
            c.onTeardown('svc', (inst) => { torn.push(inst.id); });
            c.boot();
            const a = c.get('svc');
            await c.invalidate('svc');
            check(c.has('svc') === true, () => 'T4.invalidate: has() went false after invalidate()');
            const b = c.get('svc');
            check(a.id === 1 && b.id === 2 && a !== b,
                () => `T4.invalidate: get() did not return a NEW instance (a=${a.id} b=${b.id})`);
            check(torn.length === 1 && torn[0] === 1,
                () => `T4.invalidate: the flushed instance did not run its teardown (${JSON.stringify(torn)})`);
            check(c._resolutionOrder.length === 1 && validate(c),
                () => `T4.invalidate: resolution order corrupted (len=${c._resolutionOrder.length})`);
        }

        // -- invalidate() fails closed: non-live / mid-resolution / unknown --
        {
            const c = new Container();
            class Svc {}
            c.singleton('svc', Svc);
            c.boot();
            c.get('svc');
            await c.shutdown();
            let nonLive = false;
            try { await c.invalidate('svc'); } catch (e) { nonLive = /not live/i.test(e.message); }
            check(nonLive, () => 'T4.invalidate-guard: invalidate() on a shut-down container did not throw');

            const c2 = new Container();
            c2.boot();
            let unknown = false;
            try { await c2.invalidate('ghost'); } catch (e) { unknown = /not registered/i.test(e.message); }
            check(unknown, () => 'T4.invalidate-guard: invalidate() of an unregistered name did not throw');

            const c3 = new Container();
            let pending = null;
            c3.singletonFactory('a', (cc) => { pending = cc.invalidate('a'); return {}; });
            c3.boot();
            c3.get('a');
            let midRes = false;
            try { await pending; } catch (e) { midRes = /mid-resolution/i.test(e.message); }
            check(midRes, () => 'T4.invalidate-guard: mid-resolution invalidate() did not throw');
        }

        // -- rebind(): atomic swap, and untouched-on-failure (decision 0005) --
        {
            const c = new Container();
            class Old { constructor() { this.v = 'old'; } }
            class New { constructor() { this.v = 'new'; } }
            c.singleton('svc', Old);
            c.boot();
            check(c.get('svc').v === 'old', () => 'T4.rebind: pre-rebind get() wrong');
            await c.rebind('svc', { type: TYPES.SINGLETON, Class: New, deps: [], isAsync: false, isCached: true });
            check(c.get('svc').v === 'new', () => 'T4.rebind: get() did not build from the rebound entry');
            check(c._resolutionOrder.length === 1 && validate(c),
                () => 'T4.rebind: resolution order corrupted by rebind');

            // A rebind that would introduce a cycle throws, registry UNTOUCHED.
            const c2 = new Container();
            class A {} class B {}
            c2.singleton('a', A, ['b']);
            c2.singleton('b', B, []);
            c2.boot();
            const before = c2._registry.get('b');
            let cyc = false;
            try {
                await c2.rebind('b', { type: TYPES.SINGLETON, Class: B, deps: ['a'], isAsync: false, isCached: true });
            } catch (e) { cyc = /circular/i.test(e.message); }
            check(cyc, () => 'T4.rebind: a cycle-introducing rebind did not throw');
            check(c2._registry.get('b') === before,
                () => 'T4.rebind: a failed rebind mutated the registry (not atomic)');

            // A rebind with a missing dep throws, registry UNTOUCHED.
            const c3 = new Container();
            c3.singleton('svc', Old);
            c3.boot();
            const before3 = c3._registry.get('svc');
            let missing = false;
            try {
                await c3.rebind('svc', { type: TYPES.SINGLETON, Class: New, deps: ['nope'], isAsync: false, isCached: true });
            } catch (e) { missing = /not registered/i.test(e.message); }
            check(missing, () => 'T4.rebind: a missing-dep rebind did not throw');
            check(c3._registry.get('svc') === before3,
                () => 'T4.rebind: a failed missing-dep rebind mutated the registry');

            // A kind change (multi -> single) throws.
            const c4 = new Container();
            class P {}
            c4.multi('m', P);
            c4.boot();
            let kind = false;
            try {
                await c4.rebind('m', { type: TYPES.SINGLETON, Class: P, deps: [], isAsync: false, isCached: true });
            } catch (e) { kind = /multi binding/i.test(e.message); }
            check(kind, () => 'T4.rebind: a kind-change rebind did not throw');
        }

        // -- A healthy container still validates after the whole tier --------
        {
            const c = new Container();
            c.value('x', 1);
            c.singleton('s', class {});
            c.get('s');
            check(validate(c), () => 'T4.final: validate broken');
        }
    } finally {
        console.error = _err; console.warn = _warn; console.log = _log;
        console.info = _info; console.debug = _debug;
    }

    // The no-console proof (D-12): Container.js never called console.* across
    // the entire tier. die() and check() write to process.stderr, not console.
    check(consoleCalls === 0,
        () => `T4.no-console: Container.js wrote to console ${consoleCalls} time(s) during the tier`);
}
