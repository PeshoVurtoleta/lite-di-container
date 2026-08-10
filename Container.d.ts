/**
 * Container.js -- Dependency Injection Container (v2.0.0)
 *
 * Every declaration below has a corresponding runtime member on
 * Container.prototype, and every public runtime member is declared here. A named
 * test pins Object.getOwnPropertyNames(Container.prototype) so this file cannot
 * drift from the implementation.
 */

/**
 * The registry entry-type tags. Integer literals (2.0.0 breaking change from the
 * v1 string tags), frozen. `ALIAS` is included.
 */
export const TYPES: {
    readonly VALUE: 0;
    readonly SINGLETON: 1;
    readonly TRANSIENT: 2;
    readonly FACTORY: 3;
    readonly ALIAS: 4;
};

/** The package version. Kept in three-place sync with package.json and CHANGELOG. */
export const VERSION: string;

/**
 * A generic type representing a constructable class or constructor function.
 */
export type Constructor<T = any> = new (...args: any[]) => T;

/**
 * A service token. A token is a non-empty string or a symbol; anything else is
 * rejected with a TypeError at registration (D-15).
 */
export type Token = string | symbol;

/**
 * The integer entry-type tag of a snapshot node -- one of the {@link TYPES}
 * values (`0 | 1 | 2 | 3 | 4`).
 */
export type NodeKind = typeof TYPES[keyof typeof TYPES];

/**
 * An internal registry-entry object -- the shape the registrars store and the
 * form {@link Container.rebind} accepts (decision 0005). The `type` tag selects
 * which fields are meaningful: VALUE carries `value`; SINGLETON/TRANSIENT carry
 * `Class` + `deps`; FACTORY carries `factory`; ALIAS carries `target`. `isAsync`
 * / `isCached` mirror the resolution lane the registrars set. Construct one by
 * hand when hot-swapping a single token post-boot.
 */
export interface RegistryEntry {
    type: NodeKind;
    value?: any;
    Class?: Constructor;
    deps?: Token[];
    factory?: (container: Container) => any;
    target?: Token;
    isAsync?: boolean;
    isCached?: boolean;
}

/**
 * One node of a {@link Container.describe} snapshot. There is one node per
 * single registration and one per multi-binding entry (so a multi token appears
 * once per registered entry). `deps` is the declared constructor dependency list
 * in order.
 *
 * FACTORY and VALUE nodes carry no declared dependencies -- a factory's deps live
 * in its closure and a value is opaque -- so their `deps` is `[]` and they are
 * flagged `opaqueDeps: true`. An ALIAS node additionally carries the `target` it
 * resolves to (its edge to the target is not a teardown edge).
 */
export interface DescribeNode {
    /** The registration token. */
    token: Token;
    /** The integer entry-type tag ({@link TYPES}). */
    kind: NodeKind;
    /** Declared constructor dependencies, in order. Always `[]` for FACTORY/VALUE/ALIAS. */
    deps: Token[];
    /** Present and `true` when deps are unknowable (FACTORY closure / opaque VALUE). */
    opaqueDeps?: true;
    /** Present on ALIAS nodes: the token this alias resolves to. */
    target?: Token;
}

/**
 * A directed dependency edge of a {@link Container.describe} snapshot, derived
 * from a node's declared deps or from an alias to its target.
 */
export interface DescribeEdge {
    /** The dependent token. */
    from: Token;
    /** The depended-upon token. */
    to: Token;
}

/**
 * The read-only snapshot returned by {@link Container.describe}. Allocated fresh
 * on every call (a cold path).
 */
export interface DescribeSnapshot {
    /** Every registration as a node (single registrations plus each multi entry). */
    nodes: DescribeNode[];
    /** Directed edges from each node's deps and each alias to its target. */
    edges: DescribeEdge[];
    /**
     * The predicted teardown order of CACHED instances: a recomputed topological
     * (post-order) list of exactly the tokens that {@link Container.shutdown} tears
     * down, which walks this order in REVERSE. It mirrors `_resolutionOrder`
     * precisely -- only cached bindings (singleton, singletonFactory/-Async, and
     * every multi) enter it. TRANSIENT and plain (non-cached) FACTORY nodes, along
     * with VALUE and ALIAS, appear in `nodes`/`edges` (the full DAG) but NEVER in
     * `order`, because they are never cached and never torn down.
     */
    order: Token[];
}

