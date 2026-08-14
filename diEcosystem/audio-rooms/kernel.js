// audio-rooms -- a SKELETON demo of the @zakkster/lite-di-* service kernel applied to
// spatial "audio rooms": scoped construction + fail-closed teardown of a real Web Audio
// graph (@zakkster/lite-audio). Everything runs in-browser via the import map.
//
// The corrected architecture (an external LLM proposed the INVERTED version; this is the
// honest one):
//   1. Room = container CHILD SCOPE. Leaving a room = roomScope.shutdown() -> reverse-topo
//      teardown. The parent refuses to shut down while a child scope is live.
//   2. Per-room audio = ONE LiteAudio engine per room scope, all sharing ONE AudioContext
//      created once in the ROOT scope and passed to each engine via init(sharedCtx).
//      onTeardown('engine', e => e.destroy()) -- destroy() disconnects every node but does
//      NOT close the shared ctx. There is NO destroyBus(); granularity is per-room ENGINE.
//   3. lite-di-signal holds ROOM-LEVEL aggregates ONLY (listener facing, reverb tag, live
//      emitter count). Per-voice [x,y,z] is NOT reactive -- it is the setPosition stamp.
//   4. The ticker system calls engine.setPosition(handle,x,y,z) every frame and NOTHING
//      param-related. Demo code never schedules an audio-param ramp and never touches a
//      spatial panner node -- that is lite-audio's SP-03 red control; the engine's own
//      ~10Hz monitor does the throttled param write.
//   5. Output mode (stereo/HRTF/discrete) is frozen at bus construction (container.rebind,
//      never strategies). strategies here SELECTS the VISUAL renderer only, 0 B/op.
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
import {LiteAudio} from '@zakkster/lite-audio';
import {createPointSink} from '@zakkster/lite-gl/backend';

const TAU = Math.PI * 2;
const MAXE = 8;                 // SEAM: size to your room's emitter budget
const RINGPTS = 64;             // range-ring sample count (GL renderer)
const GLCAP = MAXE + 1 + RINGPTS;
const ROOM_RANGE = 12;          // audible radius in room units (drawn as a ring)

// Modeled Web Audio node census. There is no browser API for a live-node count, so a
// skeleton MODELS it from engine state: a plain fail-closed estimate that returns to
// baseline (0) the instant an engine is torn down.
// SEAM: real census -- wrap the shared ctx's create* factories with a live counter that
// decrements on the disconnect the pool performs at voice steal / destroy.
const ENGINE_BASE_NODES = 6;    // master gain + default bus gains wired by init()
const VOICE_NODES = 3;          // per positional voice: source + panner + gain
function censusOf(engineLive, voices) {
    if (!engineLive) return 0;  // null is not zero -- but a torn-down engine IS zero nodes
    return ENGINE_BASE_NODES + voices * VOICE_NODES;
}

// ---- procedural assets: a short WAV encoded to a data: URI, no external files ----
// makeToneWav fills an Int16 mono PCM buffer + a 44-byte WAV header and base64s it.
// decodeAudioData decodes WAV, including from a data: URI. Cold path (called at asset build).
function writeStr(dv, off, s) {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
}

