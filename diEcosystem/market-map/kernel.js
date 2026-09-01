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
import {fromContainer, toJSON, toDOT, toChromeTrace} from '@zakkster/lite-di-graph';
import {createSignalScope, reactiveService, SIGNAL_REGISTRY_TOKEN} from '@zakkster/lite-di-signal';
import {createRegistry} from '@zakkster/lite-signal';
import {defineReactive, disposeReactive, costOf, capacityFor,
    releaseReactive, reinitReactive, costOfInstance, snapshotOf} from '@zakkster/lite-signal-decorators';
import {createSocketFactory} from '@zakkster/lite-ws';
import {RingBuffer} from '@zakkster/lite-ring-buffer';
import {TAG_QUOTE, TAG_DEPTH, TAG_TRADE, MAXLVL, parseFrame, OrderBook} from './Frames.js';
import {createWatchlist} from './watchlist.js';

// lite-gl/backend is loaded COLD (not a static import) so bootKernel can run headless
// under node:test, where WebGL is absent. The dynamic import is awaited once, only when
// a real canvas (gl && ctx) is present; the returned namespace carries all three sink
// factories. It is the default value of bootKernel's injectable {glSinks} param.
async function defaultGlSinks() { return import('@zakkster/lite-gl/backend'); }

// Ring sizing is a BOOT parameter, not a constant. RingBuffer's contract is a
// power-of-two capacity; pickRing() feature-detects the device class and returns a
// pow2 in [RING_MIN, RING_MAX]. Fail closed: navigator.deviceMemory is Chromium-only
// (absent on iOS Safari), so an absent value assumes the smaller tier and is logged.
const RING_MAX = 65536;            // SEAM: max firehose window (pow2)
const RING_MIN = 4096;             // degraded floor (pow2)
const RECORD_FRAMES = 2048;        // trace recorder window -- DECOUPLED from tape size:
                                   // 65536 recorded frames is a separate memory budget.
const DEPTH_QUADS = MAXLVL * 2;    // S4 Phase D: one cumulative-depth quad per level per side
const TRADE_RING = 256;            // recent-trade window (pow2, scalar rings)
const LINE_STRIDE = 9;             // lite-gl LAYOUT.LINE: (x0,y0,x1,y1,width,r,g,b,a) per segment
// GL trade-dot colors, hoisted to module scope so the hot vertex loop carries no literals.
const BUY_R = 0.306, BUY_G = 0.906, BUY_B = 0.82;   // taker-buy dot (teal)
const SELL_R = 0.96, SELL_G = 0.65, SELL_B = 0.14;  // taker-sell dot (ember)
// GL cumulative-depth quad colors (translucent, drawn behind the ladder bars).
const DEPTH_ASK_R = 0.96, DEPTH_ASK_G = 0.65, DEPTH_ASK_B = 0.14, DEPTH_A = 0.18;
const DEPTH_BID_R = 0.306, DEPTH_BID_G = 0.906, DEPTH_BID_B = 0.82;
// 2D cumulative-depth curve fills (hex-first per demo CSS law is inline-only; canvas takes rgba).
const CURVE_BID = 'rgba(78,231,210,0.12)';
const CURVE_ASK = 'rgba(245,166,35,0.12)';
// S5 perf panel. A pow2 frame-delta ring (bitmask wrap, house pattern); the percentile
// window is the newest PERF_WINDOW samples out of it. The histogram covers 0..128 ms at
// HIST_MS resolution (clamp-to-last bucket) -- a provably alloc-free p99, no sort.
const PERF_RING = 1024;            // frame-delta ring (pow2, bitmask wrap)
const PERF_WINDOW = 600;           // percentile window (newest 600 samples)
const HIST_BUCKETS = 512;          // 512 * 0.25 ms = 0..128 ms
const HIST_MS = 0.25;              // histogram bucket resolution (ms)

// Snap n to a power of two within [RING_MIN, RING_MAX]. Fail closed on a bad override.
function clampRing(n) {
    let r = n | 0;
    if (r < RING_MIN) r = RING_MIN;
    if (r > RING_MAX) r = RING_MAX;
    let p = RING_MIN;
    while (p * 2 <= r) p *= 2;      // snap DOWN to a pow2 (RingBuffer contract)
    return p;
}

// Device-class ring pick. undefined deviceMemory -> smaller tier (fail closed, logged
// to the dev console). Returns a power of two clamped to [RING_MIN, RING_MAX].
function pickRing() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const mem = nav && typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined;
    const cores = nav && typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 0;
    if (mem === undefined) {
        console.warn('pickRing: navigator.deviceMemory unavailable -- assuming smaller tier (ring ' + RING_MIN + ')');
        return RING_MIN;
    }
    let ring = mem >= 8 ? RING_MAX : (mem >= 4 ? 16384 : RING_MIN);
    if (mem >= 4 && cores >= 8 && ring < RING_MAX) ring *= 2;   // many cores nudge one tier
    return clampRing(ring);
}
// S9 watchlist capacity -- the SINGLE source of truth for both the kernel's park/revive pool
// and index.html's row pool (imported there as WL_POOL). Two independent 8s would silently
// truncate (watchlist.add throws past cap) or hide rows; there is exactly one.
export const WATCHLIST_CAP = 8;
const POLL_MS = 100;               // per-scope background-ingest poll cadence (G1)
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

// The per-symbol reactive view-model, built by lite-signal-decorators' defineReactive on
// the scope's OWN lite-signal registry (never the default -- see makeSymbolVM). ONE frozen
// module-level spec, allocated once at load and shared by every scope's fresh base class.
// Ten reactive nodes per instance: 1 anchor + 5 signals + 1 local + 2 deriveds + 1 effect.
//   - signals: bid/ask/last are the live quote; pinned/pinAnchor drive the alert local.
//   - deriveds: mid + spread (lazy, cascade-disposed with the anchor).
//   - locals.alert: upstream-keyed (@localCopy flavor -- NO initial), so the threshold
//     FOLLOWS live mid until a UI write pins it. The source reads the mid FORMULA over the
//     raw signals (bid+ask)/2, NOT the `mid` derived: a localCopy seeds its upstream during
//     wiring, before deriveds exist, so reading the derived there is a named throw. Same
//     value, seed-safe. Pinning freezes the tracked upstream to the constant pinAnchor.
//   - effects.onQuote: [HOT] three tracked reads + one plain-field store. frameDirty is a
//     NON-reactive own field (a reactive write here would re-enter the effect); the body
//     never touches draw/ctx/document -- the effect dirty-marks, the frame renders.
const SYMBOL_VM_SPEC = Object.freeze({
    signals: {bid: 0, ask: 0, last: 0, pinned: false, pinAnchor: 0},
    deriveds: {
        mid: (self) => (self.bid + self.ask) / 2,
        spread: (self) => self.ask - self.bid,
    },
    locals: {
        alert: {source: (self) => (self.pinned ? self.pinAnchor : (self.bid + self.ask) / 2)},
    },
    effects: {
        onQuote: (self) => { self.mid; self.spread; self.alert; self.frameDirty = true; },
    },
});
export {SYMBOL_VM_SPEC};

