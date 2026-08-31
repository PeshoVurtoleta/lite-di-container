// DepthCum.test.mjs -- node:test only. Run: node --test test/DepthCum.test.mjs
//
// Boundary matrix for the S4 cumulative-depth addition to Frames.js's OrderBook:
// bidCum/askCum (running sums, top-of-book down) + maxCum (fail-closed divisor
// floor, >= 1e-9) folded into the existing applyDepth/applySynthQuote single pass.
//
// OrderBook has NO dispose/iterator/async lifecycle -- it is a plain synchronous
// stateful record mutated in place by two hot methods. The generic boundary
// categories "duplicate dispose", "dispose-during-iteration", "re-entrant write"
// do not apply verbatim; this file states that explicitly (below) rather than
// fabricate a test against a lifecycle the module does not have, and substitutes
// the closest real analogs for a mutable-in-place hot object: back-to-back
// identical re-apply (idempotency, the "duplicate" analog) and interleaved
// applyDepth/applySynthQuote calls against the SAME preallocated arrays (the
// "re-entrant write onto shared state" analog).
//
// N/A, with reason:
//   - duplicate dispose            -- no dispose() on OrderBook.
//   - dispose-during-iteration     -- no dispose() and no iterator protocol.
//   - re-entrant write (recursive) -- applyDepth/applySynthQuote are synchronous
//     leaf functions; neither calls back into itself or into user code, so there
//     is no reachable recursion point to re-enter from inside a single call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MAXLVL, parseFrame, OrderBook} from '../Frames.js';
import {depth20, sim} from './fixtures/Frames.fixtures.mjs';

// Build a synthetic depth-shaped frame: n levels, bid/ask size arrays supplied
// as raw wire-style [price, sizeString] pairs so `+bids[i][1]` in applyDepth
// matches exactly what this test independently recomputes.
function frame(n, bidSizes, askSizes, {bidsLen = n, asksLen = n} = {}) {
    const bids = [], asks = [];
    for (let i = 0; i < bidsLen; i++) bids.push([String(100 - i), String(bidSizes[i])]);
    for (let i = 0; i < asksLen; i++) asks.push([String(100 + i), String(askSizes[i])]);
    return {bids, asks, n};
}

function expectedCum(sizes, n) {
    const out = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += +sizes[i];
        out[i] = Math.fround(sum);
    }
    return out;
}

// ---- boundary: n = 0 (empty) ----------------------------------------------

test('applyDepth: n=0 (empty) -- maxCum floors to 1e-9, never 0, never NaN, no throw', () => {
    const book = new OrderBook();
    const f = frame(0, [], []);
    assert.doesNotThrow(() => book.applyDepth(f));
    assert.equal(book.n, 0);
    assert.equal(book.maxCum, 1e-9);
    assert.notEqual(book.maxCum, 0);
    assert.ok(!Number.isNaN(book.maxCum));
});

// ---- boundary: n = 1 -------------------------------------------------------

test('applyDepth: n=1 -- single-level cumulative equals the single size, maxCum matches', () => {
    const book = new OrderBook();
    const f = frame(1, [3.5], [7.25]);
    book.applyDepth(f);
    assert.equal(book.bidCum[0], Math.fround(3.5));
    assert.equal(book.askCum[0], Math.fround(7.25));
    assert.equal(book.maxCum, Math.fround(7.25));
});

// ---- boundary: n = MAXLVL - 1 (partial) + tail documentation --------------

test('applyDepth: n=MAXLVL-1 -- cumulative correct through n-1; tail is STALE, not zeroed', () => {
    const book = new OrderBook();
    const fullBid = Array.from({length: MAXLVL}, (_, i) => 1 + i);
    const fullAsk = Array.from({length: MAXLVL}, (_, i) => 2 + i);
    book.applyDepth(frame(MAXLVL, fullBid, fullAsk));
    const staleLastBid = book.bidCum[MAXLVL - 1];
    const staleLastAsk = book.askCum[MAXLVL - 1];
    assert.ok(staleLastBid > 0 && staleLastAsk > 0);

    const n = MAXLVL - 1;
    const partialBid = Array.from({length: n}, (_, i) => 10 + i);
    const partialAsk = Array.from({length: n}, (_, i) => 5 + i);
    book.applyDepth(frame(n, partialBid, partialAsk));

    const expBid = expectedCum(partialBid, n);
    const expAsk = expectedCum(partialAsk, n);
    for (let i = 0; i < n; i++) {
        assert.equal(book.bidCum[i], expBid[i], 'bidCum[' + i + ']');
        assert.equal(book.askCum[i], expAsk[i], 'askCum[' + i + ']');
    }
    // DOCUMENTED ACTUAL BEHAVIOR: index n (the untouched tail slot, here MAXLVL-1)
    // retains whatever the PRIOR full-book apply left there -- it is not reset to
    // 0 on a shorter apply. Consumers must gate all reads on book.n (kernel.js's
    // drawFrame/GLRenderer.draw both do: `nb = book.n` then loop `i < nb`), never
    // read past book.n. This test pins that stale-tail contract so a future change
    // that starts zeroing (or stops gating on book.n downstream) is caught.
    assert.equal(book.bidCum[MAXLVL - 1], staleLastBid, 'tail slot must be stale, not reset');
    assert.equal(book.askCum[MAXLVL - 1], staleLastAsk, 'tail slot must be stale, not reset');
    assert.equal(book.n, n);
});

