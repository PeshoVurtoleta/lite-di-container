// market-map -- a demo of the @zakkster/lite-di-* service kernel applied to a
// real-time market-data firehose, now fed by a REAL WebSocket (@zakkster/lite-ws) over a
// zero-GC ring (@zakkster/lite-ring-buffer). Everything runs in-browser via the import map.
//
// Architecture (the honest one):
//   - the tick FIREHOSE arrives over lite-ws (onMessage pipe) and lands in a lite-ring-buffer
//     Float32Array ring -- 0-GC hot data, NOT one signal per tick;
//   - lite-di-signal holds a HANDFUL of aggregates (mid / bid / ask / spread);
//   - lite-di-event-bus fans each decoded tick out at 0 B/emit + records the session;
//   - lite-di-ticker drives the render loop; lite-di-strategies SELECTS a renderer by zoom;
//   - lite-di-supervisor heals the feed subsystem (fresh socket) while the viewport stays live.
// SEAM: markers show the productization points.

import {Container} from '@zakkster/lite-di-container';
import {EventBus} from '@zakkster/lite-di-event-bus';
import {StrategyRouter} from '@zakkster/lite-di-strategies';
import {Cron, interval} from '@zakkster/lite-di-cron';
import {Ticker} from '@zakkster/lite-di-ticker';
import {Supervisor, STRATEGIES} from '@zakkster/lite-di-supervisor';
import {Health, LANES} from '@zakkster/lite-di-health';
import {fromContainer, toJSON} from '@zakkster/lite-di-graph';
import {useScopedSignals} from '@zakkster/lite-di-signal';
import {createRegistry} from '@zakkster/lite-signal';
import {createSocketFactory} from '@zakkster/lite-ws';
import {RingBuffer} from '@zakkster/lite-ring-buffer';
import {createPointSink, createQuadSink} from '@zakkster/lite-gl/backend';
import {TAG_QUOTE, TAG_DEPTH, TAG_TRADE, MAXLVL, parseFrame, OrderBook} from './Frames.js';

const RING = 2048;                 // SEAM: size to your firehose window
const TRADE_RING = 256;            // recent-trade window (pow2, scalar rings)
const TAU = Math.PI * 2;
const DOT_BUY = '#4EE7D2';         // taker-buy trade dot (teal)
const DOT_SELL = '#F5A623';        // taker-sell trade dot (ember)
// Feed sources. Each live symbol is ONE combined Binance stream carrying three
// channels: depth20@100ms (the REAL 20-level ladder), aggTrade (the trade tape),
// and bookTicker (a dense best-quote for the price trace). `sim` is the in-page
// synthetic failover the watchdog degrades to; `local` targets feed-server.mjs.
const SOURCES = {
    'BTCUSDT': 'wss://stream.binance.com:9443/stream?streams=btcusdt@depth20@100ms/btcusdt@aggTrade/btcusdt@bookTicker',
    'ETHUSDT': 'wss://stream.binance.com:9443/stream?streams=ethusdt@depth20@100ms/ethusdt@aggTrade/ethusdt@bookTicker',
    sim: 'sim://random-walk',
    local: 'ws://127.0.0.1:8100',
};
const FEED_URL = SOURCES.BTCUSDT;

// A FEW aggregates via lite-di-signal (a scoped registry wired into container teardown).
class Aggregates {
    constructor(rx) {
        this.mid = rx.signal(0);
        this.bid = rx.signal(0);
        this.ask = rx.signal(0);
        this.spread = rx.computed(() => this.ask() - this.bid());
        this.tps = rx.signal(0);
    }

    apply(t) {
        this.mid.set(t.mid);
        this.bid.set(t.bid);
        this.ask.set(t.ask);
    }
}

// Simulation feed. Duck-types the exact lite-ws surface the render loop pulls
// (status/isOpen/latency/reconnectAttempts/poll/dispose), so `makeSocket` resolves it
// ONCE and the hot body stays source-agnostic -- no `if (isSim)` in update/feedPoll.
// poll() is the generator: a wall-clock accumulator emits ~SIM_HZ ticks/s via a random
// walk. ZERO per-call allocation -- one scratch tick object, mutated in place and
// consumed synchronously by the object bus (never recorded; the numeric trace bus carries
// the scalar for replay). This is the shape S6's scripted fake socket must satisfy.
const SIM_HZ = 50;                 // target ticks / second
const SIM_STEP = 6;                // random-walk price step (USD)
const SIM_HALF_SPREAD = 0.75;      // synthetic half-spread (USD)
const SIM_MAX_BURST = 8;           // cap ticks per poll so a stalled tab cannot spiral

