/**
 * Container.js -- High-Performance Dependency Injection (v2.0)
 *
 * Features:
 *  - Per-lane allocation is measured and gated, not claimed. See the CHANGELOG
 *    per-lane allocation table for the exact bytes/op of each resolution lane.
 *  - Concurrent-safe asynchronous resolution tracing.
 *  - Pre-allocated structures (Uint8Array flags) for the multi-binding cache.
 *  - Full integration testing lifecycle hooks (reset, unregister, clear).
 */

const VERSION = '2.0.0';

const TYPES = Object.freeze({
    VALUE: 0,
    SINGLETON: 1,
    TRANSIENT: 2,
    FACTORY: 3,
    ALIAS: 4
});

// Container lifecycle state (decision 0003). LIVE resolves normally; DRAINING is
// the teardown window (cached hits permitted, new construction rejected);
// SHUT_DOWN is terminal. Bare module-scope integers -- no property load -- so the
// hot get() lane compares this field ONCE, exactly where the single _shutdown
// boolean test used to live, and the cached-hit lane stays 0.000 B/call.
const LIVE = 0;
const DRAINING = 1;
const SHUT_DOWN = 2;

class Container {
    constructor(parent = null) {
        this._registry = new Map();
        this._singletons = new Map();

        // Multi bindings live in dedicated maps (decision 0001): _registry /
        // _singletons hold ONLY single bindings, so get()'s cache probe can
        // never see an array and the D-08 guard is unreachable by construction.
        this._multiRegistry = new Map();
        this._multiSingletons = new Map();

        // In-flight async construction promises (decision 0002 / D-03). A cached
        // async binding's build promise is memoized here BEFORE its first await
        // so N concurrent getAsync() callers share one construction; the entry is
        // evicted on settle so a rejected build is retryable, never poisoned.
        // Kept OUT of _singletons so the sync get() lane's single lookup still
        // means "a resolved value", never a raw Promise.
        this._pending = new Map();

        // Zero-allocation flag array to track explicitly undefined singletons
        this._resolvedFlags = new Map();

        this._teardowns = new Map();
        this._resolutionOrder = [];

        // Zero-GC path tracking for synchronous errors
        this._path = [];

        this._booted = false;
        this._state = LIVE;
        this._parent = parent;

        // Live child scopes, tracked as a COUNT (decision 0003 / D-13), never a
        // reference. The parent never pins a child, so a scope stays collectable
        // when dropped -- and, unlike a WeakRef, a bare integer leaves NO
        // GC-visible retention artifact (a WeakRef keeps its target alive across a
        // synchronous run, which blew the T7 heap gate by ~1.7 KB/cycle).
        // shutdown() refuses to run while a child is still live, rather than leave
        // a child holding a dead parent through _parent.
        this._liveChildren = 0;
        this._detached = false;
        if (parent !== null) parent._liveChildren++;
    }

    // =======================================================
    //  Registration (Cold Path)
    // =======================================================

    _checkBooted() {
        if (this._booted) throw new Error('Container is booted and locked.');
    }

    _isConstructable(Class) {
        return typeof Class === 'function' && !!Class.prototype;
    }

    // Cold-path builder for the "not registered" error. Restores v1 parity by
    // listing the locally available service names (DX regression restoration).
    // Only ever called on the throw branch -- never from a cached-hit lane.
    _notRegistered(name) {
        const avail = [];
        for (const k of this._registry.keys()) avail.push(String(k));
        for (const k of this._multiRegistry.keys()) avail.push(String(k));
        return new Error(`Service '${String(name)}' is not registered. Available: [${avail.join(', ')}]`);
    }