function makeToneWav(freq, ms, kind) {
    const sr = 22050;                          // modest rate -- these are cue blips
    const n = Math.max(1, (sr * ms / 1000) | 0);
    const bytes = 44 + n * 2;
    const buf = new Uint8Array(bytes);
    const dv = new DataView(buf.buffer);
    writeStr(dv, 0, 'RIFF');
    dv.setUint32(4, 36 + n * 2, true);
    writeStr(dv, 8, 'WAVE');
    writeStr(dv, 12, 'fmt ');
    dv.setUint32(16, 16, true);                // fmt chunk size
    dv.setUint16(20, 1, true);                 // PCM
    dv.setUint16(22, 1, true);                 // mono
    dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 2, true);            // byte rate
    dv.setUint16(32, 2, true);                 // block align
    dv.setUint16(34, 16, true);                // bits per sample
    writeStr(dv, 36, 'data');
    dv.setUint32(40, n * 2, true);
    const atk = sr * 0.005;
    for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env = Math.min(1, i / atk) * Math.max(0, 1 - i / n);
        let s;
        if (kind === 'square') s = Math.sin(TAU * freq * t) >= 0 ? 1 : -1;
        else if (kind === 'noise') s = Math.random() * 2 - 1;
        else s = Math.sin(TAU * freq * t);
        dv.setInt16(44 + i * 2, (s * env * 0.6 * 32767) | 0, true);
    }
    let bin = '';
    for (let i = 0; i < bytes; i++) bin += String.fromCharCode(buf[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
}

// Build the sound defs for a room from a small tone table. Each emitter gets its own id.
function buildSounds(freqs, kind) {
    const defs = {};
    for (let i = 0; i < freqs.length; i++) {
        defs['s' + i] = {src: [makeToneWav(freqs[i], 700, kind)], bus: 'world', volume: 0.9};
    }
    // one short "footstep" cue reused by the event-bus fan-out
    defs.footstep = {src: [makeToneWav(90, 120, 'noise')], bus: 'world', volume: 0.7};
    return defs;
}

// ---- room presets: reverb tag (label only) + emitter layout + tone character ----
// SEAM: real room geometry / occlusion / a measured reverb impulse per room.
const ROOMS = {
    A: {reverb: 'dry-lobby', kind: 'sine', range: 10, freqs: [330, 440, 550]},
    B: {reverb: 'stone-hall', kind: 'square', range: 14, freqs: [196, 262, 392, 523]},
    C: {reverb: 'open-yard', kind: 'noise', range: 16, freqs: [220, 277, 330, 415, 494]},
};

// ---- the world: ROOT-scoped, mutable, SoA. The render ticker reads it every frame; it
// SURVIVES a room switch so the viewport stays live, exactly like market-map's `viz`. Per-
// voice position is here as a zero-alloc stamp, NEVER a signal (correction 3). ----
function makeWorld(c2d, w, h) {
    return {
        c2d, w, h, view: 1.4, router: null, setMode: null,
        glSink: null,
        roomId: null, engine: null, count: 0, range: ROOM_RANGE, layout: 'stereo',
        reverb: '',                             // room reverb tag (read every frame in the footer)
        facing: 0,                              // listener heading (radians), game state
        hx: new Float64Array(MAXE),             // voice handle per emitter
        bx: new Float64Array(MAXE),             // orbit center x
        bz: new Float64Array(MAXE),             // orbit center z
        rad: new Float64Array(MAXE),            // orbit radius
        rate: new Float64Array(MAXE),           // orbit angular rate (rad/ms)
        phase: new Float64Array(MAXE),          // current orbit phase
        vol: new Float64Array(MAXE),            // emitter loudness (for draw size)
        px: new Float64Array(MAXE),             // current x (drawn + stamped)
        pz: new Float64Array(MAXE),             // current z
        label: new Array(MAXE),                 // static per-emitter label (precomputed)
        glPts: new Float32Array(GLCAP * 8),     // preallocated GL upload buffer
    };
}

// ---- room-level aggregates via lite-di-signal (a scoped registry wired into the child
// scope's teardown). A HANDFUL of reactive values -- NOT one signal per voice. ----
class RoomAggregates {
    constructor(rx) {
        this.facing = rx.signal(0);             // sampled ~10Hz, not per frame
        this.reverb = rx.signal('');
        this.emitters = rx.signal(0);
        this.housekeeps = rx.signal(0);
    }
}

// ---- event-bus listener: a footstep fans out to a re-trigger of every emitter (0 B/emit
// fan-out through the bus). It reads the cached engine ref off the world, never c.get(). ----
class FootstepRetrigger {
    constructor(world) {
        this.world = world;
    }

    handle() {
        const w = this.world, eng = w.engine;
        if (!eng) return;
        for (let i = 0; i < w.count; i++) {
            w.hx[i] = eng.play('s' + i, w.vol[i], 0, 1);   // fresh voice, same bus
        }
    }
}

// ---- cron job: DI-constructed wall-clock housekeeping (a rolling counter the HUD shows). ----
class HousekeepingJob {
    constructor(agg) {
        this.agg = agg;
    }

    run() {
        this.agg.housekeeps.set(this.agg.housekeeps.peek() + 1);
    }
}

// ---- renderers (lite-di-strategies selects one by `view`) ----
// Change-gated footer-line cache (market-map's cached-label discipline): rebuild the WHOLE
// composed string only when the quantized facing degree or the reverb tag moves; every other
// frame returns the cached line with NO concat. The whole line is gated -- not just the
// number -- so no `+` and no toFixed run in the per-frame render body.
class FooterLine {
    constructor() {
        this.qDeg = -2147483648;
        this.reverb = null;
        this.s = '';
    }

    get(reverb, facingRad) {
        const deg = ((facingRad * (360 / TAU)) | 0) % 360;   // wrap to 0-359, matches the HUD readout
        if (deg !== this.qDeg || reverb !== this.reverb) {
            this.qDeg = deg;
            this.reverb = reverb;
            this.s = reverb + ' / facing ' + deg + ' deg';
        }
        return this.s;
    }
}

const GRID = 'rgba(120,135,155,0.10)';
const RING = 'rgba(78,231,210,0.35)';
const LISTENER = '#4EE7D2';
const EMIT = 'rgba(245,166,35,0.85)';
const EMIT_IDLE = 'rgba(122,135,154,0.55)';

// Map room (x,z) -> screen. cx/cy center, scale from range + view zoom.
function drawRoom(w, labels) {
    const c = w.c2d, ww = w.w, hh = w.h;
    c.clearRect(0, 0, ww, hh);
    c.strokeStyle = GRID;
    c.lineWidth = 1;
    for (let x = 0; x <= ww; x += 48) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, hh);
        c.stroke();
    }
    for (let y = 0; y <= hh; y += 48) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(ww, y);
        c.stroke();
    }

    const cx = ww / 2, cy = hh / 2;
    const scale = (Math.min(ww, hh) / (2 * w.range)) * w.view;

    // audible range ring
    c.strokeStyle = RING;
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(cx, cy, w.range * scale, 0, TAU);
    c.stroke();

    // listener + facing cone
    const fx = Math.sin(w.facing), fz = -Math.cos(w.facing);
    c.strokeStyle = LISTENER;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + fx * 26, cy + fz * 26);
    c.stroke();
    c.fillStyle = LISTENER;
    c.shadowColor = LISTENER;
    c.shadowBlur = 10;
    c.beginPath();
    c.arc(cx, cy, 4.5, 0, TAU);
    c.fill();
    c.shadowBlur = 0;

    // emitters
    c.font = '10px ui-monospace, Menlo, monospace';
    for (let i = 0; i < w.count; i++) {
        const sx = cx + w.px[i] * scale, sy = cy + w.pz[i] * scale;
        const live = w.hx[i] >= 0;
        c.fillStyle = live ? EMIT : EMIT_IDLE;
        c.beginPath();
        c.arc(sx, sy, 3 + w.vol[i] * 4, 0, TAU);
        c.fill();
        if (labels) {
            c.fillStyle = 'rgba(200,210,225,0.75)';
            c.fillText(w.label[i], sx + 7, sy + 3);
        }
    }

    if (labels) {
        c.fillStyle = 'rgba(200,210,225,0.6)';
        c.fillText(labels.footer.get(w.reverb, w.facing), 12, hh - 12);
    }
}