function makeSimSocket(emit) {
    const tick = {tag: TAG_QUOTE, bid: 60000, ask: 60000, mid: 60000, t: 0};
    let last = performance.now(), acc = 0, seq = 0;
    return {
        status() {
            return 'open';
        },
        isOpen() {
            return true;
        },
        latency() {
            return 1 + (Math.random() * 2 | 0);
        },
        reconnectAttempts() {
            return 0;
        },
        poll() {
            const now = performance.now();
            acc += (now - last) * (SIM_HZ / 1000);
            last = now;
            let k = acc | 0;
            acc -= k;
            if (k > SIM_MAX_BURST) k = SIM_MAX_BURST;
            for (let i = 0; i < k; i++) {
                tick.mid += (Math.random() - 0.5) * SIM_STEP;
                tick.bid = tick.mid - SIM_HALF_SPREAD;
                tick.ask = tick.mid + SIM_HALF_SPREAD;
                tick.t = ++seq;
                emit(tick);
            }
        },
        dispose() {
        },
    };
}

// The ingestion subsystem the supervisor watches: a lite-ws socket. Re-resolving it
// (on a fault) tears down the old socket and dials a fresh one.
class Feed {
    constructor(makeSocket) {
        this.sock = makeSocket();
    }

    dispose() {
        try {
            this.sock.dispose();
        } catch {
        }
    }
}

// event-bus listeners: DI-constructed, fan each decoded frame out at 0 B/emit.
// TapeApply/AggApply are tag-agnostic -- both QUOTE and DEPTH frames carry
// mid/bid/ask scalars, so no tag branch leaks into a hot handler body. (The book
// itself is applied in the cold onMessage switch, where the DEPTH-vs-QUOTE choice
// lives.) TradeApply pushes into two scalar rings, never an object ring.
class TapeApply {
    constructor(tape) {
        this.tape = tape;
    }

    handle(f) {
        this.tape.push(f.mid);
    }
}

class AggApply {
    constructor(agg) {
        this.agg = agg;
    }

    handle(f) {
        this.agg.apply(f);
    }
}

class TradeApply {
    constructor(px, side) {
        this.px = px;
        this.side = side;
    }

    handle(f) {
        this.px.push(f.px);
        this.side.push(f.maker ? -1 : 1);
    }
}

// Trace-bus handler. The numeric traceBus records mid SCALARS live (0 B/emit, unboxed
// doubles); its capture drives replay. This handler pushes into the tape ONLY while
// replaying (refs.replaying) -- live, TapeApply already fills the tape off the object bus,
// so gating here avoids a double-advance while still repainting the price trace on replay.
class MidReplay {
    constructor(tape) {
        this.tape = tape;
    }

    handle(mid) {
        if (refs.replaying) this.tape.push(mid);
    }
}

// cron jobs: DI-constructed wall-clock housekeeping.
const refs = {stats: {pruned: 0, aggregations: 0, heartbeats: 0}, replaying: false};

class AggregateJob {
    run() {
        refs.stats.aggregations++;
    }
}

class PruneJob {
    run() {
        refs.stats.pruned++;
    }
}

class HeartbeatJob {
    run() {
        refs.stats.heartbeats++;
    }
}

// Failover watchdog -- a supervised, graph-resident cron job (NOT a stray timer). It
// counts consecutive 1s samples where the feed is down and, at 4 in a row (~4s) while not
// already on sim, degrades to the in-page simulation via the same code path as a manual
// switch. A class (not a closure) so S3 can register one per symbol scope. All control
// state lives on the injected `ctrl` (armed / count / down / isSim / trip).
class FailoverJob {
    constructor(ctrl) {
        this.ctrl = ctrl;
    }

    run() {
        const f = this.ctrl;
        if (!f.armed || f.isSim()) {
            f.count = 0;
            return;
        }
        f.count = f.down() ? f.count + 1 : 0;
        if (f.count >= 4) {
            f.count = 0;
            f.trip();
        }
    }
}

