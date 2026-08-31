// Frames.js -- market-map wire decode + order-book state. PURE, ZERO-IMPORT.
// kernel.js cannot be imported under node (its esm.sh specifiers do not resolve
// off the CDN); this module is the headless seam that `node --test` resolves
// today. ASCII only.
//
// parseFrame CONTRACT: it returns ONE of exactly three module-level scratch
// singletons (Q / D / T), or null. The returned object is valid ONLY until the
// next parseFrame call -- consume it synchronously, never retain it. DEPTH stores
// the JSON.parse-produced level arrays BY REFERENCE (no copy) so the decode adds
// no allocation of its own above JSON.parse.

export const TAG_NONE = 0;
export const TAG_QUOTE = 1;
export const TAG_DEPTH = 2;
export const TAG_TRADE = 3;
export const MAXLVL = 20;

// Three frozen-shape scratch singletons, allocated ONCE at module scope. Every
// field is declared here so V8 pins one hidden class per object across all reuse.
const Q = {tag: TAG_QUOTE, bid: 0, ask: 0, mid: 0, t: 0};
const D = {tag: TAG_DEPTH, bids: null, asks: null, n: 0, id: 0, bid: 0, ask: 0, mid: 0};
const T = {tag: TAG_TRADE, px: 0, qty: 0, maker: false, t: 0};

// [HOT] one decode per wire message. No allocation of its own: JSON.parse arrays
// are stored by reference; the return is one of the three module scratch objects.
export function parseFrame(raw) {
    let m;
    try {
        m = JSON.parse(raw);
    } catch {
        return null;                                        // malformed -> fail closed
    }
    if (m === null || typeof m !== 'object') return null;
    const d = m.data !== undefined ? m.data : m;            // unwrap combined {stream,data}
    if (d === null || typeof d !== 'object') return null;
    if (d.bids !== undefined && d.asks !== undefined) {     // depth snapshot
        D.bids = d.bids;
        D.asks = d.asks;
        let n = d.bids.length;
        if (d.asks.length < n) n = d.asks.length;
        if (n > MAXLVL) n = MAXLVL;
        D.n = n;
        D.id = d.lastUpdateId || 0;
        const bid = n > 0 ? +d.bids[0][0] : 0;
        const ask = n > 0 ? +d.asks[0][0] : 0;
        D.bid = bid;
        D.ask = ask;
        D.mid = (bid + ask) / 2;
        return D;
    }
    if (d.e === 'aggTrade') {                               // aggregated trade
        T.px = +d.p;
        T.qty = +d.q;
        T.maker = d.m === true;
        T.t = d.T || 0;
        return T;
    }
    if (d.b !== undefined && d.a !== undefined) {           // Binance bookTicker quote
        const bid = +d.b, ask = +d.a;
        Q.bid = bid;
        Q.ask = ask;
        Q.mid = (bid + ask) / 2;
        Q.t = d.u || 0;
        return Q;
    }
    if (d.mid !== undefined) {                              // sim / local-quote shape
        Q.bid = +d.bid;
        Q.ask = +d.ask;
        Q.mid = +d.mid;
        Q.t = d.t || 0;
        return Q;
    }
    return null;                                            // unknown -> fail closed
}

export class OrderBook {
    constructor() {
        this.bidPx = new Float32Array(MAXLVL);
        this.bidSz = new Float32Array(MAXLVL);
        this.askPx = new Float32Array(MAXLVL);
        this.askSz = new Float32Array(MAXLVL);
        this.bidCum = new Float32Array(MAXLVL);             // running cumulative depth (bids)
        this.askCum = new Float32Array(MAXLVL);             // running cumulative depth (asks)
        this.maxCum = 0;                                    // largest cumulative -> curve scale
        this.mid = 0;
        this.n = 0;
        this.synthetic = true;
        this.maxSz = 1;                                     // running level-size scale
    }

    // [HOT] REAL ladder off the wire. Zero allocation: every write targets a
    // preallocated typed array. maxSz snaps on the first real frame (after init or
    // a degrade), then EMA-smooths a running max so the renderers scale bar width
    // to the actual size distribution -- no hardcoded divisor, no per-frame jitter.
    applyDepth(f) {
        const bids = f.bids, asks = f.asks, n = f.n, wasSynth = this.synthetic;
        let frameMax = 0, bc = 0, ac = 0, cmax = 0;
        for (let i = 0; i < n; i++) {
            let bs = +bids[i][1], as = +asks[i][1];
            // Fail closed on a non-finite wire size (NaN/+-Infinity from a
            // malformed payload): treat it as 0 so it poisons neither its own
            // level nor the running cumulative sum. `x - x` is 0 for any finite
            // x and NaN for NaN/+-Inf -- a zero-alloc, branch-cheap finite test.
            if (bs - bs !== 0) bs = 0;
            if (as - as !== 0) as = 0;
            this.bidPx[i] = +bids[i][0];
            this.bidSz[i] = bs;
            this.askPx[i] = +asks[i][0];
            this.askSz[i] = as;
            if (bs > frameMax) frameMax = bs;
            if (as > frameMax) frameMax = as;
            bc += bs;                                       // carry running cumulative depth
            ac += as;
            this.bidCum[i] = bc;
            this.askCum[i] = ac;
            if (bc > cmax) cmax = bc;
            if (ac > cmax) cmax = ac;
        }
        this.maxCum = cmax > 1e-9 ? cmax : 1e-9;
        this.mid = (this.bidPx[0] + this.askPx[0]) / 2;
        this.n = n;
        if (wasSynth) this.maxSz = frameMax > 1e-9 ? frameMax : 1e-9;
        else {
            this.maxSz += (frameMax - this.maxSz) * 0.05;
            if (this.maxSz < 1e-9) this.maxSz = 1e-9;
        }
        this.synthetic = false;
    }

    // [HOT] SYNTHETIC ladder -- sim / bookTicker / local-quote only. Fabricates a
    // ladder around a single best quote when no real depth is arriving.
    applySynthQuote(f) {
        this.mid = f.mid;
        let bc = 0, ac = 0, cmax = 0;
        for (let i = 0; i < MAXLVL; i++) {
            this.bidPx[i] = f.bid - i * 0.5;
            this.askPx[i] = f.ask + i * 0.5;
            const bs = 4 + Math.abs(Math.sin(f.mid * 0.03 + i)) * 40;
            const as = 4 + Math.abs(Math.cos(f.mid * 0.021 + i)) * 40;
            this.bidSz[i] = bs;
            this.askSz[i] = as;
            bc += bs;                                       // carry running cumulative depth
            ac += as;
            this.bidCum[i] = bc;
            this.askCum[i] = ac;
            if (bc > cmax) cmax = bc;
            if (ac > cmax) cmax = ac;
        }
        this.maxCum = cmax > 1e-9 ? cmax : 1e-9;
        this.n = MAXLVL;
        this.synthetic = true;
        this.maxSz = 48;                                    // matches the synth size band (4..44)
    }
}