export class Container {
    /**
     * Create a container. Pass no argument for a root; {@link scope} builds a
     * child.
     */
    constructor();

    // =======================================================
    //  Registration (cold path)
    // =======================================================

    /**
     * Register a raw value (config object, 3rd-party module, primitive). Returned
     * as-is on every get() -- no instantiation.
     *
     * @param name The unique service token.
     * @param definition The raw value to register.
     */
    value(name: Token, definition: any): void;

    /**
     * Register a class instantiated once on first get(); later get()s return the
     * cached instance.
     *
     * @param name The unique service token.
     * @param definition The class or constructor function (must be constructable).
     * @param dependencies Service tokens injected into the constructor, in order.
     */
    singleton<T = any>(name: Token, definition: Constructor<T>, dependencies?: Token[]): void;

    /**
     * Register a class instantiated fresh on every get(). A transient with N deps
     * allocates by construction -- see the Zero-GC allocation table.
     *
     * @param name The unique service token.
     * @param definition The class or constructor function (must be constructable).
     * @param dependencies Service tokens injected into the constructor, in order.
     */
    transient<T = any>(name: Token, definition: Constructor<T>, dependencies?: Token[]): void;

    /**
     * Register a factory called on every get(). The factory receives the
     * container as its only argument. Not cached.
     *
     * @param name The unique service token.
     * @param fn The factory function (a TypeError is thrown at registration if it
     *   is not a function).
     */
    factory<T = any>(name: Token, fn: (container: Container) => T): void;

    /**
     * Register an async factory called on every getAsync(). Not cached.
     *
     * @param name The unique service token.
     * @param fn The async factory function.
     */
    factoryAsync<T = any>(name: Token, fn: (container: Container) => T | Promise<T>): void;

    /**
     * Register a factory whose result is cached after the first get() (a
     * factory-built singleton).
     *
     * @param name The unique service token.
     * @param fn The factory function.
     */
    singletonFactory<T = any>(name: Token, fn: (container: Container) => T): void;

    /**
     * Register an async factory whose resolved value is cached after the first
     * getAsync(). Concurrent getAsync() callers share one in-flight construction
     * (D-03); a rejected build is evicted and retryable.
     *
     * @param name The unique service token.
     * @param fn The async factory function.
     */
    singletonFactoryAsync<T = any>(name: Token, fn: (container: Container) => T | Promise<T>): void;

    /**
     * Append a class to a multi-binding under `name`. Resolve the whole group with
     * {@link getAll} / {@link getAllInto}. A multi name and a single binding under
     * the same name are mutually exclusive.
     *
     * @param name The multi-binding token.
     * @param definition The class or constructor function (must be constructable).
     * @param dependencies Service tokens injected into the constructor, in order.
     */
    multi<T = any>(name: Token, definition: Constructor<T>, dependencies?: Token[]): void;

    /**
     * Append a factory to a multi-binding under `name`.
     *
     * @param name The multi-binding token.
     * @param fn The factory function (a TypeError is thrown at registration if it
     *   is not a function).
     */
    multiFactory<T = any>(name: Token, fn: (container: Container) => T): void;

    /**
     * Register `aliasName` as another name for `targetName`. Resolving the alias
     * resolves the target. Aliases to nothing are boot-time wiring errors.
     *
     * @param aliasName The alias token.
     * @param targetName The token the alias resolves to.
     */
    alias(aliasName: Token, targetName: Token): void;

    /**
     * Register a teardown hook for `name`, invoked with the resolved instance
     * during {@link shutdown} in reverse resolution order. When absent, shutdown
     * falls back to `Symbol.asyncDispose` / `Symbol.dispose` / `close` / `destroy`.
     *
     * @param name The service token whose instance to tear down.
     * @param fn The teardown function, receiving the resolved instance.
     */
    onTeardown<T = any>(name: Token, fn: (instance: T) => void | Promise<void>): void;

    // =======================================================
    //  Resolution (hot path)
    // =======================================================