    _register(name, entry, isMulti = false) {
        this._checkBooted();

        // Token policy (D-15): a token is a non-empty string OR a symbol.
        // Cold-path only -- never reached from get().
        if (!(typeof name === 'symbol' || (typeof name === 'string' && name.length > 0))) {
            throw new TypeError('Invalid service token: a token must be a non-empty string or a symbol.');
        }

        if (isMulti) {
            if (this._registry.has(name)) {
                throw new Error(`'${String(name)}' is a single binding. Cannot append multi.`);
            }
            const existing = this._multiRegistry.get(name);
            if (existing === undefined) {
                this._multiRegistry.set(name, [entry]);
            } else {
                existing.push(entry);
            }
        } else {
            if (this._registry.has(name)) {
                throw new Error(`Service '${String(name)}' is already registered.`);
            }
            if (this._multiRegistry.has(name)) {
                throw new Error(`'${String(name)}' is a multi binding. Use multi()/multiFactory().`);
            }
            this._registry.set(name, entry);
        }
    }

    value(name, value) {
        this._register(name, {type: TYPES.VALUE, value, isAsync: false});
    }

    singleton(name, Class, deps = []) {
        if (!this._isConstructable(Class)) throw new Error(`'${name}' must be a constructable class.`);
        this._register(name, {type: TYPES.SINGLETON, Class, deps, isAsync: false, isCached: true});
    }

    transient(name, Class, deps = []) {
        if (!this._isConstructable(Class)) throw new Error(`'${name}' must be a constructable class.`);
        this._register(name, {type: TYPES.TRANSIENT, Class, deps, isAsync: false, isCached: false});
    }

    factory(name, factory) {
        if (typeof factory !== 'function') throw new TypeError(`Factory for '${String(name)}' must be a function.`);
        this._register(name, {type: TYPES.FACTORY, factory, isAsync: false, isCached: false});
    }

    factoryAsync(name, factory) {
        if (typeof factory !== 'function') throw new TypeError(`Factory for '${String(name)}' must be a function.`);
        this._register(name, {type: TYPES.FACTORY, factory, isAsync: true, isCached: false});
    }

    singletonFactory(name, factory) {
        if (typeof factory !== 'function') throw new TypeError(`Factory for '${String(name)}' must be a function.`);
        this._register(name, {type: TYPES.FACTORY, factory, isAsync: false, isCached: true});
    }

    singletonFactoryAsync(name, factory) {
        if (typeof factory !== 'function') throw new TypeError(`Factory for '${String(name)}' must be a function.`);
        this._register(name, {type: TYPES.FACTORY, factory, isAsync: true, isCached: true});
    }

    multi(name, Class, deps = []) {
        if (!this._isConstructable(Class)) throw new Error(`'${name}' must be a constructable class.`);
        this._register(name, {type: TYPES.SINGLETON, Class, deps, isAsync: false, isCached: true}, true);
    }

    multiFactory(name, factory) {
        if (typeof factory !== 'function') throw new TypeError(`Factory for '${String(name)}' must be a function.`);
        this._register(name, {type: TYPES.FACTORY, factory, isAsync: false, isCached: true}, true);
    }

    alias(aliasName, targetName) {
        this._checkBooted();
        this._register(aliasName, {type: TYPES.ALIAS, target: targetName});
    }

    onTeardown(name, fn) {
        this._teardowns.set(name, fn);
    }

    has(name) {
        return this._registry.has(name) || this._multiRegistry.has(name) ||
            (this._parent !== null && this._parent.has(name));
    }

    // Add this right next to the has() method in the Container class
    hasLocal(name) {
        return this._registry.has(name) || this._multiRegistry.has(name);
    }

    // Public read of the boot lock (D-20). Promotes the private _booted flag that
    // first-party dependents read directly, so nothing needs private state. Cold
    // getter -- never touched by the hot get() lane.
    get isBooted() {
        return this._booted;
    }

    // =======================================================
    //  Resolution (Hot Path -- see the CHANGELOG per-lane allocation table)
    // =======================================================

