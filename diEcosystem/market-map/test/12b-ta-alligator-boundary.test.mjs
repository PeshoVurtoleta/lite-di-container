// 12b-ta-alligator-boundary.test.mjs -- QA boundary sweep for the S12 Williams Alligator
// evaluator (planner plans/PLAN-S12.md section 3 ASSERTIONS). This file does NOT touch
// 11-ta-ichimoku.test.mjs, 11b-ta-boundary.test.mjs, or 12-ta-alligator.test.mjs; it REUSES
// the S11 exported fixture helpers (primePlane / driveBars / rampMids / bootWithSignals, all
// deterministic: a synthetic clock through roll(now), h.inject as the pump, never a real
// timer) and adds coverage for the assertions the happy-path suites left unverified: warm
// fail-closed (A2), edge + payload + continued-ramp-adds-zero (A3), the negative-control
// non-vacuity gate (A4, RED-provable), cooldown suppression + both re-arm flavors (A5), the
// off/router/validation surface (A6), per-symbol independence (A7), a parked symbol still
// evaluating with zero vm reads (A8), and a fail-closed micro-check on the nit-1 guard.
//
// Every non-trivial fixture below was FIRST derived empirically by driving the REAL exported
// TaPlane/AlligatorEval classes with a synthetic clock (see the session scratch probes) --
// never guessed by hand-rolled SMMA arithmetic. Two lessons that bit during derivation, noted
// so a future maintainer does not re-learn them the hard way:
//   (1) AlligatorEval.evaluate() runs on EVERY bar close, including while `plane.count <
//       ALLIGATOR_WARM` (it just early-returns to the warming branch and pins prevState=0).
//       That means `lastBar` advances every bar from bar 0 onward, so the FIRST bar past the
//       warm threshold is a genuine 0->cur transition (edge-eligible), NOT a rearm bar. A
//       fixture that is already fully bull/bear-ordered by the warm boundary WILL fire there.
//   (2) Consequently a "two-of-three-conditions" negative-control fixture must not let ANY
//       ordering fully resolve at or before the warm boundary -- prime with a flat run past
//       ALLIGATOR_WARM (keeps the mouth braided/neutral through warm-up) before introducing
//       the deliberate partial-ordering move.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf} from './helpers/harness.mjs';
import {primePlane, driveBars, rampMids, bootWithSignals} from './11-ta-ichimoku.test.mjs';
import {ALLIGATOR_WARM} from '../kernel.js';

installRaf();

const GATOR_SPREAD_MIN = 0.0002;   // mirrors kernel.js -- used only to annotate fixture margins below

// Reset the plane + the ALLIGATOR evaluator to a deterministic clean slate (mirrors
// 12-ta-alligator.test.mjs's own primeGator -- reused pattern, not imported, since it is not
// exported by 11-ta-ichimoku.test.mjs or 12-ta-alligator.test.mjs).
function primeGator(h) {
    primePlane(h);
    const g = h.taGator;
    g.prevState = 0; g.lastBar = -1; g.cooldown = 0;
    g.state = 'warming';
    g.jaw = g.teeth = g.lips = NaN;
}

// A flat run for `flatBars` at `flatPrice`, then a one-directional move of `riseBars` steps of
// `riseStep` (positive = up, negative = down), then `tailBars` bars flat at the new price. The
// flat prefix keeps the mouth braided/neutral through the ALLIGATOR_WARM boundary (lesson 1
// above) so the injected move is the ONLY thing that can trip an ordering condition.
function buildMove(flatBars, flatPrice, riseStep, riseBars, tailBars) {
    const a = [];
    for (let i = 0; i < flatBars; i++) a.push(flatPrice);
    let p = flatPrice;
    for (let i = 0; i < riseBars; i++) { p += riseStep; a.push(p); }
    for (let i = 0; i < tailBars; i++) a.push(p);
    return a;
}

