// 02-heal.test.mjs -- G2: supervised self-heal identity. A fault rebuilds a FRESH engine
// on the SAME shared ctx, re-stamps the voices, and counts the restart.
//
// FIDELITY BOUNDARY: proves the DI self-heal lifecycle against a MOCK engine, not real
// AudioNode reconnection (Web Audio has no AudioContext in node -- same boundary as
// market-map's fake socket). The mock records the ctx handed to init(), so the "same
// shared ctx into every engine" claim is checked by object identity.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeEngine, makeMockCtx, makeMock2d, ENGINE_BASE_NODES, VOICE_NODES} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

const ROOM_A_EMITTERS = 3;
const EXPECT_A = ENGINE_BASE_NODES + ROOM_A_EMITTERS * VOICE_NODES;   // 15
const settle = () => new Promise((r) => setTimeout(r, 60));

async function boot(opts = {}) {
    const {makeEngine, engines} = makeFakeEngine(opts);
    const ctx = makeMockCtx();
    const handle = await bootKernel({
        ctx, makeEngine, c2d: makeMock2d(), gl: null, w: 0, h: 0,
        onEvent() {}, onMode() {},
    });
    return {handle, engines, ctx};
}

test('G2: killAudio heals to a FRESH engine on the SAME ctx, restarts++, voices re-stamped', async () => {
    const {handle, engines, ctx} = await boot();
    try {
        await handle.enterRoom('A');
        const eng1 = engines[0];
        assert.equal(handle.readState().restarts, 0, 'no restarts before the fault');
        assert.equal(eng1.ctx, ctx, 'engine#1 was init()-ed on the shared ctx');

        handle.killAudio();                       // sup.reportFault('engine')
        await settle();

        const s = handle.readState();
        const eng2 = engines[engines.length - 1];
        assert.equal(s.restarts, 1, 'one restart recorded');
        assert.ok(engines.length >= 2, 'a NEW engine was constructed');
        assert.notEqual(eng2, eng1, 'the healed engine is a FRESH instance');
        assert.equal(eng2.ctx, ctx, 'engine#2 init()-ed on the SAME ctx object (identity stable)');
        assert.equal(eng2.live, EXPECT_A, 'census restored on the fresh engine');
        assert.equal(s.audioNodes, EXPECT_A, 'readState() census restored after heal');
        assert.equal(s.voices, ROOM_A_EMITTERS, 'voices re-stamped (activeCount back to N)');
        assert.equal(eng1.destroyed, true, 'the faulted engine was destroyed');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// NON-VACUOUS CANARY. A heal that reuses the dead instance (opts.reuse) yields the SAME
// engine object, not a fresh one. This test passes by asserting the broken heal is
// detectable -- proving the fresh-instance assertion above is real. Turn reuse off and it
// goes RED.
test('G2 canary: a heal that reuses the dead engine is detected (same instance)', async () => {
    const {handle, engines} = await boot({reuse: true});
    try {
        await handle.enterRoom('A');
        const eng1 = engines[0];
        handle.killAudio();
        await settle();
        const eng2 = engines[engines.length - 1];
        assert.equal(eng2, eng1, 'the reuse canary hands back the dead instance -- fresh-instance gate would RED');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});