    /**
     * Resolve a service by token. A cached-singleton / value hit allocates zero
     * bytes (see the Zero-GC allocation table).
     *
     * @param name The registered service token.
     * @returns The resolved service.
     */
    get<T = any>(name: Token): T;

    /**
     * Resolve a service that may build asynchronously. One per-resolution context
     * is created here and carried through every frame, including factory
     * re-entries, so cross-factory cycles are detected (D-02).
     *
     * @param name The registered service token.
     * @returns A promise for the resolved service.
     */
    getAsync<T = any>(name: Token): Promise<T>;

    /**
     * Resolve every binding registered under a multi name, allocating a fresh
     * result array on every call. See {@link getAllInto} for the zero-allocation
     * fill-into-caller-buffer form.
     *
     * @param name The multi-binding token.
     * @returns A new array of every resolved instance.
     */
    getAll<T = any>(name: Token): T[];

    /**
     * Fill-into-caller-buffer form of {@link getAll} (D-17). The caller owns
     * `out`, so a fully-cached multi resolves with zero bytes allocated per call
     * -- the ecosystem's `query(q, out)` idiom. Writes each resolved instance
     * into `out[i]` and returns the number of slots written (`out` may be longer
     * than the binding).
     *
     * Out-of-bounds policy (fail closed): a non-array `out` throws a `TypeError`;
     * an `out` shorter than the binding throws a `RangeError`. There is no async
     * form -- the async lane allocates a promise per frame by construction.
     *
     * @param name The multi-binding token.
     * @param out The caller-owned array to fill. Must be at least as long as the
     *   number of registered entries.
     * @returns The number of slots written.
     * @throws {TypeError} if `out` is not an array.
     * @throws {RangeError} if `out` is shorter than the binding.
     */
    getAllInto<T = any>(name: Token, out: T[]): number;

    /**
     * Async form of {@link getAll}. Allocates a fresh result array and a promise
     * per frame by construction.
     *
     * @param name The multi-binding token.
     * @returns A promise for a new array of every resolved instance.
     */
    getAllAsync<T = any>(name: Token): Promise<T[]>;

    /**
     * Check if a service is registered (walking the parent scope chain) without
     * resolving it.
     *
     * @param name The service token to check.
     * @returns `true` if registered here or in any parent.
     */
    has(name: Token): boolean;

    /**
     * Check if a service is registered on THIS container only, without walking the
     * parent scope chain (D-20). The public form of the internal registry read
     * that first-party reactive dependents relied on.
     *
     * @param name The service token to check.
     * @returns `true` if registered locally, `false` otherwise.
     */
    hasLocal(name: Token): boolean;

    /**
     * Whether {@link boot} has locked the container (D-20). The public form of the
     * internal boot flag that first-party dependents read to gate static topology
     * violations. `reset()` and `clear()` return it to `false`.
     */
    readonly isBooted: boolean;

    // =======================================================
    //  Introspection (cold path)
    // =======================================================

    /**
     * Return a fresh, read-only snapshot of the dependency graph:
     * `{ nodes, edges, order }`. Purely additive and cold -- it touches no
     * hot-path field and allocates a new snapshot on every call.
     *
     * `nodes` has one entry per single registration and one per multi-binding
     * entry; FACTORY/VALUE nodes report `deps: []` with `opaqueDeps: true`, and
     * ALIAS nodes carry their `target`. `edges` are `{ from, to }` derived from
     * declared deps and alias targets. `order` is a recomputed topological
     * (post-order) list of exactly the CACHED tokens {@link shutdown} tears down
     * (reverse of this order) -- boot stores none -- so TRANSIENT, plain FACTORY,
     * VALUE and ALIAS nodes appear in `nodes`/`edges` but never in `order`.
     *
     * @returns The graph snapshot.
     * @throws {Error} if the container is not booted (fail closed -- the graph is
     *   only meaningful after {@link boot}), or if a cycle is somehow present
     *   (which cannot happen post-boot, since boot would have thrown).
     */
    describe(): DescribeSnapshot;

    // =======================================================
    //  Validation & boot
    // =======================================================

    /**
     * Validate the whole dependency graph, then lock the container. Detects
     * circular dependency chains and unregistered dependency / alias targets,
     * collecting every wiring error into one thrown message. Idempotent: a second
     * boot() is a no-op. Does not return the container (2.0.0 breaking change from
     * v1's chaining).
     *
     * @throws {Error} if the graph has a cycle or any unregistered wiring.
     */
    boot(): void;

