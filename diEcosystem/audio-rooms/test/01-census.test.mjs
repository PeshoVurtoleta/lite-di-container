// 01-census.test.mjs -- G1: the live-node census returns to baseline (0) on teardown.
//
// FIDELITY BOUNDARY: Web Audio has no AudioContext in node. These gates prove the DI
// LIFECYCLE + the census MODEL (scope teardown -> census 0, self-heal identity,
// fail-closed) against a MOCK engine that tracks its OWN live-node count -- NOT real
// AudioNode disconnection. This is the SAME boundary as market-map's fake socket. The
// browser demo shows the real graph; these node gates prove the contract + census model.
//
// The mock's destroy() truly releases (live -> 0, ctx dropped), so the census gate reads
// the mock's REAL post-destroy state -- a fixture that never frees would confound it (the
// market-map S9 harness-faithfulness lesson). The `breakDestroy` canary arms exactly that
// no-op teardown to prove this gate is falsifiable, not a tautology.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeEngine, makeMockCtx, makeMock2d, ENGINE_BASE_NODES, VOICE_NODES} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

// Room 'A' lays out 3 emitters (freqs [330,440,550]); census = 6 + 3*3 = 15.
const ROOM_A_EMITTERS = 3;
const EXPECT_A = ENGINE_BASE_NODES + ROOM_A_EMITTERS * VOICE_NODES;   // 15

async function boot(opts = {}) {
    const {makeEngine, engines} = makeFakeEngine(opts);
    const ctx = makeMockCtx();
    const handle = await bootKernel({
        ctx, makeEngine, c2d: makeMock2d(), gl: null, w: 0, h: 0,
        onEvent() {}, onMode() {},
    });
    return {handle, engines, ctx};
}

test('G1: enterRoom stamps the census, leaveRoom returns it to 0', async () => {
    const {handle, engines} = await boot();
    try {
        await handle.enterRoom('A');
        const s1 = handle.readState();
        const eng = engines[0];
        assert.equal(engines.length, 1, 'one engine built');
        assert.equal(eng.live, EXPECT_A, 'mock live audio-node count == 6 + N*3');
        assert.equal(eng.voices, ROOM_A_EMITTERS, 'mock tracks N live voices');
        assert.equal(s1.audioNodes, EXPECT_A, 'readState().audioNodes mirrors the census');
        assert.equal(s1.voices, ROOM_A_EMITTERS, 'readState().voices == N');
        assert.equal(s1.engineLive, true, 'engine is live after enterRoom');

        await handle.leaveRoom();
        const s2 = handle.readState();
        assert.equal(eng.live, 0, 'mock destroy() released every node');
        assert.equal(eng.destroyed, true, 'engine.destroy() was invoked');
        assert.equal(s2.audioNodes, 0, 'census back to baseline (0)');
        assert.equal(s2.engineLive, false, 'engine nulled -- render loop off a disposed graph');
    } finally {
        handle.stop();
    }
});

test('G1: many enter/leave cycles never grow the census (census stays 0 between rooms)', async () => {
    const {handle, engines} = await boot();
    try {
        const rooms = ['A', 'B', 'C'];
        for (let i = 0; i < 12; i++) {
            const id = rooms[i % rooms.length];
            await handle.enterRoom(id);
            assert.ok(handle.readState().audioNodes > 0, 'census rises inside a room');
            await handle.leaveRoom();
            assert.equal(handle.readState().audioNodes, 0, 'census returns to 0 after every leave');
        }
        // Every engine ever built was faithfully destroyed -- no fixture retained live nodes.
        for (const e of engines) {
            assert.equal(e.live, 0, 'each historical engine released all nodes');
            assert.equal(e.destroyed, true, 'each historical engine was destroyed');
        }
    } finally {
        handle.stop();
    }
});

// NON-VACUOUS CANARY (falsifiability proof). A mock whose destroy() is a no-op leaves the
// census ABOVE baseline after leaveRoom. This test PASSES by asserting the broken fixture
// is detectable -- proving the census gate above reads the mock's real state, not a
// hardcoded 0. Flip breakDestroy off and this test goes RED.
test('G1 canary: a no-op destroy leaves the census > 0 (the gate can go RED)', async () => {
    const {handle, engines} = await boot({breakDestroy: true});
    try {
        await handle.enterRoom('A');
        await handle.leaveRoom();
        const eng = engines[0];
        assert.equal(eng.destroyed, true, 'destroy() was still invoked');
        assert.equal(eng.live, EXPECT_A, 'but the no-op destroy never freed -- census stuck at 15');
        assert.ok(eng.live > 0, 'a fixture that never frees would confound the real gate');
    } finally {
        handle.stop();
    }
});