// ---- renderers (lite-di-strategies selects one by zoom) ----
// Zero-steady-state-alloc price labels: reformat only when the quantized (0.1)
// value changes, otherwise reuse the cached string. No toFixed() on unchanged frames.
class LabelCache {
    constructor(n) {
        this.q = new Int32Array(n).fill(-2147483648);
        this.s = new Array(n);
        for (let i = 0; i < n; i++) this.s[i] = '';
    }

    get(i, value) {
        const q = (value * 10) | 0;                 // quantize to 0.1
        if (q !== this.q[i]) {
            this.q[i] = q;
            this.s[i] = value.toFixed(1);
        }
        return this.s[i];
    }
}

function drawFrame(ctx, w, h, book, scratch, n, labels, tradePx, tradeSide, nTrades) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(120,135,155,0.10)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
    }
    for (let y = 0; y <= h; y += 48) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
    }

    const plotW = w * 0.66;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
        const v = scratch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    if (!isFinite(lo)) {
        lo = 0;
        hi = 1;
    }
    const span = (hi - lo) || 1;
    ctx.strokeStyle = '#4EE7D2';
    ctx.lineWidth = labels ? 2 : 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1 || 1)) * plotW;
        const y = h - ((scratch[i] - lo) / span) * (h - 24) - 12;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (n > 0) {
        const ly = h - ((scratch[n - 1] - lo) / span) * (h - 24) - 12;
        ctx.fillStyle = '#4EE7D2';
        ctx.shadowColor = '#4EE7D2';
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(plotW, ly, 3.5, 0, TAU);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    // recent trades as buy/sell dots, mapped through the same lo/span as the trace
    if (nTrades > 0 && n > 0) {
        const denomT = (nTrades - 1) || 1;
        for (let i = 0; i < nTrades; i++) {
            const tx = (i / denomT) * plotW;
            const ty = h - ((tradePx[i] - lo) / span) * (h - 24) - 12;
            ctx.fillStyle = tradeSide[i] > 0 ? DOT_BUY : DOT_SELL;
            ctx.beginPath();
            ctx.arc(tx, ty, 2.5, 0, TAU);
            ctx.fill();
        }
    }

    const ladderX = plotW + 24, ladderW = w - ladderX - 16, midY = h / 2, rowH = (h * 0.9) / (MAXLVL * 2);
    const scale = ladderW / (book.maxSz || 1);
    for (let i = 0; i < book.n; i++) {
        const aw = Math.min(ladderW, book.askSz[i] * scale);
        const bw = Math.min(ladderW, book.bidSz[i] * scale);
        const ay = midY - (i + 1) * rowH, by = midY + i * rowH;
        ctx.fillStyle = 'rgba(245,166,35,0.55)';
        ctx.fillRect(ladderX, ay, aw, rowH - 2);
        ctx.fillStyle = 'rgba(78,231,210,0.55)';
        ctx.fillRect(ladderX, by, bw, rowH - 2);
        if (labels) {
            ctx.fillStyle = 'rgba(200,210,225,0.7)';
            ctx.font = '10px ui-monospace, Menlo, monospace';
            ctx.fillText(labels.ask.get(i, book.askPx[i]), ladderX + ladderW - 40, ay + rowH - 3);
            ctx.fillText(labels.bid.get(i, book.bidPx[i]), ladderX + ladderW - 40, by + rowH - 3);
        }
    }
}

class CoarseRenderer {
    constructor() {
        this.mode = '2d';
    }

    draw(v, book, s, n) {
        drawFrame(v.ctx, v.w, v.h, book, s, n, null, v.tradePx, v.tradeSide, v.nTrades);
    }
}

class DetailedRenderer {
    constructor() {
        this.mode = '2d';
        this.labels = {ask: new LabelCache(MAXLVL), bid: new LabelCache(MAXLVL)};
    }

    draw(v, book, s, n) {
        drawFrame(v.ctx, v.w, v.h, book, s, n, this.labels, v.tradePx, v.tradeSide, v.nTrades);
    }
}

