// 11b-ta-boundary.test.mjs -- QA boundary sweep for the S11 TA plane (planner
// plans/PLAN-S11.md section 3 ASSERTIONS). This file does NOT touch 11-ta-ichimoku.test.mjs;
// it REUSES its exported fixture helpers (primePlane / driveBars / rampMids /
// bootWithSignals, all deterministic: a synthetic clock through roll(now), h.inject as the
// pump, never a real timer) and only ADDS coverage for the assertions the happy-path suite
// left unverified: warm fail-closed (A2), a negative-control fixture that proves the gate is
// RED-provable (A4), cooldown suppression + the off->on stale-edge silent re-arm (A5), the
// off/router/validation surface + the off-readout NaN rule (A6), per-symbol independence
// (A7), a parked symbol still evaluating with zero vm reads (A8), and a reviewer-nit
// allocation check on the REAL taRouter path (10k router-resolved bar closes).
//
// Every fixture below that is not a plain ramp was FIRST derived empirically against the
// real exported TaPlane/IchimokuEval classes (never guessed by hand-rolled Ichimoku
// arithmetic, which is error-prone: the OHLC carry-forward-open rule means a single-tick
// bar's low/high are NOT simply equal to its close -- see the A4/A5 comments for exactly
// which bar each fixture is built around).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf} from './helpers/harness.mjs';
import {primePlane, driveBars, rampMids, bootWithSignals, BAR_MS, WARM_BARS} from './11-ta-ichimoku.test.mjs';

installRaf();

// ============================================================================================
// A2 -- warm fail-closed: 77 closed bars never compute a state or a signal; bar 78 does.
// ============================================================================================
test('A2: 77 closed bars of maximal ramp stay WARMING (zero signals, NaN-gated readout); bar 78 computes', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);

        let now = driveBars(h, rampMids(100, 1, WARM_BARS - 1));   // 77 closed bars -- one short of TA_WARM
        assert.equal(signals.length, 0, 'zero signals before the 78th closed bar');

        const st77 = h.state();
        assert.equal(st77.taBars, 77, 'taBars mirrors the plane bar count exactly');
        assert.equal(st77.taWarm, false, 'not warm yet at 77 closed bars');
        assert.equal(st77.taState, 'warming 98%', 'warm percentage is floor(77/78*100)');
        assert.ok(Number.isNaN(st77.tenkan), 'tenkan reads NaN while warming -- never 0');
        assert.ok(Number.isNaN(st77.kijun), 'kijun reads NaN while warming -- never 0');
        assert.ok(Number.isNaN(st77.spanA), 'spanA reads NaN while warming -- never 0');
        assert.ok(Number.isNaN(st77.spanB), 'spanB reads NaN while warming -- never 0');

        // Bar 78 (barIndex 77): the ramp continues, so this IS the first evaluated bar and
        // fires the same strong-buy edge as the S11 happy-path fixture (bar 77, price 177).
        now = driveBars(h, [177], now);
        const st78 = h.state();
        assert.equal(st78.taBars, 78, 'the 78th closed bar is now counted');
        assert.equal(st78.taWarm, true, 'warm the instant count reaches TA_WARM');
        assert.equal(st78.taState, 'bull', 'state computes on the first warm bar');
        assert.equal(typeof st78.tenkan, 'number', 'tenkan is a real number once warm');
        assert.ok(!Number.isNaN(st78.tenkan) && !Number.isNaN(st78.kijun)
            && !Number.isNaN(st78.spanA) && !Number.isNaN(st78.spanB), 'no readout field is NaN once warm');
        assert.equal(signals.length, 1, 'the warm boundary itself is where the edge fires');
        assert.equal(signals[0].bar, WARM_BARS - 1, 'fires on barIndex 77 (the 78th close)');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A4 -- negative control: the gate's RED-provability. A fixture true on THREE of the four
