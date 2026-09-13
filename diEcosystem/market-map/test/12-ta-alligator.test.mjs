// 12-ta-alligator.test.mjs -- S12 happy path (ASSERTION 3, the edge + payload) for the second
// router-selected strategy, the Williams Alligator. Boots the kernel HEADLESS (the fake
// socketFactory the S6 gates use), selects mode 'alligator', and drives candles
// DETERMINISTICALLY with the SAME S11 fixtures (imported, never duplicated): inject(mid) + a
// SYNTHETIC clock. A clean ramp opens the alligator's mouth once warm, so exactly ONE strong
// edge fires -- on the first evaluated bar (barIndex ALLIGATOR_WARM - 1 = 20). qa owns the
// boundary / negative-control / cooldown / off-mode / park / independence suite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootWithSignals, primePlane, driveBars, rampMids, WARM_BARS} from './11-ta-ichimoku.test.mjs';
import {ALLIGATOR_WARM} from '../kernel.js';

// primePlane (S11) resets the plane + the ICHIMOKU evaluator; the alligator evaluator needs
// the same clean slate so the synthetic clock is the sole driver. Reset it via the taGator seam.
function primeGator(h) {
    primePlane(h);
    const g = h.taGator;
    g.prevState = 0; g.lastBar = -1; g.cooldown = 0;
    g.state = 'warming';
    g.jaw = g.teeth = g.lips = NaN;
}

test('S12 happy path: a warm upward ramp fires EXACTLY ONE strong-buy alligator edge with the right payload', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);
        // 100 bars of a clean +1/bar ramp from 100. The 21st closed bar (barIndex 20) is the
        // first EVALUATED bar (count >= ALLIGATOR_WARM) and where the mouth first opens upward
        // -> one buy edge. The continued ramp stays bullish -> prevState pinned +1 -> zero more.
        driveBars(h, rampMids(100, 1, 100));

        assert.equal(signals.length, 1, 'exactly one signal on the ramp fixture');
        const sig = signals[0];
        assert.equal(sig.symbol, 'BTCUSDT', 'payload names its own symbol');
        assert.equal(sig.strategy, 'alligator', 'strategy tag is the active mode');
        assert.equal(sig.side, 'buy', 'a rising ramp is a strong BUY');
        assert.equal(sig.bar, ALLIGATOR_WARM - 1, 'fires on the first warm bar (barIndex 20 = the 21st close)');
        assert.ok(Math.abs(sig.price - 120) < 1e-3, 'price is the close of bar 20 (100 + 20)');
        assert.ok(signals.every((s) => s.bar >= ALLIGATOR_WARM - 1), 'zero signals before the 21st closed bar');
        assert.equal(typeof sig.at, 'number', 'payload carries a timestamp');
    } finally {
        await handle.shutdown();
    }
});

test('S12 happy path: a warm downward ramp fires EXACTLY ONE strong-sell alligator edge', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);
        // A clean -1/bar ramp from 8000: the mouth opens downward with price leading -> one sell.
        driveBars(h, rampMids(8000, -1, 100));

        assert.equal(signals.length, 1, 'exactly one signal on the down-ramp fixture');
        const sig = signals[0];
        assert.equal(sig.strategy, 'alligator', 'strategy tag');
        assert.equal(sig.side, 'sell', 'a falling ramp is a strong SELL');
        assert.equal(sig.bar, ALLIGATOR_WARM - 1, 'fires on the first warm bar');
    } finally {
        await handle.shutdown();
    }
});

test('S12 warm boundary: zero signals before ALLIGATOR_WARM closed bars; the lines are absent while warming', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('alligator');
        const h = handle._scopes.get('BTCUSDT');
        primeGator(h);
        // ALLIGATOR_WARM - 1 (= 20) closed bars of a clean ramp: still warming, no signal, and
        // the readout lines stay NaN (HUD '--', never a 0-valued span -- null is not zero).
        driveBars(h, rampMids(100, 1, ALLIGATOR_WARM - 1));

        assert.equal(signals.length, 0, 'zero signals before the warm threshold');
        assert.equal(h.taGator.state, 'warming', 'evaluator still warming at count 20');
        assert.ok(Number.isNaN(h.taGator.jaw), 'jaw absent (NaN) while warming');
        assert.ok(Number.isNaN(h.taGator.teeth), 'teeth absent while warming');
        assert.ok(Number.isNaN(h.taGator.lips), 'lips absent while warming');
        const st = handle.readState();
        assert.equal(st.taWarmNeed, ALLIGATOR_WARM, 'HUD warm hint is mode-correct (21, not 78)');
    } finally {
        await handle.shutdown();
    }
});

test('S12 ichimoku stays green: WARM_BARS is unchanged, alligator warms much sooner', () => {
    // Sanity that the two warm thresholds are distinct constants (the fast-warm browser hook).
    assert.equal(ALLIGATOR_WARM, 21, 'alligator warms in 21 bars');
    assert.equal(WARM_BARS, 78, 'ichimoku warms in 78 bars (imported constant, unchanged)');
});