// lite-gl GPU renderer: the tick ring as instanced GL_POINTS (stride 8) AND the depth
// ladder as instanced QUAD bars (stride 9: x,y=center, w,h, rot, r,g,b,a). Screen pixels,
// top-left origin. The path that scales to ~1M primitives; here both sinks compose per frame.
class GLRenderer {
    constructor() {
        this.mode = 'gl';
        this.pts = new Float32Array((RING + TRADE_RING) * 8);
        this.quads = new Float32Array(MAXLVL * 2 * 9);
    }

    draw(v, book, scratch, n) {
        const sink = v.glSink;
        if (!sink) return;
        // Retina: the GL backing store is DEVICE px. Fold dpr into the size scalars ONCE
        // here (w/h and the fixed pixel offsets), so the per-vertex loop keeps its shape --
        // no per-vertex multiply -- and the GL geometry aligns with the dpr-transformed 2D
        // ladder within 1 CSS px.
        const dpr = v.dpr, gl = sink.gl, w = v.w * dpr, h = v.h * dpr, plotW = w * 0.66;
        sink.resize(w, h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);   // translucent bars

        // -- depth ladder as QUAD bars --
        const qsink = v.glQuadSink;
        if (qsink) {
            qsink.resize(w, h);
            const q = this.quads, ladderX = plotW + 24 * dpr, ladderW = w - ladderX - 16 * dpr,
                midY = h / 2, rowH = (h * 0.9) / (MAXLVL * 2), barH = rowH - 2 * dpr,
                scale = ladderW / (book.maxSz || 1), nb = book.n;
            let k = 0;
            for (let i = 0; i < nb; i++) {
                const aw = Math.min(ladderW, book.askSz[i] * scale), ay = midY - (i + 1) * rowH;
                q[k++] = ladderX + aw / 2;
                q[k++] = ay + rowH / 2;
                q[k++] = aw;
                q[k++] = barH;
                q[k++] = 0;
                q[k++] = 0.96;
                q[k++] = 0.65;
                q[k++] = 0.14;
                q[k++] = 0.6;                       // ask amber
                const bw = Math.min(ladderW, book.bidSz[i] * scale), by = midY + i * rowH;
                q[k++] = ladderX + bw / 2;
                q[k++] = by + rowH / 2;
                q[k++] = bw;
                q[k++] = barH;
                q[k++] = 0;
                q[k++] = 0.306;
                q[k++] = 0.906;
                q[k++] = 0.82;
                q[k++] = 0.6;                      // bid teal
            }
            qsink.upload(q, 0, nb * 2 * 9, 0, 9);
            qsink.draw(nb * 2);
        }

        // -- tick ring + recent trades as GL_POINTS (on top), one buffer, one draw --
        if (n > 0) {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < n; i++) {
                const x = scratch[i];
                if (x < lo) lo = x;
                if (x > hi) hi = x;
            }
            if (!isFinite(lo)) {
                lo = 0;
                hi = 1;
            }
            const span = (hi - lo) || 1, d = this.pts,
                usableH = h - 24 * dpr, botPad = 12 * dpr, ptSize = 3.5 * dpr, denom = (n - 1 || 1);
            for (let i = 0; i < n; i++) {
                const b = i * 8;
                d[b] = (i / denom) * plotW;
                d[b + 1] = h - ((scratch[i] - lo) / span) * usableH - botPad;
                d[b + 2] = ptSize;
                d[b + 3] = 0.306;
                d[b + 4] = 0.906;
                d[b + 5] = 0.82;
                d[b + 6] = 1.0;
                d[b + 7] = 0;
            }
            const nt = v.nTrades, tp = v.tradePx, ts = v.tradeSide, base = n * 8,
                denomT = (nt - 1) || 1, tpSize = 5 * dpr;
            for (let i = 0; i < nt; i++) {
                const b = base + i * 8, buy = ts[i] > 0;
                d[b] = (i / denomT) * plotW;
                d[b + 1] = h - ((tp[i] - lo) / span) * usableH - botPad;
                d[b + 2] = tpSize;
                d[b + 3] = buy ? 0.306 : 0.96;
                d[b + 4] = buy ? 0.906 : 0.65;
                d[b + 5] = buy ? 0.82 : 0.14;
                d[b + 6] = 1.0;
                d[b + 7] = 0;
            }
            sink.upload(d, 0, (n + nt) * 8, 0, 8);
            sink.draw(n + nt);
        }
    }
}