    get(name) {
        if (this._state === SHUT_DOWN) throw new Error('Container shut down.');
        if (this._singletons.has(name)) return this._singletons.get(name);

        const entry = this._registry.get(name);

        if (entry === undefined) {
            // Cold miss. A multi name never lands in _singletons (decision 0001),
            // so its "is multi" rejection is structural and lives HERE, off the
            // cached-hit lane -- fixing D-08 without touching the hot body.
            if (this._multiRegistry.has(name)) throw new Error(`'${String(name)}' is multi. Use getAll().`);
            if (this._parent !== null) return this._parent.get(name);
            throw this._notRegistered(name);
        }

        if (entry.isAsync) throw new Error(`'${name}' is async. Use getAsync().`);

        // Drain rule (decision 0003 / D-12): during DRAINING a teardown may read a
        // CACHED collaborator (returned above) but must not build a NEW instance --
        // that would push a name onto _resolutionOrder mid-walk and resurrect a
        // cache the walk is about to release. VALUE/ALIAS pass (they neither build
        // nor push order). Cold path: reached only on a cache MISS, never on a hit.
        if (this._state === DRAINING && entry.type !== TYPES.VALUE && entry.type !== TYPES.ALIAS) {
            throw new Error(`Container is draining: cannot construct '${String(name)}' during teardown.`);
        }

        // Cycle check must occur before push to avoid throwing immediately on the current node
        if (this._path.indexOf(name) !== -1) {
            throw new Error(`Circular dependency detected: ${this._path.join(' -> ')} -> ${name}`);
        }

        // Token pushed before alias/value resolution to ensure inclusion in traces
        this._path.push(name);
        let instance;
        try {
            if (entry.type === TYPES.ALIAS) return this.get(entry.target);
            if (entry.type === TYPES.VALUE) return entry.value;

            if (entry.type === TYPES.TRANSIENT || entry.type === TYPES.SINGLETON) {
                const len = entry.deps.length;
                const args = new Array(len);
                for (let i = 0; i < len; i++) args[i] = this.get(entry.deps[i]);
                instance = new entry.Class(...args);
            } else if (entry.type === TYPES.FACTORY) {
                instance = entry.factory(this);
            } else {
                // Fail closed (v1 parity): a corrupt _registry entry with an
                // unrecognised type must throw, never silently return undefined.
                throw new Error(`Service '${String(name)}' has an unknown type: ${String(entry.type)}.`);
            }
        } finally {
            this._path.pop();
        }

        if (entry.isCached) {
            this._singletons.set(name, instance);
            this._resolutionOrder.push(name);
        }

        return instance;
    }

    getAsync(name) {
        // Public entry point (decision 0002, option B). One fresh per-resolution
        // context is created here and carried through every frame -- including
        // factory re-entries -- so a cross-factory cycle is on ONE path (D-02)
        // and an unrelated tree resolved concurrently cannot contaminate this
        // trace. The sync get() lane is untouched.
        return this._resolveAsync(name, { path: [] });
    }

    // Synchronous prologue + promise dispatch. NOT async on purpose: the cycle
    // check and the _pending memoization must run synchronously, before any
    // await, so concurrent callers observe one in-flight promise. Returns a
    // promise on every path.
    _resolveAsync(name, ctx) {
        if (this._state === SHUT_DOWN) return Promise.reject(new Error('Container shut down.'));
        if (this._singletons.has(name)) return Promise.resolve(this._singletons.get(name));

        const entry = this._registry.get(name);
        if (entry === undefined) {
            if (this._multiRegistry.has(name)) {
                return Promise.reject(new Error(`'${String(name)}' is multi. Use getAllAsync().`));
            }
            if (this._parent !== null) return this._parent._resolveAsync(name, ctx);
            return Promise.reject(this._notRegistered(name));
        }

        // Cycle check BEFORE the pending probe: a name already on this
        // resolution's path is a cycle even though its own in-flight promise is
        // in _pending; returning that promise here would DEADLOCK (it awaits a
        // subtree that awaits it) -- a hang, not the rejection D-02 requires.
        if (ctx.path.indexOf(name) !== -1) {
            return Promise.reject(new Error(`Circular async dependency: ${ctx.path.join(' -> ')} -> ${name}`));
        }

        // Drain rule (decision 0003 / D-12), async lane: reject NEW construction
        // during DRAINING. VALUE/ALIAS pass; cached hits returned above.
        if (this._state === DRAINING && entry.type !== TYPES.VALUE && entry.type !== TYPES.ALIAS) {
            return Promise.reject(new Error(`Container is draining: cannot construct '${String(name)}' during teardown.`));
        }

        // In-flight promise memoization (D-03): concurrent callers of a cached
        // async binding share ONE construction.
        if (entry.isCached && this._pending.has(name)) return this._pending.get(name);

        const p = this._buildAsync(name, entry, ctx);
        if (entry.isCached) {
            this._pending.set(name, p);
            // Evict on settle (resolve OR reject). On resolve the value is
            // already in _singletons; on reject nothing is cached, so a retry
            // rebuilds -- no poisoned promise.
            const evict = () => { this._pending.delete(name); };
            p.then(evict, evict);
        }
        return p;
    }