// Cold, once per scope. A FRESH base class every call is REQUIRED: defineReactive installs
// on Class.prototype and a second call on the same prototype is a spec-collision throw. The
// constructor takes ZERO arguments -- costOf probes with no args and S9's createFleet depends
// on it. host:{registry} binds the whole chain (and disposeReactive) to the scope registry.
export function makeSymbolVM(registry) {
    // Fail closed: without a registry defineReactive falls through to lite-signal's DEFAULT
    // registry, silently landing the VM's 10 nodes on the shared default and breaking the A2
    // isolation invariant. null is not zero -- an absent scope registry is an error, not a default.
    if (!registry) throw new TypeError('makeSymbolVM: a scope registry is required (refusing the default registry)');
    class SymbolVMBase {
        frameDirty = false;
        dispose() { disposeReactive(this); }
    }
    return defineReactive(SymbolVMBase, {host: {registry}, ...SYMBOL_VM_SPEC});
}

// Module-load validation probe (mitigates defineReactive's PENDING-poisoning: a throw
// between the push and applyReactiveHost would leave recs in the module array for the next
// claim). Building + costing ONE throwaway VM at load makes a per-scope spec failure
// structurally impossible and PROVES the 10-node count before any scope opens. costOf's two
// probes agree here because the alert branch is data-independent at the unpinned floor.
const _probeReg = createRegistry({maxNodes: 64, maxLinks: 128, prealloc: 'eager', onCapacityExceeded: 'throw'});
const _ProbeVM = makeSymbolVM(_probeReg);
const VM_COST = costOf(_ProbeVM);
if (VM_COST.nodes !== 10) {
    throw new Error('SymbolVM spec drift: expected 10 reactive nodes, measured ' + VM_COST.nodes);
}
// Per-scope registry sizing (fail closed): capacityFor sizes the VM EXACTLY (eager + throw),
// then MEASURED kernel-signal headroom is added -- one tps signal + lite-ws lifecycle (3
// signals per socket, released on socket dispose) + heal/churn slack. Forwarded verbatim
// through createSignalScope's options passthrough to createRegistry.
const _VM_CFG = capacityFor([[_ProbeVM, 1]]);
const KERNEL_SIGNAL_HEADROOM = 16;   // tps(1) + ws lifecycle(3/socket) + heal/overlap slack
const KERNEL_LINK_HEADROOM = 8;
const SCOPE_REGISTRY_CONFIG = Object.freeze({
    createRegistry,
    maxNodes: _VM_CFG.maxNodes + KERNEL_SIGNAL_HEADROOM,
    maxLinks: _VM_CFG.maxLinks + KERNEL_LINK_HEADROOM,
    prealloc: 'eager',
    onCapacityExceeded: 'throw',
});
_probeReg.destroy();

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
    constructor(vm, feedGate) {
        this.vm = vm;
        this.feedGate = feedGate;                      // S9: the park gate (public-mutable {live} field)
    }

    handle(f) {                                        // [HOT] one flag read + three plain accessor stores, no alloc
        // A PARKED VM (watchlist remove -> releaseReactive) rejects reactive writes with a
        // throw. The feed keeps running while parked (the scope/socket survive for instant
        // revive), so the gate MUST short-circuit BEFORE any vm write. One field read, no alloc.
        if (!this.feedGate.live) return;
        this.vm.bid = f.bid;
        this.vm.ask = f.ask;
        this.vm.last = f.mid;
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

// S5 perf counters (pure, DOM-free -- headless-testable). A pow2 frame-delta ring plus a
// Uint32 histogram for a provably alloc-free p99. All state preallocated in the ctor: no
// object literal, array, closure, or Math.* call leaks into the hot body. sample() is
// [HOT] (per frame, post lane); computeP99() is COLD (1 Hz). Fail closed: a non-finite
// timestamp is SKIPPED (never recorded as 0); longTasks stays -1 (=> HUD "n/a") until the
// observer is feature-proven; heapMB stays null (=> "n/a") when performance.memory absent.
// null is NOT zero. Exported so qa can unit-test sample()/computeP99() headless (the S6
// seam) IF a resolver for the esm.sh specifiers is available -- see the headless note below.
export class PerfCounters {
    constructor() {
        this.d = new Float32Array(PERF_RING);
        this.head = 0;
        this.filled = 0;
        this.hist = new Uint32Array(HIST_BUCKETS);
        this.frames = 0;
        this.worst = 0;
        this.p99 = 0;
        this.fps = 0;
        this.lastTime = 0;
        this.longTasks = -1;                       // -1 = longtask observer unsupported
        this.longWorst = 0;
        this.heapMB = null;                        // null = performance.memory absent
        this.bootAt = 0;
    }

    // [HOT] one frame delta -> ring + worst + frame count. Nine scalar ops, zero alloc.
    sample(time) {
        if (!Number.isFinite(time)) return;        // fail closed: skip, never record 0
        const dt = time - this.lastTime;
        this.lastTime = time;
        this.d[this.head] = dt;
        this.head = (this.head + 1) & (PERF_RING - 1);
        if (this.filled < PERF_RING) this.filled++;
        if (dt > this.worst) this.worst = dt;
        this.frames++;
    }

    // COLD (1 Hz): bucket the newest window into the histogram and read p99, then roll the
    // fps window. No sort, no scratch array, no comparator -- the only alloc-free percentile.
    computeP99() {
        const hist = this.hist;
        hist.fill(0);
        let n = this.filled;
        if (n > PERF_WINDOW) n = PERF_WINDOW;
        const last = HIST_BUCKETS - 1;
        let idx = this.head;
        for (let i = 0; i < n; i++) {
            idx = (idx - 1) & (PERF_RING - 1);     // walk backwards from newest
            let b = (this.d[idx] / HIST_MS) | 0;
            if (b < 0) b = 0; else if (b > last) b = last;
            hist[b]++;
        }
        const target = Math.ceil(n * 0.99);
        let cum = 0, bkt = 0;
        for (let b = 0; b < HIST_BUCKETS; b++) {
            cum += hist[b];
            if (cum >= target) {
                bkt = b;
                break;
            }
        }
        this.p99 = n > 0 ? (bkt + 1) * HIST_MS : 0;
        this.fps = this.frames;
        this.frames = 0;
    }
}

// S5: a SEPARATE post-lane system (never a branch inside RenderSystem), so the render hot
// body stays byte-identical to S4. Measures the frame AFTER RenderSystem in the same tick.
class PerfSystem {
    constructor(perf) {
        this.perf = perf;
    }

    update(dt, time) {                             // [HOT]
        this.perf.sample(time);
    }
}

// S5: 1 Hz perf roll on the EXISTING top-level cron (no second timer / no stray setInterval).
// Rolls the p99 window + fps, then samples the heap (Chrome-only, coarse; null off-Chrome).
class PerfJob {
    constructor(perf) {
        this.perf = perf;
    }

    run() {
        this.perf.computeP99();
        const pm = typeof performance !== 'undefined' ? performance.memory : undefined;
        this.perf.heapMB = (pm && typeof pm.usedJSHeapSize === 'number') ? pm.usedJSHeapSize / 1048576 : null;
    }
}

// S5 burst stress: a [HOT] pre-lane system, DISABLED by default (ticker.enable('burst',
// false) -> not called at all, so there is no dead branch in any hot body). When enabled it
// injects burstN synthetic ticks per frame straight into the ACTIVE scope's dispatch seam
// (tape + vm + bus + traceBus + counters) via an integer-LCG walk on the last real mid.
// Zero allocation per synthetic tick: scope.inject mutates one reused scope-owned frame.
// Exported so the S9 gate can execute update() headlessly against the REAL parked active
// holder (the ticker does not expose its resolved system instances).
export class BurstSystem {
    constructor(viz) {
        this.viz = viz;
        this.seed = 0x9e3779b1 | 0;                // LCG state (integer)
    }

    update() {                                     // [HOT] (only while enabled)
        const v = this.viz;
        const a = v.active;
        if (!a) return;
        const inject = a.inject;
        if (!inject) return;
        const g = a.feedGate;                      // S9: the active symbol is parkable (releaseReactive keeps it active);
        if (g && !g.live) return;                  // a PARKED vm throws on a.vm.mid -- gate off, same idiom as AggApply
        const n = v.burstN;
        const base = a.vm.mid;                     // last real mid (derived), read ONCE outside the loop
        let s = this.seed;
        for (let i = 0; i < n; i++) {
            s = (Math.imul(s, 1664525) + 1013904223) | 0;   // integer LCG walk
            const step = (((s >>> 16) & 0xff) - 128) * 0.05;
            const mid = base + step;
            inject(mid, mid - 0.5, mid + 0.5);
        }
        this.seed = s;
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
    // cumulative-depth curve BEHIND the bars: one filled sweep per side, scaled by maxCum.
    const cmax = book.maxCum || 1, nb = book.n;
    ctx.fillStyle = CURVE_BID;
    ctx.beginPath();
    ctx.moveTo(ladderX, midY);
    for (let i = 0; i < nb; i++) {
        ctx.lineTo(ladderX + (book.bidCum[i] / cmax) * ladderW, midY + i * rowH + rowH / 2);
    }
    ctx.lineTo(ladderX, midY + nb * rowH);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = CURVE_ASK;
    ctx.beginPath();
    ctx.moveTo(ladderX, midY);
    for (let i = 0; i < nb; i++) {
        ctx.lineTo(ladderX + (book.askCum[i] / cmax) * ladderW, midY - (i + 1) * rowH + rowH / 2);
    }
    ctx.lineTo(ladderX, midY - nb * rowH);
    ctx.closePath();
    ctx.fill();
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
    constructor(cap) {
        this.mode = 'gl';
        // Primary trace = a LINE polyline (cap-1 segments). this.pts survives ONLY as the
        // fail-closed point-cloud fallback (trace + trades) when the line sink is absent.
        this.line = new Float32Array((cap - 1) * LINE_STRIDE);
        this.tradePts = new Float32Array(TRADE_RING * 8);   // trade dots (second point draw)
        this.pts = new Float32Array((cap + TRADE_RING) * 8);
        this.quads = new Float32Array((MAXLVL * 2 + DEPTH_QUADS) * 9);
        // Trace size + palette as instance fields, read (never allocated) in the hot
        // body -- so a rebind() to GLRendererV2 swaps the visible build in one frame.
        this.ptSize = 3.5;
        this.tpSize = 5;
        this.lineW = 2;
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

        // -- cumulative depth curve (behind) + depth ladder bars (on top): ONE buffer, ONE draw --
        const qsink = v.glQuadSink;
        if (qsink) {
            qsink.resize(w, h);
            const q = this.quads, ladderX = plotW + 24 * dpr, ladderW = w - ladderX - 16 * dpr,
                midY = h / 2, rowH = (h * 0.9) / (MAXLVL * 2), barH = rowH - 2 * dpr,
                scale = ladderW / (book.maxSz || 1), cmax = book.maxCum || 1, nb = book.n;
            let k = 0;
            // depth curve FIRST (earlier instances draw behind): one translucent quad per side.
            for (let i = 0; i < nb; i++) {
                const acw = (book.askCum[i] / cmax) * ladderW, acy = midY - (i + 1) * rowH;
                q[k++] = ladderX + acw / 2;
                q[k++] = acy + rowH / 2;
                q[k++] = acw;
                q[k++] = barH;
                q[k++] = 0;
                q[k++] = DEPTH_ASK_R;
                q[k++] = DEPTH_ASK_G;
                q[k++] = DEPTH_ASK_B;
                q[k++] = DEPTH_A;                  // ask cumulative (faint amber)
                const bcw = (book.bidCum[i] / cmax) * ladderW, bcy = midY + i * rowH;
                q[k++] = ladderX + bcw / 2;
                q[k++] = bcy + rowH / 2;
                q[k++] = bcw;
                q[k++] = barH;
                q[k++] = 0;
                q[k++] = DEPTH_BID_R;
                q[k++] = DEPTH_BID_G;
                q[k++] = DEPTH_BID_B;
                q[k++] = DEPTH_A;                  // bid cumulative (faint teal)
            }
            // ladder bars ON TOP.
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
            const count = nb * 4;                  // nb*2 depth quads + nb*2 bar quads
            qsink.upload(q, 0, count * 9, 0, 9);
            qsink.draw(count);
        }

        // -- price trace as a thick LINE polyline (primary) + trade dots as GL_POINTS --
        // A missing line sink (fail-closed degrade flag v.glLineSink === null) falls back to
        // the original single point cloud (trace + trades), so the GPU path never throws.
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
            const span = (hi - lo) || 1, cr = this.cr, cg = this.cg, cb = this.cb,
                usableH = h - 24 * dpr, botPad = 12 * dpr, denom = (n - 1 || 1),
                nt = v.nTrades, tp = v.tradePx, ts = v.tradeSide,
                tpSize = this.tpSize * dpr, denomT = (nt - 1) || 1, lineSink = v.glLineSink;
            // S4 Phase B timer (temporary, flag-gated): S2 = the interleaved vertex build.
            const mm = v.measure, mt0 = mm ? performance.now() : 0;
            if (lineSink) {
                // S2a: line segments (i -> segment i-1); carry the previous point, no re-map.
                const L = this.line, lw = this.lineW * dpr;
                let px = 0, py = h - ((scratch[0] - lo) / span) * usableH - botPad;
                for (let i = 1; i < n; i++) {
                    const cx = (i / denom) * plotW;
                    const cy = h - ((scratch[i] - lo) / span) * usableH - botPad;
                    const b = (i - 1) * 9;
                    L[b] = px;
                    L[b + 1] = py;
                    L[b + 2] = cx;
                    L[b + 3] = cy;
                    L[b + 4] = lw;
                    L[b + 5] = cr;
                    L[b + 6] = cg;
                    L[b + 7] = cb;
                    L[b + 8] = 1.0;
                    px = cx;
                    py = cy;
                }
                // S2b: trade dots into the dedicated trade-point buffer.
                const d = this.tradePts;
                for (let i = 0; i < nt; i++) {
                    const b = i * 8, buy = ts[i] > 0;
                    d[b] = (i / denomT) * plotW;
                    d[b + 1] = h - ((tp[i] - lo) / span) * usableH - botPad;
                    d[b + 2] = tpSize;
                    d[b + 3] = buy ? BUY_R : SELL_R;
                    d[b + 4] = buy ? BUY_G : SELL_G;
                    d[b + 5] = buy ? BUY_B : SELL_B;
                    d[b + 6] = 1.0;
                    d[b + 7] = 0;
                }
                if (mm) v.mS2[v.mHead] = performance.now() - mt0;
                // S3 = upload + draw: LINE (trace) then POINTS (trades) -- 2 of the 3 GL draws.
                const mt1 = mm ? performance.now() : 0;
                const segs = n - 1;
                if (segs > 0) {
                    lineSink.upload(L, 0, segs * 9, 0, 9);
                    lineSink.draw(segs);
                }
                sink.upload(d, 0, nt * 8, 0, 8);
                sink.draw(nt);
                if (mm) v.mS3[v.mHead] = performance.now() - mt1;
            } else {
                // fail-closed fallback: no line sink -> the original point cloud (trace + trades).
                const d = this.pts, ptSize = this.ptSize * dpr, base = n * 8;
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
                for (let i = 0; i < nt; i++) {
                    const b = base + i * 8, buy = ts[i] > 0;
                    d[b] = (i / denomT) * plotW;
                    d[b + 1] = h - ((tp[i] - lo) / span) * usableH - botPad;
                    d[b + 2] = tpSize;
                    d[b + 3] = buy ? BUY_R : SELL_R;
                    d[b + 4] = buy ? BUY_G : SELL_G;
                    d[b + 5] = buy ? BUY_B : SELL_B;
                    d[b + 6] = 1.0;
                    d[b + 7] = 0;
                }
                if (mm) v.mS2[v.mHead] = performance.now() - mt0;
                const mt1 = mm ? performance.now() : 0;
                sink.upload(d, 0, (n + nt) * 8, 0, 8);
                sink.draw(n + nt);
                if (mm) v.mS3[v.mHead] = performance.now() - mt1;
            }
        }
    }
}

// Rebind target (GAP-3): a post-boot renderer HOT-SWAP proof. Same GL geometry, a
// louder build -- bigger ember trace points -- so `rebind('renderer:gpu', v2)` is
// visible in the very next frame (requires zoom >= 2.2 to select the gpu strategy).
// A VALUE (no GL resources of its own; it draws through the shared parent sink), so
// the un-torn-down old instance is harmless (owner risk 6).
class GLRendererV2 extends GLRenderer {
    constructor(cap) {
        super(cap);
        this.ptSize = 6;
        this.tpSize = 8;
        this.lineW = 4;
        this.cr = 0.96;
        this.cg = 0.65;
        this.cb = 0.14;
    }
}

// ticker system [HOT]: pulls the ACTIVE scope's socket once per frame, then selects +
// draws. deps ['viz'] ONLY -- the per-symbol book/tape/vm/feed live behind the single
// pre-allocated `viz.active` holder, mutated on tab switch (cold). No c.get, no literal,
// no closure in this body; a background symbol's ingest is pumped by its own PollJob.
// S4 Phase B (temporary, S5 hands these to the perf panel): compute p50/p99 over the
// filled samples of one 600-slot stage ring and print at 1 Hz. NOT a hot path -- called
// once per ~60 frames; the subarray view + toFixed are fine at that cadence.
function reportStage(label, ring, count, sortBuf) {
    if (count === 0) return;
    for (let i = 0; i < count; i++) sortBuf[i] = ring[i];
    const view = sortBuf.subarray(0, count);
    view.sort();
    const p50 = view[(count * 0.5) | 0], p99 = view[(count * 0.99) | 0];
    console.log('measure ' + label + ' p50=' + p50.toFixed(3) + 'ms p99=' + p99.toFixed(3) + 'ms n=' + count);
}

class RenderSystem {
    constructor(viz) {
        this.viz = viz;
    }

    update() {
        const v = this.viz;
        if (!v.router || !v.ctx) return;
        const a = v.active;
        if (!a) return;                                     // no live symbol -> idle
        const vm = a.vm;                                    // consume the effect's per-quote dirty marker
        if (vm && vm.frameDirty) vm.frameDirty = false;     // (A5): draw stays UNCONDITIONAL below -- never a render gate
        a.feedPoll();                                       // active scope: wake its socket
        const n = a.tape.count;
        // S4 Phase B timer (temporary, flag-gated by v.measure; off = only these bytes).
        const mm = v.measure, mt0 = mm ? performance.now() : 0;
        a.tape.copyTo(v.scratch, 0);                        // ring -> scratch (oldest-first) = S1
        if (mm) v.mS1[v.mHead] = performance.now() - mt0;
        const nt = a.tradePx.count;
        a.tradePx.copyTo(v.tradePx, 0);                     // scalar rings -> preallocated views
        a.tradeSide.copyTo(v.tradeSide, 0);
        v.nTrades = nt;
        const r = v.router.resolve(v.zoom);                 // lite-di-strategies selects the renderer
        if (v.setMode) v.setMode(r.mode);                   // toggle 2d <-> gl canvas
        r.draw(v, a.book, v.scratch, n);                    // GLRenderer.draw writes S2/S3 at v.mHead
        if (mm) {
            let h = v.mHead + 1;
            if (h >= 600) h = 0;                            // 600 is not pow2 -> compare, not mask
            v.mHead = h;
            if (v.mCount < 600) v.mCount++;
            if (++v.mFrame >= 60) {                         // ~1 Hz report (frame-counter throttle)
                v.mFrame = 0;
                reportStage('S1-copy', v.mS1, v.mCount, v.mSort);
                reportStage('S2-build', v.mS2, v.mCount, v.mSort);
                reportStage('S3-upload', v.mS3, v.mCount, v.mSort);
            }
        }
    }
}

// Per-symbol child scope (finding 7). Each symbol owns feed / book / tape / vm +
// its OWN lite-di-signal registry, its OWN object bus + numeric trace recorder, and
// its OWN supervisor/health so killing one feed faults ONE scope. The registry is
// created via createSignalScope (eager -> _resolutionOrder[0]) so it tears down LAST.
// Cold factory: everything here runs once, at tab open, never per frame.
function createSymbolScope(parent, {symbol, url, log, faulty, ringSize, socketFactory}) {
    const s = createSignalScope(parent, SCOPE_REGISTRY_CONFIG);   // registry pinned first (eager+throw), torn down last
    const scopeReg = s.get(SIGNAL_REGISTRY_TOKEN);

    // Per-scope rate aggregate: ONE scoped signal, deliberately OUTSIDE the VM's 10 nodes
    // (tps is not a quote field). A raw registry signal (not a container binding) -- torn
    // down by registry.destroy with the rest. Written by ratectl.sample, read by state().
    const tpsSig = scopeReg.signal(0);

    // OBSERVED teardown order (not a constant): each real disposable's onTeardown appends
    // its name here AS THE CONTAINER FIRES IT, so the narrated walk reflects the true
    // reverse-topological order. Reorder the resolves and this array reorders with them --
    // that is what makes the S6 teardown gate able to go RED (a hardcoded order cannot).
    const teardownWalk = [];

    // tape / book / vm / trade rings are singleton(Factory) -- NEVER value: a VALUE
    // returns before the isCached block (Container.js:237) so it is never in the
    // resolution order and never torn down or counted. Anything that must appear in
    // the teardown walk is a singleton.
    s.value('symbol', symbol);
    s.singletonFactory('tape', () => new RingBuffer(ringSize));
    s.singleton('book', OrderBook);
    // The reactive VM, built on the scope's OWN registry (api.registry, NEVER the parent).
    // reactiveService auto-wires onTeardown('vm', svc => svc.dispose()) because the base
    // class exposes dispose() -- so vm.dispose() runs during the reverse walk, while the
    // registry (resolution index 0) is still live, and registry.destroy() drains last.
    reactiveService(s, 'vm', (api) => new (makeSymbolVM(api.registry))());
    s.singletonFactory('trades:px', () => new RingBuffer(TRADE_RING));
    s.singletonFactory('trades:side', () => new RingBuffer(TRADE_RING));

    const replayCtl = {on: false};                           // per-scope replay gate
    s.value('replayCtl', replayCtl);

    // S9 park gate (di-ticker public-mutable-field idiom). live=true while the VM is reactive;
    // the watchlist flips it false on park (after releaseReactive) and true on revive (after
    // reinitReactive). AggApply and state() read it O(1), zero-alloc, on the hot path so a
    // parked VM is never written or read (both throw ReactiveDisposedError). The scope, its
    // socket, and its registry all survive a park -- only the reactive writes are gated off.
    const feedGate = {live: true};
    s.value('feedGate', feedGate);

    // Object bus (unrecorded) + numeric trace recorder. Registered as singletons so
    // their onTeardown -> dispose() actually fires (risk 4): a VALUE would leak the
    // recorder ring across the 50x churn gate (G2).
    const bus = new EventBus(s);
    bus.on('tick', TapeApply, ['tape']).on('tick', AggApply, ['vm', 'feedGate'])
        .on('trade', TradeApply, ['trades:px', 'trades:side']);
    s.singletonFactory('bus', () => bus);
    s.onTeardown('bus', (b) => {
        teardownWalk.push('bus');
        try {
            b.dispose();
        } catch {
        }
    });

    const traceBus = new EventBus(s);
    traceBus.on('mid', MidReplay, ['tape', 'replayCtl']);
    s.singletonFactory('traceBus', () => traceBus);
    s.onTeardown('traceBus', (b) => {
        teardownWalk.push('traceBus');
        try {
            b.dispose();
        } catch {
        }
    });

    // per-scope feed lifecycle + counters (all scope-local, no module globals)
    let feedUrl = url, sock = null;
    let quoteCount = 0, depthCount = 0, tradeCount = 0, qps = 0, trps = 0, lastQ = 0, lastT = 0;
    let book = null, tape = null, vm = null, tradePx = null, tradeSide = null;
    let alertResetPending = false;                            // set on unpin, cleared on the reset-logging quote

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
        // After an unpin, the FIRST quote whose upstream actually moved swings the alert
        // local back to mid (upstream-keyed). Log that reset ONCE. If the quote's mid
        // returned to the last-adopted value (the ABA case), alert stays stale and this
        // stays pending -- honest, per the localTo contract. Gated: false in steady state.
        if (alertResetPending && feedGate.live && vm && vm.alert === vm.mid) {   // feedGate: parked vm getters throw
            alertResetPending = false;
            log('heal', 'localTo: upstream moved -> alert threshold reset to mid (upstream-keyed)');
        }
    };

    // S5 burst: ONE reused scope-owned scratch frame (S2's tagged-scratch rule). inject()
    // mutates it and calls the SAME dispatch() seam a real QUOTE tick takes, so tape / vm /
    // bus / traceBus / quoteCount all advance identically. Zero allocation per call.
    const burstFrame = {tag: TAG_QUOTE, bid: 0, ask: 0, mid: 0, t: 0};
    const inject = (mid, bid, ask) => {
        burstFrame.mid = mid;
        burstFrame.bid = bid;
        burstFrame.ask = ask;
        dispatch(burstFrame);
    };

    const {createSocket} = socketFactory(scopeReg);           // per-scope socket factory (injectable: tests pass a fake)
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
        teardownWalk.push('feed');
        sock = null;
        try {
            fd.dispose();
        } catch {
        }
    });

    // dev-only fault injection (?faultyTeardown): one scope binding throws on teardown;
    // container isolation (D-12) still fires the siblings and routes the error. It still
    // records itself in the observed walk (before throwing) so the narration is honest.
    if (faulty) s.onTeardown('book', () => {
        teardownWalk.push('book');
        throw new Error('injected teardown fault (?faultyTeardown)');
    });

    // Registry narration: createSignalScope already wired onTeardown(TOKEN, reg => reg.destroy())
    // at scope creation. A SECOND onTeardown on the SAME token would CLOBBER it -- the container's
    // _teardowns is a Map (last write wins, Container.js), so the destroy would silently never run
    // and the registry would leak (narrated "destroyed" while still live). So narrate by WRAPPING
    // the registry's own destroy: the wrap pushes 'signal-registry' then runs the real destroy,
    // both firing at the registry's teardown position (LAST, reverse of its index-0 resolve).
    const realRegDestroy = scopeReg.destroy.bind(scopeReg);
    scopeReg.destroy = () => {
        teardownWalk.push('signal-registry');
        return realRegDestroy();
    };

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
            tpsSig.set(qps);
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
    // feed -> vm -> tape -> book -> signal-registry (registry is index 0). Resolving 'vm'
    // AFTER the registry guarantees vm.dispose() fires before registry.destroy() (task 5).
    book = s.get('book');
    tape = s.get('tape');
    vm = s.get('vm');
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
        symbol, scope: s, registry: scopeReg, feedGate, nodeCount,   // registry + feedGate: S9 watchlist park/revive seams
        book, tape, vm, tradePx, tradeSide, feedPoll, inject,
        sup,                                             // test seam (S6): heal.test.mjs reaches the per-scope supervisor to reportFault
        async start() {
            await sup.start();                               // resolves 'feed' -> opens the socket
            refreshFeed();
            traceBus.record(RECORD_FRAMES, {onOverflow: 'drop-oldest'});   // decoupled from tape size (task 3)
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
            // A PARKED VM (watchlist remove) throws on every getter. If this symbol is parked
            // while still the active tab, read ZERO for the reactive fields -- gate on the flag,
            // never try/catch a throw into a value. The socket/health fields below are unaffected.
            const gLive = feedGate.live;
            return {
                mid: gLive ? vm.mid : 0, bid: gLive ? vm.bid : 0, ask: gLive ? vm.ask : 0,
                spread: gLive ? vm.spread : 0, qps: tpsSig(), trps,
                alert: gLive ? vm.alert : 0, pinned: gLive ? vm.pinned : false,
                levels: book ? book.n : 0, syntheticLadder: book ? book.synthetic : true,
                readyz: health.readyz(), livez: health.livez(), supState: sup.state, restarts,
                recorded: traceBus.recorded(), status, latency, attempts, open,
                ticks: quoteCount + depthCount + tradeCount,
            };
        },
        // Alert threshold pin/unpin (cold, one click per intent). Pin freezes the tracked
        // upstream to the constant pinAnchor so the local override survives every mid move;
        // unpin swings upstream back to mid -> the next moved quote resets (dispatch logs it).
        pinAlert() {
            vm.pinAnchor = vm.mid;
            vm.pinned = true;
            vm.alert = vm.mid;
            alertResetPending = false;
        },
        unpinAlert() {
            vm.pinned = false;
            alertResetPending = true;
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
            teardownWalk.length = 0;                          // drop any 'feed' entries pushed by prior heals; s.shutdown() re-fires every hook fresh

            const regNodes = scopeReg.stats().activeNodes;   // read the live count BEFORE destroy
            // Capture which bindings actually threw so the closed-line reflects the real
            // outcome (?faultyTeardown makes 'book' throw); still route each error outward.
            const failed = [];
            const onTeardownError = (err, name) => {
                failed.push(String(name));
                if (outerOnTeardownError) outerOnTeardownError(err, name);
            };
            await s.shutdown({onTeardownError});             // reverse-topological, registry last
            // Build the narration from the OBSERVED fire order (teardownWalk), not a
            // constant: it reflects exactly what the container tore down, in order.
            let walk = '';
            for (let i = 0; i < teardownWalk.length; i++) {
                const step = teardownWalk[i];
                walk += (i ? ' -> ' : '') + step + (failed.indexOf(step) !== -1 ? ' (failed)' : '');
            }
            log('down', 'scope: ' + symbol + ' closed -- teardown: ' + walk);
            // One coherent teardown line for the reactive plane (task 12): the SymbolVM's
            // node count (proven at boot) plus the scoped registry's live count before
            // destroy. Merged with the registry line -- never double-narrated.
            log('down', 'teardown[' + symbol + ']: SymbolVM disposed (' + VM_COST.nodes
                + ' nodes) + scoped registry destroyed (' + regNodes + ' reactive nodes released) -- scope gone');
        },
    };
}