// ticker system: pulls the socket once per frame, then selects + draws.
class RenderSystem {
    constructor(viz, book, tape, agg, tradePx, tradeSide) {
        this.viz = viz;
        this.book = book;
        this.tape = tape;
        this.agg = agg;
        this.tradePx = tradePx;
        this.tradeSide = tradeSide;
    }

    update() {
        const v = this.viz;
        if (!v.router || !v.ctx) return;
        if (v.feedPoll) v.feedPoll();                       // lite-ws: wake once per frame
        const n = this.tape.count;
        this.tape.copyTo(v.scratch, 0);   // ring -> scratch (oldest-first)
        const nt = this.tradePx.count;
        this.tradePx.copyTo(v.tradePx, 0);                  // scalar rings -> preallocated views
        this.tradeSide.copyTo(v.tradeSide, 0);
        v.nTrades = nt;
        const r = v.router.resolve(v.zoom);                 // lite-di-strategies selects the renderer
        if (v.setMode) v.setMode(r.mode);                   // toggle 2d <-> gl canvas
        r.draw(v, this.book, v.scratch, n);
    }
}

export async function bootKernel({ctx, gl, w, h, dpr, onEvent, onMode}) {
    const log = (kind, msg) => onEvent && onEvent(kind, msg);
    const viz = {
        ctx, w, h, dpr: dpr || 1, zoom: 1, router: null, scratch: new Float32Array(RING),
        tradePx: new Float32Array(TRADE_RING), tradeSide: new Float32Array(TRADE_RING), nTrades: 0,
        feedPoll: null, glSink: null, glQuadSink: null, setMode: onMode || null
    };
    try {                                                                        // lite-gl WebGL2 sinks
        if (gl) {
            viz.glSink = createPointSink(gl, {capacity: RING + TRADE_RING});
            viz.glQuadSink = createQuadSink(gl, {capacity: MAXLVL * 2});
        }
    } catch (e) {
        log('down', 'WebGL2 unavailable -- GPU renderer disabled');
    }

    const c = new Container();
    c.value('viz', viz);

    const rx = useScopedSignals(c, {createRegistry});     // lite-di-signal scoped registry
    const agg = new Aggregates(rx);
    c.value('agg', agg);
    c.value('tape', new RingBuffer(RING));                    // lite-ring-buffer (pow2, bitmask wrap)
    c.value('trades:px', new RingBuffer(TRADE_RING));         // recent-trade price ring (scalars)
    c.value('trades:side', new RingBuffer(TRADE_RING));       // recent-trade side ring (+1 buy / -1 sell)
    c.singleton('book', OrderBook);
    c.value('renderer:coarse', new CoarseRenderer());
    c.value('renderer:detailed', new DetailedRenderer());
    c.value('renderer:gpu', new GLRenderer());               // lite-gl instanced points + quads

    // event-bus fan-out (boot-locked topology). The OBJECT bus is NOT recorded: its
    // handlers consume each frame synchronously, so S2 may reuse per-tag scratch freely.
    // 'tick' carries QUOTE/DEPTH frames (tape + aggregates); 'trade' carries aggTrade
    // frames into the two scalar rings. The book itself is applied in the cold dispatch
    // switch below, where the DEPTH-vs-QUOTE choice lives -- never in a hot handler.
    const bus = new EventBus(c);
    bus.on('tick', TapeApply, ['tape']).on('tick', AggApply, ['agg'])
        .on('trade', TradeApply, ['trades:px', 'trades:side']);

    // Dedicated numeric flight-recorder. Carries mid SCALARS only -- an unboxed-double
    // payload array, so each capture is an inline store (no per-tick HeapNumber boxing) and
    // replay is honest (replaying object references off the reused-scratch bus would redraw
    // a flat line). This is the recorded bus; the object bus above is not.
    const traceBus = new EventBus(c);
    traceBus.on('mid', MidReplay, ['tape']);
    c.value('traceBus', traceBus);
    c.onTeardown('traceBus', (b) => {
        try {
            b.dispose();
        } catch {
        }
    });

    // lite-ws: bind lifecycle signals to the SAME scoped registry, then dial the feed.
    // onMessage is the per-message pipe (0 B/emit fan-out); status/latency stay coarse signals.
    const {createSocket} = createSocketFactory(rx.registry);
    let quoteCount = 0, depthCount = 0, tradeCount = 0, feedUrl = FEED_URL, bookRef = null;
    // Single frame dispatch point. This is the ONLY place the wire tag is inspected: the
    // switch is the cold seam. DEPTH sets the REAL 20-level ladder; QUOTE only fabricates a
    // ladder when the book is still synthetic (sim / local-quote), so a live bookTicker
    // never clobbers a real depth ladder -- it just feeds the dense price trace. TRADE fans
    // to the two scalar rings. Every downstream handler (tape/agg/trade) is tag-agnostic.
    const dispatch = (f) => {
        switch (f.tag) {
            case TAG_DEPTH:
                bookRef.applyDepth(f);
                bus.emit('tick', f);            // tape + aggregates (synchronous, unrecorded)
                traceBus.emit('mid', f.mid);    // scalar-only, recorded -> zero-GC honest replay
                depthCount++;
                break;
            case TAG_QUOTE:
                if (bookRef.synthetic) bookRef.applySynthQuote(f);
                bus.emit('tick', f);
                traceBus.emit('mid', f.mid);
                quoteCount++;
                break;
            case TAG_TRADE:
                bus.emit('trade', f);           // -> TradeApply -> two scalar rings
                tradeCount++;
                break;
        }
    };
    // Resolve sim vs wire ONCE, here. The hot body never sees the distinction. The sim
    // socket emits a QUOTE-tagged scratch; the wire socket decodes via parseFrame. Both
    // funnel through dispatch, so the tag switch stays the single cold seam.
    const makeSocket = () => feedUrl.startsWith('sim://')
        ? makeSimSocket(dispatch)
        : createSocket(feedUrl, {
            onMessage: (data) => {
                try {
                    const f = parseFrame(data);
                    if (f) dispatch(f);
                } catch {
                }
            },
            backoff: {min: 250, max: 4000, factor: 2, jitter: 0.5},
        });
    c.value('makeSocket', makeSocket);
    c.singleton('feed', Feed, ['makeSocket']);
    // Hot-path cache: hold the resolved socket so the render loop never does c.get('feed')
    // per frame. Refreshed on every (re)resolve; nulled on teardown so a disposed socket
    // is never polled.
    let activeSock = null;
    const refreshFeed = () => {
        try {
            activeSock = c.get('feed').sock;
        } catch {
            activeSock = null;
        }
    };
    c.onTeardown('feed', (f) => {
        activeSock = null;
        try {
            f.dispose();
        } catch {
        }
    });  // re-resolve closes the old socket

    // render loop
    const ticker = new Ticker(c);
    ticker.system('render', RenderSystem, {lane: 'normal', deps: ['viz', 'book', 'tape', 'agg', 'trades:px', 'trades:side']});

    // scheduled housekeeping
    const cron = new Cron(c, {tickMs: 1000});
    cron.job('aggregate', AggregateJob, interval(5000))
        .job('prune', PruneJob, interval(3000))
        .job('heartbeat', HeartbeatJob, interval(2000));

    // health + supervisor over the feed subsystem
    const health = new Health();
    health.source('feed', () => (activeSock && activeSock.isOpen() ? 0 : 1), LANES.READY);  // pure fail-closed read

    health.source('loop', () => 0, LANES.LIVE);
    let restarts = 0;
    const sup = new Supervisor(c, {
        children: ['feed'], strategy: STRATEGIES.ONE_FOR_ONE, maxRestarts: 30, windowMs: 60000,
        onRestart: () => {
            restarts++;
            refreshFeed();
            log('heal', 'feed subsystem re-resolved -- dialing a fresh socket');
        },
        onEscalate: () => log('escalate', 'restart budget exhausted -- feed left down (fail closed)'),
    });
    health.watchSupervisor('supervisor', sup, LANES.READY);

    // Shared degrade path: switch feedUrl, clear the rings (price scale differs), log, and
    // fault the feed so the supervisor re-resolves a fresh socket. Used by BOTH a manual
    // source switch and the failover watchdog -- one place holds the resets + reportFault.
    // Switching TO sim re-arms the synthetic ladder so its QUOTE frames refabricate levels
    // instead of freezing the last real depth.
    const degradeTo = (url, kind, msg) => {
        const toSim = url.startsWith('sim://');
        feedUrl = url;
        try {
            c.get('tape').reset();
            c.get('trades:px').reset();
            c.get('trades:side').reset();
            if (toSim) c.get('book').synthetic = true;
        } catch {
        }
        log(kind, msg);
        sup.reportFault('feed').catch(() => {
        });
    };

    // Watchdog control surface (injected into FailoverJob). Closures read the live locals;
    // `armed` is disarmed permanently by the first manual setSource (a choice must stick).
    const failover = {
        armed: true,
        count: 0,
        down: () => !activeSock || !activeSock.isOpen(),
        isSim: () => feedUrl.startsWith('sim://'),
        trip: () => degradeTo(SOURCES.sim, 'escalate', 'live feed unreachable -- degrading to simulation'),
    };
    c.value('failover', failover);
    cron.job('failover', FailoverJob, interval(1000), {deps: ['failover']});

    c.boot();
    bus.boot();
    traceBus.boot();
    bookRef = c.get('book');                                  // resolve the book once for the cold dispatch
    await sup.start();                                        // resolves 'feed' -> opens the socket
    refreshFeed();                                            // cache the initial socket for the hot path

    viz.router = new StrategyRouter(c, {
        strategies: {coarse: 'renderer:coarse', detailed: 'renderer:detailed', gpu: 'renderer:gpu'},
        gate: (zoom) => (viz.glSink && zoom >= 2.2 ? 'gpu' : (zoom >= 1.5 ? 'detailed' : 'coarse')),
    });
    viz.feedPoll = () => {
        const s = activeSock;
        if (s) {
            try {
                s.poll();
            } catch {
            }
        }
    };  // cached ref, no per-frame c.get

    traceBus.record(RING, {onOverflow: 'drop-oldest'});    // event-bus 1.1.0 flight recorder (scalars only)
    ticker.start();
    cron.start();

    let nodeCount = 0;
    try {
        nodeCount = (fromContainer(c).nodes || []).length;
        toJSON(fromContainer(c));
    } catch {
        nodeCount = 0;
    }

    // rate sampler: quotes+depth per second (qps) and trades per second (trps)
    let qps = 0, trps = 0, lastQ = 0, lastT = 0;
    const tpsTimer = setInterval(() => {
        const q = quoteCount + depthCount;
        qps = q - lastQ;
        lastQ = q;
        trps = tradeCount - lastT;
        lastT = tradeCount;
        agg.tps.set(qps);
    }, 1000);

    return {
        readState() {
            let status = 'closed', latency = -1, attempts = 0, open = false;
            const s = activeSock;
            if (s) {
                try {
                    status = s.status();
                    latency = s.latency();
                    attempts = s.reconnectAttempts();
                    open = s.isOpen();
                } catch {
                }
            }
            return {
                mid: agg.mid(), bid: agg.bid(), ask: agg.ask(), spread: agg.spread(), qps, trps,
                levels: bookRef ? bookRef.n : 0, syntheticLadder: bookRef ? bookRef.synthetic : true,
                readyz: health.readyz(), livez: health.livez(), supState: sup.state, restarts,
                recorded: traceBus.recorded(), nodeCount, jobs: refs.stats,
                status, latency, attempts, open,
            };
        },
        setZoom(z) {
            viz.zoom = z;
        },
        setSource(url) {                                          // switch feed, re-dial via supervisor
            failover.armed = false;                               // a manual choice disarms the watchdog for good
            degradeTo(url, 'heal', 'switching feed -> ' + url.replace(/^wss?:\/\//, ''));
        },
        sources: SOURCES,
        killFeed() {
            sup.reportFault('feed').catch(() => {
            });
        },   // subsystem fault -> supervisor heal
        replay() {
            refs.replaying = true;                                // MidReplay pushes to tape only while this is set
            let n = 0;
            try {
                n = traceBus.replay();
            } finally {
                refs.replaying = false;
            }
            log('replay', 'replayed ' + n + ' recorded ticks');
            return n;
        },
        resize(nw, nh, ndpr) {
            viz.w = nw;
            viz.h = nh;
            if (ndpr) viz.dpr = ndpr;
        },
        stop() {
            clearInterval(tpsTimer);
            ticker.stop();
            cron.stop();
            try {
                if (activeSock) activeSock.dispose();
            } catch {
            }
            try {
                traceBus.dispose();
            } catch {
            }
        },
    };
}
