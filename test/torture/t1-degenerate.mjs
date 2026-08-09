/**
 * T1 -- degenerate tokens, definitions and dep lists.
 *
 * Crosses the registration surface with hostile tokens, definition shapes and
 * dependency lists. Every case has a decided policy: THROW, documented NO-OP, or
 * documented UNDEFINED -- never "silently returns garbage".
 *
 * The token-rejection policy (a token must be a non-empty string or a symbol) is
 * D-15, still unfixed: `''`, `undefined` and `42` register and resolve today.
 * Those cases are registered here with a `// FAILS: D-15 (fixed in D2)` marker
 * and GUARDED (asserting the current behaviour) so the suite stays green while
 * the finding is open. The isolation half of D-15 -- that `'__proto__'` is a
 * real, isolated Map key -- already holds and is asserted for real.
 */

import { Container } from '../../Container.js';
import { check } from './harness.mjs';

export async function run() {
    // -- Symbols are first-class tokens (Map keys) ----------------------------
    {
        const c = new Container();
        const s1 = Symbol('x');
        const s2 = Symbol.for('x');
        c.value(s1, 1);
        c.value(s2, 2);
        check(c.get(s1) === 1, () => 'T1.symbol: Symbol() token lost its value');
        check(c.get(s2) === 2, () => 'T1.symbol: Symbol.for() token lost its value');
        check(s1 !== s2, () => 'T1.symbol: Symbol() collided with Symbol.for()');
    }

    // -- Prototype-pollution tokens are isolated Map keys (D-15 isolation) -----
    {
        const c = new Container();
        c.value('__proto__', 41);
        c.value('constructor', 42);
        c.value('toString', 43);
        check(c.get('__proto__') === 41, () => 'T1.proto: __proto__ token not stored as a real key');
        check(c.get('constructor') === 42, () => 'T1.proto: constructor token not stored as a real key');
        check(c.get('toString') === 43, () => 'T1.proto: toString token not stored as a real key');
        // The container prototype must be untouched: no pollution leaked through.
        check(Object.getPrototypeOf(c) !== 41,
            () => 'T1.proto: __proto__ token polluted the container prototype');
        check(({}).polluted === undefined, () => 'T1.proto: global Object.prototype was polluted');
    }

    // -- A 4 KB token and a token containing the trace separator --------------
    {
        const c = new Container();
        const big = 'k'.repeat(4096);
        const sep = 'a -> b'; // contains the cycle-trace separator
        c.value(big, 'big');
        c.value(sep, 'sep');
        check(c.get(big) === 'big', () => 'T1.token: 4 KB token lost its value');
        check(c.get(sep) === 'sep', () => 'T1.token: separator-bearing token lost its value');
    }

    // -- Dep lists: undefined default, [], and an unregistered name -----------
    {
        const c = new Container();
        class Zero { constructor() { this.ok = true; } }
        c.singleton('zero', Zero);          // deps default to []
        check(c.get('zero').ok === true, () => 'T1.deps: default [] deps failed to construct');

        class Empty {}
        c.singleton('empty', Empty, []);
        check(c.get('empty') instanceof Empty, () => 'T1.deps: explicit [] deps failed');

        class Needs { constructor(x) { this.x = x; } }
        c.singleton('needs', Needs, ['ghost']);
        let threw = false;
        try { c.get('needs'); } catch { threw = true; }
        check(threw, () => 'T1.deps: dep on an unregistered name did not throw');
    }

    // -- A live dep array mutated AFTER registration --------------------------
    // Policy: documented -- the container keeps the array by reference, so a
    // post-registration mutation is observed. (Pinned so a future defensive copy
    // is a conscious change, not an accident.)
    {
        const c = new Container();
        c.value('a', 1);
        c.value('b', 2);
        const deps = ['a'];
        class Two { constructor(a, b) { this.sum = a + (b || 0); } }
        c.singleton('two', Two, deps);
        deps.push('b'); // mutate after registration
        const inst = c.get('two');
        check(inst.sum === 3, () => `T1.deps-mutate: expected 3, got ${inst.sum} (array kept by reference)`);
    }

    // -- Definition shapes ----------------------------------------------------
    {
        const c = new Container();
        // arrow / async / plain object rejected by the constructable heuristic.
        let a = false; try { c.singleton('arrow', () => {}); } catch { a = true; }
        check(a, () => 'T1.def: arrow function accepted as a class');
        let as = false; try { c.singleton('async', async () => {}); } catch { as = true; }
        check(as, () => 'T1.def: async function accepted as a class (no .prototype)');
        let ob = false; try { c.singleton('obj', { plain: 1 }); } catch { ob = true; }
        check(ob, () => 'T1.def: plain object accepted as a class');

        // A regular function constructor and a class both pass.
        function OldSchool() { this.ok = 1; }
        c.transient('old', OldSchool);
        check(c.get('old').ok === 1, () => 'T1.def: function constructor did not build');
        class Modern { constructor() { this.ok = 2; } }
        c.singleton('modern', Modern);
        check(c.get('modern').ok === 2, () => 'T1.def: class did not build');

        // A Proxy over a class keeps typeof "function" and .prototype -> accepted.
        const PClass = new Proxy(class { constructor() { this.viaProxy = true; } }, {});
        c.transient('proxy', PClass);
        check(c.get('proxy').viaProxy === true, () => 'T1.def: Proxy-wrapped class did not construct');
    }

    // -- A throwing constructor leaves _path clean (finally pops it) -----------
    {
        const c = new Container();
        class Boom { constructor() { throw new Error('boom'); } }
        c.transient('boom', Boom);
        let threw = false;
        try { c.get('boom'); } catch { threw = true; }
        check(threw, () => 'T1.throwctor: a throwing constructor did not propagate');
        check(c._path.length === 0, () => `T1.throwctor: _path leaked a frame (len=${c._path.length})`);
    }

    // -- Factories returning falsy / promise values ---------------------------
    {
        const c = new Container();
        c.factory('u', () => undefined);
        c.factory('n', () => null);
        c.factory('z', () => 0);
        c.factory('f', () => false);
        check(c.get('u') === undefined, () => 'T1.factory: undefined return not passed through');
        check(c.get('n') === null, () => 'T1.factory: null return not passed through');
        check(c.get('z') === 0, () => 'T1.factory: 0 return not passed through');
        check(c.get('f') === false, () => 'T1.factory: false return not passed through');

        // A SYNC factory that returns a promise: documented -- the promise is
        // returned unawaited (sync get() never awaits).
        const p = Promise.resolve(1);
        c.factory('p', () => p);
        check(c.get('p') === p, () => 'T1.factory: sync factory did not return the promise unawaited');
    }

    // -- D-15: primitive/empty tokens are rejected at the door (FIXED in D2) ---
    // A token must be a non-empty string or a symbol; anything else throws a
    // TypeError at REGISTRATION (cold path, in _register, never in get()).
    {
        const c = new Container();
        let e1 = false; try { c.value('', 100); } catch (e) { e1 = e instanceof TypeError; }
        check(e1, () => 'T1.D-15: empty-string token was not rejected with a TypeError');
        let e2 = false; try { c.value(undefined, 200); } catch (e) { e2 = e instanceof TypeError; }
        check(e2, () => 'T1.D-15: undefined token was not rejected with a TypeError');
        let e3 = false; try { c.value(42, 300); } catch (e) { e3 = e instanceof TypeError; }
        check(e3, () => 'T1.D-15: numeric token was not rejected with a TypeError');
    }
}