// ============================================================================================
// A2 -- warm fail-closed: ALLIGATOR_WARM - 1 (= 20) closed bars never compute a state or a
// signal; the readout lines stay NaN (never 0-valued). Bar 21 (barIndex 20) computes.
// ============================================================================================
test('A2: 20 closed bars of a clean ramp stay WARMING (zero signals, NaN-gated jaw/teeth/lips); bar 21 computes finite lines', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        let now = driveBars(h, rampMids(100, 1, ALLIGATOR_WARM - 1));   // 20 closed bars -- one short of ALLIGATOR_WARM
        assert.equal(signals.length, 0, 'zero signals before the 21st closed bar');
        assert.equal(h.taGator.state, 'warming', 'evaluator still warming at count 20');
        assert.ok(Number.isNaN(h.taGator.jaw), 'jaw absent (NaN) while warming -- never 0-valued');
        assert.ok(Number.isNaN(h.taGator.teeth), 'teeth absent while warming');
        assert.ok(Number.isNaN(h.taGator.lips), 'lips absent while warming');
        assert.equal(h.state().taWarmNeed, ALLIGATOR_WARM, 'HUD warm hint is mode-correct (21, not 78)');
        assert.equal(h.state().taWarm, false, 'not warm yet at 20 closed bars');

        // Bar 21 (barIndex 20): the ramp continues -- now count >= ALLIGATOR_WARM, so the
        // lines compute (finite, no longer NaN), and this happens to be the exact bar the
        // happy-path fixture fires its edge on (verified by 12-ta-alligator.test.mjs already).
        driveBars(h, [121], now);
        assert.equal(h.taGator.state, 'bull', 'state computes on the first warm bar');
        assert.ok(Number.isFinite(h.taGator.jaw) && Number.isFinite(h.taGator.teeth) && Number.isFinite(h.taGator.lips),
            'no readout field is NaN once warm');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A3 -- edge + payload: exactly one buy on the up-ramp with a fully-validated payload; the
// continued ramp adds zero (cooldown + no new edge). Exactly one sell on the down-ramp.
// ============================================================================================
test('A3: up-ramp fires exactly ONE buy with a fully-correct payload; the continued ramp adds ZERO', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        driveBars(h, rampMids(100, 1, ALLIGATOR_WARM));   // exactly the 21 bars that fire the edge
        assert.equal(signals.length, 1, 'exactly one signal at the warm boundary');
        const sig = signals[0];
        assert.equal(sig.symbol, 'BTCUSDT', 'payload names its own symbol');
        assert.equal(sig.strategy, 'alligator', 'strategy tag is the active mode');
        assert.equal(sig.side, 'buy', 'a rising ramp is a strong BUY');
        assert.equal(sig.bar, ALLIGATOR_WARM - 1, 'fires on barIndex 20 (the 21st close)');
        assert.ok(Math.abs(sig.price - 120) < 1e-3, 'price is the close of bar 20 (100 + 20)');
        assert.equal(typeof sig.at, 'number', 'payload carries a timestamp');

        driveBars(h, rampMids(121, 1, 79));   // 79 more bars, still rising -- prevState pinned +1
        assert.equal(signals.length, 1, 'the continued ramp adds ZERO new signals (cooldown + no new edge)');
    } finally {
        await handle.shutdown();
    }
});