// pure DI applied to the DI demo: the two host imports (the ws socket factory and the
// lite-gl sink factories) are injectable so bootKernel runs headless under node:test.
export async function bootKernel({ctx, gl, w, h, dpr, onEvent, onMode, ringSize, socketFactory = createSocketFactory, glSinks = defaultGlSinks}) {
    const bootAt = performance.now();                        // S5 uptime origin (re-captured on re-boot)
    const log = (kind, msg) => onEvent && onEvent(kind, msg);

    // S9 T2 -- capability assert (cold, boot): the pooled watchlist needs four
    // lite-signal-decorators functions an OLD esm.sh build (pre-1.5.0) would lack. Fail
    // closed HERE, before wiring the watchlist, with a NAMED error -- index.html's boot
    // catch surfaces e.stack in the #err block. null is not a function.
    if (typeof releaseReactive !== 'function' || typeof reinitReactive !== 'function'
        || typeof costOfInstance !== 'function' || typeof snapshotOf !== 'function') {
        throw new TypeError('bootKernel: @zakkster/lite-signal-decorators is missing the park/revive '
            + 'surface (releaseReactive/reinitReactive/costOfInstance/snapshotOf) -- pin >= 1.5.0 in the import map');
    }
    // ?faultyTeardown read ONCE, cold, at boot (never on the hot path).
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const faulty = !!(params && params.has('faultyTeardown'));

    // Ring size, resolved ONCE at boot: explicit {ringSize} option wins; else the
    // ?ring=N URL override (the measurement hook -- boot at ?ring=65536); else pickRing()
    // by device class. clampRing keeps every source a pow2 in [RING_MIN, RING_MAX].
    let ring = ringSize;
    if (ring === undefined && params && params.has('ring')) {
        const r = parseInt(params.get('ring'), 10);
        if (Number.isFinite(r) && r > 0) ring = r;
    }
    ring = clampRing(ring === undefined ? pickRing() : ring);
    if (ring < RING_MAX) {
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        const memD = nav && typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 'unknown';
        log('degrade', 'degrade: ring ' + RING_MAX + ' -> ' + ring + ' (deviceMemory=' + memD + ')');
    }

    const viz = {
        ctx, w, h, dpr: dpr || 1, zoom: 1, router: null, active: null, scratch: new Float32Array(ring),
        tradePx: new Float32Array(TRADE_RING), tradeSide: new Float32Array(TRADE_RING), nTrades: 0,
        glSink: null, glQuadSink: null, glLineSink: null, setMode: onMode || null,
        // S4 Phase B: flag-gated three-stage timer state (preallocated; see reportStage).
        measure: false, mHead: 0, mCount: 0, mFrame: 0,
        mS1: new Float64Array(600), mS2: new Float64Array(600), mS3: new Float64Array(600),
        mSort: new Float64Array(600),
        // S5 burst control (read by BurstSystem in the pre lane; set by handle.burst).
        burstN: 0, burstActive: false,
    };
    // GL sink factories are loaded COLD, and ONLY when a real canvas is present. Headless
    // (ctx: null || gl: null) skips both the import and construction -- viz.glSink/glQuadSink/
    // glLineSink stay null and RenderSystem.update() already returns on !v.ctx, so headless
    // render is a no-op with NO new branch or flag in the hot body.
    const glb = (gl && ctx) ? await glSinks() : null;
    try {                                                                        // lite-gl WebGL2 sinks (shared, risk 5)
        if (glb) {
            viz.glSink = glb.createPointSink(gl, {capacity: ring + TRADE_RING});
            viz.glQuadSink = glb.createQuadSink(gl, {capacity: MAXLVL * 2 + DEPTH_QUADS});
        }
    } catch (e) {
        log('down', 'WebGL2 unavailable -- GPU renderer disabled');
    }
    // The LINE sink is a SEPARATE fail-closed stage (Path A: full ring, ring-1 segments).
    // If it fails while the point sink lives, GLRenderer.draw sees v.glLineSink === null and
    // degrades the trace to the point cloud -- it must degrade, never throw.
    try {
        if (glb && viz.glSink) viz.glLineSink = glb.createLineSink(gl, {capacity: ring - 1});
    } catch (e) {
        viz.glLineSink = null;
        log('down', 'lite-gl LINE sink unavailable -- price trace degraded to point cloud');
    }

    // The single pre-allocated active-symbol holder. Mutated on tab switch (cold);
    // read by RenderSystem.update() every frame, never re-allocated.
    const activeHolder = {book: null, tape: null, vm: null, feedPoll: null, tradePx: null, tradeSide: null, inject: null, feedGate: null};

    const c = new Container();
    c.value('viz', viz);
    // S5 perf counters live in the container as a VALUE (same rule that put stats in S3), so a
    // second bootKernel gets its own counters. lastTime seeded to bootAt -> honest first frame.
    const perf = new PerfCounters();
    perf.bootAt = bootAt;
    perf.lastTime = bootAt;
    c.value('perf', perf);
    const stats = {pruned: 0, aggregations: 0, heartbeats: 0};   // finding 12: counters IN the container
    c.value('stats', stats);
    c.value('renderer:coarse', new CoarseRenderer());
    c.value('renderer:detailed', new DetailedRenderer());
    c.value('renderer:gpu', new GLRenderer(ring));              // rebind target -- a VALUE (risk 6)

    const ticker = new Ticker(c);
    ticker.system('render', RenderSystem, {lane: 'normal', deps: ['viz']});      // deps: viz ONLY (hot)
    ticker.system('perf', PerfSystem, {lane: 'post', deps: ['perf']});           // S5: measures AFTER render
    ticker.system('burst', BurstSystem, {lane: 'pre', deps: ['viz']});           // S5: stress injector...
    ticker.enable('burst', false);                                               // ...disabled by default

    const cron = new Cron(c, {tickMs: 1000});
    cron.job('aggregate', AggregateJob, interval(5000), {deps: ['stats']})
        .job('prune', PruneJob, interval(3000), {deps: ['stats']})
        .job('heartbeat', HeartbeatJob, interval(2000), {deps: ['stats']})
        .job('perf', PerfJob, interval(1000), {deps: ['perf']});                 // S5: 1 Hz p99 + heap roll

    // shutdown bookkeeping + parent teardown narration (task 12: the walk narrates itself).
    let teardownFailed = 0, teardownTotal = 0;
    const onTeardownError = (err, name) => {
        teardownFailed++;
        log('escalate', 'teardown-error: ' + String(name) + ' -- ' + err.message);
    };
    for (const id of ['aggregate', 'prune', 'heartbeat', 'perf']) {
        c.onTeardown('cron:job:' + id, () => {
            teardownTotal++;
            log('down', 'teardown: cron:' + id);
        });
    }

    c.boot();
    ticker.start();
    cron.start();

    // S5 long-task observer (cold). Feature-detect EXACTLY: a PerformanceObserver whose
    // supportedEntryTypes lists 'longtask'. Only then does longTasks leave -1; unsupported
    // STAYS -1 (=> HUD "n/a"). null is not zero. The callback fires only when a long task
    // exists -- cold by construction. Disconnected on shutdown (it would outlive the container).
    let longTaskObs = null;
    if (typeof PerformanceObserver === 'function'
        && Array.isArray(PerformanceObserver.supportedEntryTypes)
        && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        perf.longTasks = 0;
        try {
            longTaskObs = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                for (let i = 0; i < entries.length; i++) {
                    perf.longTasks++;
                    const d = entries[i].duration;
                    if (d > perf.longWorst) perf.longWorst = d;
                }
            });
            longTaskObs.observe({entryTypes: ['longtask']});
        } catch (e) {
            longTaskObs = null;
            perf.longTasks = -1;
        }
    }

    const scopes = new Map();
    let activeSymbol = null, nodeCount = 0, gpuV2 = false, shuttingDown = false;
    let burstTimer = 0;                                      // S5: the single cold burst-end timer (cleared on re-burst + shutdown)

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
            activeHolder.vm = null;
            activeHolder.feedPoll = null;
            activeHolder.tradePx = null;
            activeHolder.tradeSide = null;
            activeHolder.inject = null;
            activeHolder.feedGate = null;
            return;
        }
        activeSymbol = sym;
        activeHolder.book = h.book;
        activeHolder.tape = h.tape;
        activeHolder.vm = h.vm;
        activeHolder.feedPoll = h.feedPoll;
        activeHolder.tradePx = h.tradePx;
        activeHolder.tradeSide = h.tradeSide;
        activeHolder.inject = h.inject;                      // S5: BurstSystem reaches it via viz.active
        activeHolder.feedGate = h.feedGate;                  // S9: BurstSystem gates on it (parked active symbol)
        viz.active = activeHolder;
    };

    // S9 T4 -- the pooled watchlist (park/revive over RETAINED scopes). Every OPEN symbol
    // gets a LIVE watchlist entry; parkSymbol()/reviveSymbol() flip its VM between parked and
    // live WITHOUT firing scope.shutdown(). `lastTicks` holds ONE preallocated record per
    // symbol -- the watchlist captures the last live values into it at park (no per-tick
    // alloc) and re-seeds the revive from it. handle._watchlist (the entries Map) is S10's
    // symbol -> {vm, scope, registry, live} label seam.
    const lastTicks = new Map();
    const lastTickOf = (sym) => {
        let rec = lastTicks.get(sym);
        if (!rec) {
            rec = {bid: 0, ask: 0, last: 0, pinned: false, pinAnchor: 0, alert: 0};   // preallocated per symbol
            lastTicks.set(sym, rec);
        }
        return rec;
    };
    const watchlist = createWatchlist({
        scopes,
        SymbolVMOf: (sym) => { const h = scopes.get(sym); return h ? h.vm : null; },
        lastTickOf,
        capacity: WATCHLIST_CAP,
    });

    const addSymbol = async (sym, u) => {
        if (scopes.has(sym)) {
            setActive(sym);
            return scopes.get(sym);
        }
        const h = createSymbolScope(c, {symbol: sym, url: u, log, faulty, ringSize: ring, socketFactory});
        await h.start();
        scopes.set(sym, h);
        // Register a LIVE watchlist entry over the freshly cold-constructed scope. Fail closed
        // on capacity (fail LOUD in the log) without breaking the scope that already opened.
        try {
            watchlist.add(sym);
        } catch (e) {
            log('down', 'watchlist: ' + (e && e.message ? e.message : String(e)));
        }
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
        watchlist.forget(sym);                               // drop the entry so a torn-down VM/registry is not retained (leak gate)
        lastTicks.delete(sym);
        recomputeNodes();
        if (activeSymbol === sym) setActive(scopes.size > 0 ? scopes.keys().next().value : null);
    };

    // rebind hot-swap (GAP-3): renderer:gpu is a VALUE; invalidate() is a no-op for a
    // value so the swap is instant and the router needs no reconfiguration.
    const swapRenderer = async () => {
        await c.rebind('renderer:gpu', {type: TYPES.VALUE, value: new GLRendererV2(ring), isAsync: false});
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
        // test seams. _scopes: S6 headless assertions reach a per-scope handle (and its
        // supervisor) through it. _c: the parent container, RESERVED for the S8/S9 gates
        // (plans/PLAN-S6.md:45); no S6 test consumes it yet.
        _c: c, _scopes: scopes,
        // S9 seams. _watchlist: the symbol -> {vm, scope, registry, live} entries Map (S10
        // label source). watchlist: the full park/revive API, for the T8 gate.
        _watchlist: watchlist.entries, watchlist, watchlistCap: WATCHLIST_CAP,
        // Park (releaseReactive) / revive (reinitReactive) the symbol's VM. The scope, its
        // registry, and its wrapper class survive -- scope.shutdown() is never fired here.
        parkSymbol(sym) { return watchlist.remove(sym); },
        reviveSymbol(sym) { return watchlist.add(sym); },
        exportWatchlist() { return watchlist.exportWatchlist(); },
        importWatchlist(json) { return watchlist.importWatchlist(json); },
        readWatchlist(rows) { return watchlist.readWatchlist(rows); },
        watchlistStats() { return watchlist.stats(); },
        readState() {
            const h = active();
            const base = {
                symbol: activeSymbol, symbols: scopes.size, nodeCount, jobs: stats,
                gpuBuild: gpuV2 ? 'v2' : 'v1',
                mid: 0, bid: 0, ask: 0, spread: 0, qps: 0, trps: 0, levels: 0,
                alert: 0, pinned: false,
                syntheticLadder: true, readyz: 1, livez: 1, supState: 0, restarts: 0,
                recorded: 0, status: 'closed', latency: -1, attempts: 0, open: false, ticks: 0,
                // S5 perf (global, not per-scope): p99/worst/fps/long-tasks/heap/uptime/burst.
                fps: perf.fps, p99: perf.p99, worst: perf.worst,
                longTasks: perf.longTasks, longWorst: perf.longWorst,
                heapMB: perf.heapMB, uptimeMs: performance.now() - bootAt,
                ringUse: 0, burstActive: viz.burstActive,
            };
            if (!h) return base;
            const st = h.state();
            base.mid = st.mid;
            base.bid = st.bid;
            base.ask = st.ask;
            base.spread = st.spread;
            base.alert = st.alert;
            base.pinned = st.pinned;
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
            base.ringUse = (h.tape && h.tape.count) ? h.tape.count / ring : 0;   // S5: active-ring occupancy (guarded)
            return base;
        },
        setZoom(z) {
            viz.zoom = z;
        },
        // S4 Phase B measurement hook. From the console: `handle.measure(true)` (boot at
        // ?ring=65536 first) starts the three-stage timer; p50/p99 print to console at 1 Hz.
        measure(on) {
            viz.measure = !!on;
            viz.mHead = 0;
            viz.mCount = 0;
            viz.mFrame = 0;
        },
        ringSize: ring,
        // S5 burst stress. Enables the pre-lane BurstSystem for `ms`, pumping `n` synthetic
        // ticks per frame into the ACTIVE scope's real pipeline; logs the p99 before/after pair.
        burst(n = 100, ms = 10000) {
            viz.burstN = n | 0;
            viz.burstActive = true;
            ticker.enable('burst', true);
            const before = perf.p99;
            log('stress', 'stress: burst x' + (n | 0) + ' for ' + ((ms / 1000) | 0) + 's -- synthetic ticks, bypassing the socket');
            clearTimeout(burstTimer);                            // re-clicking within the window: no overlapping timers
            burstTimer = setTimeout(() => {
                if (shuttingDown) return;                        // a stale timer must not log into a reborn HUD
                ticker.enable('burst', false);
                viz.burstActive = false;
                log('stress', 'stress: burst ended -- p99 ' + before.toFixed(2) + 'ms -> ' + perf.p99.toFixed(2) + 'ms');
            }, ms);
        },
        // S5 graph export seam (S10 swaps only the formatter behind it). NOTE: this exports the
        // TOP-LEVEL kernel graph ONLY -- child symbol scopes are SEPARATE containers, so this
        // node count is parent-only, NOT readState().nodeCount (which sums parent + all scopes).
        // Use graphNodeCount() to assert against the RIGHT number. Fail closed: any formatter
        // throw logs 'down' and returns null (no half file).
        exportGraph(kind) {
            try {
                const snap = fromContainer(c);
                if (kind === 'json') return {name: 'market-map-graph.json', mime: 'application/json', text: toJSON(snap)};
                if (kind === 'dot') return {name: 'market-map-graph.dot', mime: 'text/vnd.graphviz', text: toDOT(snap)};
                if (kind === 'trace') return {name: 'market-map-graph.trace.json', mime: 'application/json', text: toChromeTrace(snap)};
                log('down', 'graph export failed: unknown kind ' + String(kind));
                return null;
            } catch (e) {
                log('down', 'graph export failed');
                return null;
            }
        },
        graphNodeCount() {
            try {
                return (fromContainer(c).nodes || []).length;
            } catch {
                return 0;
            }
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
        pinAlert() {
            const h = active();
            if (h) h.pinAlert();
        },
        unpinAlert() {
            const h = active();
            if (h) h.unpinAlert();
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
            clearTimeout(burstTimer);                            // S5: no stale burst-end timer survives shutdown
            log('down', 'shutdown: kernel draining -- children first');
            ticker.stop();
            cron.stop();
            if (longTaskObs) {                               // S5: the observer would outlive the container
                try {
                    longTaskObs.disconnect();
                } catch (e) {
                }
                longTaskObs = null;
            }
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
