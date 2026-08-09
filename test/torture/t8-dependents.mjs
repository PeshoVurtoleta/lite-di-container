/**
 * T8 -- the real consumption surface (dependents).
 *
 * Instantiates each first-party dependent under 2.0.0/dependents/ against the
 * RELEASED container and runs its documented happy path as a smoke test. This is
 * the conformance tier that proves the frozen 2.0.0 public surface actually
 * carries the ecosystem, including the D-20 couplings (now the public isBooted).
 *
 * PASSING (smoke-tested here): DIEventBus, DIStrategyRouter (StrategyRouter +
 * PipelineSwapper), DIOrchestrator, DICron, DILock.
 *
 * DOCUMENTED KNOWN-GAPS (deferred, not silently skipped -- listed in GAPS below
 * and in the CHANGELOG 2.0.0 entry):
 *   - DIT (Ticker): imports '@zakkster/lite-raf', a peer not installed in this
 *     dev tree, so the module cannot even be imported here. Its container coupling
 *     was already migrated off private _booted to the public isBooted in X1.
 *   - DIOExample / DILExample: runnable examples that import 'fastify', 'pg',
 *     'bullmq' and 'lite-di-orchestrator' -- external services, not unit-smokeable.
 *
 * Dependents are gitignored dev fixtures, not shipped. The core package ships
 * regardless of this tier.
 */

import { Container } from '../../Container.js';
import { check, validate } from './harness.mjs';

import { EventBus } from '../../2.0.0/dependents/DIEventBus.js';
import { StrategyRouter, PipelineSwapper } from '../../2.0.0/dependents/DIStrategyRouter.js';
import { Orchestrator, PHASES } from '../../2.0.0/dependents/DIOrchestrator.js';
import { Cron, interval } from '../../2.0.0/dependents/DICron.js';
import { registerLockManager, withLock } from '../../2.0.0/dependents/DILock.js';

// Explicitly enumerated deferrals -- a visible list, never a silent empty tier.
const GAPS = ['DIT (needs @zakkster/lite-raf)', 'DIOExample (needs fastify/pg/bullmq)', 'DILExample (needs fastify/pg/bullmq)'];

export async function run() {
    // Dependents default several error hooks to console.*; keep stdout clean.
    const _err = console.error, _warn = console.warn, _log = console.log;
    console.error = () => {}; console.warn = () => {}; console.log = () => {};

    try {
        // -- DIEventBus: multi topology + emit, isBooted lock (D-20) ----------
        {
            const c = new Container();
            class L { constructor() { this.sum = 0; } handle(p) { this.sum += p; } }
            const bus = new EventBus(c);
            bus.on('evt', L);
            c.boot();
            bus.emit('evt', 5);
            bus.emit('evt', 3);
            const [listener] = c.getAll('evt');
            check(listener.sum === 8, () => 'T8 DIEventBus: emit did not dispatch (sum=' + listener.sum + ')');
            check(bus.listenerCount('evt') === 1, () => 'T8 DIEventBus: wrong listener count');
            let blocked = false;
            try { bus.on('late', L); } catch { blocked = true; }
            check(blocked, () => 'T8 DIEventBus: post-boot registration not blocked via isBooted');
            validate(c);
        }

        // -- DIStrategyRouter: multi + bitmask routing; PipelineSwapper swap ---
        {
            const c = new Container();
            class S { constructor() { this.priority = 1; this.activeStates = -1; this.hits = 0; } handle() { this.hits++; return false; } }
            c.multi('strategies', S);
            c.boot();
            const router = new StrategyRouter(c, 'strategies');
            const ran = router.routeAll({ n: 1 });
            check(ran === 1, () => 'T8 StrategyRouter: routeAll ran ' + ran + ' (expected 1)');
            check(router.route({ n: 1 }) === false, () => 'T8 StrategyRouter: route consumed a non-consuming strategy');
            validate(c);
        }
        {
            const c = new Container();
            class Pipe { constructor() { this.runs = 0; this.active = 0; } execute() { this.runs++; } onActivate() { this.active++; } onDeactivate() {} }
            c.singleton('pipeA', Pipe);
            c.singleton('pipeB', Pipe);
            c.boot();
            const swap = new PipelineSwapper(c, 'pipeA', ['pipeB']);
            swap.execute({});
            swap.swap('pipeB');
            swap.execute({});
            check(swap.currentKey === 'pipeB', () => 'T8 PipelineSwapper: swap did not switch key');
            check(c.get('pipeB').runs === 1, () => 'T8 PipelineSwapper: swapped pipeline did not execute');
            validate(c);
        }

        // -- DIOrchestrator: bootAsync + graceful shutdown (rejection-safe) ----
        {
            const c = new Container();
            c.value('cfg', { port: 0 });
            const orch = new Orchestrator(c, { exitOnFail: false, log: () => {}, signals: [] });
            let ready = 0;
            orch.onReady(() => { ready++; });
            await orch.start();
            check(orch.isReady, () => 'T8 DIOrchestrator: not READY after start');
            check(ready === 1, () => 'T8 DIOrchestrator: onReady not fired');
            await orch.shutdown();
            check(orch.phase === PHASES.TERMINATED, () => 'T8 DIOrchestrator: not TERMINATED after shutdown');
        }

        // -- DICron: per-id singleton jobs, arm + tick, reset unregisters ------
        {
            const c = new Container();
            let ran = 0;
            class Job { run() { ran++; } }
            const cronMgr = new Cron(c, { now: () => 0, onError: () => {} });
            cronMgr.job('j', Job, interval(1000, 0));
            cronMgr.arm();       // resolves job singletons (container never booted)
            cronMgr.tick(0);     // offset 0 fires on the first tick
            check(ran === 1, () => 'T8 DICron: job did not run on first tick (ran=' + ran + ')');
            cronMgr.reset();     // stop + unregister each job key (container unlocked)
            check(c.has('cron:job:j') === false, () => 'T8 DICron: reset did not unregister the job binding');
            validate(c);
        }

        // -- DILock: registerLockManager + withLock scope RAII ----------------
        {
            const c = new Container();
            const held = new Map();
            const store = {
                async acquire(res, id) { if (held.has(res)) return false; held.set(res, id); return 1; },
                async extend(res, id) { return held.get(res) === id; },
                async release(res, id) { if (held.get(res) === id) held.delete(res); },
            };
            registerLockManager(c, store, { error() {}, warn() {} });
            const result = await withLock(c, 'r1', async (scope) => {
                check(scope.get('fencingToken') === 1, () => 'T8 DILock: fencing token not scoped');
                return 'done';
            });
            check(result === 'done', () => 'T8 DILock: withLock did not return job result');
            check(held.has('r1') === false, () => 'T8 DILock: lock not released after withLock');
        }

        // Deferrals are explicit, not silent. This assertion fails loudly if the
        // gap list is ever emptied or altered without a conscious decision.
        check(GAPS.length === 3, () => 'T8: known-gap list changed unexpectedly (' + GAPS.length + ')');
    } finally {
        console.error = _err; console.warn = _warn; console.log = _log;
    }
}