test('A3: down-ramp fires exactly ONE sell', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        driveBars(h, rampMids(8000, -1, 100));
        assert.equal(signals.length, 1, 'exactly one signal on the down-ramp fixture');
        assert.equal(signals[0].side, 'sell', 'a falling ramp is a strong SELL');
        assert.equal(signals[0].bar, ALLIGATOR_WARM - 1, 'fires on the first warm bar');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A4 -- negative control (the RED-provable non-vacuity gate). Two independent fixtures:
//   (i)  awake=true, TWO of three ordering clauses hold, ONE deliberately violated -> 0
//        signals. Construction: 30 flat bars at 1000 (keeps the mouth braided through the
//        ALLIGATOR_WARM boundary -- lesson 1 in the file header), then a +2/bar rise for 4
//        bars, then ONE more flat bar. At the final bar (barIndex 34): price=1008,
//        jaw=teeth=1000 (the SMMA(13) and SMMA(8) windows still average almost entirely over
//        the pre-rise flat history so they read exactly equal -- teeth > jaw is FALSE),
//        lips=1000.76 (the SMMA(5) has already caught the rise -- lips > teeth is TRUE), and
//        price > lips is TRUE. spread = |lips-jaw|/price = 0.76/1008 ~= 7.5e-4 >=
//        GATOR_SPREAD_MIN (0.0002) -- genuinely awake. Empirically verified: zero signals for
//        the entire 35-bar drive (no earlier bar resolves all three clauses either).
//   (ii) SLEEPING: lines fully ordered (lips > teeth > jaw) but the mouth spread never clears
//        the floor -> 0 signals, proving the awake filter has real teeth. Construction: a
//        monotone ramp at a huge base price (1,000,000) with a microscopic step (0.001/bar) --
//        the absolute line separation is real and correctly ordered, but relative to a
//        7-figure price it is ~40 orders of magnitude below the 2-bps floor.
// Both are proven RED-provable below: the corresponding kernel.js guard is TEMPORARILY broken,
// the suite is re-run and shown to fail, then kernel.js is restored byte-for-byte and the
// suite is shown green again (see the coordinator-run RED/GREEN proof in the session report --
// this file only encodes the fixtures; it is re-run unmodified against both kernel states).
// ============================================================================================
test('A4(i): awake + 2-of-3 ordering clauses (teeth>jaw deliberately false) -> ZERO signals', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        const mids = buildMove(30, 1000, 2, 4, 1);   // 35 bars total, barIndex 0..34
        driveBars(h, mids);

        assert.equal(signals.length, 0, 'the gate never fires when one of three ordering clauses is false');
        const g = h.taGator;
        const price = mids[mids.length - 1];
        const spread = Math.abs(g.lips - g.jaw) / price;
        assert.ok(spread >= GATOR_SPREAD_MIN, 'sanity: the fixture is genuinely AWAKE (not vacuously sleeping)');
        assert.ok(g.lips > g.teeth, 'sanity: lips > teeth genuinely holds (clause 1 true)');
        assert.ok(price > g.lips, 'sanity: price > lips genuinely holds (clause 3 true)');
        assert.ok(!(g.teeth > g.jaw), 'sanity: teeth > jaw is the ONE deliberately-false clause (teeth == jaw here)');
        assert.equal(g.state, 'neutral', 'three-of-three is required for bull; two-of-three reads neutral');
    } finally {
        await handle.shutdown();
    }
});