    async _buildAsync(name, entry, ctx) {
        ctx.path.push(name);
        let instance;
        try {
            if (entry.type === TYPES.ALIAS) return await this._resolveAsync(entry.target, ctx);
            if (entry.type === TYPES.VALUE) return entry.value;

            if (entry.type === TYPES.TRANSIENT || entry.type === TYPES.SINGLETON) {
                const len = entry.deps.length;
                const args = new Array(len);
                for (let i = 0; i < len; i++) args[i] = this._resolveAsync(entry.deps[i], ctx);
                const resolvedArgs = await Promise.all(args);
                instance = new entry.Class(...resolvedArgs);
            } else if (entry.type === TYPES.FACTORY) {
                // The factory receives a context-bound facade: its getAsync /
                // getAllAsync re-enter with THIS resolution's path, so a
                // cross-factory call inherits the caller's trace (D-02).
                instance = await entry.factory(this._asyncFacade(ctx));
            } else {
                // Fail closed (v1 parity): a corrupt _registry entry with an
                // unrecognised type must throw, never silently return undefined.
                throw new Error(`Service '${String(name)}' has an unknown type: ${String(entry.type)}.`);
            }
        } finally {
            ctx.path.pop();
        }

        if (entry.isCached) {
            // If the container was shut down while this build was in flight
            // (decision 0003), return the value to the caller but do NOT
            // resurrect the released caches -- retention must stay at zero.
            if (this._state === SHUT_DOWN) return instance;
            // Symmetry with the sync lane: an undefined result IS cached, so the
            // factory runs exactly once even when it returns undefined.
            this._singletons.set(name, instance);
            this._resolutionOrder.push(name);
        }

        return instance;
    }

    // A per-resolution facade for factory callbacks. It delegates every sync
    // method (get, has, ...) to the container through its prototype, and
    // overrides only the async entries to re-enter with the caller's ctx.
    _asyncFacade(ctx) {
        const self = this;
        const f = Object.create(this);
        f.getAsync = (name) => self._resolveAsync(name, ctx);
        f.getAllAsync = (name) => self._resolveAllAsync(name, ctx);
        return f;
    }

