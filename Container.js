/**
 * Container.js — Dependency Injection Container (v2)
 *
 * Explicit registration API — no class-vs-function guessing.
 *
 *   container.value('config', { port: 3000 });        — raw value, returned as-is
 *   container.singleton('db', MySQLPool, ['config']);   — one instance, created on first get()
 *   container.transient('logger', Logger, ['config']);  — new instance every get()
 *   container.factory('requestId', () => uuid());      — function called every get()
 *
 * Features:
 *   - Circular dependency detection at resolution AND at boot (A→B→A)
 *   - boot() validates all declared wiring at startup
 *   - Arrow function guard on singleton/transient (not constructable)
 *   - Lazy resolution — nothing is instantiated until first get()
 *   - Boot lock — no registrations accepted after boot() (reset() unlocks)
 *   - reset() / unregister() for test teardown and mock swapping
 *   - Clear error messages with dependency chain context
 *
 * Known limitations:
 *   - boot() cannot validate factory dependencies (resolved dynamically via c.get())
 *   - Arrow function detection uses .prototype heuristic — works for all practical
 *     cases but theoretically bypassable with Object.defineProperty
 */

const TYPES = Object.freeze({
    VALUE:     'value',
    SINGLETON: 'singleton',
    TRANSIENT: 'transient',
    FACTORY:   'factory',
});

class Container {

    constructor() {
        /** @type {Map<string, {type: string, definition: *, dependencies: string[]}>} */
        this._registry = new Map();

        /** @type {Map<string, *>} Cached singleton instances */
        this._singletons = new Map();

        /** @type {Set<string>} Guards against circular resolution */
        this._resolving = new Set();

        this._booted = false;
    }


    // ═══════════════════════════════════════════════════════
    //  Registration
    // ═══════════════════════════════════════════════════════

    /**
     * Register a raw value (config object, 3rd-party module, primitive).
     * Returned as-is on every get() — no instantiation.
     */
    value(name, definition) {
        this._assertNotBooted();
        this._assertName(name);
        this._registry.set(name, {
            type: TYPES.VALUE,
            definition,
            dependencies: [],
        });
        return this;
    }

    /**
     * Register a class that will be instantiated once on first get().
     * Subsequent calls return the cached instance.
     */
    singleton(name, definition, dependencies = []) {
        this._assertNotBooted();
        this._assertName(name);
        this._assertConstructable(name, definition);
        this._registry.set(name, {
            type: TYPES.SINGLETON,
            definition,
            dependencies,
        });
        return this;
    }

    /**
     * Register a class that will be instantiated fresh on every get().
     */
    transient(name, definition, dependencies = []) {
        this._assertNotBooted();
        this._assertName(name);
        this._assertConstructable(name, definition);
        this._registry.set(name, {
            type: TYPES.TRANSIENT,
            definition,
            dependencies,
        });
        return this;
    }

    /**
     * Register a factory function that will be called on every get().
     * The factory receives the container as its only argument,
     * allowing ad-hoc resolution inside the function body.
     *
     * NOTE: boot() cannot statically validate factory dependencies since
     * they are resolved dynamically via c.get() at runtime. A typo like
     * c.get('dataBse') will only throw when the factory is first called.
     *
     * @example
     *   container.factory('requestId', () => crypto.randomUUID());
     *   container.factory('userRepo', (c) => new UserRepo(c.get('db')));
     */
    factory(name, fn) {
        this._assertNotBooted();
        this._assertName(name);
        if (typeof fn !== 'function') {
            throw new TypeError(
                `Container: factory "${name}" must be a function, got ${typeof fn}`
            );
        }
        this._registry.set(name, {
            type: TYPES.FACTORY,
            definition: fn,
            dependencies: [],
        });
        return this;
    }


    // ═══════════════════════════════════════════════════════
    //  Resolution
    // ═══════════════════════════════════════════════════════

    /**
     * Resolve a service by name.
     * @param {string} name
     * @returns {*}
     */
    get(name) {
        const entry = this._registry.get(name);

        if (!entry) {
            throw new Error(
                `Container: service "${name}" is not registered. ` +
                `Available: [${[...this._registry.keys()].join(', ')}]`
            );
        }

        // ── Circular dependency guard ──
        if (this._resolving.has(name)) {
            const chain = [...this._resolving, name].join(' → ');
            throw new Error(`Container: circular dependency detected: ${chain}`);
        }

        switch (entry.type) {

            case TYPES.VALUE:
                return entry.definition;

            case TYPES.SINGLETON: {
                if (this._singletons.has(name)) {
                    return this._singletons.get(name);
                }
                const instance = this._instantiate(name, entry);
                this._singletons.set(name, instance);
                return instance;
            }

            case TYPES.TRANSIENT:
                return this._instantiate(name, entry);

            // FIX: Factories now participate in circular dependency detection.
            // Without this, a factory calling c.get('self') causes a stack
            // overflow instead of throwing a clear circular dependency error.
            case TYPES.FACTORY: {
                this._resolving.add(name);
                try {
                    return entry.definition(this);
                } finally {
                    this._resolving.delete(name);
                }
            }

            default:
                throw new Error(`Container: unknown type "${entry.type}" for "${name}"`);
        }
    }

