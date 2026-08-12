/**
 * T8 -- dependents conformance (RETIRED, registered but intentionally empty).
 *
 * This tier used to smoke-test five in-repo PROTOTYPE dependents under
 * `2.0.0/dependents/` (DIEventBus, DIStrategyRouter, DIOrchestrator, DICron,
 * DILock) against the released container. Those prototypes were gitignored dev
 * fixtures -- never shipped, never committed -- and have since been SUPERSEDED by
 * the real published packages:
 *   - @zakkster/lite-di-event-bus  @zakkster/lite-di-strategies
 *   - @zakkster/lite-di-orchestrator  @zakkster/lite-di-cron  @zakkster/lite-di-lock
 *
 * Each of those ships its own node:test + `test/torture.mjs` suite that proves its
 * container coupling first-hand, and `LiteDiOrchestrator/examples/service-kernel.mjs`
 * proves five of them in COMPOSITION against a real container (a hard prepublish
 * gate over there). So the conformance this tier once provided now lives IN the
 * dependents, not in a prototype fixture the container repo has to carry.
 *
 * Kept as a documented no-op (not deleted) so the tier slot and this rationale stay
 * visible -- matching the `torture.mjs` note that T8 is "registered but empty". To
 * re-arm it as a real tier, import the PUBLISHED packages as dev deps and smoke
 * their frozen surfaces here -- never the old `2.0.0/dependents/` prototypes.
 */

export async function run() {
    // Intentionally empty. Coverage moved to the published dependents' own
    // node:test + torture suites and the composed service-kernel.mjs reference app.
}
