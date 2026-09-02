// 05-boundary.test.mjs -- QA leg (final) adversarial BOUNDARY suite. Reviewer APPROVED the
// 4 core gates (01-census, 02-heal, 03-failclosed, 04-teardown-order); this file COMPLEMENTS
// them, it does not duplicate them. Every assertion here is independently derivable and
// falsifiable (a canary or a constructed break proves each sharp claim can go RED).
//
// FIDELITY BOUNDARY (same as 01-04): Web Audio has no AudioContext in node. These tests
// prove the DI LIFECYCLE + census MODEL against a MOCK engine -- not real AudioNode
// disconnection.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    installRaf, makeFakeEngine, makeMockCtx, makeMock2d,
    ENGINE_BASE_NODES, VOICE_NODES,
} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';
import {Container} from '@zakkster/lite-di-container';
import {Supervisor} from '@zakkster/lite-di-supervisor';

installRaf();

const ROOM_A_EMITTERS = 3;                 // room A freqs [330,440,550]
const ROOM_B_EMITTERS = 4;                 // room B freqs [196,262,392,523]
const EXPECT_A = ENGINE_BASE_NODES + ROOM_A_EMITTERS * VOICE_NODES;   // 15
const EXPECT_B = ENGINE_BASE_NODES + ROOM_B_EMITTERS * VOICE_NODES;   // 18
const MAX_RESTARTS = 20;                   // kernel.js:518 -- Supervisor({..., maxRestarts: 20})
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function boot(opts = {}) {
    const {makeEngine, engines} = makeFakeEngine(opts);
    const ctx = makeMockCtx();
    const events = [];
    const handle = await bootKernel({
        ctx, makeEngine, c2d: makeMock2d(), gl: null, w: 0, h: 0,
        onEvent: (k, m) => events.push(k + ': ' + m), onMode() {},
    });
    return {handle, engines, ctx, events};
}

// A local, test-only engine factory with a CONTROLLABLE async gate inside init(). The
// shared harness's makeFakeEngine cannot pause mid-build, which is exactly what boundary #7
// (census DURING a heal) needs: a window wide enough to observe the DOWN state before the
// healed engine finishes constructing. Same census fidelity as the harness mock (tracks its
// own live-node count; destroy() truly releases) -- only init() gains a manual release.
function makeGatedFakeEngine() {
    const engines = [];
    const gates = [];
    const build = () => {
        let release;
        const gate = new Promise((res) => { release = res; });
        gates.push({release});
        const eng = {
            id: engines.length, live: 0, ctx: null, voices: 0, handleSeq: 0, destroyed: false,
            async init(ctx) { await gate; this.ctx = ctx; },
            createBus() { this.live += ENGINE_BASE_NODES; },
            async defineSounds() {},
            layoutOf() { return 'stereo'; },
            play(id, vol, x, y) { this.live += VOICE_NODES; this.voices++; return this.handleSeq++; },
            setPosition() {},
            activeCount() { return this.voices; },
            destroy() { this.destroyed = true; this.live = 0; this.voices = 0; this.ctx = null; },
        };
        engines.push(eng);
        return eng;
    };
    return {makeEngine: () => build(), engines, gates};
}

