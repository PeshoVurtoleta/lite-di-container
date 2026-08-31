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

import {Container, TYPES} from '@zakkster/lite-di-container';
import {EventBus} from '@zakkster/lite-di-event-bus';
import {StrategyRouter} from '@zakkster/lite-di-strategies';
import {Cron, interval} from '@zakkster/lite-di-cron';
import {Ticker} from '@zakkster/lite-di-ticker';
import {Supervisor, STRATEGIES} from '@zakkster/lite-di-supervisor';
import {Health, LANES} from '@zakkster/lite-di-health';
import {fromContainer, toJSON} from '@zakkster/lite-di-graph';
import {createSignalScope, SIGNAL_REGISTRY_TOKEN} from '@zakkster/lite-di-signal';
import {createRegistry} from '@zakkster/lite-signal';
import {createSocketFactory} from '@zakkster/lite-ws';
import {RingBuffer} from '@zakkster/lite-ring-buffer';
import {createPointSink, createQuadSink} from '@zakkster/lite-gl/backend';
import {TAG_QUOTE, TAG_DEPTH, TAG_TRADE, MAXLVL, parseFrame, OrderBook} from './Frames.js';

const RING = 2048;                 // SEAM: size to your firehose window
const TRADE_RING = 256;            // recent-trade window (pow2, scalar rings)
const POLL_MS = 100;               // per-scope background-ingest poll cadence (G1)
const TAU = Math.PI * 2;
const DOT_BUY = '#4EE7D2';         // taker-buy trade dot (teal)
const DOT_SELL = '#F5A623';        // taker-sell trade dot (ember)
// Narrated reverse-teardown order for a scope close. The closed-line is built from
// this list marked against the ACTUAL failed steps, so it never claims a step that threw.
const TEARDOWN_ORDER = ['feed', 'agg', 'tape', 'book', 'signal-registry'];
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
// replaying (a per-scope replayCtl.on) -- live, TapeApply already fills the tape off the
// object bus, so gating here avoids a double-advance while still repainting on replay.
// replayCtl is a per-scope value (S3): replay is now scoped, no module-global flag.
class MidReplay {
    constructor(tape, replayCtl) {
        this.tape = tape;
        this.replayCtl = replayCtl;
    }

    handle(mid) {
        if (this.replayCtl.on) this.tape.push(mid);
    }
}

// cron jobs: DI-constructed wall-clock housekeeping. S3 (finding 12): the counters
// live in the container as a `stats` VALUE, injected as a dep -- so two boots never
// share a module-global object, and a re-boot resets to zero honestly.
class AggregateJob {
    constructor(stats) {
        this.stats = stats;
    }

    run() {
        this.stats.aggregations++;
    }
}

class PruneJob {
    constructor(stats) {
        this.stats = stats;
    }

    run() {
        this.stats.pruned++;
    }
}

class HeartbeatJob {
    constructor(stats) {
        this.stats = stats;
    }

    run() {
        this.stats.heartbeats++;
    }
}

// Per-scope feed poll (background ingest, G1). A DI cron job so a non-active symbol
// keeps pulling its socket OFF the render frame. Every scope runs this cron; the active
// tab is ADDITIONALLY polled per-frame inside RenderSystem.update() for live freshness
// (poll() is idempotent, so the extra pump is harmless), while non-active tabs rely on
// this cron alone -- so tickCount keeps rising with zero cost to the render budget.
// Injected `pollctl.poll` reads the scope's CURRENT socket (survives a supervisor re-resolve).
class PollJob {
    constructor(pollctl) {
        this.pollctl = pollctl;
    }

    run() {
        this.pollctl.poll();
    }
}

// Per-scope rate sampler (quotes+depth per second, trades per second). A cron job, not
// a stray setInterval, so it tears down with the scope and stays graph-resident.
class RateJob {
    constructor(ratectl) {
        this.ratectl = ratectl;
    }