    /**
     * Check if a service is registered (without resolving it).
     */
    has(name) {
        return this._registry.has(name);
    }


    // ═══════════════════════════════════════════════════════
    //  Validation
    // ═══════════════════════════════════════════════════════

    /**
     * Validate all dependency wiring at startup.
     * Call after all registrations are complete.
     *
     * Catches:
     *   - Typos in dependency names (references to unregistered services)
     *   - Circular dependency chains (in declared dependencies only)
     *
     * NOTE: Factory dependencies are resolved dynamically via c.get() and
     * cannot be validated statically. Those errors surface at runtime.
     *
     * @returns {Container} this (for chaining)
     */
    boot() {
        const errors = [];

        for (const [name, entry] of this._registry) {
            for (const dep of entry.dependencies) {
                if (!this._registry.has(dep)) {
                    errors.push(
                        `"${name}" depends on "${dep}" which is not registered`
                    );
                }
            }
        }

        if (errors.length > 0) {
            throw new Error(
                `Container: wiring errors found:\n  - ${errors.join('\n  - ')}`
            );
        }

        // DFS cycle detection across declared dependency graph (no instantiation)
        this._detectCycles();

        this._booted = true;
        return this;
    }

    /**
     * DFS cycle detection across the full dependency graph.
     * Runs without instantiating anything.
     */
    _detectCycles() {
        const visited = new Set();
        const stack = new Set();

        const visit = (name, chain) => {
            if (stack.has(name)) {
                throw new Error(
                    `Container: circular dependency detected: ` +
                    `${[...chain, name].join(' → ')}`
                );
            }
            if (visited.has(name)) return;

            stack.add(name);
            chain.push(name);

            const entry = this._registry.get(name);
            for (const dep of entry.dependencies) {
                visit(dep, [...chain]);
            }

            stack.delete(name);
            visited.add(name);
        };

        for (const name of this._registry.keys()) {
            visit(name, []);
        }
    }


    // ═══════════════════════════════════════════════════════
    //  Lifecycle
    // ═══════════════════════════════════════════════════════

    /**
     * Clear all singleton instances and unlock registrations (for test teardown).
     * Registrations are preserved — only cached instances are flushed.
     * Clears the booted flag so services can be re-registered or swapped.
     */
    reset() {
        this._singletons.clear();
        this._booted = false;
        return this;
    }

    /**
     * Remove a single service registration and its cached singleton (if any).
     * Useful in tests to swap a real service for a mock without rebuilding
     * the entire container.
     *
     * @example
     *   container.unregister('db');
     *   container.singleton('db', MockDB);
     */
    unregister(name) {
        this._assertNotBooted();
        this._registry.delete(name);
        this._singletons.delete(name);
        return this;
    }

    /**
     * Clear everything — registrations, singletons, state.
     */
    clear() {
        this._registry.clear();
        this._singletons.clear();
        this._resolving.clear();
        this._booted = false;
        return this;
    }


    // ═══════════════════════════════════════════════════════
    //  Internals
    // ═══════════════════════════════════════════════════════

    _instantiate(name, entry) {
        this._resolving.add(name);

        try {
            const deps = entry.dependencies.map(dep => this.get(dep));
            return new entry.definition(...deps);
        } finally {
            this._resolving.delete(name);
        }
    }

    _assertNotBooted() {
        if (this._booted) {
            throw new Error(
                'Container: cannot modify registrations after boot(). ' +
                'Call reset() first to unlock the container (e.g. in test teardown).'
            );
        }
    }

    _assertName(name) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError(
                `Container: service name must be a non-empty string, got ${JSON.stringify(name)}`
            );
        }
    }

    /**
     * Validate that a definition can be called with `new`.
     *
     * Arrow functions pass `typeof === 'function'` but lack .prototype,
     * so `new (() => {})` throws TypeError at runtime. We catch this at
     * registration time with a .prototype check.
     *
     * Edge case: this heuristic can be fooled by manually adding a
     * .prototype to an arrow function, but that's adversarial, not
     * accidental — and this guard exists to catch accidental misuse.
     */
    _assertConstructable(name, definition) {
        if (typeof definition !== 'function') {
            throw new TypeError(
                `Container: "${name}" must be a class or constructor function, ` +
                `got ${typeof definition}. Use .value() for plain objects.`
            );
        }

        if (!definition.prototype) {
            throw new TypeError(
                `Container: "${name}" is an arrow function and cannot be ` +
                `instantiated with \`new\`. Use .factory() for arrow functions ` +
                `or .value() for static utilities.`
            );
        }
    }
}

export default Container;
export { Container, TYPES };