// ---- boundary: n = MAXLVL (full) -------------------------------------------

test('applyDepth: n=MAXLVL (full, real fixture depth20) -- cumulative matches independent recompute', () => {
    const book = new OrderBook();
    const f = parseFrame(depth20);
    assert.equal(f.n, MAXLVL);
    book.applyDepth(f);

    let bidSum = 0, askSum = 0, cmax = 0;
    for (let i = 0; i < MAXLVL; i++) {
        bidSum += +f.bids[i][1];
        askSum += +f.asks[i][1];
        const rb = Math.fround(bidSum), ra = Math.fround(askSum);
        assert.equal(book.bidCum[i], rb, 'bidCum[' + i + ']');
        assert.equal(book.askCum[i], ra, 'askCum[' + i + ']');
        if (bidSum > cmax) cmax = bidSum;
        if (askSum > cmax) cmax = askSum;
    }
    // NOTE (documented, non-blocking precision finding): maxCum is a PLAIN double
    // field (`this.maxCum = cmax`), never rounded to float32, while bidCum/askCum
    // ARE Float32Array reads -- so maxCum matches the raw double accumulator
    // exactly, and is only approximately (not bit-exactly) equal to
    // max(bidCum[last], askCum[last]) after float32 rounding of the latter.
    // Immaterial for a render-time scale divisor; asserted against its actual
    // (double-precision) source of truth, not the lossy array read.
    assert.equal(book.maxCum, cmax);
    assert.equal(Math.fround(book.maxCum), Math.max(book.bidCum[MAXLVL - 1], book.askCum[MAXLVL - 1]));
});

// ---- boundary: n = MAXLVL + 1 (adversarial -- over-limit direct call) -----

test('applyDepth ADVERSARIAL: n=MAXLVL+1 direct call (bypassing parseFrame\'s clamp) does not throw, does not corrupt bounds, but maxCum can silently diverge from the stored curve', () => {
    // Production NEVER reaches this: parseFrame clamps `n = min(bids.length, asks.length, MAXLVL)`
    // before applyDepth ever sees the frame (Frames.js:41), and kernel.js's dispatch only
    // calls applyDepth on a parseFrame-produced object (kernel.js:779, guarded by
    // `if (fr) dispatch(fr)` at kernel.js:804). This test calls applyDepth DIRECTLY with a
    // hand-built frame whose n exceeds MAXLVL -- the adversarial case a caller bug, not the
    // wire decoder, could produce.
    const book = new OrderBook();
    const n = MAXLVL + 1; // 21
    const bidSizes = Array.from({length: n}, (_, i) => (i === MAXLVL ? 1000 : 1)); // level 20 (OOB) is huge
    const askSizes = Array.from({length: n}, () => 1);
    const f = frame(n, bidSizes, askSizes);

    assert.doesNotThrow(() => book.applyDepth(f));

    // Bounds are NOT corrupted: the backing arrays stay length MAXLVL (typed-array
    // out-of-bounds numeric-index assignment is a silent, spec-defined no-op -- it
    // neither throws nor grows the buffer).
    assert.equal(book.bidCum.length, MAXLVL);
    assert.equal(book.askCum.length, MAXLVL);

    // In-bounds levels (0..MAXLVL-1) are exactly the running sum of the FIRST
    // MAXLVL sizes -- writes to index MAXLVL never landed.
    const expBid = expectedCum(bidSizes, MAXLVL);
    for (let i = 0; i < MAXLVL; i++) assert.equal(book.bidCum[i], expBid[i]);

    // FINDING (documented, not blocking S4): the accumulator that feeds maxCum
    // keeps summing past index MAXLVL-1 even though the WRITE to bidCum[MAXLVL]
    // is dropped -- so maxCum can reflect a level that is never visible in the
    // stored curve. Assert the ACTUAL divergence rather than pretend it matches.
    const storedMax = Math.max(book.bidCum[MAXLVL - 1], book.askCum[MAXLVL - 1]);
    assert.ok(book.maxCum > storedMax,
        'expected the documented divergence: maxCum(' + book.maxCum + ') > stored curve max(' + storedMax + ')');
    // Still fail-closed in the one way the PLAN actually requires: finite, non-zero.
    assert.ok(Number.isFinite(book.maxCum) && book.maxCum > 0);
});

