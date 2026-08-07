/**
 * Container.js — Dependency Injection Container
 */

export const TYPES: {
    readonly VALUE: 'value';
    readonly SINGLETON: 'singleton';
    readonly TRANSIENT: 'transient';
    readonly FACTORY: 'factory';
};

/**
 * A generic type representing a constructable class or constructor function.
 */
export type Constructor<T = any> = new (...args: any[]) => T;

export class Container {
    constructor();

    // ═══════════════════════════════════════════════════════
    //  Registration
    // ═══════════════════════════════════════════════════════

    /**
     * Register a raw value (config object, 3rd-party module, primitive).
     * Returned as-is on every get() — no instantiation.
     *
     * @param name The unique name of the service.
     * @param definition The raw value to register.
     * @returns `this` for chaining.
     */
    value(name: string, definition: any): this;

    /**
     * Register a class that will be instantiated once on first get().
     * Subsequent calls return the cached instance.
     *
     * @param name The unique name of the service.
     * @param definition The class or constructor function.
     * @param dependencies An array of service names to inject into the constructor.
     * @returns `this` for chaining.
     */
    singleton<T = any>(name: string, definition: Constructor<T>, dependencies?: string[]): this;

    /**
     * Register a class that will be instantiated fresh on every get().
     *
     * @param name The unique name of the service.
     * @param definition The class or constructor function.
     * @param dependencies An array of service names to inject into the constructor.
     * @returns `this` for chaining.
     */
    transient<T = any>(name: string, definition: Constructor<T>, dependencies?: string[]): this;

    /**
     * Register a factory function that will be called on every get().
     * The factory receives the container as its only argument.
     *
     * @param name The unique name of the service.
     * @param fn The factory function.
     * @returns `this` for chaining.
     */
    factory<T = any>(name: string, fn: (container: Container) => T): this;

    // ═══════════════════════════════════════════════════════
    //  Resolution
    // ═══════════════════════════════════════════════════════

    /**
     * Resolve a service by name.
     *
     * @template T The expected return type (optional).
     * @param name The name of the registered service.
     * @returns The resolved service, instantiated or executed if necessary.
     */
    get<T = any>(name: string): T;

    /**
     * Check if a service is registered (without resolving it).
     *
     * @param name The name of the service to check.
     * @returns `true` if registered, `false` otherwise.
     */
    has(name: string): boolean;

    // ═══════════════════════════════════════════════════════
    //  Validation
    // ═══════════════════════════════════════════════════════

    /**
     * Validate all dependency wiring at startup.
     * Call after all registrations are complete.
     *
     * Catches typos in dependency names and circular dependency chains.
     * Locks the container from further registrations until `reset()` is called.
     *
     * @returns `this` for chaining.
     */
    boot(): this;

    // ═══════════════════════════════════════════════════════
    //  Lifecycle
    // ═══════════════════════════════════════════════════════

    /**
     * Clear all singleton instances and unlock registrations (for test teardown).
     * Registrations are preserved — only cached instances are flushed.
     *
     * @returns `this` for chaining.
     */
    reset(): this;

    /**
     * Remove a single service registration and its cached singleton (if any).
     *
     * @param name The name of the service to remove.
     * @returns `this` for chaining.
     */
    unregister(name: string): this;

    /**
     * Clear everything — registrations, singletons, state, and unlocks the container.
     *
     * @returns `this` for chaining.
     */
    clear(): this;
}

export default Container;