    /**
     * boot() the container, then eagerly resolve every cached async binding
     * exactly once (concurrent construction is deduped via the in-flight promise
     * cache, D-03).
     *
     * @returns A promise that resolves once every cached async binding is built.
     */
    bootAsync(): Promise<void>;

    // =======================================================
    //  Lifecycle
    // =======================================================

    /**
     * Create a child scope. A child resolves an un-overridden binding from its
     * parent, gets the parent's instance (recorded in the parent, torn down by the
     * parent), and never writes into a parent's caches. A child owns its own
     * lifetime: shut it down before its parent.
     */
    scope(): Container;

    /**
     * Gracefully tear down the container. Two-phase: teardown hooks run in reverse
     * resolution order (a dependency is torn down after its dependents) while the
     * container is DRAINING (a teardown may resolve an already-cached collaborator,
     * but constructing a new service is rejected); then all retained state is
     * released. Never writes to `console`. Does NOT cascade to child scopes.
     * Double shutdown() is a no-op.
     *
     * @param options.onTeardownError Invoked with `(error, name)` for each failing
     *   teardown. When supplied it suppresses the AggregateError.
     * @returns A promise that resolves once every teardown has run and state has
     *   been released.
     * @throws {Error} (rejects) if a child scope is still live, or on an unknown
     *   option key.
     * @throws {AggregateError} (rejects) after all teardowns have run, if any threw
     *   and no `onTeardownError` hook was supplied.
     */
    shutdown(options?: {
        onTeardownError?: (error: unknown, name: string | symbol) => void;
    }): Promise<void>;

    // =======================================================
    //  Post-boot hot-swap (decision 0005 -- Reading B)
    // =======================================================

    /**
     * Flush a single cached instance so the next {@link get} re-resolves fresh from
     * the SAME registration (decision 0005). Topology is unchanged, so boot's
     * graph-validation invariant is preserved. Single-token: a dependent already
     * built with `name` still holds the OLD instance -- 2.2 does NOT cascade
     * (that is the supervisor's job). Async because a teardown may be async.
     *
     * Removes the cached instance(s) from the singleton (or multi) cache, evicts
     * any in-flight async build memo first (so a racing build cannot re-cache a
     * stale instance), splices `name` out of the resolution order (no double
     * teardown), and runs the teardown ladder on the flushed instance(s).
     *
     * Fails closed: throws if the container is not live, if `name` is registered
     * neither as a single nor a multi binding, or if `name` is mid-resolution.
     * Invalidating a registered-but-never-resolved name is a safe no-op.
     *
     * @param name The service token to flush.
     */
    invalidate(name: Token): Promise<void>;

    /**
     * Atomically swap the registration for a single token on a booted container,
     * then {@link invalidate} it, so the next {@link get} re-resolves from the new
     * entry (decision 0005 -- Reading B: constrained post-boot hot-swap). All five
     * checks run BEFORE any mutation, so on any failure the registry is atomically
     * untouched: the container is live; `name` is not mid-resolution; same kind
     * (the existing registration is a single binding -- a single cannot become a
     * multi or vice-versa); every dependency / alias target of the new entry is
     * already registered; the new entry introduces no cycle.
     *
     * @param name The single-token registration to replace.
     * @param entry The internal registry-entry object to install.
     */
    rebind(name: Token, entry: RegistryEntry): Promise<void>;

    // =======================================================
    //  Testing hooks
    // =======================================================

    /**
     * Flush all cached singletons and unlock registrations (for test teardown).
     * Registrations are preserved; only cached instances and resolution state are
     * cleared. Does not return the container.
     */
    reset(): void;

    /**
     * Remove a single service registration and its cached singleton (if any), and
     * splice it out of the resolution order (D-09). The container must be unlocked
     * (call {@link reset} first if booted).
     *
     * @param name The service token to remove.
     */
    unregister(name: Token): void;

    /**
     * Clear everything -- registrations, singletons, teardowns and state -- and
     * unlock the container. Detaches the scope from its parent's live-child count.
     */
    clear(): void;
}

export default Container;