// ---- floor: all-zero-size full book (never 0, never NaN) ------------------

test('applyDepth: full book, all sizes exactly 0 -- maxCum floors to 1e-9', () => {
    const book = new OrderBook();
    const zeros = new Array(MAXLVL).fill(0);
    book.applyDepth(frame(MAXLVL, zeros, zeros));
    for (let i = 0; i < MAXLVL; i++) {
        assert.equal(book.bidCum[i], 0);
        assert.equal(book.askCum[i], 0);
    }
    assert.equal(book.maxCum, 1e-9);
});

// ---- adversarial: -0 sizes --------------------------------------------------

test('applyDepth ADVERSARIAL: -0 sizes -- maxCum floors to +1e-9 (never -0, never negative)', () => {
    const book = new OrderBook();
    const negZeros = new Array(MAXLVL).fill('-0');
    book.applyDepth(frame(MAXLVL, negZeros, negZeros));
    assert.equal(book.maxCum, 1e-9);
    assert.ok(!Object.is(book.maxCum, -0), 'maxCum must not be -0');
    assert.ok(!Object.is(book.maxCum, 0) || book.maxCum === 1e-9);
});

// ---- fail-closed: NaN-poisoned level no longer contaminates the cum tail ---

test('applyDepth: a NaN size fails closed to 0 -- it poisons NEITHER its own bidSz level NOR any downstream bidCum slot (no cumulative contagion)', () => {
    // HARDENING (post-S4 fail-closed fix, Frames.js applyDepth): `bs - bs !== 0`
    // rejects NaN/+-Infinity and substitutes 0 BEFORE the value reaches either
    // bidSz[i] or the running accumulator `bc`. Regression guard: before the fix
    // a single NaN at level 0 turned every bidCum slot NaN forever (`bc += NaN`
    // stays NaN), a fail-open surface that conflicts with the house law "fail
    // closed on every unverified state; null is not zero."
    const book = new OrderBook();
    const bidSizes = Array.from({length: MAXLVL}, (_, i) => (i === 0 ? 'not-a-number' : 1));
    const askSizes = new Array(MAXLVL).fill(1);
    book.applyDepth(frame(MAXLVL, bidSizes, askSizes));

    // The bad level itself is 0 (its size failed closed), not NaN.
    assert.equal(book.bidSz[0], 0, 'poisoned level size must fail closed to 0');
    assert.ok(!Number.isNaN(book.bidSz[0]));

    // The cumulative tail is CLEAN: bidCum is the running sum with the bad level
    // counted as 0. Level 0 contributes 0, then each subsequent level adds 1, so
    // bidCum[i] == i (0,1,2,...). No slot is NaN -- the contagion is gone.
    for (let i = 0; i < MAXLVL; i++) {
        assert.ok(!Number.isNaN(book.bidCum[i]), 'bidCum[' + i + '] must not be NaN');
        assert.equal(book.bidCum[i], Math.fround(i), 'bidCum[' + i + '] == running sum with bad level as 0');
    }

    // The unpoisoned ask side is unchanged, and maxCum stays finite + floored.
    assert.equal(book.askCum[MAXLVL - 1], Math.fround(MAXLVL));
    assert.ok(!Number.isNaN(book.maxCum), 'maxCum must never be NaN');
    assert.ok(book.maxCum >= 1e-9);
    assert.equal(book.maxCum, Math.fround(MAXLVL)); // askCum[19] = 20 * 1, the surviving side
});

// ---- fail-closed: +-Infinity size also fails closed (not just NaN) ---------

test('applyDepth: an Infinity size fails closed to 0 -- bidCum stays finite (no Inf/NaN leak into the curve or maxCum)', () => {
    const book = new OrderBook();
    // A raw 'Infinity' string parses to +Infinity via unary +; a huge overflow
    // literal ('1e400') also coerces to Infinity. Both must fail closed.
    const bidSizes = Array.from({length: MAXLVL}, (_, i) => (i === 5 ? 'Infinity' : (i === 10 ? '1e400' : 2)));
    const askSizes = new Array(MAXLVL).fill(2);
    book.applyDepth(frame(MAXLVL, bidSizes, askSizes));

    assert.equal(book.bidSz[5], 0, 'Infinity level fails closed to 0');
    assert.equal(book.bidSz[10], 0, '1e400 overflow level fails closed to 0');
    for (let i = 0; i < MAXLVL; i++) {
        assert.ok(Number.isFinite(book.bidCum[i]), 'bidCum[' + i + '] must stay finite');
    }
    // Two levels dropped to 0, the other 18 carry 2 each: final cum == 18 * 2.
    assert.equal(book.bidCum[MAXLVL - 1], Math.fround((MAXLVL - 2) * 2));
    assert.ok(Number.isFinite(book.maxCum) && book.maxCum > 0);
});