// strong-bull conditions with chikou deliberately violated must emit ZERO signals.
// ============================================================================================
// Construction (empirically derived, see the file header): start from the EXACT S11
// happy-path ramp (rampMids(100,1,78) -- warms and would fire a strong buy at bar 77) and
// spike exactly ONE bar: index 51, which is precisely DISP(26) bars behind bar 77. That
// single bar feeds bar 77's chikou comparison directly (`priceD = cAt(DISP)` reads index 51
// verbatim) while sitting just outside the tenkan/kijun back=0 windows (kijun's 26-bar
// window at bar 77 starts at index 52, one past the spike) -- so tenkan>kijun and the
// forward cloud stay bullish, and the spike is only mildly diluted into the "cloud now"
// windows (which also read index 51) so price still clears cloudTop. Net effect at bar 77:
// price>cloudTop TRUE, tenkan>kijun TRUE, forward cloud bullish TRUE, chikou (price>priceD)
// FALSE -- three bull conditions with chikou alone broken. Empirically verified: state stays
// 'neutral', signals stay at 0 for the entire 78-bar drive (RED-provable: flip the chikou
// comparison operator in kernel.js and this fixture starts firing).
test('A4: negative control -- 3-of-4 bull conditions true, chikou deliberately violated -> ZERO signals', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);

        const mids = rampMids(100, 1, WARM_BARS);   // 78 bars, identical to the happy-path ramp
        mids[51] = 180;                             // the ONE spiked bar -- see the derivation above

        driveBars(h, mids);

        assert.equal(signals.length, 0, 'the gate never fires on a chikou-violated fixture');
        const st = h.state();
        assert.equal(st.taWarm, true, 'sanity: the fixture is warm (the negative control is not vacuous-by-warming)');
        assert.equal(st.taState, 'neutral', 'three-of-four bull conditions is neutral, not bull');
        assert.ok(st.tenkan > st.kijun, 'sanity: tenkan>kijun genuinely holds in this fixture (not a coincidental neutral)');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A5a -- cooldown suppression + silent re-arm after expiry.
// ============================================================================================
// Construction (empirically derived): the happy-path ramp fires a buy at bar 77 (cooldown
// set to TA_COOLDOWN_BARS=30, active through the evaluate at bar 106). A 12-bar gentle
// retreat (bars 78-89) brings state back to neutral; a 10-bar re-climb (bars 90-99) crosses
// back into bull at bar 99 -- STILL inside the cooldown window (cooldown=8 at that bar) so
// the transition is recorded (prevState flips to +1) but NEVER emitted. A second 10-bar
// retreat (bars 100-109) returns to neutral once more (and the cooldown expires along the
// way, at bar 107); a final 5-bar re-climb (bars 110-114) crosses into bull again at bar
// 110 -- this time cooldown is 0, so it fires for real.
test('A5a: cooldown suppresses a same-window re-entry; the same edge fires again once the cooldown expires', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);

        let now = driveBars(h, rampMids(100, 1, WARM_BARS));   // bar 77: buy fires, cooldown -> 30
        assert.equal(signals.length, 1, 'sanity: the initial edge fired');
        assert.equal(h.taEval.cooldown, 30, 'sanity: cooldown armed at the max after the edge');

        let p = 177;
        const retreat1 = [];
        for (let i = 0; i < 12; i++) { p -= 1; retreat1.push(p); }     // bars 78-89: toward neutral
        const reclimb1 = [];
        for (let i = 0; i < 10; i++) { p += 1.5; reclimb1.push(p); }   // bars 90-99: back into bull, still cooling down
        now = driveBars(h, retreat1.concat(reclimb1), now);

        assert.equal(signals.length, 1, 'the re-entry into bull inside the cooldown window is SUPPRESSED (no second signal)');
        assert.equal(h.taEval.state, 'bull', 'the underlying state genuinely re-entered bull...');
        assert.equal(h.taEval.prevState, 1, '...and prevState silently tracks it (so a LATER edge is not a false one)');
        assert.ok(h.taEval.cooldown > 0, 'the suppression is because the cooldown has not expired yet');

        const retreat2 = [];
        for (let i = 0; i < 10; i++) { p -= 1; retreat2.push(p); }     // bars 100-109: back to neutral, cooldown expires en route
        const reclimb2 = [p + 2];                                       // bar 110 alone: into bull again -- cooldown is now 0
        driveBars(h, retreat2.concat(reclimb2), now);

        assert.equal(signals.length, 2, 'once the cooldown has expired, the next genuine edge fires');
        assert.equal(signals[1].side, 'buy');
        assert.equal(signals[1].bar, 110, 'fires exactly on the bar where the post-cooldown edge occurs');
        assert.equal(h.taEval.cooldown, 30, 'the fresh edge re-arms the cooldown to the max again, read on the SAME bar it fired');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A5b -- the off->on stale-edge case (contract 2): an evaluator that did not run on the
