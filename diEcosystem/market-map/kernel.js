// market-map -- a SKELETON demo of the @zakkster/lite-di-* service kernel applied to a
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

const RING = 2048;                 // SEAM: size to your firehose window
const LVL = 16;                   // order-book depth levels per side
// Feed sources. `local` is the reliable default (feed-server.mjs); the Binance public
// bookTicker streams REAL best bid/ask over wss, no auth. Selectable at runtime.
const SOURCES = {
    local: 'ws://127.0.0.1:8100',
    'BTCUSDT': 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker',
    'ETHUSDT': 'wss://stream.binance.com:9443/ws/ethusdt@bookTicker',
};
const FEED_URL = SOURCES.local;

// Normalize a raw frame from either the local server or Binance bookTicker to a tick.
function parseTick(raw) {
    const m = JSON.parse(raw);
    if (m.b !== undefined && m.a !== undefined) {            // Binance bookTicker: b=bid, a=ask
        const bid = +m.b, ask = +m.a;
        return {mid: (bid + ask) / 2, bid, ask, t: m.u};
    }
    if (m.mid !== undefined) return m;                       // local feed-server shape
    return null;
}

class OrderBook {
    constructor() {
        this.bidPx = new Float32Array(LVL);
        this.bidSz = new Float32Array(LVL);
        this.askPx = new Float32Array(LVL);
        this.askSz = new Float32Array(LVL);
        this.mid = 0;
    }

    apply(t) {                                    // SEAM: real book deltas off the wire
        this.mid = t.mid;
        for (let i = 0; i < LVL; i++) {
            this.bidPx[i] = t.bid - i * 0.5;
            this.askPx[i] = t.ask + i * 0.5;
            this.bidSz[i] = 4 + Math.abs(Math.sin(t.mid * 0.03 + i)) * 40;
            this.askSz[i] = 4 + Math.abs(Math.cos(t.mid * 0.021 + i)) * 40;
        }
    }
}

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

// event-bus listeners: DI-constructed, fan each decoded tick out at 0 B/emit.
class BookApply {
    constructor(book) {
        this.book = book;
    }

    handle(t) {
        this.book.apply(t);
    }
}

class TapeApply {
    constructor(tape) {
        this.tape = tape;
    }

    handle(t) {
        this.tape.push(t.mid);
    }
}

class AggApply {
    constructor(agg) {
        this.agg = agg;
    }

    handle(t) {
        this.agg.apply(t);
    }
}

// cron jobs: DI-constructed wall-clock housekeeping.
const refs = {stats: {pruned: 0, aggregations: 0, heartbeats: 0}};

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

function drawFrame(ctx, w, h, book, scratch, n, labels) {
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
        ctx.arc(plotW, ly, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }

    const ladderX = plotW + 24, ladderW = w - ladderX - 16, midY = h / 2, rowH = (h * 0.9) / (LVL * 2);
    for (let i = 0; i < LVL; i++) {
        const aw = Math.min(ladderW, book.askSz[i] * (ladderW / 48));
        const bw = Math.min(ladderW, book.bidSz[i] * (ladderW / 48));
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
        drawFrame(v.ctx, v.w, v.h, book, s, n, null);
    }
}

class DetailedRenderer {
    constructor() {
        this.mode = '2d';
        this.labels = {ask: new LabelCache(LVL), bid: new LabelCache(LVL)};
    }

    draw(v, book, s, n) {
        drawFrame(v.ctx, v.w, v.h, book, s, n, this.labels);
    }
}

// lite-gl GPU renderer: the tick ring as instanced GL_POINTS (stride 8) AND the depth
// ladder as instanced QUAD bars (stride 9: x,y=center, w,h, rot, r,g,b,a). Screen pixels,
// top-left origin. The path that scales to ~1M primitives; here both sinks compose per frame.
class GLRenderer {
    constructor() {
        this.mode = 'gl';
        this.pts = new Float32Array(RING * 8);
        this.quads = new Float32Array(LVL * 2 * 9);
    }

    draw(v, book, scratch, n) {
        const sink = v.glSink;
        if (!sink) return;
        const gl = sink.gl, w = v.w, h = v.h, plotW = w * 0.66;
        sink.resize(w, h);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);   // translucent bars

        // -- depth ladder as QUAD bars --
        const qsink = v.glQuadSink;
        if (qsink) {
            qsink.resize(w, h);
            const q = this.quads, ladderX = plotW + 24, ladderW = w - ladderX - 16, midY = h / 2,
                rowH = (h * 0.9) / (LVL * 2);
            let k = 0;
            for (let i = 0; i < LVL; i++) {
                const aw = Math.min(ladderW, book.askSz[i] * (ladderW / 48)), ay = midY - (i + 1) * rowH;
                q[k++] = ladderX + aw / 2;
                q[k++] = ay + rowH / 2;
                q[k++] = aw;
                q[k++] = rowH - 2;
                q[k++] = 0;
                q[k++] = 0.96;
                q[k++] = 0.65;
                q[k++] = 0.14;
                q[k++] = 0.6;                       // ask amber
                const bw = Math.min(ladderW, book.bidSz[i] * (ladderW / 48)), by = midY + i * rowH;
                q[k++] = ladderX + bw / 2;
                q[k++] = by + rowH / 2;
                q[k++] = bw;
                q[k++] = rowH - 2;
                q[k++] = 0;
                q[k++] = 0.306;
                q[k++] = 0.906;
                q[k++] = 0.82;
                q[k++] = 0.6;                      // bid teal
            }
            qsink.upload(q, 0, LVL * 2 * 9, 0, 9);
            qsink.draw(LVL * 2);
        }