// ---- null / undefined frame: fail LOUD on contract violation, by design ---

test('applyDepth: null/undefined frame throws (never called this way in production -- kernel.js gates on `if (fr) dispatch(fr)` before dispatch ever reaches book.applyDepth)', () => {
    const book = new OrderBook();
    assert.throws(() => book.applyDepth(null));
    assert.throws(() => book.applyDepth(undefined));
    // book state must be untouched by the throw -- fresh-constructor invariants hold.
    assert.equal(book.n, 0);
    assert.equal(book.maxCum, 0); // constructor default; consumers guard with `book.maxCum || 1` (kernel.js:395,493)
});

// ---- duplicate re-apply (the "duplicate dispose" analog: idempotency) -----

test('applyDepth: identical frame applied twice back-to-back is idempotent (no cross-call accumulation)', () => {
    const book = new OrderBook();
    const sizes = Array.from({length: MAXLVL}, (_, i) => 1 + i * 0.25);
    const f = frame(MAXLVL, sizes, sizes);
    book.applyDepth(f);
    const firstBid = Float32Array.from(book.bidCum);
    const firstAsk = Float32Array.from(book.askCum);
    const firstMax = book.maxCum;

    book.applyDepth(f); // duplicate re-apply of the SAME frame object
    for (let i = 0; i < MAXLVL; i++) {
        assert.equal(book.bidCum[i], firstBid[i], 'bidCum[' + i + '] must not double-accumulate');
        assert.equal(book.askCum[i], firstAsk[i], 'askCum[' + i + '] must not double-accumulate');
    }
    assert.equal(book.maxCum, firstMax);
});

// ---- interleaved applyDepth / applySynthQuote onto the SAME arrays --------

test('applySynthQuote fully overwrites a prior applyDepth cumulative state (re-entrant-write-onto-shared-state analog)', () => {
    const book = new OrderBook();
    book.applyDepth(frame(MAXLVL, new Array(MAXLVL).fill(50), new Array(MAXLVL).fill(50)));
    assert.equal(book.synthetic, false);

    const q = parseFrame(sim);
    book.applySynthQuote(q); // synthetic path always covers all MAXLVL levels itself

    let bidSum = 0, askSum = 0;
    for (let i = 0; i < MAXLVL; i++) {
        const bs = 4 + Math.abs(Math.sin(q.mid * 0.03 + i)) * 40;
        const as = 4 + Math.abs(Math.cos(q.mid * 0.021 + i)) * 40;
        bidSum += bs;
        askSum += as;
        assert.equal(book.bidCum[i], Math.fround(bidSum), 'bidCum[' + i + '] must be the synth sum, not depth residue');
        assert.equal(book.askCum[i], Math.fround(askSum), 'askCum[' + i + ']');
    }
    // See the precision note in the depth20-full test: maxCum is the raw double
    // accumulator, compared against its actual source, not the float32 array read.
    assert.equal(book.maxCum, Math.max(bidSum, askSum));
    assert.equal(book.synthetic, true);
});

// ---- applySynthQuote full-fixture cross-check ------------------------------

test('applySynthQuote (sim fixture): cumulative sums + maxCum match independent recompute', () => {
    const book = new OrderBook();
    const q = parseFrame(sim);
    book.applySynthQuote(q);

    let bidSum = 0, askSum = 0, cmax = 0;
    for (let i = 0; i < MAXLVL; i++) {
        const bs = 4 + Math.abs(Math.sin(q.mid * 0.03 + i)) * 40;
        const as = 4 + Math.abs(Math.cos(q.mid * 0.021 + i)) * 40;
        bidSum += bs;
        askSum += as;
        if (bidSum > cmax) cmax = bidSum;
        if (askSum > cmax) cmax = askSum;
        assert.equal(book.bidCum[i], Math.fround(bidSum));
        assert.equal(book.askCum[i], Math.fround(askSum));
    }
    assert.ok(cmax > 1e-9);
    assert.equal(book.maxCum, cmax); // maxCum is the raw double accumulator, not floored (real data)
    assert.equal(Math.fround(book.maxCum), Math.max(book.bidCum[MAXLVL - 1], book.askCum[MAXLVL - 1]));
});