    getAll(name) {
        // D-10: getAll respects the shut-down guard, exactly as get() does.
        if (this._state === SHUT_DOWN) throw new Error('Container shut down.');
        const entries = this._multiRegistry.get(name);
        if (entries === undefined) {
            if (this._registry.has(name)) return [this.get(name)];
            if (this._parent !== null) return this._parent.getAll(name);
            throw this._notRegistered(name);
        }

        // Drain rule (decision 0003 / D-12): a first-time multi resolution pushes
        // the name onto _resolutionOrder; reject it during DRAINING so a teardown
        // cannot resurrect a released cache mid-walk. An already-cached multi
        // (cacheArr present) never re-pushes, so it is permitted.
        if (this._state === DRAINING && this._multiSingletons.get(name) === undefined) {
            throw new Error(`Container is draining: cannot construct multi '${String(name)}' during teardown.`);
        }

        // Cycle detection (D-11): push the multi name onto the same path the
        // single lane uses, BEFORE resolving any entry, so a cycle re-entering
        // through this multi name is caught and named in the trace.
        if (this._path.indexOf(name) !== -1) {
            throw new Error(`Circular dependency detected: ${this._path.join(' -> ')} -> ${name}`);
        }

        this._path.push(name);
        let instances;
        try {
            const len = entries.length;
            instances = new Array(len);

            let cacheArr = this._multiSingletons.get(name);
            let flags = this._resolvedFlags.get(name);

            if (cacheArr === undefined) {
                cacheArr = new Array(len);
                flags = new Uint8Array(len); // Zero-object tracking for undefined singletons
                this._multiSingletons.set(name, cacheArr);
                this._resolvedFlags.set(name, flags);
                this._resolutionOrder.push(name);
            }

            for (let i = 0; i < len; i++) {
                const entry = entries[i];
                if (entry.isAsync) throw new Error(`Multi-binding '${name}' contains async targets.`);

                if (entry.isCached && flags[i] === 1) {
                    instances[i] = cacheArr[i];
                    continue;
                }

                let instance;
                if (entry.type === TYPES.SINGLETON || entry.type === TYPES.TRANSIENT) {
                    const depLen = entry.deps.length;
                    const args = new Array(depLen);
                    for (let j = 0; j < depLen; j++) args[j] = this.get(entry.deps[j]);
                    instance = new entry.Class(...args);
                } else if (entry.type === TYPES.FACTORY) {
                    instance = entry.factory(this);
                }

                instances[i] = instance;
                if (entry.isCached) {
                    cacheArr[i] = instance;
                    flags[i] = 1;
                }
            }
        } finally {
            this._path.pop();
        }

        return instances;
    }

    // Fill-into-caller-buffer form of getAll (D-17, decision alpha.6). The
    // ecosystem idiom (query(q, out) in lite-bvh): the caller owns the output
    // array, so a fully-cached multi resolves with ZERO bytes/call -- no fresh
    // result array per call the way getAll() allocates. Returns the number of
    // slots written (out may be longer than the binding). Out-of-bounds policy,
    // fail closed: a non-array out is a TypeError; an out shorter than the
    // binding is a RangeError -- both thrown before any resolution, both cold
    // (they build a message only when they fire, off the happy path). There is
    // NO async form: getAllAsync stays the async lane (it allocates a promise
    // per frame by construction, so a fill-into buffer cannot make it zero).
    getAllInto(name, out) {
        if (this._state === SHUT_DOWN) throw new Error('Container shut down.');
        if (!Array.isArray(out)) {
            throw new TypeError(`getAllInto: out must be an array, got ${typeof out}.`);
        }

        const entries = this._multiRegistry.get(name);
        if (entries === undefined) {
            if (this._registry.has(name)) {
                if (out.length < 1) {
                    throw new RangeError(`getAllInto: out length ${out.length} is too short for '${String(name)}' (1 entry).`);
                }
                out[0] = this.get(name);
                return 1;
            }
            if (this._parent !== null) return this._parent.getAllInto(name, out);
            throw this._notRegistered(name);
        }

        const len = entries.length;
        if (out.length < len) {
            throw new RangeError(`getAllInto: out length ${out.length} is too short for multi '${String(name)}' (${len} entries).`);
        }

        // Drain rule (decision 0003 / D-12): reject a first-time multi resolution
        // during DRAINING; an already-cached multi never re-pushes and is allowed.
        if (this._state === DRAINING && this._multiSingletons.get(name) === undefined) {
            throw new Error(`Container is draining: cannot construct multi '${String(name)}' during teardown.`);
        }

        // Cycle detection (D-11): push the multi name before resolving any entry.
        if (this._path.indexOf(name) !== -1) {
            throw new Error(`Circular dependency detected: ${this._path.join(' -> ')} -> ${name}`);
        }

        this._path.push(name);
        try {
            let cacheArr = this._multiSingletons.get(name);
            let flags = this._resolvedFlags.get(name);

            if (cacheArr === undefined) {
                cacheArr = new Array(len);
                flags = new Uint8Array(len);
                this._multiSingletons.set(name, cacheArr);
                this._resolvedFlags.set(name, flags);
                this._resolutionOrder.push(name);
            }

            for (let i = 0; i < len; i++) {
                const entry = entries[i];
                if (entry.isAsync) throw new Error(`Multi-binding '${name}' contains async targets.`);

                if (entry.isCached && flags[i] === 1) {
                    out[i] = cacheArr[i];
                    continue;
                }

                let instance;
                if (entry.type === TYPES.SINGLETON || entry.type === TYPES.TRANSIENT) {
                    const depLen = entry.deps.length;
                    const args = new Array(depLen);
                    for (let j = 0; j < depLen; j++) args[j] = this.get(entry.deps[j]);
                    instance = new entry.Class(...args);
                } else if (entry.type === TYPES.FACTORY) {
                    instance = entry.factory(this);
                }

                out[i] = instance;
                if (entry.isCached) {
                    cacheArr[i] = instance;
                    flags[i] = 1;
                }
            }
        } finally {
            this._path.pop();
        }

        return len;
    }

