// 03-failclosed.test.mjs -- G3: fail-closed on unverified state. null is not zero.
//   (a) With no room / no engine, readyz is NOT ready; after enterRoom it is ready.
//   (b) The ROOT refuses to shut down while a room child scope is live.
//
// FIDELITY BOUNDARY: proves the DI fail-closed lifecycle against a MOCK engine (Web Audio
// has no AudioContext in node -- same boundary as market-map's fake socket).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeEngine, makeMockCtx, makeMock2d} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

const settle = () => new Promise((r) => setTimeout(r, 60));

async function boot() {
    const {makeEngine, engines} = makeFakeEngine();
    const ctx = makeMockCtx();
    const events = [];
    const handle = await bootKernel({
        ctx, makeEngine, c2d: makeMock2d(), gl: null, w: 0, h: 0,
        onEvent: (k, m) => events.push(k + ': ' + m), onMode() {},
    });
    return {handle, engines, ctx, events};
}

test('G3a: no room -> readyz not-ready; enterRoom -> ready; leaveRoom -> not-ready again', async () => {
    const {handle} = await boot();
    try {
        const s0 = handle.readState();
        assert.equal(s0.engineLive, false, 'no engine before a room');
        assert.notEqual(s0.readyz, 0, 'readyz is NOT ready with no engine (fail closed -- null is not zero)');

        await handle.enterRoom('A');
        assert.equal(handle.readState().readyz, 0, 'readyz is ready once the engine is live');

        await handle.leaveRoom();
        assert.notEqual(handle.readState().readyz, 0, 'readyz falls back to not-ready after teardown');
    } finally {
        handle.stop();
    }
});

test('G3b: the ROOT refuses to shut down while a room child scope is live', async () => {
    const {handle, events} = await boot();
    try {
        await handle.enterRoom('A');
        assert.equal(handle.readState().engineLive, true, 'a room is live');
        events.length = 0;

        handle.shutdownRoot();                     // parent must refuse: a child scope is live
        await settle();

        const refused = events.find((e) => e.startsWith('escalate') && e.includes('refused shutdown'));
        assert.ok(refused, 'root fires the fail-closed escalate: ' + JSON.stringify(events));
        assert.ok(refused.includes('child scope'), 'the refusal names the live child scope');
        assert.equal(handle.readState().engineLive, true, 'the engine is STILL live -- the root did not tear down');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// NON-VACUOUS COUNTERPART to G3b: once the room is left, the SAME shutdownRoot() succeeds
// (a 'replay' log, no escalate). This proves the refusal above is contingent on a live
// child, not an unconditional escalate -- perturb by removing the leaveRoom and it REDs.
test('G3b counterpart: with no live room, the root shuts down cleanly (no refusal)', async () => {
    const {handle, events} = await boot();
    await handle.enterRoom('A');
    await handle.leaveRoom();                       // child gone -> root may now shut down
    events.length = 0;
    handle.shutdownRoot();
    await settle();
    const refused = events.find((e) => e.startsWith('escalate') && e.includes('refused shutdown'));
    assert.ok(!refused, 'no refusal once the child scope is gone: ' + JSON.stringify(events));
    handle.stop();
});