    run() {
        this.ratectl.sample();
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
        // Trace point size + palette as instance fields, read (never allocated) in the
        // hot body -- so a rebind() to GLRendererV2 swaps the visible build in one frame.
        this.ptSize = 3.5;
        this.tpSize = 5;
        this.cr = 0.306;
        this.cg = 0.906;
        this.cb = 0.82;
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
            const span = (hi - lo) || 1, d = this.pts, cr = this.cr, cg = this.cg, cb = this.cb,
                usableH = h - 24 * dpr, botPad = 12 * dpr, ptSize = this.ptSize * dpr, denom = (n - 1 || 1);
            for (let i = 0; i < n; i++) {
                const b = i * 8;
                d[b] = (i / denom) * plotW;
                d[b + 1] = h - ((scratch[i] - lo) / span) * usableH - botPad;
                d[b + 2] = ptSize;
                d[b + 3] = cr;
                d[b + 4] = cg;
                d[b + 5] = cb;
                d[b + 6] = 1.0;
                d[b + 7] = 0;
            }
            const nt = v.nTrades, tp = v.tradePx, ts = v.tradeSide, base = n * 8,
                denomT = (nt - 1) || 1, tpSize = this.tpSize * dpr;
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

// Rebind target (GAP-3): a post-boot renderer HOT-SWAP proof. Same GL geometry, a
// louder build -- bigger ember trace points -- so `rebind('renderer:gpu', v2)` is
// visible in the very next frame (requires zoom >= 2.2 to select the gpu strategy).
// A VALUE (no GL resources of its own; it draws through the shared parent sink), so
// the un-torn-down old instance is harmless (owner risk 6).
class GLRendererV2 extends GLRenderer {
    constructor() {
        super();
        this.ptSize = 6;
        this.tpSize = 8;
        this.cr = 0.96;
        this.cg = 0.65;
        this.cb = 0.14;
    }
}

// ticker system [HOT]: pulls the ACTIVE scope's socket once per frame, then selects +
// draws. deps ['viz'] ONLY -- the per-symbol book/tape/agg/feed live behind the single
// pre-allocated `viz.active` holder, mutated on tab switch (cold). No c.get, no literal,
// no closure in this body; a background symbol's ingest is pumped by its own PollJob.
class RenderSystem {
    constructor(viz) {
        this.viz = viz;
    }

    update() {
        const v = this.viz;
        if (!v.router || !v.ctx) return;
        const a = v.active;
        if (!a) return;                                     // no live symbol -> idle
        a.feedPoll();                                       // active scope: wake its socket
        const n = a.tape.count;
        a.tape.copyTo(v.scratch, 0);                        // ring -> scratch (oldest-first)
        const nt = a.tradePx.count;
        a.tradePx.copyTo(v.tradePx, 0);                     // scalar rings -> preallocated views
        a.tradeSide.copyTo(v.tradeSide, 0);
        v.nTrades = nt;
        const r = v.router.resolve(v.zoom);                 // lite-di-strategies selects the renderer
        if (v.setMode) v.setMode(r.mode);                   // toggle 2d <-> gl canvas
        r.draw(v, a.book, v.scratch, n);
    }
}

// rx primitives bound to a scope's OWN registry (cold, per-scope setup).
function rxOf(sc) {
    const reg = sc.get(SIGNAL_REGISTRY_TOKEN);
    return {signal: reg.signal.bind(reg), computed: reg.computed.bind(reg)};
}

// Per-symbol child scope (finding 7). Each symbol owns feed / book / tape / agg +
// its OWN lite-di-signal registry, its OWN object bus + numeric trace recorder, and
// its OWN supervisor/health so killing one feed faults ONE scope. The registry is
// created via createSignalScope (eager -> _resolutionOrder[0]) so it tears down LAST.
// Cold factory: everything here runs once, at tab open, never per frame.
function createSymbolScope(parent, {symbol, url, log, faulty}) {
    const s = createSignalScope(parent, {createRegistry});   // registry pinned first, torn down last
    const scopeReg = s.get(SIGNAL_REGISTRY_TOKEN);

    // tape / book / agg / trade rings are singleton(Factory) -- NEVER value: a VALUE
    // returns before the isCached block (Container.js:237) so it is never in the
    // resolution order and never torn down or counted. Anything that must appear in
    // the teardown walk is a singleton.
    s.value('symbol', symbol);
    s.singletonFactory('tape', () => new RingBuffer(RING));
    s.singleton('book', OrderBook);
    s.singletonFactory('agg', (sc) => new Aggregates(rxOf(sc)));
    s.singletonFactory('trades:px', () => new RingBuffer(TRADE_RING));
    s.singletonFactory('trades:side', () => new RingBuffer(TRADE_RING));

    const replayCtl = {on: false};                           // per-scope replay gate
    s.value('replayCtl', replayCtl);

    // Object bus (unrecorded) + numeric trace recorder. Registered as singletons so
    // their onTeardown -> dispose() actually fires (risk 4): a VALUE would leak the
    // recorder ring across the 50x churn gate (G2).
    const bus = new EventBus(s);
    bus.on('tick', TapeApply, ['tape']).on('tick', AggApply, ['agg'])
        .on('trade', TradeApply, ['trades:px', 'trades:side']);
    s.singletonFactory('bus', () => bus);
    s.onTeardown('bus', (b) => {
        try {
            b.dispose();
        } catch {
        }
    });

    const traceBus = new EventBus(s);
    traceBus.on('mid', MidReplay, ['tape', 'replayCtl']);
    s.singletonFactory('traceBus', () => traceBus);
    s.onTeardown('traceBus', (b) => {
        try {
            b.dispose();
        } catch {
        }
    });

    // per-scope feed lifecycle + counters (all scope-local, no module globals)
    let feedUrl = url, sock = null;
    let quoteCount = 0, depthCount = 0, tradeCount = 0, qps = 0, trps = 0, lastQ = 0, lastT = 0;
    let book = null, tape = null, agg = null, tradePx = null, tradeSide = null;

    // Single cold dispatch seam (the ONLY place the wire tag is inspected). book is
    // assigned after boot; dispatch runs only after sup.start() opens the socket.
    const dispatch = (f) => {
        switch (f.tag) {
            case TAG_DEPTH:
                book.applyDepth(f);
                bus.emit('tick', f);
                traceBus.emit('mid', f.mid);
                depthCount++;
                break;
            case TAG_QUOTE:
                if (book.synthetic) book.applySynthQuote(f);
                bus.emit('tick', f);
                traceBus.emit('mid', f.mid);
                quoteCount++;
                break;
            case TAG_TRADE:
                bus.emit('trade', f);
                tradeCount++;
                break;
        }
    };

    const {createSocket} = createSocketFactory(scopeReg);     // per-scope socket factory
    const makeSocket = () => feedUrl.startsWith('sim://')
        ? makeSimSocket(dispatch)
        : createSocket(feedUrl, {
            onMessage: (data) => {
                try {
                    const fr = parseFrame(data);
                    if (fr) dispatch(fr);
                } catch {
                }
            },
            backoff: {min: 250, max: 4000, factor: 2, jitter: 0.5},
        });
    s.value('makeSocket', makeSocket);
    s.singleton('feed', Feed, ['makeSocket']);
    s.onTeardown('feed', (fd) => {
        sock = null;
        try {
            fd.dispose();
        } catch {
        }
    });

    // dev-only fault injection (?faultyTeardown): one scope binding throws on teardown;
    // container isolation (D-12) still fires the siblings and routes the error.
    if (faulty) s.onTeardown('book', () => {
        throw new Error('injected teardown fault (?faultyTeardown)');
    });

    const refreshFeed = () => {
        try {
            sock = s.get('feed').sock;
        } catch {
            sock = null;
        }
    };
    const feedPoll = () => {
        const so = sock;
        if (so) {
            try {
                so.poll();
            } catch {
            }
        }
    };
    s.value('pollctl', {poll: feedPoll});

    const degradeTo = (u, kind, msg) => {
        const toSim = u.startsWith('sim://');
        feedUrl = u;
        try {
            tape.reset();
            tradePx.reset();
            tradeSide.reset();
            if (toSim) book.synthetic = true;
        } catch {
        }
        log(kind, msg);
        sup.reportFault('feed').catch(() => {
        });
    };

    const failover = {
        armed: true,
        count: 0,
        down: () => !sock || !sock.isOpen(),
        isSim: () => feedUrl.startsWith('sim://'),
        trip: () => degradeTo(SOURCES.sim, 'escalate', symbol + ': live feed unreachable -- degrading to simulation'),
    };
    s.value('failover', failover);

    const ratectl = {
        sample: () => {
            const q = quoteCount + depthCount;
            qps = q - lastQ;
            lastQ = q;
            trps = tradeCount - lastT;
            lastT = tradeCount;
            if (agg) agg.tps.set(qps);
        },
    };
    s.value('ratectl', ratectl);

    // per-scope supervisor + health (risk 3: Supervisor accepts the child scope as its
    // container -- a Container instance carrying isBooted/invalidate/get, verified).
    let restarts = 0;
    const sup = new Supervisor(s, {
        children: ['feed'], strategy: STRATEGIES.ONE_FOR_ONE, maxRestarts: 30, windowMs: 60000,
        onRestart: () => {
            restarts++;
            refreshFeed();
            log('heal', symbol + ': feed re-resolved -- dialing a fresh socket');
        },
        onEscalate: () => log('escalate', symbol + ': restart budget exhausted -- feed left down (fail closed)'),
    });
    const health = new Health();
    health.source('feed', () => (sock && sock.isOpen() ? 0 : 1), LANES.READY);
    health.source('loop', () => 0, LANES.LIVE);
    health.watchSupervisor('supervisor', sup, LANES.READY);

    // per-scope cron: fast background poll (G1) + 1s failover watchdog + 1s rate sampler.
    // A dedicated fast cron for poll so a background tab is not starved by 1s granularity.
    const scron = new Cron(s, {tickMs: POLL_MS});
    scron.job('poll', PollJob, interval(POLL_MS), {deps: ['pollctl']})
        .job('failover', FailoverJob, interval(1000), {deps: ['failover']})
        .job('rate', RateJob, interval(1000), {deps: ['ratectl']});

    s.boot();
    bus.boot();
    traceBus.boot();
    // Eager resolve in an order that makes the reverse teardown read
    // feed -> agg -> tape -> book -> signal-registry (registry is index 0).
    book = s.get('book');
    tape = s.get('tape');
    agg = s.get('agg');
    tradePx = s.get('trades:px');
    tradeSide = s.get('trades:side');
    s.get('bus');
    s.get('traceBus');

    let nodeCount = 0;
    try {
        nodeCount = (fromContainer(s).nodes || []).length;
    } catch {
        nodeCount = 0;
    }

    return {
        symbol, scope: s, nodeCount,
        book, tape, agg, tradePx, tradeSide, feedPoll,
        async start() {
            await sup.start();                               // resolves 'feed' -> opens the socket
            refreshFeed();
            traceBus.record(RING, {onOverflow: 'drop-oldest'});
            scron.start();
        },
        state() {
            let status = 'closed', latency = -1, attempts = 0, open = false;
            const so = sock;
            if (so) {
                try {
                    status = so.status();
                    latency = so.latency();
                    attempts = so.reconnectAttempts();
                    open = so.isOpen();
                } catch {
                }
            }
            return {
                mid: agg.mid(), bid: agg.bid(), ask: agg.ask(), spread: agg.spread(), qps, trps,
                levels: book ? book.n : 0, syntheticLadder: book ? book.synthetic : true,
                readyz: health.readyz(), livez: health.livez(), supState: sup.state, restarts,
                recorded: traceBus.recorded(), status, latency, attempts, open,
                ticks: quoteCount + depthCount + tradeCount,
            };
        },
        setSource(u) {
            failover.armed = false;                          // a manual choice disarms the watchdog for good
            degradeTo(u, 'heal', symbol + ': switching feed -> ' + u.replace(/^wss?:\/\//, ''));
        },
        killFeed() {
            sup.reportFault('feed').catch(() => {
            });
        },
        replay() {
            replayCtl.on = true;
            let n = 0;
            try {
                n = traceBus.replay();
            } finally {
                replayCtl.on = false;
            }
            log('replay', symbol + ': replayed ' + n + ' recorded ticks');
            return n;
        },
        async close(outerOnTeardownError) {
            log('down', 'teardown: feed[' + symbol + ']');
            scron.stop();
            const regNodes = scopeReg.stats().activeNodes;   // read the live count BEFORE destroy
            // Capture which bindings actually threw so the closed-line reflects the real
            // outcome (?faultyTeardown makes 'book' throw); still route each error outward.
            const failed = [];
            const onTeardownError = (err, name) => {
                failed.push(String(name));
                if (outerOnTeardownError) outerOnTeardownError(err, name);
            };
            await s.shutdown({onTeardownError});             // reverse-topological, registry last
            let walk = '';
            for (let i = 0; i < TEARDOWN_ORDER.length; i++) {
                const step = TEARDOWN_ORDER[i];
                walk += (i ? ' -> ' : '') + step + (failed.indexOf(step) !== -1 ? ' (failed)' : '');
            }
            log('down', 'scope: ' + symbol + ' closed -- teardown: ' + walk);
            log('down', 'scope: ' + symbol + ' registry destroyed -- ' + regNodes + ' reactive nodes released');
        },
    };
}

export async function bootKernel({ctx, gl, w, h, dpr, onEvent, onMode}) {
    const log = (kind, msg) => onEvent && onEvent(kind, msg);
    // ?faultyTeardown read ONCE, cold, at boot (never on the hot path).
    const faulty = typeof location !== 'undefined'
        && new URLSearchParams(location.search).has('faultyTeardown');

    const viz = {
        ctx, w, h, dpr: dpr || 1, zoom: 1, router: null, active: null, scratch: new Float32Array(RING),
        tradePx: new Float32Array(TRADE_RING), tradeSide: new Float32Array(TRADE_RING), nTrades: 0,
        glSink: null, glQuadSink: null, setMode: onMode || null,
    };
    try {                                                                        // lite-gl WebGL2 sinks (shared, risk 5)
        if (gl) {
            viz.glSink = createPointSink(gl, {capacity: RING + TRADE_RING});
            viz.glQuadSink = createQuadSink(gl, {capacity: MAXLVL * 2});
        }
    } catch (e) {
        log('down', 'WebGL2 unavailable -- GPU renderer disabled');
    }

    // The single pre-allocated active-symbol holder. Mutated on tab switch (cold);
    // read by RenderSystem.update() every frame, never re-allocated.
    const activeHolder = {book: null, tape: null, agg: null, feedPoll: null, tradePx: null, tradeSide: null};

    const c = new Container();
    c.value('viz', viz);
    const stats = {pruned: 0, aggregations: 0, heartbeats: 0};   // finding 12: counters IN the container
    c.value('stats', stats);
    c.value('renderer:coarse', new CoarseRenderer());
    c.value('renderer:detailed', new DetailedRenderer());
    c.value('renderer:gpu', new GLRenderer());                  // rebind target -- a VALUE (risk 6)

    const ticker = new Ticker(c);
    ticker.system('render', RenderSystem, {lane: 'normal', deps: ['viz']});      // deps: viz ONLY (hot)

    const cron = new Cron(c, {tickMs: 1000});
    cron.job('aggregate', AggregateJob, interval(5000), {deps: ['stats']})
        .job('prune', PruneJob, interval(3000), {deps: ['stats']})
        .job('heartbeat', HeartbeatJob, interval(2000), {deps: ['stats']});

    // shutdown bookkeeping + parent teardown narration (task 12: the walk narrates itself).
    let teardownFailed = 0, teardownTotal = 0;
    const onTeardownError = (err, name) => {
        teardownFailed++;
        log('escalate', 'teardown-error: ' + String(name) + ' -- ' + err.message);
    };
    for (const id of ['aggregate', 'prune', 'heartbeat']) {
        c.onTeardown('cron:job:' + id, () => {
            teardownTotal++;
            log('down', 'teardown: cron:' + id);
        });
    }

    c.boot();
    ticker.start();
    cron.start();

    const scopes = new Map();
    let activeSymbol = null, nodeCount = 0, gpuV2 = false, shuttingDown = false;

    const recomputeNodes = () => {
        let total = 0;
        try {
            total = (fromContainer(c).nodes || []).length;
            for (const h of scopes.values()) total += h.nodeCount;
        } catch {
            total = 0;
        }
        nodeCount = total;
    };
    recomputeNodes();

    const setActive = (sym) => {
        const h = sym !== null ? scopes.get(sym) : null;
        if (!h) {
            activeSymbol = null;
            viz.active = null;
            // Drop references to the drained scope so the holder pins nothing (G2).
            activeHolder.book = null;
            activeHolder.tape = null;
            activeHolder.agg = null;
            activeHolder.feedPoll = null;
            activeHolder.tradePx = null;
            activeHolder.tradeSide = null;
            return;
        }
        activeSymbol = sym;
        activeHolder.book = h.book;
        activeHolder.tape = h.tape;
        activeHolder.agg = h.agg;
        activeHolder.feedPoll = h.feedPoll;
        activeHolder.tradePx = h.tradePx;
        activeHolder.tradeSide = h.tradeSide;
        viz.active = activeHolder;
    };

    const addSymbol = async (sym, u) => {
        if (scopes.has(sym)) {
            setActive(sym);
            return scopes.get(sym);
        }
        const h = createSymbolScope(c, {symbol: sym, url: u, log, faulty});
        await h.start();
        scopes.set(sym, h);
        recomputeNodes();
        log('heal', 'scope: ' + sym + ' opened -- child scope + own signal registry (' + h.nodeCount + ' bindings)');
        if (activeSymbol === null) setActive(sym);
        return h;
    };

    const closeSymbol = async (sym) => {
        const h = scopes.get(sym);
        if (!h) return;
        await h.close(onTeardownError);                      // child before parent (Container.js child-guard)
        scopes.delete(sym);
        recomputeNodes();
        if (activeSymbol === sym) setActive(scopes.size > 0 ? scopes.keys().next().value : null);
    };

    // rebind hot-swap (GAP-3): renderer:gpu is a VALUE; invalidate() is a no-op for a
    // value so the swap is instant and the router needs no reconfiguration.
    const swapRenderer = async () => {
        await c.rebind('renderer:gpu', {type: TYPES.VALUE, value: new GLRendererV2(), isAsync: false});
        gpuV2 = true;
        log('rebind', 'rebind: renderer:gpu -> v2 (post-boot hot-swap, GAP-3)');
        if (viz.zoom < 2.2) log('rebind', 'rebind: zoom is ' + viz.zoom.toFixed(1) + 'x -- raise zoom >= 2.2x to see the gpu build');
    };

    // boot with one live symbol.
    await addSymbol('BTCUSDT', SOURCES.BTCUSDT);

    viz.router = new StrategyRouter(c, {
        strategies: {coarse: 'renderer:coarse', detailed: 'renderer:detailed', gpu: 'renderer:gpu'},
        gate: (zoom) => (viz.glSink && zoom >= 2.2 ? 'gpu' : (zoom >= 1.5 ? 'detailed' : 'coarse')),
    });

    const active = () => (activeSymbol !== null ? scopes.get(activeSymbol) : null);

    return {
        readState() {
            const h = active();
            const base = {
                symbol: activeSymbol, symbols: scopes.size, nodeCount, jobs: stats,
                gpuBuild: gpuV2 ? 'v2' : 'v1',
                mid: 0, bid: 0, ask: 0, spread: 0, qps: 0, trps: 0, levels: 0,
                syntheticLadder: true, readyz: 1, livez: 1, supState: 0, restarts: 0,
                recorded: 0, status: 'closed', latency: -1, attempts: 0, open: false, ticks: 0,
            };
            if (!h) return base;
            const st = h.state();
            base.mid = st.mid;
            base.bid = st.bid;
            base.ask = st.ask;
            base.spread = st.spread;
            base.qps = st.qps;
            base.trps = st.trps;
            base.levels = st.levels;
            base.syntheticLadder = st.syntheticLadder;
            base.readyz = st.readyz;
            base.livez = st.livez;
            base.supState = st.supState;
            base.restarts = st.restarts;
            base.recorded = st.recorded;
            base.status = st.status;
            base.latency = st.latency;
            base.attempts = st.attempts;
            base.open = st.open;
            base.ticks = st.ticks;
            return base;
        },
        setZoom(z) {
            viz.zoom = z;
        },
        setSource(u) {
            const h = active();
            if (h) h.setSource(u);
        },
        killFeed() {
            const h = active();
            if (h) h.killFeed();
        },
        replay() {
            const h = active();
            return h ? h.replay() : 0;
        },
        swapRenderer,
        addSymbol,
        closeSymbol,
        setActive,
        symbols() {
            return Array.from(scopes.keys());
        },
        activeSymbol() {
            return activeSymbol;
        },
        sources: SOURCES,
        resize(nw, nh, ndpr) {
            viz.w = nw;
            viz.h = nh;
            if (ndpr) viz.dpr = ndpr;
        },
        async shutdown() {
            if (shuttingDown) return;
            shuttingDown = true;
            log('down', 'shutdown: kernel draining -- children first');
            ticker.stop();
            cron.stop();
            for (const sym of Array.from(scopes.keys())) await closeSymbol(sym);   // children first
            try {
                await c.shutdown({onTeardownError});
            } catch (e) {
                log('escalate', 'shutdown: parent teardown error -- ' + (e && e.message ? e.message : String(e)));
            }
            if (teardownFailed > 0) {
                log('down', 'shutdown: complete -- ' + teardownFailed + ' of ' + (teardownTotal + teardownFailed) + ' teardowns failed (AggregateError, isolated)');
            } else {
                log('down', 'shutdown: complete -- ' + teardownTotal + ' teardowns, clean');
            }
            viz.active = null;
            if (onMode) onMode('shut');
        },
    };
}