        // -- tick ring as GL_POINTS (on top) --
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
            const span = (hi - lo) || 1;
            const d = this.pts;
            for (let i = 0; i < n; i++) {
                const b = i * 8;
                d[b] = (i / (n - 1 || 1)) * plotW;
                d[b + 1] = h - ((scratch[i] - lo) / span) * (h - 24) - 12;
                d[b + 2] = 3.5;
                d[b + 3] = 0.306;
                d[b + 4] = 0.906;
                d[b + 5] = 0.82;
                d[b + 6] = 1.0;
                d[b + 7] = 0;
            }
            sink.upload(d, 0, n * 8, 0, 8);
            sink.draw(n);
        }
    }
}

// ticker system: pulls the socket once per frame, then selects + draws.
class RenderSystem {
    constructor(viz, book, tape, agg) {
        this.viz = viz;
        this.book = book;
        this.tape = tape;
        this.agg = agg;
    }

    update() {
        const v = this.viz;
        if (!v.router || !v.ctx) return;
        if (v.feedPoll) v.feedPoll();                       // lite-ws: wake once per frame
        const n = this.tape.count;
        this.tape.copyTo(v.scratch, 0);   // ring -> scratch (oldest-first)
        const r = v.router.resolve(v.zoom);                 // lite-di-strategies selects the renderer
        if (v.setMode) v.setMode(r.mode);                   // toggle 2d <-> gl canvas
        r.draw(v, this.book, v.scratch, n);
    }
}

export async function bootKernel({ctx, gl, w, h, onEvent, onMode}) {
    const log = (kind, msg) => onEvent && onEvent(kind, msg);
    const viz = {
        ctx, w, h, zoom: 1, router: null, scratch: new Float32Array(RING), feedPoll: null,
        glSink: null, glQuadSink: null, setMode: onMode || null
    };
    try {                                                                        // lite-gl WebGL2 sinks
        if (gl) {
            viz.glSink = createPointSink(gl, {capacity: RING});
            viz.glQuadSink = createQuadSink(gl, {capacity: LVL * 2});
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
    c.singleton('book', OrderBook);
    c.value('renderer:coarse', new CoarseRenderer());
    c.value('renderer:detailed', new DetailedRenderer());
    c.value('renderer:gpu', new GLRenderer());               // lite-gl instanced points + quads

    // event-bus fan-out (boot-locked topology)
    const bus = new EventBus(c);
    bus.on('tick', BookApply, ['book']).on('tick', TapeApply, ['tape']).on('tick', AggApply, ['agg']);

    // lite-ws: bind lifecycle signals to the SAME scoped registry, then dial the feed.
    // onMessage is the per-message pipe (0 B/emit fan-out); status/latency stay coarse signals.
    const {createSocket} = createSocketFactory(rx.registry);
    let tickCount = 0, feedUrl = FEED_URL;
    const makeSocket = () => createSocket(feedUrl, {
        onMessage: (data) => {
            try {
                const t = parseTick(data);
                if (t) {
                    bus.emit('tick', t);
                    tickCount++;
                }
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
    ticker.system('render', RenderSystem, {lane: 'normal', deps: ['viz', 'book', 'tape', 'agg']});

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

    c.boot();
    bus.boot();
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

    bus.record(RING, {onOverflow: 'drop-oldest'});         // event-bus 1.1.0 flight recorder
    ticker.start();
    cron.start();

    let nodeCount = 0;
    try {
        nodeCount = (fromContainer(c).nodes || []).length;
        toJSON(fromContainer(c));
    } catch {
        nodeCount = 0;
    }

    // tps sampler
    let tps = 0, lastCount = 0;
    const tpsTimer = setInterval(() => {
        tps = tickCount - lastCount;
        lastCount = tickCount;
        agg.tps.set(tps);
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
                mid: agg.mid(), bid: agg.bid(), ask: agg.ask(), spread: agg.spread(), tps,
                readyz: health.readyz(), livez: health.livez(), supState: sup.state, restarts,
                recorded: bus.recorded(), nodeCount, jobs: refs.stats,
                status, latency, attempts, open,
            };
        },
        setZoom(z) {
            viz.zoom = z;
        },
        setSource(url) {                                          // switch feed, re-dial via supervisor
            feedUrl = url;
            try {
                c.get('tape').reset();
            } catch {
            }               // price scale differs -> clear the ring
            log('heal', 'switching feed -> ' + url.replace(/^wss?:\/\//, ''));
            sup.reportFault('feed').catch(() => {
            });
        },
        sources: SOURCES,
        killFeed() {
            sup.reportFault('feed').catch(() => {
            });
        },   // subsystem fault -> supervisor heal
        replay() {
            const n = bus.replay();
            log('replay', 'replayed ' + n + ' recorded ticks');
            return n;
        },
        resize(nw, nh) {
            viz.w = nw;
            viz.h = nh;
        },
        stop() {
            clearInterval(tpsTimer);
            ticker.stop();
            cron.stop();
            try {
                if (activeSock) activeSock.dispose();
            } catch {
            }
        },
    };
}