    getAllAsync(name) {
        // Public entry point: one fresh per-resolution context (decision 0002).
        return this._resolveAllAsync(name, { path: [] });
    }

    async _resolveAllAsync(name, ctx) {
        // D-10: getAllAsync respects the shut-down guard, exactly as getAsync does.
        if (this._state === SHUT_DOWN) throw new Error('Container shut down.');
        const entries = this._multiRegistry.get(name);
        if (entries === undefined) {
            if (this._registry.has(name)) return [await this._resolveAsync(name, ctx)];
            if (this._parent !== null) return this._parent._resolveAllAsync(name, ctx);
            throw this._notRegistered(name);
        }

        // Drain rule (decision 0003 / D-12): reject a first-time multi resolution
        // during DRAINING (see getAll).
        if (this._state === DRAINING && this._multiSingletons.get(name) === undefined) {
            throw new Error(`Container is draining: cannot construct multi '${String(name)}' during teardown.`);
        }

        // Cycle detection (D-11): push the multi name before resolving entries.
        if (ctx.path.indexOf(name) !== -1) {
            throw new Error(`Circular async dependency: ${ctx.path.join(' -> ')} -> ${name}`);
        }

        ctx.path.push(name);
        let instances;
        try {
            const len = entries.length;
            instances = new Array(len);

            let cacheArr = this._multiSingletons.get(name);
            let flags = this._resolvedFlags.get(name);

            if (cacheArr === undefined) {
                cacheArr = new Array(len);
                flags = new Uint8Array(len);
                this._multiSingletons.set(name, cacheArr);
                this._resolvedFlags.set(name, flags);
                this._resolutionOrder.push(name);
            }

            for (let i = 0; i < len; i++) {
                const entry = entries[i];

                if (entry.isCached && flags[i] === 1) {
                    instances[i] = cacheArr[i];
                    continue;
                }

                let instance;
                if (entry.type === TYPES.SINGLETON || entry.type === TYPES.TRANSIENT) {
                    const depLen = entry.deps.length;
                    const args = new Array(depLen);
                    for (let j = 0; j < depLen; j++) args[j] = this._resolveAsync(entry.deps[j], ctx);
                    const resolvedArgs = await Promise.all(args);
                    instance = new entry.Class(...resolvedArgs);
                } else if (entry.type === TYPES.FACTORY) {
                    instance = await entry.factory(this._asyncFacade(ctx));
                }

                instances[i] = instance;
                if (entry.isCached) {
                    cacheArr[i] = instance;
                    flags[i] = 1;
                }
            }
        } finally {
            ctx.path.pop();
        }

        return instances;
    }

    // =======================================================
    //  Lifecycle & Validation
    // =======================================================

    scope() {
        return new Container(this);
    }