class CoarseRenderer {
    constructor() {
        this.mode = '2d';
    }

    draw(w) {
        drawRoom(w, null);
    }
}

class DetailedRenderer {
    constructor() {
        this.mode = '2d';
        this.labels = {footer: new FooterLine()};
    }

    draw(w) {
        drawRoom(w, this.labels);
    }
}

// lite-gl GPU renderer: emitters + listener + a sampled range ring as an instanced
// GL_POINTS cloud (stride 8: x,y,size, r,g,b,a, extra). The path that scales to ~1M
// primitives; here the room is tiny but composes the identical sink. Screen px, top-left.
class GLRenderer {
    constructor() {
        this.mode = 'gl';
    }

    draw(w) {
        const sink = w.glSink;
        if (!sink) return;
        const gl = sink.gl, ww = w.w, hh = w.h;
        sink.resize(ww, hh);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        const cx = ww / 2, cy = hh / 2;
        const scale = (Math.min(ww, hh) / (2 * w.range)) * w.view;
        const d = w.glPts;
        let k = 0;
        // range ring
        for (let i = 0; i < RINGPTS; i++) {
            const a = (i / RINGPTS) * TAU;
            const b = k * 8;
            d[b] = cx + Math.cos(a) * w.range * scale;
            d[b + 1] = cy + Math.sin(a) * w.range * scale;
            d[b + 2] = 1.5;
            d[b + 3] = 0.306;
            d[b + 4] = 0.906;
            d[b + 5] = 0.82;
            d[b + 6] = 0.4;
            d[b + 7] = 0;
            k++;
        }
        // listener
        let b = k * 8;
        d[b] = cx;
        d[b + 1] = cy;
        d[b + 2] = 7;
        d[b + 3] = 0.306;
        d[b + 4] = 0.906;
        d[b + 5] = 0.82;
        d[b + 6] = 1.0;
        d[b + 7] = 0;
        k++;
        // emitters
        for (let i = 0; i < w.count; i++) {
            b = k * 8;
            d[b] = cx + w.px[i] * scale;
            d[b + 1] = cy + w.pz[i] * scale;
            d[b + 2] = 5 + w.vol[i] * 6;
            d[b + 3] = 0.96;
            d[b + 4] = 0.65;
            d[b + 5] = 0.14;
            d[b + 6] = w.hx[i] >= 0 ? 0.95 : 0.4;
            d[b + 7] = 0;
            k++;
        }
        sink.upload(d, 0, k * 8, 0, 8);
        sink.draw(k);
    }
}

