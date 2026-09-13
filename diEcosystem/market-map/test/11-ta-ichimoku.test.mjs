// 11-ta-ichimoku.test.mjs -- S11 happy path (ASSERTION 3, the edge + payload). Boots the
// kernel HEADLESS (the fake socketFactory the S6 gates use), selects mode ichimoku, and
// drives candles DETERMINISTICALLY with inject(mid) + a SYNTHETIC clock (never real timers,
// per the plan's contract 3 note). A clean upward ramp satisfies all four Ichimoku strong-
// bull conditions once warm, so exactly ONE buy edge fires -- on the first evaluated bar.
//
// The fixture helpers (primePlane / driveBars / rampMids / bootWithSignals) are EXPORTED so
// the qa boundary suite reuses the same deterministic drive for its negative-control,
// cooldown, off-mode, and per-symbol-independence fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

export const BAR_MS = 1000;              // deterministic synthetic timeframe
export const WARM_BARS = 78;             // TA_WARM closed bars; the 78th (barIndex 77) is first evaluated

// Reset the plane + evaluator to a deterministic clean slate so the synthetic clock is the
// SOLE driver: a stray BarJob timer cannot have advanced barStart during boot. h.ta is the
// exposed test seam -- taking its clock is exactly the "never real timers" contract.
export function primePlane(h) {
    const p = h.ta;
    p.head = 0; p.count = 0; p.barIndex = -1;
    p.bo = p.bh = p.bl = p.bc = 0;
    p.bucketOpen = false; p.started = false; p.barStart = 0;
    const e = h.taEval;
    e.prevState = 0; e.lastBar = -1; e.cooldown = 0;
    e.state = 'warming';
    e.tenkan = e.kijun = e.spanA = e.spanB = NaN;
}

// Drive a per-bar mid series: one inject + one roll per bar, advancing a synthetic clock by
// BAR_MS. Fully synchronous (no await) so no real cron timer interleaves. Returns final now.
export function driveBars(h, mids, startNow = 0) {
    let now = startNow;
    h.ta.roll(now);                      // first call stamps barStart; closes nothing
    for (let i = 0; i < mids.length; i++) {
        const mid = mids[i];
        h.inject(mid, mid - 1, mid + 1);
        now += BAR_MS;
        h.ta.roll(now);                  // closes exactly one bar -> one evaluate()
    }
    return now;
}

// A monotone upward ramp: satisfies all four strong-bull conditions once warm.
export function rampMids(base, step, bars) {
    const a = new Array(bars);
    for (let i = 0; i < bars; i++) a[i] = base + i * step;
    return a;
}

// Boot a headless kernel with a captured signal sink + a fake socket. Reusable seam.
export async function bootWithSignals() {
    const {factory} = makeFakeFactory();
    const signals = [];
    const handle = await bootKernel({
        ctx: null, gl: null, w: 0, h: 0, ringSize: 4096, barMs: BAR_MS,
        onEvent() {}, onMode() {}, onSignal: (s) => signals.push(s), socketFactory: factory,
    });
    return {handle, signals};
}

test('S11 happy path: a warm upward ramp fires EXACTLY ONE strong-buy edge with the right payload', async () => {
    const {handle, signals} = await bootWithSignals();
    try {
        handle.setTaMode('ichimoku');
        const h = handle._scopes.get('BTCUSDT');
        primePlane(h);
        // 100 bars of a clean +1/bar ramp from 100. The 78th closed bar (barIndex 77) is the
        // first EVALUATED bar and where all four bull conditions first hold -> one buy edge.
        // The continued ramp (bars 78..99) stays bullish -> prevState pinned +1 -> zero more.
        driveBars(h, rampMids(100, 1, 100));

        assert.equal(signals.length, 1, 'exactly one signal on the ramp fixture');
        const sig = signals[0];
        assert.equal(sig.symbol, 'BTCUSDT', 'payload names its own symbol');
        assert.equal(sig.strategy, 'ichimoku', 'strategy tag');
        assert.equal(sig.side, 'buy', 'a rising ramp is a strong BUY');
        assert.equal(sig.bar, WARM_BARS - 1, 'fires on the first warm bar (barIndex 77 = the 78th close)');
        assert.ok(Math.abs(sig.price - 177) < 1e-3, 'price is the close of bar 77 (100 + 77)');
        assert.ok(signals.every((s) => s.bar >= WARM_BARS - 1), 'zero signals before the 78th closed bar');
        assert.equal(typeof sig.at, 'number', 'payload carries a timestamp');
    } finally {
        await handle.shutdown();
    }
});