// immediately-preceding bar must resync prevState SILENTLY, never emit on the resync bar.
// ============================================================================================
// Construction (empirically derived): drive the S11 happy-path ramp (78 bars) plus a 15-bar
// retreat (step -2/bar) while the strategy is 'off' (the default at boot) -- the plane still
// warms (CandleApply is not mode-gated) but the evaluator never runs (router resolves the
// frozen ta:off no-op), so taEval.lastBar stays at its constructor default (-1). Flipping to
// 'ichimoku' and closing exactly one more bar (barIndex 93) is the STALE-EDGE bar: lastBar
// (-1) != barIndex-1 (92) triggers the rearm branch, which resyncs prevState and returns
// before the emit check -- this bar computes 'neutral' and must never signal, whatever it
// computes. Continuing the climb (13 more bars, +2/bar) then crosses genuinely into bull at
// barIndex 106 -- lastBar is now contiguous, so this is a REAL edge and fires.
test('A5b: an off->on stale edge re-arms silently; the next REAL transition (not the resync) emits', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);
        assert.equal(handle.taMode(), 'off', 'sanity: the strategy boots off by default');

        const mids1 = rampMids(100, 1, WARM_BARS);        // bars 0-77, still off -- the evaluator never runs
        let p = mids1[mids1.length - 1];
        for (let i = 0; i < 15; i++) { p -= 2; mids1.push(p); }   // bars 78-92, still off (a state flip the evaluator never sees)
        let now = driveBars(h, mids1);
        assert.equal(signals.length, 0, 'nothing fires while off, even though the plane is fully warm');
        assert.equal(h.taEval.lastBar, -1, 'the evaluator never ran once -- lastBar is untouched');
        assert.equal(h.ta.count, WARM_BARS + 15, 'sanity: the PLANE warmed and kept rolling regardless of mode');

        handle.setTaMode('ichimoku');

        now = driveBars(h, [p + 2], now);                 // barIndex 93: the stale-edge / resync bar
        assert.equal(signals.length, 0, 'the resync bar (contract 2) never emits, no matter what state it lands on');
        assert.equal(h.taEval.lastBar, 93, 'the evaluator now HAS run, and recorded this bar');
        assert.equal(h.taEval.state, 'neutral', 'sanity: this is the exact resync bar the fixture was built around');

        const rest = [];
        let q = p + 2;
        for (let i = 0; i < 13; i++) { q += 2; rest.push(q); }
        driveBars(h, rest, now);

        assert.equal(signals.length, 1, 'the next REAL transition (contiguous lastBar, a genuine edge) fires exactly once');
        assert.equal(signals[0].side, 'buy');
        assert.equal(signals[0].bar, 106, 'fires on the bar where the genuine neutral -> bull edge occurs');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A6 -- off mode + router selection + setTaMode validation, including the post-review