// ---- the ticker system: cached world + cached 2D context (world.c2d), stamps setPosition
// every frame and NOTHING param-related, then selects + draws. NO c.get / getElementById /
// toFixed in this hot body (correction 4 + the demo audit). ----
class RenderSystem {
    constructor(world) {
        this.world = world;
    }

    update(dt) {
        const w = this.world;
        if (!w.router) return;
        const eng = w.engine;
        const n = w.count;
        w.facing += 0.0004 * dt;                       // listener slowly turns (game state)
        for (let i = 0; i < n; i++) {
            w.phase[i] += w.rate[i] * dt;
            const x = w.bx[i] + Math.cos(w.phase[i]) * w.rad[i];
            const z = w.bz[i] + Math.sin(w.phase[i]) * w.rad[i];
            w.px[i] = x;
            w.pz[i] = z;
            if (eng) eng.setPosition(w.hx[i], x, 0, z);   // the stamp -- zero alloc, no ramp
        }
        const r = w.router.resolve(w.view);               // lite-di-strategies selects renderer
        if (w.setMode) w.setMode(r.mode);
        r.draw(w);
    }
}

// ===========================================================================
//  bootKernel -- ROOT scope: shared ctx, assets cache, the render ticker.
// ===========================================================================
export async function bootKernel({ctx, c2d, gl, w, h, onEvent, onMode}) {
    const log = (kind, msg) => onEvent && onEvent(kind, msg);
    const world = makeWorld(c2d, w, h);
    world.setMode = onMode || null;             // toggle 2d <-> gl canvas (strategies swap)

    try {
        if (gl) world.glSink = createPointSink(gl, {capacity: GLCAP});
    } catch (e) {
        log('down', 'WebGL2 unavailable -- GPU renderer disabled');
    }

    // ROOT container: the shared AudioContext, the mutable world, the visual renderers.
    const root = new Container();
    root.value('ctx', ctx);                            // ONE shared AudioContext (correction 2)
    root.value('world', world);
    root.value('renderer:coarse', new CoarseRenderer());
    root.value('renderer:detailed', new DetailedRenderer());
    root.value('renderer:gpu', new GLRenderer());

    // Root-level render ticker: it drives repaint across room switches so the viewport
    // stays LIVE while a room scope is entered, healed, or torn down.
    const ticker = new Ticker(root);
    ticker.system('render', RenderSystem, {lane: 'normal', deps: ['world']});

    root.boot();

    world.router = new StrategyRouter(root, {
        strategies: {coarse: 'renderer:coarse', detailed: 'renderer:detailed', gpu: 'renderer:gpu'},
        gate: (view) => (world.glSink && view >= 2.2 ? 'gpu' : (view >= 1.5 ? 'detailed' : 'coarse')),
    });
    ticker.start();

    // Per-room live handles (one room at a time). null == no room live.
    let roomScope = null, sup = null, cron = null, bus = null, health = null;
    let restarts = 0, nodeCount = 0, roomBooted = false, facingTimer = null;

    // Cache the fresh engine ref + census after boot OR after a supervised restart. Mirrors
    // market-map's refreshFeed: the render loop never resolves the engine per frame.
    const recache = () => {
        try {
            world.engine = roomScope.get('engine');
        } catch {
            world.engine = null;
        }
        nodeCount = 0;
        try {
            nodeCount = (fromContainer(roomScope).nodes || []).length;
            toJSON(fromContainer(roomScope));               // graph export smoke (JSON profile)
        } catch {
            nodeCount = 0;
        }
    };

    async function enterRoom(id) {
        if (roomScope) await leaveRoom();
        const cfg = ROOMS[id];
        if (!cfg) throw new Error("enterRoom: unknown room '" + id + "'. Try A, B, or C.");

        // Lay out the emitters into the SURVIVING world SoA first (game state persists
        // across a heal); only the voice HANDLES are (re)stamped when the engine builds.
        const freqs = cfg.freqs, count = Math.min(freqs.length, MAXE);
        world.roomId = id;
        world.range = cfg.range;
        world.count = count;
        for (let i = 0; i < count; i++) {
            const a = (i / count) * TAU;
            world.bx[i] = Math.cos(a) * cfg.range * 0.5;
            world.bz[i] = Math.sin(a) * cfg.range * 0.5;
            world.rad[i] = cfg.range * 0.22;
            world.rate[i] = 0.0006 + i * 0.00018;
            world.phase[i] = a;
            world.vol[i] = 0.6 + (i % 3) * 0.12;
            world.px[i] = world.bx[i] + world.rad[i];
            world.pz[i] = world.bz[i];
            world.hx[i] = -1;
            world.label[i] = 's' + i + ' ' + freqs[i] + 'Hz';
        }

        const sounds = buildSounds(freqs, cfg.kind);          // procedural WAV data: URIs

        // Room = child scope (correction 1). Per-room services live here.
        roomScope = root.scope();

        // scoped signal registry (torn down with the scope): room-level aggregates ONLY.
        const rx = useScopedSignals(roomScope, {createRegistry});
        const agg = new RoomAggregates(rx);
        agg.reverb.set(cfg.reverb);
        agg.emitters.set(count);
        world.reverb = cfg.reverb;
        roomScope.value('agg', agg);

        // ONE LiteAudio engine per room scope, sharing the ROOT ctx. Async singleton so a
        // supervised restart (getAsync) rebuilds a fully-initialized engine on the SAME ctx.
        roomScope.singletonFactoryAsync('engine', async (c) => {
            const e = new LiteAudio();
            await e.init(ctx);                                // PASS the shared ctx -- never a new one
            e.createBus('world', {spatial: 'positional'});    // mode frozen HERE (correction 5)
            await e.defineSounds(sounds);
            world.layout = e.layoutOf();                      // read once, cached (correction 5)
            for (let i = 0; i < world.count; i++) {
                world.hx[i] = e.play('s' + i, world.vol[i], 0, 1);   // positioned emitters
            }
            return e;
        });
        // Fail-closed teardown: destroy() disconnects every node; it does NOT close the
        // shared ctx. Nulling world.engine keeps the render loop off a disposed graph.
        roomScope.onTeardown('engine', (e) => {
            world.engine = null;
            for (let i = 0; i < world.count; i++) world.hx[i] = -1;
            try {
                e.destroy();
            } catch {
            }
        });

        // event-bus: footstep -> retrigger every emitter (0 B/emit fan-out).
        // 'world' resolves through the parent chain (registered on the root scope), so the
        // listener's dep is satisfied without re-registering it on the child.
        bus = new EventBus(roomScope);
        bus.on('footstep', FootstepRetrigger, ['world']);

        // cron: wall-clock housekeeping.
        cron = new Cron(roomScope, {tickMs: 1000});
        cron.job('housekeep', HousekeepingJob, interval(3000), {deps: ['agg']});

        // health + supervisor over the room engine.
        health = new Health();
        health.source('engine', () => (world.engine ? 0 : 1), LANES.READY);   // fail-closed read
        health.source('loop', () => 0, LANES.LIVE);
        sup = new Supervisor(roomScope, {
            children: ['engine'], strategy: STRATEGIES.ONE_FOR_ONE, maxRestarts: 20, windowMs: 60000,
            onRestart: () => {
                restarts++;
                recache();
                log('heal', 'engine re-resolved on the shared ctx -- voices re-stamped');
            },
            onEscalate: () => log('escalate', 'restart budget exhausted -- engine left down (fail closed)'),
        });
        health.watchSupervisor('supervisor', sup, LANES.READY);

        roomScope.boot();
        roomBooted = true;
        bus.boot();
        cron.start();
        await sup.start();                                    // resolves 'engine' -> builds the graph
        recache();

        // ~10Hz sampler: mirror the listener facing (game state) into the reactive aggregate.
        // Per-frame signal writes are avoided -- the aggregate is coarse by design.
        facingTimer = setInterval(() => agg.facing.set(world.facing), 100);

        log('heal', 'entered room ' + id + ' (' + cfg.reverb + ') -- ' + nodeCount + ' graph nodes, ' + count + ' emitters');
    }

    async function leaveRoom() {
        if (!roomScope) return;
        if (facingTimer) {
            clearInterval(facingTimer);
            facingTimer = null;
        }
        try {
            if (sup) await sup.shutdown();
        } catch {
        }
        try {
            if (cron) cron.stop();
        } catch {
        }
        // Reverse-topo teardown: engine.destroy() (nodes disconnect) + signal registry
        // destroy(). The live-node census returns to baseline (0).
        try {
            await roomScope.shutdown();
        } catch (e) {
            log('escalate', 'room teardown reported: ' + (e && e.message ? e.message : String(e)));
        }
        roomScope = null;
        sup = null;
        cron = null;
        bus = null;
        health = null;
        roomBooted = false;
        world.roomId = null;
        world.engine = null;
        world.count = 0;
        world.reverb = '';
        nodeCount = 0;
        log('replay', 'left room -- engine torn down, live audio nodes back to baseline (0)');
    }

    return {
        enterRoom,
        leaveRoom,
        killAudio() {                                        // supervisor self-heal beat
            // reportFault throws SYNCHRONOUSLY when the supervisor is not RUNNING (state 1)
            // -- e.g. post-escalation. Guard on state; a bare .catch would miss the throw.
            if (sup && sup.state === 1) sup.reportFault('engine').catch(() => {});
        },
        footstep() {                                         // event-bus fan-out beat
            if (bus) bus.emit('footstep', 1);
        },
        setView(v) {
            world.view = v;
        },
        resize(nw, nh) {
            world.w = nw;
            world.h = nh;
        },
        readState() {
            const engineLive = !!world.engine;
            let voices = 0;
            const eng = world.engine;
            if (eng) {
                try {
                    voices = eng.activeCount('world');
                } catch {
                    voices = world.count;
                }
            }
            let readyz = 0, livez = 0, facing = 0, reverb = '', emitters = 0, housekeeps = 0, supState = -1;
            if (health) {
                readyz = health.readyz();
                livez = health.livez();
            }
            if (sup) supState = sup.state;
            if (roomScope) {
                try {
                    const agg = roomScope.get('agg');
                    facing = agg.facing.peek();
                    reverb = agg.reverb.peek();
                    emitters = agg.emitters.peek();
                    housekeeps = agg.housekeeps.peek();
                } catch {
                }
            }
            return {
                roomId: world.roomId,
                facingDeg: (facing * (360 / TAU)) % 360,
                reverb, emitters, housekeeps,
                layout: world.layout,
                voices,
                audioNodes: censusOf(engineLive, voices),    // returns to 0 on teardown
                nodeCount, restarts, readyz, livez, supState,
                engineLive,
            };
        },
        // The parent refuses to shut down while a room scope is live (correction 1). This
        // surfaces that fail-closed guard for the teardown beat.
        shutdownRoot() {
            root.shutdown().then(
                () => log('replay', 'root scope shut down'),
                (e) => log('escalate', 'root refused shutdown: ' + (e && e.message ? e.message : String(e))),
            );
        },
        stop() {
            if (facingTimer) clearInterval(facingTimer);
            ticker.stop();
            if (cron) try {
                cron.stop();
            } catch {
            }
        },
    };
}
