/**
 * Container.test.js — DI Container Tests (v2)
 *
 * Covers: value, singleton, transient, factory, circular deps (including
 * factory loophole), arrow function guard, boot validation, unregister,
 * reset, clear, chaining, and deep resolution chains.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Container } from './Container.js';


describe('DI Container', () => {
    let container;

    beforeEach(() => {
        container = new Container();
    });

    // ── value() ──────────────────────────────────────────

    describe('value()', () => {
        it('returns the registered object as-is', () => {
            const config = { port: 3000 };
            container.value('config', config);
            expect(container.get('config')).toBe(config);
        });

        it('returns the same reference every time', () => {
            const obj = { key: 'val' };
            container.value('obj', obj);
            expect(container.get('obj')).toBe(container.get('obj'));
        });

        it('handles primitives', () => {
            container.value('port', 3000);
            container.value('name', 'app');
            container.value('debug', false);
            expect(container.get('port')).toBe(3000);
            expect(container.get('name')).toBe('app');
            expect(container.get('debug')).toBe(false);
        });

        it('handles null', () => {
            container.value('empty', null);
            expect(container.get('empty')).toBeNull();
        });
    });

    // ── singleton() ──────────────────────────────────────

    describe('singleton()', () => {
        it('creates one instance on first get() (lazy)', () => {
            let callCount = 0;
            class DB { constructor() { callCount++; } }

            container.singleton('db', DB);
            expect(callCount).toBe(0);

            container.get('db');
            expect(callCount).toBe(1);

            container.get('db');
            expect(callCount).toBe(1);
        });

        it('returns the same instance every time', () => {
            class Cache {}
            container.singleton('cache', Cache);
            expect(container.get('cache')).toBe(container.get('cache'));
        });

        it('injects resolved dependencies', () => {
            const config = { host: 'localhost' };
            class DB { constructor(cfg) { this.config = cfg; } }

            container.value('config', config);
            container.singleton('db', DB, ['config']);

            expect(container.get('db').config).toBe(config);
        });
    });

    // ── transient() ──────────────────────────────────────

    describe('transient()', () => {
        it('creates a new instance every get()', () => {
            class Logger {}
            container.transient('logger', Logger);

            const a = container.get('logger');
            const b = container.get('logger');
            expect(a).not.toBe(b);
            expect(a).toBeInstanceOf(Logger);
        });

        it('injects dependencies into each instance', () => {
            class Formatter { format(s) { return s.toUpperCase(); } }
            class Logger { constructor(fmt) { this.formatter = fmt; } }

            container.singleton('formatter', Formatter);
            container.transient('logger', Logger, ['formatter']);

            const logger = container.get('logger');
            expect(logger.formatter).toBeInstanceOf(Formatter);
        });
    });

    // ── factory() ────────────────────────────────────────

    describe('factory()', () => {
        it('calls the function on every get()', () => {
            let n = 0;
            container.factory('counter', () => ++n);
            expect(container.get('counter')).toBe(1);
            expect(container.get('counter')).toBe(2);
        });

        it('receives the container as an argument', () => {
            container.value('secret', '42');
            container.factory('wrapped', (c) => ({ val: c.get('secret') }));
            expect(container.get('wrapped').val).toBe('42');
        });

        it('rejects non-function definitions', () => {
            expect(() => container.factory('bad', 'not a function'))
                .toThrow(/must be a function/);
        });

        it('detects self-referencing factory (circular)', () => {
            container.factory('loop', (c) => c.get('loop'));
            expect(() => container.get('loop'))
                .toThrow(/circular.*loop → loop/i);
        });

        it('detects factory → service → factory cycle', () => {
            class B { constructor(a) {} }
            container.factory('a', (c) => c.get('b'));
            container.transient('b', B, ['a']);

            expect(() => container.get('a'))
                .toThrow(/circular/i);
        });

        it('detects factory → factory cycle', () => {
            container.factory('ping', (c) => c.get('pong'));
            container.factory('pong', (c) => c.get('ping'));

            expect(() => container.get('ping'))
                .toThrow(/circular.*ping → pong → ping/i);
        });
    });

    // ── has() ────────────────────────────────────────────

    describe('has()', () => {
        it('returns true for registered services', () => {
            container.value('x', 1);
            expect(container.has('x')).toBe(true);
        });

        it('returns false for unknown services', () => {
            expect(container.has('ghost')).toBe(false);
        });
    });

    // ── Error handling ───────────────────────────────────

    describe('error handling', () => {
        it('throws on get() for unregistered service', () => {
            expect(() => container.get('nope'))
                .toThrow(/not registered/);
        });

        it('includes available services in the error message', () => {
            container.value('a', 1);
            container.value('b', 2);
            expect(() => container.get('c'))
                .toThrow(/Available:.*a.*b/);
        });

        it('rejects empty string as service name', () => {
            expect(() => container.value('', 1))
                .toThrow(/non-empty string/);
        });

        it('rejects non-string service names', () => {
            expect(() => container.value(42, 'val'))
                .toThrow(/non-empty string/);
        });

        it('rejects non-constructable definitions for singleton', () => {
            expect(() => container.singleton('bad', { plain: 'object' }))
                .toThrow(/class or constructor function/);
        });

        it('rejects non-constructable definitions for transient', () => {
            expect(() => container.transient('bad', 'a string'))
                .toThrow(/class or constructor function/);
        });
    });

    // ── Arrow function guard ─────────────────────────────

    describe('arrow function guard', () => {
        it('rejects arrow functions for singleton', () => {
            expect(() => container.singleton('bad', () => {}))
                .toThrow(/arrow function/i);
        });

        it('rejects arrow functions for transient', () => {
            expect(() => container.transient('bad', (a, b) => a + b))
                .toThrow(/arrow function/i);
        });

        it('accepts regular function constructors', () => {
            function OldSchool(cfg) { this.cfg = cfg; }
            container.value('cfg', {});
            expect(() => container.transient('old', OldSchool, ['cfg']))
                .not.toThrow();
        });

        it('accepts class definitions', () => {
            class Modern {}
            expect(() => container.singleton('modern', Modern))
                .not.toThrow();
        });
    });

    // ── Circular dependency detection ────────────────────

    describe('circular dependencies (declared)', () => {
        it('throws on direct circular dependency (A → B → A)', () => {
            class A { constructor(b) {} }
            class B { constructor(a) {} }

            container.transient('a', A, ['b']);
            container.transient('b', B, ['a']);

            expect(() => container.get('a'))
                .toThrow(/circular.*a → b → a/i);
        });

        it('throws on indirect circular dependency (A → B → C → A)', () => {
            class A { constructor(b) {} }
            class B { constructor(c) {} }
            class C { constructor(a) {} }

            container.transient('a', A, ['b']);
            container.transient('b', B, ['c']);
            container.transient('c', C, ['a']);

            expect(() => container.get('a'))
                .toThrow(/circular/i);
        });
    });

    // ── boot() validation ────────────────────────────────

    describe('boot()', () => {
        it('passes when all dependencies are satisfied', () => {
            class DB { constructor(cfg) {} }
            container.value('config', {});
            container.singleton('db', DB, ['config']);

            expect(() => container.boot()).not.toThrow();
        });

        it('catches missing dependency references (typos)', () => {
            class DB { constructor(cfg) {} }
            container.singleton('db', DB, ['conifg']);

            expect(() => container.boot())
                .toThrow(/conifg.*not registered/);
        });

        it('catches multiple wiring errors at once', () => {
            class A { constructor(x, y) {} }
            container.transient('a', A, ['x', 'y']);

            expect(() => container.boot())
                .toThrow(/x.*not registered[\s\S]*y.*not registered/);
        });

        it('detects circular dependencies without instantiation', () => {
            class A { constructor(b) { throw new Error('should not run'); } }
            class B { constructor(a) { throw new Error('should not run'); } }

            container.transient('a', A, ['b']);
            container.transient('b', B, ['a']);

            expect(() => container.boot())
                .toThrow(/circular/i);
        });

        it('skips factory dependencies (cannot validate statically)', () => {
            container.factory('dynamic', (c) => c.get('nonExistent'));

            // boot() should NOT throw — it can't see inside factory bodies
            expect(() => container.boot()).not.toThrow();

            // But runtime resolution DOES throw
            expect(() => container.get('dynamic'))
                .toThrow(/not registered/);
        });

        it('covers visited node optimization in cycle detection (shared dependencies)', () => {
            // Diamond dependency graph:
            //   A depends on B and C
            //   B depends on D
            //   C depends on D
            class D {}
            class C { constructor(d) {} }
            class B { constructor(d) {} }
            class A { constructor(b, c) {} }

            container.singleton('d', D);
            container.transient('c', C, ['d']);
            container.transient('b', B, ['d']);
            container.transient('a', A, ['b', 'c']);

            // When _detectCycles checks 'a', it will verify 'b' -> 'd'.
            // Then it will verify 'c' -> 'd'.
            // Since 'd' was already verified, `if (visited.has(name)) return;` is executed.
            expect(() => container.boot()).not.toThrow();
        });
    });

    // ── Boot lock ────────────────────────────────────────

    describe('boot lock', () => {
        it('blocks value() after boot()', () => {
            container.value('x', 1);
            container.boot();
            expect(() => container.value('y', 2))
                .toThrow(/cannot modify.*after boot/i);
        });

        it('blocks singleton() after boot()', () => {
            class A {}
            container.boot();
            expect(() => container.singleton('a', A))
                .toThrow(/cannot modify.*after boot/i);
        });

        it('blocks transient() after boot()', () => {
            class A {}
            container.boot();
            expect(() => container.transient('a', A))
                .toThrow(/cannot modify.*after boot/i);
        });

        it('blocks factory() after boot()', () => {
            container.boot();
            expect(() => container.factory('f', () => 1))
                .toThrow(/cannot modify.*after boot/i);
        });

        it('blocks unregister() after boot()', () => {
            container.value('x', 1);
            container.boot();
            expect(() => container.unregister('x'))
                .toThrow(/cannot modify.*after boot/i);
        });

        it('reset() unlocks registrations', () => {
            container.value('x', 1);
            container.boot();

            // Locked
            expect(() => container.value('y', 2)).toThrow(/after boot/i);

            // Unlock
            container.reset();

            // Now allowed
            expect(() => container.value('y', 2)).not.toThrow();
            expect(container.get('y')).toBe(2);
        });

        it('clear() unlocks registrations', () => {
            container.value('x', 1);
            container.boot();

            container.clear();
            expect(() => container.value('z', 3)).not.toThrow();
        });

        it('get() still works after boot()', () => {
            container.value('x', 42);
            container.boot();
            expect(container.get('x')).toBe(42);
        });

        it('full test teardown flow: boot → reset → swap → re-boot', () => {
            class RealDB { constructor() { this.type = 'real'; } }
            class MockDB { constructor() { this.type = 'mock'; } }

            container.singleton('db', RealDB);
            container.boot();
            expect(container.get('db').type).toBe('real');

            // Test teardown: unlock, swap, re-validate
            container.reset();
            container.unregister('db');
            container.singleton('db', MockDB);
            container.boot();

            expect(container.get('db').type).toBe('mock');
        });
    });

    // ── Lifecycle ────────────────────────────────────────

    describe('reset()', () => {
        it('clears singleton caches but keeps registrations', () => {
            let n = 0;
            class Counter { constructor() { this.id = ++n; } }

            container.singleton('counter', Counter);
            expect(container.get('counter').id).toBe(1);
            expect(container.get('counter').id).toBe(1); // cached

            container.reset();
            expect(container.get('counter').id).toBe(2); // fresh
        });
    });

    describe('unregister()', () => {
        it('removes a single service', () => {
            container.value('x', 1);
            container.value('y', 2);

            container.unregister('x');
            expect(container.has('x')).toBe(false);
            expect(container.has('y')).toBe(true);
        });

        it('clears the singleton cache for the removed service', () => {
            let n = 0;
            class DB { constructor() { this.id = ++n; } }

            container.singleton('db', DB);
            expect(container.get('db').id).toBe(1);

            // Swap for a mock
            container.unregister('db');

            class MockDB { constructor() { this.id = 'mock'; } }
            container.singleton('db', MockDB);

            expect(container.get('db').id).toBe('mock');
        });

        it('is a no-op for unknown services', () => {
            expect(() => container.unregister('ghost')).not.toThrow();
        });
    });

    describe('clear()', () => {
        it('removes all registrations', () => {
            container.value('x', 1);
            container.clear();
            expect(container.has('x')).toBe(false);
        });
    });

    // ── Chaining ─────────────────────────────────────────

    describe('chaining', () => {
        it('supports fluent registration', () => {
            class A {}
            class B {}

            const result = container
                .value('config', {})
                .singleton('a', A)
                .transient('b', B)
                .factory('time', () => Date.now());

            expect(result).toBe(container);
            expect(container.has('config')).toBe(true);
            expect(container.has('a')).toBe(true);
            expect(container.has('b')).toBe(true);
            expect(container.has('time')).toBe(true);
        });
    });

    // ── Deep dependency chains ───────────────────────────

    describe('deep resolution', () => {
        it('resolves multi-level dependency chains', () => {
            class A { constructor() { this.name = 'A'; } }
            class B { constructor(a) { this.a = a; } }
            class C { constructor(b) { this.b = b; } }
            class D { constructor(c, a) { this.c = c; this.a = a; } }

            container
                .singleton('a', A)
                .transient('b', B, ['a'])
                .transient('c', C, ['b'])
                .transient('d', D, ['c', 'a']);

            container.boot();

            const d = container.get('d');
            expect(d.a.name).toBe('A');
            expect(d.c.b.a.name).toBe('A');
            expect(d.a).toBe(d.c.b.a); // same singleton
        });
    });

    describe('error handling', () => {
        it('throws an error if the registry contains an unknown type (defensive safeguard)', () => {
            // Forcefully inject a corrupted record into the internal map
            // (assuming your map is called `_registry` or `registry` — adjust if it's named differently)
            container._registry.set('corrupt_service', {
                type: 'MAGIC_UNKNOWN_TYPE',
                definition: class {},
                dependencies: []
            });

            // Trying to resolve it should trigger the default switch case (Line 184)
            expect(() => container.get('corrupt_service')).toThrowError(/unknown type "MAGIC_UNKNOWN_TYPE"/);
        });
    });
});