    boot() {
        if (this._booted) return;
        this._detectCycles();
        this._validateWiring();
        this._booted = true;
    }

    // Boot-time graph validation (D-07): walk every entry's deps and every ALIAS
    // target; a name that is not registered locally AND not resolvable through
    // the parent chain is a wiring error. Collect ALL errors, throw ONE message.
    // Cold path -- never reached from get().
    _validateWiring() {
        const errors = [];
        for (const [name, entry] of this._registry) {
            if (entry.type === TYPES.ALIAS) {
                if (!this.has(entry.target)) {
                    errors.push(`Alias '${String(name)}' target '${String(entry.target)}' is not registered.`);
                }
            } else if (entry.deps) {
                for (let i = 0; i < entry.deps.length; i++) {
                    if (!this.has(entry.deps[i])) {
                        errors.push(`Dependency '${String(entry.deps[i])}' is not registered.`);
                    }
                }
            }
        }
        for (const [, entries] of this._multiRegistry) {
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                if (e.deps) {
                    for (let j = 0; j < e.deps.length; j++) {
                        if (!this.has(e.deps[j])) {
                            errors.push(`Dependency '${String(e.deps[j])}' is not registered.`);
                        }
                    }
                }
            }
        }
        if (errors.length > 0) {
            throw new Error('Boot validation failed:\n  ' + errors.join('\n  '));
        }
    }

    async bootAsync() {
        this.boot();
        const promises = [];

        for (const [name, entry] of this._registry.entries()) {
            if (entry.isAsync && entry.isCached) promises.push(this.getAsync(name));
        }
        for (const [name, entries] of this._multiRegistry.entries()) {
            let needsBoot = false;
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].isAsync && entries[i].isCached) {
                    needsBoot = true;
                    break;
                }
            }
            if (needsBoot) promises.push(this.getAllAsync(name));
        }
        await Promise.all(promises);
    }

    _detectCycles() {
        const visiting = new Set();
        const visited = new Set();

        const visit = (name) => {
            if (visiting.has(name)) throw new Error(`Boot circular dependency: ${name}`);
            if (visited.has(name)) return;

            visiting.add(name);
            const single = this._registry.get(name);
            const entries = single !== undefined ? [single] : this._multiRegistry.get(name);

            if (entries) {
                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    if (e.type === TYPES.ALIAS) visit(e.target);
                    else if (e.deps) {
                        for (let j = 0; j < e.deps.length; j++) visit(e.deps[j]);
                    }
                }
            }

            visiting.delete(name);
            visited.add(name);
        };

        for (const name of this._registry.keys()) visit(name);
        for (const name of this._multiRegistry.keys()) visit(name);
    }

    // Detach this scope from its parent's live-child count. Idempotent: a scope
    // drains its parent exactly once even if both shutdown() and clear() run.
    _detachFromParent() {
        if (this._parent !== null && !this._detached) {
            this._detached = true;
            this._parent._liveChildren--;
        }
    }

    /**
     * Tear down the container (decision 0003). Two-phase: DRAINING permits a
     * teardown to read a cached collaborator but rejects new construction; the
     * walk fires teardowns in reverse resolution order (a dependency after its
     * dependents); then the container flips to SHUT_DOWN and releases all
     * retained state. Never writes to console. Does NOT cascade to child scopes;
     * throws if a child scope is still live. Rejects with an AggregateError if
     * any teardown threw and no onTeardownError hook was supplied.
     *
     * @param {{ onTeardownError?: (error: unknown, name: (string|symbol)) => void }} [options]
     */
    async shutdown(options) {
        // Idempotent: a second shutdown() (or one during the drain) re-runs
        // nothing. D-13: double shutdown() is a no-op.
        if (this._state !== LIVE) return;

        let onTeardownError;
        if (options !== undefined) {
            for (const k of Object.keys(options)) {
                if (k !== 'onTeardownError') {
                    throw new Error(`shutdown: unknown option '${k}'. Did you mean 'onTeardownError'?`);
                }
            }
            onTeardownError = options.onTeardownError;
            if (onTeardownError !== undefined && typeof onTeardownError !== 'function') {
                throw new TypeError('shutdown: onTeardownError must be a function.');
            }
        }

        // Law 4: a child owns its lifetime. Refuse to shut down while a child is
        // live rather than leave it holding a dead parent. Checked BEFORE any
        // state flip so the container stays usable and the caller can drain the
        // child and retry.
        if (this._liveChildren > 0) {
            throw new Error(`Cannot shut down: ${this._liveChildren} child scope(s) still live. Shut down children first.`);
        }

        this._state = DRAINING;
        let errors = null;

        for (let i = this._resolutionOrder.length - 1; i >= 0; i--) {
            const name = this._resolutionOrder[i];
            const instances = this._singletons.has(name)
                ? this._singletons.get(name)
                : this._multiSingletons.get(name);
            if (!instances) continue;

            const targets = Array.isArray(instances) ? instances : [instances];
            const flags = this._resolvedFlags.get(name);

            for (let j = 0; j < targets.length; j++) {
                // Prevent teardown on undefined targets if they weren't explicitly resolved as cached singletons
                if (targets[j] === undefined && (!flags || flags[j] !== 1)) continue;

                const instance = targets[j];
                if (!instance) continue;

                try {
                    if (this._teardowns.has(name)) await this._teardowns.get(name)(instance);
                    else if (Symbol.asyncDispose && typeof instance[Symbol.asyncDispose] === 'function') await instance[Symbol.asyncDispose]();
                    else if (Symbol.dispose && typeof instance[Symbol.dispose] === 'function') instance[Symbol.dispose]();
                    else if (typeof instance.close === 'function') await instance.close();
                    else if (typeof instance.destroy === 'function') await instance.destroy();
                } catch (err) {
                    // D-12: never console. Isolation preserved -- a thrower does
                    // not stop its siblings. Route to the hook, or collect.
                    if (onTeardownError !== undefined) onTeardownError(err, name);
                    else {
                        if (errors === null) errors = [];
                        errors.push(err);
                    }
                }
            }
        }

        this._state = SHUT_DOWN;

        // D-13: release all retained state after the walk. _registry is kept
        // (the wiring is still described; only the instances are gone).
        this._singletons.clear();
        this._multiSingletons.clear();
        this._resolvedFlags.clear();
        this._resolutionOrder.length = 0;
        this._teardowns.clear();
        this._pending.clear();
        this._detachFromParent();

        if (errors !== null) {
            throw new AggregateError(errors, `shutdown: ${errors.length} teardown(s) failed.`);
        }
    }

    // =======================================================
    //  Testing Hooks
    // =======================================================

    reset() {
        this._booted = false;
        this._state = LIVE;
        this._singletons.clear();
        this._multiSingletons.clear();
        this._resolvedFlags.clear();
        this._resolutionOrder.length = 0;
        this._path.length = 0; // D-16: never leave a stale resolution frame
    }

    unregister(name) {
        this._checkBooted();
        this._registry.delete(name);
        this._multiRegistry.delete(name);
        this._singletons.delete(name);
        this._multiSingletons.delete(name);
        this._resolvedFlags.delete(name);
        // D-09: splice the resolution order so a re-register cannot double the
        // teardown contract. orderInvariant enforces this.
        const idx = this._resolutionOrder.indexOf(name);
        if (idx !== -1) this._resolutionOrder.splice(idx, 1);
    }

    clear() {
        this._checkBooted();
        this._registry.clear();
        this._multiRegistry.clear();
        this._singletons.clear();
        this._multiSingletons.clear();
        this._resolvedFlags.clear();
        this._teardowns.clear();
        this._resolutionOrder.length = 0;
        this._path.length = 0; // D-16
        this._state = LIVE;
        this._detachFromParent(); // a cleared scope is no longer live to its parent
    }
}

export {Container, TYPES, VERSION};
