// 04-teardown-order.test.mjs -- G4: reverse-topological teardown ORDER (genuine, S6 lesson).
//
// The room child scope is torn down in REVERSE resolution order. We OBSERVE the actual
// fires -- each name is pushed by a callback the CONTAINER itself invokes during
// leaveRoom() (the mock engine's destroy() and the scoped signal registry's destroy()),
// wrapped here in the test. We do NOT narrate by iterating a hardcoded list (the
// market-map S6 VACUOUS-ORDER-GATE: comparing a copy to itself always passes). The
// EXPECTED order is derived INDEPENDENTLY below from the known resolution order.
//
// Resolution order inside enterRoom():
//   1. useScopedSignals() eagerly resolves the scoped registry -> pinned at _resolutionOrder
//      index 0, so it is torn down LAST.
//   2. sup.start() resolves the 'engine' singleton later, so it is torn down FIRST.
// Reverse-topological teardown therefore fires engine.destroy() BEFORE registry.destroy().
//
// FIDELITY BOUNDARY: proves the DI teardown-order lifecycle against a MOCK engine (Web
// Audio has no AudioContext in node -- same boundary as market-map's fake socket).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeEngine, makeMockCtx, makeMock2d} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

// The well-known token under which lite-di-signal registers a scope's registry
// (DiSignal.js: Symbol.for('lite-signal.scoped-registry')). Independent of any kernel const.
const REGISTRY_TOKEN = Symbol.for('lite-signal.scoped-registry');

// EXPECTED order, derived independently from the resolution reasoning above -- NOT copied
// from the observed walk. Engine (resolved last via sup.start) tears down before the
// registry (resolved first, index 0).
const EXPECTED_TEARDOWN = ['engine', 'signal-registry'];

test('G4: room tears down in reverse-topological order (engine before signal-registry)', async () => {
    const {makeEngine, engines} = makeFakeEngine();
    const ctx = makeMockCtx();
    const handle = await bootKernel({
        ctx, makeEngine, c2d: makeMock2d(), gl: null, w: 0, h: 0,
        onEvent() {}, onMode() {},
    });
    try {
        await handle.enterRoom('A');
        const roomScope = handle._roomScope;
        assert.ok(roomScope, '_roomScope is exposed while a room is live (fail closed: null == no room)');

        // Observe REAL teardown fires by wrapping the two disposables the container invokes.
        const walk = [];
        const eng = engines[engines.length - 1];
        const engDestroy = eng.destroy.bind(eng);
        eng.destroy = () => { walk.push('engine'); engDestroy(); };

        const reg = roomScope.get(REGISTRY_TOKEN);
        const regDestroy = reg.destroy.bind(reg);
        reg.destroy = () => { walk.push('signal-registry'); regDestroy(); };

        await handle.leaveRoom();

        assert.equal(walk.length, 2, 'both disposables actually fired during teardown');
        assert.deepEqual(walk, EXPECTED_TEARDOWN, 'reverse-topological: engine.destroy() before registry.destroy()');
    } finally {
        handle.stop();
    }
});