// ---------------------------------------------------------------------------
// 1. ROOM SWITCH -- enterRoom auto-leaves the prior room.
// ---------------------------------------------------------------------------
test('B1: enterRoom(B) while A is live tears A down first -- one room live, B census correct', async () => {
    const {handle, engines} = await boot();
    try {
        await handle.enterRoom('A');
        const engA = engines[0];
        assert.equal(engA.live, EXPECT_A, 'A built with its own census');

        await handle.enterRoom('B');                      // NOTE: no leaveRoom() call
        assert.equal(engA.destroyed, true, 'A engine.destroy() was invoked on switch');
        assert.equal(engA.live, 0, 'A engine fully released its nodes on switch');

        const engB = engines[engines.length - 1];
        assert.notEqual(engB, engA, 'B got a fresh engine instance');
        assert.equal(engB.live, EXPECT_B, 'B census == 6 + 4*3');
        assert.equal(engines.length, 2, 'exactly one switch -> exactly two engines ever built');

        const s = handle.readState();
        assert.equal(s.roomId, 'B', 'world.roomId is B');
        assert.equal(s.audioNodes, EXPECT_B, 'readState mirrors B census, not a stale A+B sum');
        assert.ok(handle._roomScope, '_roomScope live');
        assert.equal(handle._roomScope.get('engine'), engB, '_roomScope resolves to B\'s engine, not A\'s');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// NON-VACUOUS CANARY: with the harness's breakDestroy canary armed, A's engine.destroy() is
// invoked (the switch still calls it) but never actually frees -- proving the `engA.live===0`
// assertion above is a REAL measurement, not a tautology on `destroyed` alone.
test('B1 canary: a no-op destroy on switch leaves A\'s node count stuck (destroyed flag alone is not enough)', async () => {
    const {handle, engines} = await boot({breakDestroy: true});
    try {
        await handle.enterRoom('A');
        await handle.enterRoom('B');
        const engA = engines[0];
        assert.equal(engA.destroyed, true, 'destroy() was still called');
        assert.equal(engA.live, EXPECT_A, 'but a no-op destroy never freed -- live nodes stuck at 15');
        assert.ok(engA.live > 0, 'proves the real B1 assertion (live===0) is falsifiable, not vacuous');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// ---------------------------------------------------------------------------
// 2. HEAL SEQUENCE -- repeated faults.
// ---------------------------------------------------------------------------
test('B2: N repeated killAudio() heals -- restarts++ each time, fresh engine each time, ALL prior engines destroyed', async () => {
    const {handle, engines} = await boot();
    try {
        await handle.enterRoom('A');
        const N = 5;
        for (let i = 0; i < N; i++) {
            handle.killAudio();
            await settle();
        }
        const s = handle.readState();
        assert.equal(s.restarts, N, 'restarts incremented exactly N times');
        assert.equal(engines.length, N + 1, 'N heals -> N+1 engines ever built (initial + N)');
        assert.equal(s.audioNodes, EXPECT_A, 'census restored after the Nth heal');
        assert.equal(s.engineLive, true);

        for (let i = 0; i < engines.length - 1; i++) {
            assert.equal(engines[i].destroyed, true, 'historical engine #' + i + ' was destroyed');
            assert.equal(engines[i].live, 0, 'historical engine #' + i + ' fully released');
        }
        const current = engines[engines.length - 1];
        assert.equal(current.destroyed, false, 'the CURRENT engine is not torn down');
        assert.equal(current.live, EXPECT_A, 'the CURRENT engine holds the live census');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// ---------------------------------------------------------------------------
// 3. HEAL BUDGET / ESCALATION -- the N vs N+1 boundary at maxRestarts=20.
// ---------------------------------------------------------------------------
test('B3: exactly maxRestarts faults stay RUNNING; the (maxRestarts+1)th escalates -- engine left DOWN, killAudio becomes a safe no-op', async () => {
    const {handle, engines} = await boot();
    try {
        await handle.enterRoom('A');

        for (let i = 0; i < MAX_RESTARTS; i++) {
            handle.killAudio();
            await settle(50);
        }
        let s = handle.readState();
        assert.equal(s.restarts, MAX_RESTARTS, 'boundary N: all ' + MAX_RESTARTS + ' restarts succeeded');
        assert.equal(s.supState, 1, 'boundary N: supervisor still RUNNING at exactly maxRestarts');
        assert.equal(s.engineLive, true, 'boundary N: engine still live');

        handle.killAudio();                              // the (N+1)th fault crosses the budget
        await settle(150);
        s = handle.readState();
        assert.equal(s.supState, 2, 'boundary N+1: supervisor ESCALATED');
        assert.equal(s.engineLive, false, 'fail closed: engine left DOWN post-escalation (null is not zero)');
        assert.notEqual(s.readyz, 0, 'readyz not-ready post-escalation');
        const enginesAtEscalate = engines.length;

        assert.doesNotThrow(() => handle.killAudio(), 'a bare fault post-escalation must NOT throw (reportFault guards on sup.state===1)');
        await settle();
        assert.equal(engines.length, enginesAtEscalate, 'the no-op guard held -- no further engine was built');
        assert.equal(handle.readState().supState, 2, 'still ESCALATED, unchanged');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
}, {timeout: 30000});

// ADVERSARIAL (not envisioned by the reviewer's 4 gates): the kernel's killAudio() guards
// with `sup.state === 1` before calling reportFault specifically because reportFault THROWS
// SYNCHRONOUSLY once the supervisor is not RUNNING (Supervisor.js:291-296) -- a bare
// `.catch()` cannot catch a synchronous throw. This constructs a SMALLER-budget Supervisor
// directly (maxRestarts:1) to prove that hazard is real, independent of the full 20-fault
// drive above.
test('B3-adversarial: raw Supervisor.reportFault() throws SYNCHRONOUSLY post-escalation -- the exact hazard kernel.js guards against', async () => {
    const c = new Container();
    c.value('x', {});
    c.boot();
    const sup2 = new Supervisor(c, {children: ['x'], maxRestarts: 1, windowMs: 60000});
    await sup2.start();

    await sup2.reportFault('x');                          // 1st fault: count(0) < 1 -> restart
    assert.equal(sup2.state, 1, 'still RUNNING after the 1st fault (budget not yet crossed)');

    await sup2.reportFault('x');                          // 2nd fault: count(1) >= 1 -> escalate
    assert.equal(sup2.state, 2, 'ESCALATED on the 2nd fault with a maxRestarts:1 budget');

    assert.throws(
        () => sup2.reportFault('x'),
        /not running/,
        'an UNGUARDED reportFault call throws synchronously -- proves kernel.js:583\'s `sup.state === 1` guard is load-bearing, not decorative',
    );
});

// ---------------------------------------------------------------------------
// 4. IDEMPOTENCY / FAIL-CLOSED INPUTS.
// ---------------------------------------------------------------------------
test('B4: no-room operations are safe no-ops (incl. duplicate leaveRoom); unknown room throws naming the room', async () => {
    const {handle} = await boot();
    try {
        await assert.doesNotReject(handle.leaveRoom(), 'leaveRoom() with nothing live is a no-op');
        await assert.doesNotReject(handle.leaveRoom(), 'DUPLICATE leaveRoom() (double dispose) is still a no-op');

        assert.doesNotThrow(() => handle.footstep(), 'footstep() with no room is a no-op');
        assert.doesNotThrow(() => handle.killAudio(), 'killAudio() with no room is a no-op');

        const s0 = handle.readState();
        assert.equal(s0.engineLive, false, 'readState() with no room: engineLive false');
        assert.equal(s0.audioNodes, 0, 'readState() with no room: audioNodes 0');
        assert.notEqual(s0.readyz, 0, 'readState() with no room: readyz not-ready');

        await assert.rejects(handle.enterRoom('ZZZ'), (e) => {
            assert.match(e.message, /ZZZ/, 'the error names the bad room id');
            return true;
        });

        // the failed attempt did not corrupt state -- a real room still boots afterward.
        await handle.enterRoom('A');
        assert.equal(handle.readState().engineLive, true);

        // duplicate leaveRoom AFTER a real room, too.
        await handle.leaveRoom();
        await assert.doesNotReject(handle.leaveRoom(), 'second leaveRoom() after a real teardown stays a no-op');
    } finally {
        handle.stop();
    }
});

// ADVERSARIAL: every non-string / near-miss room id shape fails closed, and none of the
// failed attempts leaves residue that blocks a subsequent real enterRoom.
test('B4-adversarial: enterRoom fails closed for null/undefined/empty/0/NaN/near-miss ids', async () => {
    const {handle} = await boot();
    try {
        const bad = [null, undefined, '', 0, NaN, 'a', 'A ', -0];
        for (const id of bad) {
            await assert.rejects(handle.enterRoom(id), Error, 'enterRoom(' + String(id) + ') must throw');
        }
        assert.equal(handle.readState().engineLive, false, 'no room leaked live across the bad-id sweep');
        await handle.enterRoom('A');                      // the container is still usable
        assert.equal(handle.readState().engineLive, true);
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// ---------------------------------------------------------------------------
// 5. FAN-OUT -- footstep() re-triggers every emitter (bus -> FootstepRetrigger).
// ---------------------------------------------------------------------------
test('B5: footstep() re-triggers every emitter exactly once via the bus; no-op with no engine', async () => {
    const {handle, engines} = await boot();
    try {
        assert.doesNotThrow(() => handle.footstep(), 'pre-room: no-op (no bus target)');

        await handle.enterRoom('A');
        const eng = engines[engines.length - 1];
        const before = eng.voices;
        assert.equal(before, ROOM_A_EMITTERS, 'enterRoom stamped N initial voices');

        handle.footstep();
        assert.equal(eng.voices, before + ROOM_A_EMITTERS, 'one footstep re-plays exactly N voices (every emitter, once each)');
        assert.equal(handle.readState().voices, eng.voices, 'readState().voices mirrors activeCount()');

        handle.footstep();
        handle.footstep();
        assert.equal(eng.voices, before + ROOM_A_EMITTERS * 3, 'fan-out scales linearly with call count -- no drift, no double-fire');
    } finally {
        await handle.leaveRoom();
        handle.stop();
    }
});

// ---------------------------------------------------------------------------
// 6. NO INTERVAL LEAK -- the facingTimer lifecycle (distinct from G1's census-stays-0 gate).
// ---------------------------------------------------------------------------
test('B6: the facing timer is created once per room and cleared on leaveRoom -- no growth across many cycles', async () => {
    const {handle} = await boot();
    const origSet = global.setInterval;
    const origClear = global.clearInterval;
    const live = new Set();
    let facingSetCount = 0;
    global.setInterval = function (fn, ms, ...rest) {
        const id = origSet(fn, ms, ...rest);
        if (ms === 100) { live.add(id); facingSetCount++; }
        return id;
    };
    global.clearInterval = function (id) {
        live.delete(id);
        return origClear(id);
    };
    try {
        const CYCLES = 6;
        for (let i = 0; i < CYCLES; i++) {
            await handle.enterRoom('A');
            assert.equal(live.size, 1, 'exactly one facing-timer outstanding while a room is live (cycle ' + i + ')');
            await handle.leaveRoom();
            assert.equal(live.size, 0, 'facing-timer cleared on leaveRoom -- no leak (cycle ' + i + ')');
        }
        assert.equal(facingSetCount, CYCLES, 'exactly one facing-timer per room enter -- no extras, no growth');
    } finally {
        global.setInterval = origSet;
        global.clearInterval = origClear;
        handle.stop();
    }
});

// NON-VACUOUS CANARY: defeat clearInterval (simulate the bug the gate above must catch) and
// show the live-timer set genuinely does not drain. Proves B6 is a real measurement.
test('B6 canary: with clearInterval defeated, the facing-timer set is NOT released (proves B6 is falsifiable)', async () => {
    const {handle} = await boot();
    const origSet = global.setInterval;
    const origClear = global.clearInterval;
    const live = new Set();
    global.setInterval = function (fn, ms, ...rest) {
        const id = origSet(fn, ms, ...rest);
        if (ms === 100) live.add(id);
        return id;
    };
    global.clearInterval = function (id) { return origClear(id); };  // CANARY: never untracks
    try {
        await handle.enterRoom('A');
        await handle.leaveRoom();
        assert.equal(live.size, 1, 'defeated clearInterval -> the timer set is stuck at 1, not drained to 0');
    } finally {
        global.setInterval = origSet;
        global.clearInterval = origClear;
        handle.stop();
    }
});

// ---------------------------------------------------------------------------
// 7. CENSUS DURING A HEAL -- the brief mid-heal window must read DOWN, not stale.
// ---------------------------------------------------------------------------
test('B7: readState reflects DOWN during the heal window (not a stale pre-fault count); restores after; a re-entrant footstep mid-heal is a safe no-op', async () => {
    const {makeEngine, engines, gates} = makeGatedFakeEngine();
    const ctx = makeMockCtx();
    const handle = await bootKernel({
        ctx, makeEngine, c2d: makeMock2d(), gl: null, w: 0, h: 0,
        onEvent() {}, onMode() {},
    });
    try {
        const enterP = handle.enterRoom('A');
        gates[0].release();                               // let the initial build complete
        await enterP;
        assert.equal(handle.readState().audioNodes, EXPECT_A, 'pre-fault census established');

        handle.killAudio();                                // fires reportFault (fire-and-forget)
        await settle(20);                                  // teardown of engine#1 runs; engine#2's
                                                             // init() is gated -- it will NOT resolve
                                                             // until we release it below.

        const mid = handle.readState();
        assert.equal(mid.engineLive, false, 'mid-heal: engine observably DOWN');
        assert.equal(mid.audioNodes, 0, 'mid-heal: census reflects DOWN (0), not the pre-fault 15');
        assert.notEqual(mid.readyz, 0, 'mid-heal: readyz not-ready while the engine rebuilds');
        assert.equal(engines[0].destroyed, true, 'the faulted engine was already torn down mid-window');
        assert.equal(engines[1].live, 0, 'the incoming engine has not finished building yet');

        // RE-ENTRANT WRITE: a footstep fired into the down window must not throw and must
        // not fan out through a half-built engine.
        assert.doesNotThrow(() => handle.footstep(), 're-entrant footstep during the down window must not throw');
        assert.equal(engines[1].voices, 0, 're-entrant footstep during the window was a safe no-op');

        gates[1].release();                                // let the healed engine finish init()
        await settle(80);

        const after = handle.readState();
        assert.equal(after.engineLive, true, 'heal completed -- engine restored');
        assert.equal(after.audioNodes, EXPECT_A, 'census restored to 6+N*3 once the heal settles');
        assert.equal(after.restarts, 1, 'exactly one restart recorded');
    } finally {
        // Defensive: release every gate regardless of pass/fail/perturbation above, so a
        // failed mid-window assertion can never leave sup.shutdown() awaiting a permanently
        // stuck getAsync('engine') build (which would hang leaveRoom() and the whole run).
        for (const g of gates) g.release();
        await handle.leaveRoom();
        handle.stop();
    }
});

// ---------------------------------------------------------------------------
// ADVERSARIAL -- handle.stop() itself is a disposer; duplicate dispose must not throw.
// ---------------------------------------------------------------------------
test('B-adversarial: handle.stop() is idempotent -- duplicate dispose does not throw', async () => {
    const {handle} = await boot();
    await handle.enterRoom('A');
    await handle.leaveRoom();
    assert.doesNotThrow(() => handle.stop(), 'first stop()');
    assert.doesNotThrow(() => handle.stop(), 'second stop() (duplicate dispose)');
    assert.doesNotThrow(() => handle.stop(), 'third stop(), for good measure');
});