test('A4(ii): lines fully ordered but sleeping (spread below GATOR_SPREAD_MIN) -> ZERO signals', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        const mids = rampMids(1000000, 0.001, 40);
        driveBars(h, mids);

        assert.equal(signals.length, 0, 'a sleeping alligator never fires, however cleanly the lines are ordered');
        const g = h.taGator;
        const price = mids[mids.length - 1];
        assert.ok(g.lips > g.teeth && g.teeth > g.jaw, 'sanity: the lines ARE fully ordered (not vacuously neutral)');
        assert.ok(Math.abs(g.lips - g.jaw) / price < GATOR_SPREAD_MIN, 'sanity: the spread genuinely sits below the floor');
        assert.equal(g.state, 'neutral', 'a sleeping mouth reads neutral regardless of ordering');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A5a -- cooldown suppresses a same-window re-entry; the same edge fires again once the
// cooldown expires. Construction (empirically derived): the 21-bar ramp fires a buy at bar 20
// (cooldown -> 30). A 10-bar retreat (step -1) crosses back to neutral by bar 24. A 10-bar
// re-climb (step +1.5) crosses back into bull at bar 37 -- STILL inside the cooldown window
// (cooldown=13 there) so the transition is recorded (prevState flips to +1) but NEVER
// emitted. A second 10-bar retreat (step -1) returns to neutral (cooldown expires en route, at
// bar 50); a final 10-bar re-climb (step +1.5) crosses into bull again at bar 57 -- cooldown is
// 0 by then, so it fires for real.
// ============================================================================================
test('A5a: cooldown suppresses a same-window re-entry; the same edge fires again once the cooldown expires', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        let now = driveBars(h, rampMids(100, 1, ALLIGATOR_WARM));   // bar 20: buy fires, cooldown -> 30
        assert.equal(signals.length, 1, 'sanity: the initial edge fired');
        assert.equal(h.taGator.cooldown, 30, 'sanity: cooldown armed at the max after the edge');

        let p = 120;
        const retreat1 = []; for (let i = 0; i < 10; i++) { p -= 1; retreat1.push(p); }
        now = driveBars(h, retreat1, now);

        let q = p;
        const reclimb1 = []; for (let i = 0; i < 10; i++) { q += 1.5; reclimb1.push(q); }
        now = driveBars(h, reclimb1, now);

        assert.equal(signals.length, 1, 'the re-entry into bull inside the cooldown window is SUPPRESSED (no second signal)');
        assert.equal(h.taGator.state, 'bull', 'the underlying state genuinely re-entered bull...');
        assert.equal(h.taGator.prevState, 1, '...and prevState silently tracks it (so a LATER edge is not a false one)');
        assert.ok(h.taGator.cooldown > 0, 'the suppression is because the cooldown has not expired yet');

        let r = q;
        const retreat2 = []; for (let i = 0; i < 10; i++) { r -= 1; retreat2.push(r); }
        now = driveBars(h, retreat2, now);
        assert.equal(h.taGator.cooldown, 0, 'sanity: the cooldown has fully expired by the second retreat');
        assert.equal(h.taGator.state, 'neutral', 'sanity: back to neutral before the final re-climb');

        let s = r;
        const reclimb2 = []; for (let i = 0; i < 10; i++) { s += 1.5; reclimb2.push(s); }
        // Drive up to and including the firing bar (index 6 = barIndex 57) first, so the
        // cooldown re-arm can be observed on the EXACT bar it happens, before later bars in
        // the same fixture decrement it again.
        let now2 = driveBars(h, reclimb2.slice(0, 7), now);

        assert.equal(signals.length, 2, 'once the cooldown has expired, the next genuine edge fires');
        assert.equal(signals[1].side, 'buy');
        assert.equal(signals[1].bar, 57, 'fires exactly on the bar where the post-cooldown edge occurs');
        assert.equal(h.taGator.cooldown, 30, 'the fresh edge re-arms the cooldown to the max again, read on the SAME bar it fired');

        driveBars(h, reclimb2.slice(7), now2);
        assert.equal(signals.length, 2, 'the 3 further evaluated bars decrement the cooldown but add no new signal');
        assert.equal(h.taGator.cooldown, 27, 'cooldown decrements once per evaluated bar after the fresh edge');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A5b -- the off->alligator stale-edge case (contract 2): an evaluator that did not run on the
// immediately-preceding bar must resync prevState SILENTLY, no emission on the resync bar
// EVEN IF the resync bar computes a genuine-looking bull/bear state.
// ============================================================================================
// Construction (empirically derived, reusing the A5a 5-stage sequence but with mode 'off' for
// the first 56 bars): the plane still warms and the state machine still WOULD reach bull at
// barIndex 57 in a continuously-'alligator' run (proven by A5a above) -- but here the evaluator
// never runs through bar 56 (mode is 'off', router resolves the frozen no-op). Flipping to
// 'alligator' and closing exactly bar 57 is the STALE-EDGE / resync bar: taGator.lastBar (-1)
// != barIndex-1 (56) triggers the rearm branch, which computes+stores the readout (state
// genuinely reads 'bull') and resyncs prevState to it WITHOUT emitting -- proving contract 2
// holds even on a resync bar whose own computed state looks like a real edge.
test('A5b: an off->alligator stale edge re-arms silently, even when the resync bar itself computes bull', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);
        assert.equal(handle.taMode(), 'off', 'sanity: the strategy boots off by default');

        let p = 120;
        const retreat1 = []; for (let i = 0; i < 10; i++) { p -= 1; retreat1.push(p); }
        let q = p;
        const reclimb1 = []; for (let i = 0; i < 10; i++) { q += 1.5; reclimb1.push(q); }
        let r = q;
        const retreat2 = []; for (let i = 0; i < 10; i++) { r -= 1; retreat2.push(r); }
        let s = r;
        const reclimb2 = []; for (let i = 0; i < 10; i++) { s += 1.5; reclimb2.push(s); }

        const mids1 = rampMids(100, 1, ALLIGATOR_WARM).concat(retreat1, reclimb1, retreat2, reclimb2.slice(0, 6));
        let now = driveBars(h, mids1);   // bars 0..56, mode 'off' throughout -- the evaluator never runs

        assert.equal(signals.length, 0, 'nothing fires while off, even though the plane is fully warm');
        assert.equal(h.taGator.lastBar, -1, 'the evaluator never ran once -- lastBar is untouched');
        assert.equal(h.ta.count, 57, 'sanity: the PLANE warmed and kept rolling regardless of mode');

        handle.setTaMode('alligator');
        now = driveBars(h, [reclimb2[6]], now);   // barIndex 57: the stale-edge / resync bar

        assert.equal(signals.length, 0, 'the resync bar never emits, no matter what it computes');
        assert.equal(h.taGator.lastBar, 57, 'the evaluator now HAS run, and recorded this bar');
        assert.equal(h.taGator.state, 'bull', 'sanity: this resync bar genuinely computes bull (the strong case for contract 2)');
        assert.equal(h.taGator.prevState, 1, 'prevState silently resynced to the resync-bar state');

        driveBars(h, reclimb2.slice(7), now);
        assert.equal(signals.length, 0, 'continuing the (already-bull) climb fires nothing new -- prevState already matches cur');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A6 -- off mode + router selection + setTaMode validation; identity + mode-exclusivity.
// ============================================================================================
test('A6: mode off never signals; setTaMode fails closed on a bad mode; router resolves the SAME ta:alligator singleton', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        // -- off + router: the ramp fixture (which fires a buy once warm in mode alligator)
        // produces ZERO signals while the router resolves ta:off.
        assert.equal(handle.taMode(), 'off', 'sanity: default mode is off');
        driveBars(h, rampMids(100, 1, 100));
        assert.equal(signals.length, 0, 'the off-mode router resolves the frozen no-op evaluator -- never a signal');
        assert.equal(h.state().taState, 'off', 'the off readout string is the literal "off"');

        // -- setTaMode validation: a mis-shaped mode fails closed with the REAL cause named.
        assert.throws(() => handle.setTaMode('bogus'), (err) => err instanceof TypeError && /bogus/.test(err.message),
            'setTaMode names the offending mode in the thrown TypeError');
        assert.equal(handle.taMode(), 'off', 'a rejected setTaMode call never mutates the live mode');

        // -- setTaMode('alligator') is valid and round-trips.
        handle.setTaMode('alligator');
        assert.equal(handle.taMode(), 'alligator');

        // -- router identity: the container resolves the SAME ta:alligator singleton the test
        // seam (taGator) already holds -- not a fresh instance per resolve.
        assert.equal(h.scope.get('ta:alligator'), h.taGator, 'the router-selected token IS the taGator test seam, by identity');

        // -- mode exclusivity: while in alligator mode, driving bars advances ONLY taGator's
        // lastBar; taEval (the ichimoku evaluator, still sitting untouched since primePlane's
        // reset) never runs.
        primeGator(h);
        const now = driveBars(h, rampMids(100, 1, 10));
        assert.equal(h.taGator.lastBar, 9, 'taGator ran on every bar in alligator mode');
        assert.equal(h.taEval.lastBar, -1, 'taEval never ran while mode was alligator');

        // -- switching back to ichimoku selects the OTHER evaluator; taGator now freezes.
        handle.setTaMode('ichimoku');
        driveBars(h, rampMids(111, 1, 10), now);
        assert.equal(h.taEval.lastBar >= 0, true, 'taEval now runs once ichimoku is selected');
        assert.equal(h.taGator.lastBar, 9, 'taGator is frozen at its last alligator-mode bar -- one strategy at a time');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A7 -- per-symbol independence: two scopes warm independently, sign their own payloads, and
// survive a sibling close with the other's AlligatorEval state completely intact.
// ============================================================================================
test('A7: two symbol scopes warm independently, sign their own payloads, and survive a sibling close untouched', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');   // global (one strategy at a time) -- both scopes share this gate
        const h1 = handle._scopes.get('BTCUSDT');
        primeGator(h1);
        const h2 = await handle.addSymbol('LINKUSDT', 'wss://feed/link');
        primeGator(h2);

        driveBars(h1, rampMids(100, 1, 40));    // fires its own buy at bar 20
        driveBars(h2, rampMids(500, 1, 60));    // a DIFFERENT total bar count -- also fires at its own bar 20

        assert.equal(h1.state().taBars, 40, 'BTCUSDT warmed on its own bar count');
        assert.equal(h2.state().taBars, 60, 'LINKUSDT warmed on a completely different bar count');
        assert.notEqual(h1.state().taBars, h2.state().taBars, 'the two counts are independent, not shared');

        const btc = signals.find((sg) => sg.symbol === 'BTCUSDT');
        const link = signals.find((sg) => sg.symbol === 'LINKUSDT');
        assert.ok(btc, 'BTCUSDT signal present');
        assert.ok(link, 'LINKUSDT signal present');
        assert.equal(btc.bar, ALLIGATOR_WARM - 1, 'BTCUSDT fired on its own first warm bar');
        assert.equal(link.bar, ALLIGATOR_WARM - 1, 'LINKUSDT fired on its own first warm bar (independent evaluator state)');
        assert.equal(signals.length, 2, 'exactly one signal per scope -- no cross-contamination');

        const before = {
            state: h1.taGator.state, prevState: h1.taGator.prevState, cooldown: h1.taGator.cooldown,
            jaw: h1.taGator.jaw, teeth: h1.taGator.teeth, lips: h1.taGator.lips,
        };
        assert.equal(before.cooldown, 30 - (40 - 1 - (ALLIGATOR_WARM - 1)), 'sanity: cooldown decremented once per evaluated bar since the edge');

        await handle.closeSymbol('LINKUSDT');

        assert.equal(handle._scopes.has('LINKUSDT'), false, 'sanity: the sibling scope is really gone');
        assert.deepEqual({
            state: h1.taGator.state, prevState: h1.taGator.prevState, cooldown: h1.taGator.cooldown,
            jaw: h1.taGator.jaw, teeth: h1.taGator.teeth, lips: h1.taGator.lips,
        }, before, 'closing one scope leaves the other AlligatorEval (state, cooldown, readout) byte-identical');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A8 -- a PARKED symbol still evaluates and emits, with NO vm read anywhere on the alligator
// path (contract 1: AlligatorEval reads the plane only).
// ============================================================================================
test('A8: a parked symbol keeps filling candles and still emits a due alligator signal -- the plane never reads vm', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        const parked = handle.parkSymbol('BTCUSDT');
        assert.equal(parked, true, 'sanity: the park call itself succeeded');
        assert.throws(() => h.vm.mid, Error, 'sanity: the vm really is parked -- every accessor throws');

        let caught = null;
        try {
            driveBars(h, rampMids(100, 1, 40));
        } catch (e) {
            caught = e;
        }
        assert.equal(caught, null, 'driving candles + the alligator evaluator through a parked scope never throws');

        assert.equal(h.ta.count, 40, 'candles kept filling while parked');
        assert.equal(signals.length, 1, 'a due signal still emits while parked');
        assert.equal(signals[0].symbol, 'BTCUSDT');
        assert.equal(signals[0].side, 'buy');
        assert.equal(h.state().taWarm, true, 'the state() readout itself also never touches vm');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// Micro-check (reviewer nit-1) -- a warm plane whose latest close is exactly 0 (a 0/NaN mid,
// out of contract) never crashes and never signals: `price > 0 &&` fails closed before the
// spread division, so `awake` is forced false rather than a NaN/Infinity propagating.
// ============================================================================================
test('nit-1: a warm plane fed mid=0 on its latest bar fails closed (awake=false, no throw, no new signal)', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);

        const now = driveBars(h, rampMids(100, 1, 25));   // warms + fires the ordinary buy at bar 20
        assert.equal(signals.length, 1, 'sanity: the ordinary edge fired before the zero tick');

        let caught = null;
        try {
            driveBars(h, [0], now);
        } catch (e) {
            caught = e;
        }
        assert.equal(caught, null, 'a zero-price bar never throws (no division-by-zero propagation)');
        assert.equal(signals.length, 1, 'the zero-price bar never itself emits a new signal');
        assert.ok(!Number.isNaN(h.taGator.jaw) && !Number.isNaN(h.taGator.teeth) && !Number.isNaN(h.taGator.lips),
            'the readout lines stay finite (the forward displacement means the newest bar is not yet read into them)');
    } finally {
        await handle.shutdown();
    }
});
