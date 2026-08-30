// ParseFrame.test.mjs -- node:test only. Run: node --test test/ParseFrame.test.mjs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    TAG_QUOTE, TAG_DEPTH, TAG_TRADE, MAXLVL, parseFrame, OrderBook,
} from '../Frames.js';
import {
    bookTicker, combinedWrapper, depth20, depth20b, aggTrade, aggTradeTaker,
    local, sim, garbage,
} from './fixtures/Frames.fixtures.mjs';

// ---- ASSERTION 1: tag + decoded fields per fixture -----------------------

test('parseFrame: bookTicker -> TAG_QUOTE', () => {
    const f = parseFrame(bookTicker);
    assert.equal(f.tag, TAG_QUOTE);
    assert.equal(f.bid, 78547.33);
    assert.equal(f.ask, 78547.34);
    assert.equal(f.mid, (78547.33 + 78547.34) / 2);
});

test('parseFrame: depth20 -> TAG_DEPTH, n === 20', () => {
    const f = parseFrame(depth20);
    assert.equal(f.tag, TAG_DEPTH);
    assert.equal(f.n, 20);
    assert.equal(f.n, MAXLVL);
    // arrays stored by reference (no copy), scalars decoded from the top of book
    assert.equal(f.bids.length, 20);
    assert.equal(f.asks.length, 20);
    assert.equal(f.bid, 78547.33);
    assert.equal(f.ask, 78547.34);
});

test('parseFrame: aggTrade -> TAG_TRADE, maker flag preserved', () => {
    const maker = parseFrame(aggTrade);
    assert.equal(maker.tag, TAG_TRADE);
    assert.equal(maker.px, 78606.93);
    assert.equal(maker.qty, 0.01449);
    assert.equal(maker.maker, true);
    const taker = parseFrame(aggTradeTaker);
    assert.equal(taker.tag, TAG_TRADE);
    assert.equal(taker.maker, false);
});

test('parseFrame: combined wrapper unwraps to the inner tag', () => {
    const f = parseFrame(combinedWrapper);
    assert.equal(f.tag, TAG_QUOTE);
    assert.equal(f.bid, 78547.33);
    assert.equal(f.ask, 78547.34);
});

test('parseFrame: local feed-server depth frame -> TAG_DEPTH', () => {
    const f = parseFrame(local);
    assert.equal(f.tag, TAG_DEPTH);
    assert.equal(f.n, 20);
});

test('parseFrame: sim quote -> TAG_QUOTE', () => {
    const f = parseFrame(sim);
    assert.equal(f.tag, TAG_QUOTE);
    assert.equal(f.mid, 60000);
    assert.equal(f.bid, 59999.25);
    assert.equal(f.ask, 60000.75);
});

test('parseFrame: garbage (5 inputs) -> null, no throw', () => {
    assert.equal(garbage.length, 5);
    for (const g of garbage) {
        let f;
        assert.doesNotThrow(() => {
            f = parseFrame(g);
        });
        assert.equal(f, null);
    }
});

// ---- ASSERTION 2: scratch identity (no per-frame object literal) ----------

test('parseFrame: reuses exactly three module scratch singletons', () => {
    const dA = parseFrame(depth20);
    const dB = parseFrame(depth20b);
    assert.equal(dA, dB);                                   // same D scratch
    const tA = parseFrame(aggTrade);
    const tB = parseFrame(aggTradeTaker);
    assert.equal(tA, tB);                                   // same T scratch
    assert.notEqual(dA, tA);                                // D !== T
    const qA = parseFrame(bookTicker);
    assert.notEqual(qA, dA);                                // Q !== D
    assert.notEqual(qA, tA);                                // Q !== T
});

// ---- ASSERTION 5: wire fidelity + ladder independence --------------------

test('OrderBook.applyDepth: exact sizes + independent real deltas (>= 3 sign changes)', () => {
    const book = new OrderBook();
    // apply A, then B: B must fully overwrite A element-wise.
    const fa = parseFrame(depth20);
    // snapshot A sizes BEFORE B clobbers the by-reference arrays
    const aBid = new Float32Array(20);
    for (let i = 0; i < 20; i++) aBid[i] = Math.fround(+fa.bids[i][1]);
    book.applyDepth(fa);

    const fb = parseFrame(depth20b);
    const bBidRaw = new Array(20);
    for (let i = 0; i < 20; i++) bBidRaw[i] = +fb.bids[i][1];
    book.applyDepth(fb);

    // Exact wire fidelity: bidSz is a Float32Array, so the honest exact compare
    // is against Math.fround(wire value) -- the value actually stored.
    for (let i = 0; i < 20; i++) {
        assert.equal(book.bidSz[i], Math.fround(bBidRaw[i]));
    }
    assert.equal(book.synthetic, false);
    assert.equal(book.n, 20);

    // Level deltas B - A: real snapshots interleave up/down moves. sin/cos cannot.
    let signChanges = 0, prev = 0;
    for (let i = 0; i < 20; i++) {
        const d = Math.fround(bBidRaw[i]) - aBid[i];
        if (d === 0) continue;
        const s = d > 0 ? 1 : -1;
        if (prev !== 0 && s !== prev) signChanges++;
        prev = s;
    }
    assert.ok(signChanges >= 3, 'expected >= 3 sign changes, got ' + signChanges);
});

test('OrderBook.applySynthQuote: fabricates a full synthetic ladder', () => {
    const book = new OrderBook();
    book.applySynthQuote(parseFrame(sim));
    assert.equal(book.synthetic, true);
    assert.equal(book.n, MAXLVL);
    assert.equal(book.mid, 60000);
    assert.ok(book.bidSz[0] > 0);
});