// off-readout rule (spans read NaN, not stale numbers, once the strategy is turned off).
// ============================================================================================
test('A6: mode off never signals; setTaMode fails closed on a bad mode; taMode() round-trips; off-readout is NaN, not stale', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        const h = handle._scopes.get('BTCUSDT');

        // -- off + router: the ramp fixture (which fires a buy once warm in mode ichimoku)
        // produces ZERO signals while the router resolves ta:off.
        primePlane(h);
        assert.equal(handle.taMode(), 'off', 'sanity: default mode is off');
        driveBars(h, rampMids(100, 1, 100));
        assert.equal(signals.length, 0, 'the off-mode router resolves the frozen no-op evaluator -- never a signal');
        assert.equal(h.state().taState, 'off', 'the off readout string is the literal "off", not a stale evaluator state');

        // -- setTaMode validation: a mis-shaped mode fails closed with the REAL cause named.
        assert.throws(() => handle.setTaMode('bogus'), (err) => err instanceof TypeError && /bogus/.test(err.message),
            'setTaMode names the offending mode in the thrown TypeError');
        assert.equal(handle.taMode(), 'off', 'a rejected setTaMode call never mutates the live mode');

        // -- round-trip: taMode() always reflects the last successfully applied mode.
        handle.setTaMode('ichimoku');
        assert.equal(handle.taMode(), 'ichimoku');
        handle.setTaMode('off');
        assert.equal(handle.taMode(), 'off');

        // -- the off-readout rule: warm up + fire a real signal in mode ichimoku, THEN switch
        // back to off. The readout must show NaN, not the evaluator's last-computed numbers
        // (which are still sitting on taEval, proving this is a READOUT gate, not a data loss).
        primePlane(h);
        handle.setTaMode('ichimoku');
        driveBars(h, rampMids(100, 1, 90));
        const warmState = h.state();
        assert.equal(warmState.taState, 'bull');
        assert.equal(typeof warmState.tenkan, 'number');
        assert.ok(!Number.isNaN(h.taEval.tenkan), 'sanity: the evaluator DOES hold real numbers internally');

        handle.setTaMode('off');
        const offState = h.state();
        assert.equal(offState.taState, 'off');
        assert.ok(Number.isNaN(offState.tenkan), 'tenkan reads NaN once off, even though taEval.tenkan is still a real number');
        assert.ok(Number.isNaN(offState.kijun), 'kijun reads NaN once off');
        assert.ok(Number.isNaN(offState.spanA), 'spanA reads NaN once off');
        assert.ok(Number.isNaN(offState.spanB), 'spanB reads NaN once off');
        assert.ok(!Number.isNaN(h.taEval.tenkan), 'the underlying evaluator field is untouched -- this is a display gate, not a reset');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A7 -- per-symbol independence: two scopes warm independently, each payload names its own
// symbol, and closing one leaves the other's evaluator state (including pending cooldown)
// completely intact.
// ============================================================================================
test('A7: two symbol scopes warm independently, sign their own payloads, and survive a sibling close untouched', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');   // global (one strategy at a time) -- both scopes share this gate
        const h1 = handle._scopes.get('BTCUSDT');
        primePlane(h1);
        const h2 = await handle.addSymbol('LINKUSDT', 'wss://feed/link');
        primePlane(h2);

        driveBars(h1, rampMids(100, 1, 90));    // 90 bars -- fires its own buy at bar 77
        driveBars(h2, rampMids(500, 1, 110));   // a DIFFERENT total bar count (still < TA_RING=128, no saturation) -- also fires at its own bar 77

        assert.equal(h1.state().taBars, 90, 'BTCUSDT warmed on its own bar count');
        assert.equal(h2.state().taBars, 110, 'LINKUSDT warmed on a completely different bar count');
        assert.notEqual(h1.state().taBars, h2.state().taBars, 'the two counts are independent, not shared');

        const btc = signals.find((s) => s.symbol === 'BTCUSDT');
        const link = signals.find((s) => s.symbol === 'LINKUSDT');
        assert.ok(btc, 'BTCUSDT signal present');
        assert.ok(link, 'LINKUSDT signal present');
        assert.equal(btc.bar, 77, 'BTCUSDT fired on its own first warm bar');
        assert.equal(link.bar, 77, 'LINKUSDT fired on its own first warm bar (independent evaluator state)');
        assert.equal(signals.length, 2, 'exactly one signal per scope -- no cross-contamination');

        // Snapshot BTCUSDT's evaluator state (including the pending cooldown from its own
        // edge at bar 77, decremented by its own 12 post-edge evaluated bars) BEFORE closing
        // the sibling scope.
        const before = {
            state: h1.taEval.state, prevState: h1.taEval.prevState, cooldown: h1.taEval.cooldown,
            tenkan: h1.taEval.tenkan, kijun: h1.taEval.kijun, spanA: h1.taEval.spanA, spanB: h1.taEval.spanB,
        };
        assert.equal(before.cooldown, 30 - (90 - 1 - 77), 'sanity: cooldown decremented once per evaluated bar since the edge');

        await handle.closeSymbol('LINKUSDT');

        assert.equal(handle._scopes.has('LINKUSDT'), false, 'sanity: the sibling scope is really gone');
        assert.deepEqual({
            state: h1.taEval.state, prevState: h1.taEval.prevState, cooldown: h1.taEval.cooldown,
            tenkan: h1.taEval.tenkan, kijun: h1.taEval.kijun, spanA: h1.taEval.spanA, spanB: h1.taEval.spanB,
        }, before, 'closing one scope leaves the other evaluator (state, cooldown, readout) byte-identical');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// A8 -- a PARKED symbol still evaluates and emits, with NO vm read anywhere on the TA path.
// ============================================================================================
test('A8: a parked symbol keeps filling candles and still emits a due signal -- the plane never reads vm', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);

        const parked = handle.parkSymbol('BTCUSDT');
        assert.equal(parked, true, 'sanity: the park call itself succeeded');
        assert.throws(() => h.vm.mid, Error, 'sanity: the vm really is parked -- every accessor throws');

        let caught = null;
        try {
            driveBars(h, rampMids(100, 1, 90));
        } catch (e) {
            caught = e;
        }
        assert.equal(caught, null, 'driving candles + the evaluator through a parked scope never throws (no ReactiveDisposedError anywhere)');

        assert.equal(h.ta.count, 90, 'candles kept filling while parked');
        assert.equal(signals.length, 1, 'a due signal still emits while parked');
        assert.equal(signals[0].symbol, 'BTCUSDT');
        assert.equal(signals[0].side, 'buy');
        assert.equal(h.state().taWarm, true, 'the state() readout itself also never touches vm (gated on feedGate elsewhere, not here)');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// REVIEWER NIT -- 10,000 bar closes through the REAL taRouter path (StrategyRouter.resolve
// every bar, the path alloc-ta.mjs bypasses by driving TaPlane/IchimokuEval directly) stay
// steady-state 0-alloc. Self-skips loudly (not a silent vacuous pass) without --expose-gc.
// ============================================================================================
test('NIT: 10,000 taRouter-resolved bar closes in mode ichimoku stay steady-state 0-alloc (<65536 B growth)', async (t) => {
    if (typeof globalThis.gc !== 'function') {
        t.skip('needs --expose-gc -- run under `node --expose-gc --test test/11b-ta-boundary.test.mjs`');
        return;
    }
    const {handle} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);

        let now = driveBars(h, rampMids(100, 1, 90));   // warm past TA_WARM through the REAL router path
        // Warm the JIT on the exact hot loop before fencing the measurement window.
        for (let i = 0; i < 2000; i++) {
            h.inject(190, 189, 191);
            now += BAR_MS;
            h.ta.roll(now);
        }

        globalThis.gc();
        const before = process.memoryUsage().heapUsed;
        const N = 10000;
        for (let i = 0; i < N; i++) {
            h.inject(190, 189, 191);            // flat tick -- taRouter.resolve() + evaluate() run every bar close
            now += BAR_MS;
            h.ta.roll(now);
        }
        globalThis.gc();
        const after = process.memoryUsage().heapUsed;
        const growth = after - before;

        console.log('NIT taRouter-path growth = ' + growth + ' B over ' + N + ' bar closes (limit < 65536)');
        assert.ok(growth < 65536, 'post-gc heap growth ' + growth + ' B must be < 65536 B over ' + N + ' router-resolved bar closes');
    } finally {
        await handle.shutdown();
    }
});
