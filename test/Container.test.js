/**
 * Container.test.js -- DI Container tests (v2 public API).
 *
 * Ported from the published v1 test suite to node:test + node:assert/strict
 * and adapted to the v2 surface: named { Container, TYPES, VERSION } import,
 * integer TYPES, ASCII ' -> ' cycle traces, no fluent chaining.
 *
 * Every finding D-07..D-17 and D-20 that has a synchronous witness lives in the
 * `known-broken (v2 proposal)` block as a { todo: true } case named with its ID.
 * Each is written so that removing `todo` makes it FAIL against today's code.
 * The async findings (D-02, D-03) live in ContainerAsync.test.js.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Container, TYPES, VERSION } from '../Container.js';

const PKG_VERSION = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url))
).version;

describe('DI Container', () => {
    let container;

    beforeEach(() => {
        container = new Container();
    });

    // -- value() ------------------------------------------------------------

    describe('value()', () => {
        it('returns the registered object as-is', () => {
            const config = { port: 3000 };
            container.value('config', config);
            assert.equal(container.get('config'), config);
        });

        it('returns the same reference every time', () => {
            const obj = { key: 'val' };
            container.value('obj', obj);
            assert.equal(container.get('obj'), container.get('obj'));
        });

        it('handles primitives', () => {
            container.value('port', 3000);
            container.value('name', 'app');
            container.value('debug', false);
            assert.equal(container.get('port'), 3000);
            assert.equal(container.get('name'), 'app');
            assert.equal(container.get('debug'), false);
        });

        it('handles null', () => {
            container.value('empty', null);
            assert.equal(container.get('empty'), null);
        });
    });

    // -- singleton() --------------------------------------------------------

    describe('singleton()', () => {
        it('creates one instance on first get() (lazy)', () => {
            let callCount = 0;
            class DB { constructor() { callCount++; } }

            container.singleton('db', DB);
            assert.equal(callCount, 0);

            container.get('db');
            assert.equal(callCount, 1);

            container.get('db');
            assert.equal(callCount, 1);
        });

        it('returns the same instance every time', () => {
            class Cache {}
            container.singleton('cache', Cache);
            assert.equal(container.get('cache'), container.get('cache'));
        });

        it('injects resolved dependencies', () => {
            const config = { host: 'localhost' };
            class DB { constructor(cfg) { this.config = cfg; } }

            container.value('config', config);
            container.singleton('db', DB, ['config']);

            assert.equal(container.get('db').config, config);
        });
    });

    // -- transient() --------------------------------------------------------

    describe('transient()', () => {
        it('creates a new instance every get()', () => {
            class Logger {}
            container.transient('logger', Logger);

            const a = container.get('logger');
            const b = container.get('logger');
            assert.notEqual(a, b);
            assert.ok(a instanceof Logger);
        });

        it('injects dependencies into each instance', () => {
            class Formatter { format(s) { return s.toUpperCase(); } }
            class Logger { constructor(fmt) { this.formatter = fmt; } }

            container.singleton('formatter', Formatter);
            container.transient('logger', Logger, ['formatter']);

            const logger = container.get('logger');
            assert.ok(logger.formatter instanceof Formatter);
        });
    });

    // -- factory() ----------------------------------------------------------

    describe('factory()', () => {
        it('calls the function on every get()', () => {
            let n = 0;
            container.factory('counter', () => ++n);
            assert.equal(container.get('counter'), 1);
            assert.equal(container.get('counter'), 2);
        });

        it('receives the container as an argument', () => {
            container.value('secret', '42');
            container.factory('wrapped', (c) => ({ val: c.get('secret') }));
            assert.equal(container.get('wrapped').val, '42');
        });

        it('detects self-referencing factory (circular)', () => {
            container.factory('loop', (c) => c.get('loop'));
            // v2 emits an ASCII ' -> ' trace (v1 used U+2192).
            assert.throws(() => container.get('loop'), /circular.*loop -> loop/i);
        });

        it('detects factory -> service -> factory cycle', () => {
            class B { constructor(a) {} }
            container.factory('a', (c) => c.get('b'));
            container.transient('b', B, ['a']);

            assert.throws(() => container.get('a'), /circular/i);
        });

        it('detects factory -> factory cycle', () => {
            container.factory('ping', (c) => c.get('pong'));
            container.factory('pong', (c) => c.get('ping'));

            assert.throws(() => container.get('ping'), /circular.*ping -> pong -> ping/i);
        });
    });

    // -- has() --------------------------------------------------------------

    describe('has()', () => {
        it('returns true for registered services', () => {
            container.value('x', 1);
            assert.equal(container.has('x'), true);
        });

        it('returns false for unknown services', () => {
            assert.equal(container.has('ghost'), false);
        });
    });

    // -- Error handling -----------------------------------------------------

    describe('error handling', () => {
        it('throws on get() for unregistered service', () => {
            assert.throws(() => container.get('nope'), /not registered/);
        });

        it('rejects non-constructable definitions for singleton', () => {
            // v2 message: "'bad' must be a constructable class." (v1 differed).
            assert.throws(() => container.singleton('bad', { plain: 'object' }), /constructable class/);
        });

        it('rejects non-constructable definitions for transient', () => {
            assert.throws(() => container.transient('bad', 'a string'), /constructable class/);
        });
    });

    // -- Arrow function guard ----------------------------------------------

    describe('arrow function guard', () => {
        it('rejects arrow functions for singleton', () => {
            // v2 rejects via the .prototype heuristic with a generic message.
            assert.throws(() => container.singleton('bad', () => {}), /constructable class/);
        });

        it('rejects arrow functions for transient', () => {
            assert.throws(() => container.transient('bad', (a, b) => a + b), /constructable class/);
        });

        it('accepts regular function constructors', () => {
            function OldSchool(cfg) { this.cfg = cfg; }
            container.value('cfg', {});
            assert.doesNotThrow(() => container.transient('old', OldSchool, ['cfg']));
        });

        it('accepts class definitions', () => {
            class Modern {}
            assert.doesNotThrow(() => container.singleton('modern', Modern));
        });
    });

    // -- Circular dependency detection -------------------------------------

    describe('circular dependencies (declared)', () => {
        it('throws on direct circular dependency (A -> B -> A)', () => {
            class A { constructor(b) {} }
            class B { constructor(a) {} }

            container.transient('a', A, ['b']);
            container.transient('b', B, ['a']);

            assert.throws(() => container.get('a'), /circular.*a -> b -> a/i);
        });

        it('throws on indirect circular dependency (A -> B -> C -> A)', () => {
            class A { constructor(b) {} }
            class B { constructor(c) {} }
            class C { constructor(a) {} }

            container.transient('a', A, ['b']);
            container.transient('b', B, ['c']);
            container.transient('c', C, ['a']);

            assert.throws(() => container.get('a'), /circular/i);
        });
    });

    // -- boot() validation --------------------------------------------------

    describe('boot()', () => {
        it('passes when all dependencies are satisfied', () => {
            class DB { constructor(cfg) {} }
            container.value('config', {});
            container.singleton('db', DB, ['config']);

            assert.doesNotThrow(() => container.boot());
        });

        it('detects circular dependencies without instantiation', () => {
            class A { constructor(b) { throw new Error('should not run'); } }
            class B { constructor(a) { throw new Error('should not run'); } }

            container.transient('a', A, ['b']);
            container.transient('b', B, ['a']);

            assert.throws(() => container.boot(), /circular/i);
        });

        it('skips factory dependencies (cannot validate statically)', () => {
            container.factory('dynamic', (c) => c.get('nonExistent'));

            // boot() should NOT throw -- it cannot see inside factory bodies.
            assert.doesNotThrow(() => container.boot());

            // But runtime resolution DOES throw.
            assert.throws(() => container.get('dynamic'), /not registered/);
        });

        it('covers visited node optimization in cycle detection (shared dependencies)', () => {
            class D {}
            class C { constructor(d) {} }
            class B { constructor(d) {} }
            class A { constructor(b, c) {} }

            container.singleton('d', D);
            container.transient('c', C, ['d']);
            container.transient('b', B, ['d']);
            container.transient('a', A, ['b', 'c']);

            assert.doesNotThrow(() => container.boot());
        });
    });

    // -- Boot lock ----------------------------------------------------------

    describe('boot lock', () => {
        it('blocks value() after boot()', () => {
            container.value('x', 1);
            container.boot();
            // v2 message: "Container is booted and locked." (v1 differed).
            assert.throws(() => container.value('y', 2), /booted and locked/i);
        });

        it('blocks singleton() after boot()', () => {
            class A {}
            container.boot();
            assert.throws(() => container.singleton('a', A), /booted and locked/i);
        });

        it('blocks transient() after boot()', () => {
            class A {}
            container.boot();
            assert.throws(() => container.transient('a', A), /booted and locked/i);
        });

        it('blocks factory() after boot()', () => {
            container.boot();
            assert.throws(() => container.factory('f', () => 1), /booted and locked/i);
        });

        it('blocks unregister() after boot()', () => {
            container.value('x', 1);
            container.boot();
            assert.throws(() => container.unregister('x'), /booted and locked/i);
        });

        it('reset() unlocks registrations', () => {
            container.value('x', 1);
            container.boot();

            assert.throws(() => container.value('y', 2), /booted and locked/i);

            container.reset();

            assert.doesNotThrow(() => container.value('y', 2));
            assert.equal(container.get('y'), 2);
        });

        it('get() still works after boot()', () => {
            container.value('x', 42);
            container.boot();
            assert.equal(container.get('x'), 42);
        });

        it('full test teardown flow: boot -> reset -> swap -> re-boot', () => {
            class RealDB { constructor() { this.type = 'real'; } }
            class MockDB { constructor() { this.type = 'mock'; } }

            container.singleton('db', RealDB);
            container.boot();
            assert.equal(container.get('db').type, 'real');

            container.reset();
            container.unregister('db');
            container.singleton('db', MockDB);
            container.boot();

            assert.equal(container.get('db').type, 'mock');
        });
    });

    // -- Lifecycle ----------------------------------------------------------

    describe('reset()', () => {
        it('clears singleton caches but keeps registrations', () => {
            let n = 0;
            class Counter { constructor() { this.id = ++n; } }

            container.singleton('counter', Counter);
            assert.equal(container.get('counter').id, 1);
            assert.equal(container.get('counter').id, 1); // cached

            container.reset();
            assert.equal(container.get('counter').id, 2); // fresh
        });
    });

    describe('unregister()', () => {
        it('removes a single service', () => {
            container.value('x', 1);
            container.value('y', 2);

            container.unregister('x');
            assert.equal(container.has('x'), false);
            assert.equal(container.has('y'), true);
        });

        it('clears the singleton cache for the removed service', () => {
            let n = 0;
            class DB { constructor() { this.id = ++n; } }

            container.singleton('db', DB);
            assert.equal(container.get('db').id, 1);

            container.unregister('db');

            class MockDB { constructor() { this.id = 'mock'; } }
            container.singleton('db', MockDB);

            assert.equal(container.get('db').id, 'mock');
        });

        it('is a no-op for unknown services', () => {
            assert.doesNotThrow(() => container.unregister('ghost'));
        });
    });

    describe('clear()', () => {
        it('removes all registrations', () => {
            container.value('x', 1);
            container.clear();
            assert.equal(container.has('x'), false);
        });
    });

    // -- Registration API shape (v2 breaking change: no fluent chaining) ----

    describe('registration API shape', () => {
        it('registration methods return undefined (v2 dropped fluent chaining)', () => {
            class A {}
            class B {}

            // v1 returned `this`; v2 returns undefined. Registrations still land.
            assert.equal(container.value('config', {}), undefined);
            assert.equal(container.singleton('a', A), undefined);
            assert.equal(container.transient('b', B), undefined);
            assert.equal(container.factory('time', () => Date.now()), undefined);

            assert.equal(container.has('config'), true);
            assert.equal(container.has('a'), true);
            assert.equal(container.has('b'), true);
            assert.equal(container.has('time'), true);
        });
    });

    // -- Deep dependency chains --------------------------------------------

    describe('deep resolution', () => {
        it('resolves multi-level dependency chains', () => {
            class A { constructor() { this.name = 'A'; } }
            class B { constructor(a) { this.a = a; } }
            class C { constructor(b) { this.b = b; } }
            class D { constructor(c, a) { this.c = c; this.a = a; } }

            // v2 has no fluent chaining -- register with separate calls.
            container.singleton('a', A);
            container.transient('b', B, ['a']);
            container.transient('c', C, ['b']);
            container.transient('d', D, ['c', 'a']);

            container.boot();

            const d = container.get('d');
            assert.equal(d.a.name, 'A');
            assert.equal(d.c.b.a.name, 'A');
            assert.equal(d.a, d.c.b.a); // same singleton
        });
    });

    // -- v2 surface (passing happy paths) ----------------------------------

    describe('v2 surface', () => {
        it('exports a VERSION in three-place sync with package.json', () => {
            assert.equal(VERSION, PKG_VERSION);
        });

        it('public prototype surface matches the pinned d.ts list (drift guard)', () => {
            // Every public runtime member must have a Container.d.ts declaration
            // and vice versa. Pin the sorted public (non-underscore) surface so
            // any added/removed/renamed method fails here until d.ts is updated.
            const PINNED_PUBLIC_SURFACE = [
                'alias',
                'boot',
                'bootAsync',
                'clear',
                'constructor',
                'describe',
                'factory',
                'factoryAsync',
                'get',
                'getAll',
                'getAllAsync',
                'getAllInto',
                'getAsync',
                'has',
                'hasLocal',
                'invalidate',
                'isBooted',
                'multi',
                'multiFactory',
                'onTeardown',
                'rebind',
                'reset',
                'scope',
                'shutdown',
                'singleton',
                'singletonFactory',
                'singletonFactoryAsync',
                'transient',
                'unregister',
                'value'
            ];
            const actual = Object.getOwnPropertyNames(Container.prototype)
                .filter((n) => n[0] !== '_')
                .sort();
            assert.deepEqual(actual, PINNED_PUBLIC_SURFACE);
        });

        it('TYPES is a frozen integer enum including ALIAS', () => {
            assert.equal(TYPES.VALUE, 0);
            assert.equal(TYPES.ALIAS, 4);
            assert.equal(Object.isFrozen(TYPES), true);
        });

        it('alias() resolves to the target', () => {
            container.value('real', 7);
            container.alias('nick', 'real');
            assert.equal(container.get('nick'), 7);
        });

        it('multi() / getAll() returns every registered instance', () => {
            class P {}
            class Q {}
            container.multi('plugins', P);
            container.multi('plugins', Q);
            const all = container.getAll('plugins');
            assert.equal(all.length, 2);
            assert.ok(all[0] instanceof P);
            assert.ok(all[1] instanceof Q);
        });

        it('scope() inherits an un-overridden parent binding', () => {
            class S {}
            container.singleton('svc', S);
            const parentInst = container.get('svc');
            const child = container.scope();
            assert.equal(child.get('svc'), parentInst);
        });

        // -- getAllInto (D-17, decision alpha.6) -------------------------------

        it('getAllInto() fills the buffer and returns the count written', () => {
            class P {} class Q {} class R {}
            container.multi('plugins', P);
            container.multi('plugins', Q);
            container.multi('plugins', R);
            const out = new Array(3);
            const n = container.getAllInto('plugins', out);
            assert.equal(n, 3);
            assert.ok(out[0] instanceof P);
            assert.ok(out[1] instanceof Q);
            assert.ok(out[2] instanceof R);
        });

        it('getAllInto() returns the same cached instances as getAll()', () => {
            class P {} class Q {}
            container.multi('plugins', P);
            container.multi('plugins', Q);
            const all = container.getAll('plugins');
            const out = new Array(2);
            container.getAllInto('plugins', out);
            assert.equal(out[0], all[0]);
            assert.equal(out[1], all[1]);
        });

        it('getAllInto() accepts an out longer than the binding and writes only the count', () => {
            class P {} class Q {}
            container.multi('plugins', P);
            container.multi('plugins', Q);
            const out = new Array(8).fill('sentinel');
            const n = container.getAllInto('plugins', out);
            assert.equal(n, 2);
            assert.ok(out[0] instanceof P);
            assert.ok(out[1] instanceof Q);
            assert.equal(out[2], 'sentinel'); // extra slots untouched
        });

        it('getAllInto() fills a single (non-multi) binding into out[0], returns 1', () => {
            class S {}
            container.singleton('svc', S);
            const out = new Array(1);
            const n = container.getAllInto('svc', out);
            assert.equal(n, 1);
            assert.ok(out[0] instanceof S);
        });

        it('getAllInto() resolves an inherited multi binding through the parent', () => {
            class P {}
            container.multi('plugins', P);
            container.getAll('plugins'); // warm parent cache
            const child = container.scope();
            const out = new Array(1);
            const n = child.getAllInto('plugins', out);
            assert.equal(n, 1);
            assert.ok(out[0] instanceof P);
        });

        // -- getAllInto out-of-bounds policy (fail closed) ---------------------

        it('getAllInto() throws a TypeError when out is not an array', () => {
            class P {}
            container.multi('plugins', P);
            assert.throws(() => container.getAllInto('plugins', {}), TypeError);
            assert.throws(() => container.getAllInto('plugins', null), TypeError);
            assert.throws(() => container.getAllInto('plugins', undefined), TypeError);
        });

        it('getAllInto() throws a RangeError when out is shorter than the binding', () => {
            class P {} class Q {} class R {}
            container.multi('plugins', P);
            container.multi('plugins', Q);
            container.multi('plugins', R);
            const out = new Array(2);
            assert.throws(() => container.getAllInto('plugins', out), RangeError);
        });

        it('getAllInto() throws a RangeError for a single binding when out is empty', () => {
            class S {}
            container.singleton('svc', S);
            assert.throws(() => container.getAllInto('svc', []), RangeError);
        });

        it('getAllInto() throws when the name is not registered', () => {
            assert.throws(() => container.getAllInto('nope', new Array(1)),
                /not registered/);
        });

        it('getAllInto() throws after shutdown', async () => {
            class P {}
            container.multi('plugins', P);
            container.getAll('plugins');
            await container.shutdown();
            assert.throws(() => container.getAllInto('plugins', new Array(1)),
                /shut down/i);
        });

        // -- D6: frozen namespace, public surface, pinned conventions ----------

        it('D-20: isBooted is a public boolean getter tracking the boot lock', () => {
            container.value('x', 1);
            assert.equal(typeof container.isBooted, 'boolean');
            assert.equal(container.isBooted, false);
            container.boot();
            assert.equal(container.isBooted, true);
            container.reset();
            assert.equal(container.isBooted, false);
        });

        it('D-20: hasLocal() reports a local binding without walking the parent chain', () => {
            container.value('rootOnly', 1);
            const child = container.scope();
            child.value('childOnly', 2);
            assert.equal(child.hasLocal('childOnly'), true);
            assert.equal(child.hasLocal('rootOnly'), false); // parent binding, not local
            assert.equal(child.has('rootOnly'), true);       // but visible via has()
        });

        it('TYPES is frozen and its integer values are pinned (VALUE===0 .. ALIAS===4)', () => {
            assert.equal(Object.isFrozen(TYPES), true);
            assert.equal(TYPES.VALUE, 0);
            assert.equal(TYPES.SINGLETON, 1);
            assert.equal(TYPES.TRANSIENT, 2);
            assert.equal(TYPES.FACTORY, 3);
            assert.equal(TYPES.ALIAS, 4);
            // These are the published .d.ts literal types: a frozen object rejects
            // mutation in strict mode (this file is an ESM module -> strict).
            assert.throws(() => { TYPES.VALUE = 99; }, TypeError);
            assert.equal(TYPES.VALUE, 0);
        });

        it('the cycle-trace separator is the ASCII string " -> "', () => {
            class A { constructor(b) {} }
            class B { constructor(a) {} }
            container.transient('a', A, ['b']);
            container.transient('b', B, ['a']);
            let msg = '';
            try { container.get('a'); } catch (e) { msg = e.message; }
            assert.ok(msg.includes(' -> '), 'trace uses the ASCII " -> " separator');
            assert.ok(msg.includes('a -> b -> a'), 'trace joins the path with " -> "');
        });

        it('a circular-dependency message is ASCII-only (matches /^[\\x00-\\x7F]+$/)', () => {
            class A { constructor(b) {} }
            class B { constructor(a) {} }
            container.transient('a', A, ['b']);
            container.transient('b', B, ['a']);
            let msg = '';
            try { container.get('a'); } catch (e) { msg = e.message; }
            assert.match(msg, /^[\x00-\x7F]+$/);
        });

        it('the alias the caller requested appears in the cycle trace, not just the target', () => {
            // alias 'nick' -> 'a'; 'a' depends on 'nick' -> the requested alias
            // name must be named in the trace.
            class A { constructor(nick) {} }
            container.transient('a', A, ['nick']);
            container.alias('nick', 'a');
            let msg = '';
            try { container.get('nick'); } catch (e) { msg = e.message; }
            assert.ok(msg.includes('nick'), 'the requested alias name is in the trace');
        });
    });

    // ======================================================================
    //  known-broken (v2 proposal)
    //
    //  One named test per finding. Each is { todo: true } so the suite is
    //  green while the bug is open. Removing `todo` makes the test FAIL
    //  against today's code -- that is the proof the finding is real. The
    //  fixes land in the sessions named in ROADMAP_v2.md section 4.
    // ======================================================================

    describe('known-broken (v2 proposal)', () => {
        it('D-07: boot() validates missing dependency references (typos)', () => {
            class DB { constructor(cfg) {} }
            container.singleton('db', DB, ['conifg']);
            // v1 threw; v2 boot() only runs _detectCycles and never checks
            // _registry.has(dep), so this passes silently.
            assert.throws(() => container.boot(), /conifg.*not registered/);
        });

        it('D-07: boot() reports multiple wiring errors at once', () => {
            class A { constructor(x, y) {} }
            container.transient('a', A, ['x', 'y']);
            assert.throws(() => container.boot(), /x.*not registered[\s\S]*y.*not registered/);
        });

        it('D-07: alias to an unregistered target fails at boot()', () => {
            container.alias('a', 'nope');
            assert.throws(() => container.boot(), /nope.*not registered/);
        });

        it('D-08: get() on a multi name throws instead of returning the internal cache array', () => {
            container.multiFactory('m', () => 1);
            container.getAll('m');
            // get() probes _singletons before the Array.isArray guard and hands
            // back the container's live cache array.
            assert.throws(() => container.get('m'), /is multi\. Use getAll/);
        });

        it('D-09: unregister/re-register keeps _resolutionOrder deduped (no double teardown)', async () => {
            let teardowns = 0;
            const obj = {};
            container.singletonFactory('x', () => obj);
            container.get('x');
            container.unregister('x');
            const obj2 = {};
            container.singletonFactory('x', () => obj2);
            container.get('x');
            container.onTeardown('x', () => { teardowns++; });
            // Dedup is proven BEFORE shutdown; D-13 releases _resolutionOrder in
            // shutdown(), so the length check belongs here, not after.
            assert.equal(container._resolutionOrder.length, 1);
            await container.shutdown();
            assert.equal(container._resolutionOrder.length, 0);
            assert.equal(teardowns, 1);
        });

        it('D-10: getAll() rejects resolution after shutdown()', async () => {
            container.multiFactory('m', () => ({ live: true }));
            await container.shutdown();
            assert.throws(() => container.getAll('m'), /shut down/i);
        });

        it('D-11: getAll() participates in cycle detection and names the multi binding', () => {
            class A { constructor(b) { this.b = b; } }
            container.multi('a', A, ['b']);
            container.singletonFactory('b', (c) => c.getAll('a')[0]);
            // Today this throws "Circular dependency detected: b -> b" -- the
            // multi name 'a' is never pushed onto the resolution path, so the
            // trace omits it. (Roadmap repro said "hangs"; observed: throws.)
            assert.throws(() => container.getAll('a'), /circular[\s\S]*\ba\b/i);
        });

        it('D-12: a teardown may resolve a cached collaborator during shutdown', async () => {
            class Logger { flush() { this.flushed = true; } }
            container.singleton('logger', Logger);
            const logger = container.get('logger');
            class Svc {}
            container.singleton('svc', Svc);
            container.get('svc');
            let ran = false;
            container.onTeardown('svc', () => { container.get('logger').flush(); ran = true; });
            // Two-phase shutdown: DRAINING permits the cached-collaborator hit, so
            // the teardown runs to completion instead of throwing 'shut down'.
            await container.shutdown();
            assert.equal(ran, true);
            assert.equal(logger.flushed, true);
        });

        it('D-12: a throwing teardown does not stop siblings and surfaces in an AggregateError', async () => {
            const torn = [];
            class A {} class B {} class D {}
            container.singleton('a', A);
            container.singleton('b', B);
            container.singleton('d', D);
            container.onTeardown('a', () => { torn.push('a'); });
            container.onTeardown('b', () => { throw new Error('b boom'); });
            container.onTeardown('d', () => { torn.push('d'); });
            container.get('a'); container.get('b'); container.get('d');
            await assert.rejects(
                () => container.shutdown(),
                (err) => {
                    assert.ok(err instanceof AggregateError, 'expected an AggregateError');
                    assert.equal(err.errors.length, 1);
                    assert.match(err.errors[0].message, /b boom/);
                    return true;
                }
            );
            // Isolation: the siblings still ran.
            assert.deepEqual(torn.sort(), ['a', 'd']);
        });

        it('D-12: an onTeardownError hook suppresses the AggregateError', async () => {
            class A {}
            container.singleton('a', A);
            container.get('a');
            container.onTeardown('a', () => { throw new Error('a boom'); });
            const seen = [];
            await assert.doesNotReject(
                () => container.shutdown({ onTeardownError: (err, name) => seen.push(name + ':' + err.message) })
            );
            assert.deepEqual(seen, ['a:a boom']);
        });

        it('D-13: shutdown() releases retained state and double shutdown is a no-op', async () => {
            let torn = 0;
            class A {}
            container.singleton('a', A);
            container.multiFactory('m', () => ({}));
            container.onTeardown('a', () => { torn++; });
            container.get('a');
            container.getAll('m');
            await container.shutdown();
            assert.equal(container._singletons.size, 0);
            assert.equal(container._multiSingletons.size, 0);
            assert.equal(container._resolvedFlags.size, 0);
            assert.equal(container._resolutionOrder.length, 0);
            assert.equal(container._teardowns.size, 0);
            assert.equal(container._pending.size, 0);
            // Double shutdown re-runs nothing.
            await container.shutdown();
            assert.equal(torn, 1);
        });

        it('D-13: parent shutdown with a live child throws; child-then-parent succeeds', async () => {
            class S {}
            container.singleton('svc', S);
            container.get('svc');
            const child = container.scope();
            class C {}
            child.singleton('cs', C);
            child.get('cs');
            // A live child blocks the parent (law 4).
            await assert.rejects(() => container.shutdown(), /child scope\(s\) still live/i);
            // Drain the child, then the parent, and both reach zero retention.
            await child.shutdown();
            await container.shutdown();
            assert.equal(child._singletons.size, 0);
            assert.equal(container._singletons.size, 0);
            assert.equal(container._resolutionOrder.length, 0);
        });

        it('D-14: a booted container keeps the boot lock on unregister() (reset() first)', () => {
            container.value('x', 1);
            container.boot();
            // Decision 0003: keep the lock, fail closed. The documented swap flow
            // is reset() -> unregister -> re-register -> boot (DICron is fixed in
            // X1 to call reset() first).
            assert.throws(() => container.unregister('x'), /booted and locked/i);
            container.reset();
            assert.doesNotThrow(() => container.unregister('x'));
            container.value('x', 2);
            container.boot();
            assert.equal(container.get('x'), 2);
        });

        it('D-14: a booted container keeps the boot lock on clear() (reset() first)', () => {
            container.value('x', 1);
            container.boot();
            assert.throws(() => container.clear(), /booted and locked/i);
            container.reset();
            assert.doesNotThrow(() => container.clear());
        });

        it('D-15: empty-string token is rejected at registration', () => {
            assert.throws(() => container.value('', 1), /non-empty string|token/i);
        });

        it('D-15: undefined token is rejected at registration', () => {
            assert.throws(() => container.value(undefined, 2), /non-empty string|token/i);
        });

        it('D-15: numeric token is rejected at registration', () => {
            assert.throws(() => container.value(42, 3), /non-empty string|token/i);
        });

        it('D-16: reset() clears the resolution path (_path)', () => {
            container._path.push('ghost');
            container.reset();
            assert.equal(container._path.length, 0);
        });

        it('D-16: clear() clears the resolution path (_path)', () => {
            container._path.push('ghost');
            container.clear();
            assert.equal(container._path.length, 0);
        });

        it('D-17: getAllInto(name, out) fills a caller buffer without allocating a result array', () => {
            // D-17 is fixed via option (b): getAll() stays the allocating
            // convenience (a fresh array per call, so a !== b), and getAllInto
            // fills the caller-owned buffer so a fully-cached multi allocates
            // nothing. The zero-byte proof is the T6 lane-3 gate; here we pin the
            // observable contract.
            class P {} class Q {}
            container.multi('m', P);
            container.multi('m', Q);
            const a = container.getAll('m');
            const b = container.getAll('m');
            assert.notEqual(a, b);                 // getAll allocates fresh
            const out = new Array(4);
            const n = container.getAllInto('m', out);
            assert.equal(n, 2);                    // returns slots written
            assert.ok(out[0] instanceof P);
            assert.ok(out[1] instanceof Q);
            // The cached instances are identical to getAll's.
            assert.equal(out[0], a[0]);
            assert.equal(out[1], a[1]);
        });

        // D-20 is resolved in D6: `isBooted` (getter) and `hasLocal(name)` are now
        // public API, tested by name in the `v2 surface` block above. The private
        // reads that motivated this finding no longer have any reason to exist.

        // -- v2 regressions with no assigned finding ID (v1 coverage preserved) --

        it('v2-regression: factory() validates non-function definitions at registration', () => {
            // Restored v1 parity: throw a TypeError at register, not at first get().
            assert.throws(() => container.factory('bad', 'not a function'), /must be a function/);
        });

        it('v2-regression: unregistered-service error lists available services', () => {
            container.value('a', 1);
            container.value('b', 2);
            // Restored v1 parity: the "not registered" error lists available names.
            assert.throws(() => container.get('c'), /Available/);
        });

        it('v2-regression: unknown registry type throws instead of returning undefined', () => {
            container._registry.set('corrupt', { type: 'MAGIC_UNKNOWN_TYPE' });
            // Restored fail-closed parity: a corrupt entry throws, never returns undefined.
            assert.throws(() => container.get('corrupt'), /unknown type/i);
        });
    });

    // -- describe() introspection (2.1.0) -----------------------------------
    describe('describe() introspection', () => {
        class A {}
        class B { constructor(a) { this.a = a; } }

        // A-DESC-2: fail closed before boot.
        it('A-DESC-2: throws before boot() (fail closed)', () => {
            container.value('cfg', { k: 1 });
            assert.equal(container.isBooted, false);
            assert.throws(() => container.describe(), /not booted/i);
        });

        it('A-DESC-2: succeeds after boot()', () => {
            container.value('cfg', { k: 1 });
            container.boot();
            const snap = container.describe();
            assert.ok(Array.isArray(snap.nodes));
            assert.ok(Array.isArray(snap.edges));
            assert.ok(Array.isArray(snap.order));
        });

        // A-DESC-3: node count == _registry.size + multi entries.
        it('A-DESC-3: node count == _registry.size + multi entries', () => {
            container.value('cfg', 1);
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.alias('nick', 'a');
            container.multi('plugins', A);
            container.multi('plugins', A);
            container.boot();

            const snap = container.describe();
            let multiEntries = 0;
            for (const [, entries] of container._multiRegistry) multiEntries += entries.length;

            assert.equal(snap.nodes.length, container._registry.size + multiEntries);
            assert.equal(multiEntries, 2);
        });

        // A-DESC-3: a VALUE node has kind === TYPES.VALUE and is absent from order.
        it('A-DESC-3: a VALUE node has kind TYPES.VALUE and is absent from order', () => {
            container.value('cfg', { port: 8080 });
            container.singleton('a', A);
            container.boot();

            const snap = container.describe();
            const cfg = snap.nodes.find((n) => n.token === 'cfg');
            assert.equal(cfg.kind, TYPES.VALUE);
            assert.deepEqual(cfg.deps, []);
            assert.equal(cfg.opaqueDeps, true);
            assert.equal(snap.order.includes('cfg'), false);
            // The constructable node IS in the order.
            assert.equal(snap.order.includes('a'), true);
        });

        // A-DESC-3: an ALIAS node points at its target, with an edge but no teardown.
        it('A-DESC-3: an ALIAS node points at its target and is absent from order', () => {
            container.singleton('a', A);
            container.alias('nick', 'a');
            container.boot();

            const snap = container.describe();
            const nick = snap.nodes.find((n) => n.token === 'nick');
            assert.equal(nick.kind, TYPES.ALIAS);
            assert.equal(nick.target, 'a');
            assert.deepEqual(nick.deps, []);
            assert.equal(snap.order.includes('nick'), false);
            // The alias edge is present.
            assert.ok(snap.edges.some((e) => e.from === 'nick' && e.to === 'a'));
        });

        // FACTORY deps are opaque (closure); flagged, no edges.
        it('A-DESC-3: a FACTORY node reports opaqueDeps and no declared edges', () => {
            container.factory('f', () => ({}));
            container.boot();
            const snap = container.describe();
            const f = snap.nodes.find((n) => n.token === 'f');
            assert.equal(f.kind, TYPES.FACTORY);
            assert.deepEqual(f.deps, []);
            assert.equal(f.opaqueDeps, true);
            assert.equal(snap.edges.some((e) => e.from === 'f'), false);
        });

        // deps and edges are derived for constructable nodes.
        it('order is a valid topological order (a dependency precedes its dependent)', () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);
            container.boot();
            const snap = container.describe();
            const b = snap.nodes.find((n) => n.token === 'b');
            assert.deepEqual(b.deps, ['a']);
            assert.ok(snap.edges.some((e) => e.from === 'b' && e.to === 'a'));
            assert.ok(snap.order.indexOf('a') < snap.order.indexOf('b'));
        });

        // A-DESC-3: a cycle can never appear post-boot (boot would have thrown).
        it('A-DESC-3: a cycle can never appear (boot rejects it first)', () => {
            container.singleton('x', B, ['y']);
            container.singleton('y', B, ['x']);
            assert.throws(() => container.boot(), /circular/i);
            // describe() is unreachable on a real container here (boot threw), but
            // if forced past boot with a cycle present it fails closed, never hangs.
            container._booted = true;
            assert.throws(() => container.describe(), /circular/i);
        });

        // A-DESC-1: read-only -- describe() mutates no hot-path resolution state.
        it('A-DESC-1: describe() is read-only (mutates no resolution state)', () => {
            container.value('cfg', 1);
            container.singleton('a', A);
            container.boot();
            container.get('a'); // populate _resolutionOrder / caches
            const orderBefore = container._resolutionOrder.slice();
            const pathLenBefore = container._path.length;
            const cachedA = container.get('a');

            container.describe();
            container.describe();

            assert.deepEqual(container._resolutionOrder, orderBefore);
            assert.equal(container._path.length, pathLenBefore);
            // The cached get() identity is unchanged after describe().
            assert.equal(container.get('a'), cachedA);
        });

        // A-DESC-4: order must NOT lie -- it lists EXACTLY the cached instances
        // that shutdown() tears down, in teardown-reverse order. A transient or a
        // plain (non-cached) factory is in nodes/edges (the full DAG) but NEVER in
        // order, because it is never pushed to _resolutionOrder and never torn down.
        it('A-DESC-4: describe().order mirrors _resolutionOrder exactly (never lies)', async () => {
            container.singleton('a', A);
            container.singleton('b', B, ['a']);   // cached, deps on cached a
            container.transient('t', A);          // never cached, never torn down
            container.factory('f', () => ({}));   // plain factory, never cached
            container.value('cfg', { k: 1 });     // value, never torn down
            container.alias('nick', 'a');         // alias, never torn down
            container.multi('plugins', A);        // multi, always cached
            container.boot();

            // Register teardown recorders on the teardown-eligible tokens.
            const torn = [];
            container.onTeardown('a', () => { torn.push('a'); });
            container.onTeardown('b', () => { torn.push('b'); });
            container.onTeardown('plugins', () => { torn.push('plugins'); });
            // Recorders on tokens that must NEVER be torn down -- if they fire the
            // order/teardown contract is broken.
            container.onTeardown('t', () => { torn.push('t'); });
            container.onTeardown('f', () => { torn.push('f'); });

            // Resolve the WHOLE graph so _resolutionOrder is actually populated.
            container.get('a');
            container.get('b');
            container.get('t');
            container.get('f');
            container.get('cfg');
            container.get('nick');
            container.getAll('plugins');

            // Capture the predicted order and the real resolve-time order BEFORE
            // shutdown (shutdown() releases _resolutionOrder).
            const snap = container.describe();
            const resolutionOrder = container._resolutionOrder.slice();

            // describe().order equals the container's real _resolutionOrder snapshot.
            assert.deepEqual(snap.order, resolutionOrder);

            // The full DAG (nodes) DOES contain the transient and plain factory...
            assert.ok(snap.nodes.some((n) => n.token === 't'));
            assert.ok(snap.nodes.some((n) => n.token === 'f'));
            // ...but order does NOT -- nor value/alias.
            assert.equal(snap.order.includes('t'), false);
            assert.equal(snap.order.includes('f'), false);
            assert.equal(snap.order.includes('cfg'), false);
            assert.equal(snap.order.includes('nick'), false);
            // Cached tokens ARE present.
            assert.equal(snap.order.includes('a'), true);
            assert.equal(snap.order.includes('b'), true);
            assert.equal(snap.order.includes('plugins'), true);

            await container.shutdown();

            // The ACTUAL teardown order equals describe().order REVERSED: order is
            // the resolution order; teardown walks it in reverse.
            assert.deepEqual(torn, snap.order.slice().reverse());
            // No transient/plain-factory token was ever torn down.
            assert.equal(torn.includes('t'), false);
            assert.equal(torn.includes('f'), false);
        });
    });
});
