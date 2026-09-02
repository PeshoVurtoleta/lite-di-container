// test/helpers/harness.mjs -- headless seams for the audio-rooms node:test gates.
//
// FIDELITY: these seams prove the DI LIFECYCLE + census MODEL (scope teardown, census
// -> 0, self-heal identity, fail-closed) against a MOCK engine -- NOT real AudioNode
// disconnection. Web Audio has no AudioContext in node; this is the SAME boundary as
// market-map's fake socket. The browser demo shows the real graph.

// The census constants are the kernel's own model (kernel.js:47-48). The mock tracks its
// OWN live-node count against these so a gate measures the mock's REAL post-destroy state,
// not a fixture that never frees (the market-map S9 harness-faithfulness lesson).
export const ENGINE_BASE_NODES = 6;   // createBus wires master + bus gains
export const VOICE_NODES = 3;         // each play(): source + panner + gain

// lite-raf fails closed without a global requestAnimationFrame (correct behavior); a
// headless kernel boot must install a shim first. setTimeout-backed; cancelAnimationFrame
// clears the pending timer so ticker.stop() inside handle.stop() lets the process exit.
// Idempotent: installed once per process.
export function installRaf() {
    if (typeof globalThis.requestAnimationFrame !== 'function') {
        globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
        globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
}

// A stable-identity mock AudioContext. The mock engine never calls real ctx methods, so a
// plain object suffices -- but it carries an identity so the heal gate can assert ctx
// stability (the "same shared ctx into every engine" claim). A fresh one per call keeps
// separate boots isolated.
export function makeMockCtx() {
    return {__mockCtx: true, id: 'ctx#' + (mockCtxSeq++)};
}
let mockCtxSeq = 0;

// A no-op 2D canvas context stub. The root render ticker starts at bootKernel and draws
// every frame through world.router (set at boot); with a null c2d the CoarseRenderer would
// throw each frame. This stub satisfies every 2D method drawRoom() touches so the render
// loop -- and thus the per-frame setPosition stamp (the T5 hot path) -- runs headless.
export function makeMock2d() {
    return {
        clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        arc() {}, fill() {}, fillRect() {}, fillText() {}, save() {}, restore() {},
        strokeStyle: '', fillStyle: '', lineWidth: 1, shadowColor: '', shadowBlur: 0, font: '',
    };
}

// makeFakeEngine() -> {makeEngine, engines}. `makeEngine` is passed to bootKernel's seam
// (kernel.js:479) and returns a FRESH faithful mock each call -- a heal builds a NEW engine
// so the seam is invoked again. Every engine built is pushed to `engines` so the heal gate
// can assert a fresh instance + the same ctx object into init.
//
// The mock is FAITHFUL to LiteAudio's surface AND to the census model: createBus adds
// ENGINE_BASE_NODES, each play adds VOICE_NODES, and destroy() releases -- sets live to 0
// AND drops the ctx ref. `opts.breakDestroy` arms the non-vacuous G1 canary (a no-op
// destroy that never frees); `opts.reuse` arms a G2 canary that reuses the dead instance.
export function makeFakeEngine(opts = {}) {
    const engines = [];
    let reused = null;
    // AR_BREAK=1 GLOBALLY arms the breakDestroy canary (a no-op destroy) so the CI
    // break-gate can prove the census gate is falsifiable end-to-end: with it set, G1's
    // "census -> 0 after leaveRoom" assertion reds and `npm test` exits non-zero. Read
    // once at mock construction (cold); a per-test `opts.breakDestroy` still arms it too.
    const breakDestroy = opts.breakDestroy || process.env.AR_BREAK === '1';
    const build = () => {
        const eng = {
            id: engines.length,
            live: 0,          // the mock's OWN live audio-node count
            ctx: null,        // the ctx handed to init() -- the heal identity anchor
            voices: 0,        // active positional voices on the 'world' bus
            handleSeq: 0,
            destroyed: false,
            async init(ctx) { this.ctx = ctx; },
            createBus(name, o) { this.live += ENGINE_BASE_NODES; },
            async defineSounds(sounds) {},
            layoutOf() { return 'stereo'; },
            play(id, vol, x, y) { this.live += VOICE_NODES; this.voices++; return this.handleSeq++; },
            setPosition(h, x, y, z) {},   // the hot-path stamp -- no-op, zero alloc
            activeCount(bus) { return this.voices; },
            destroy() {
                this.destroyed = true;
                if (breakDestroy) return;   // CANARY: never frees -> census stays > 0
                this.live = 0;
                this.voices = 0;
                this.ctx = null;
            },
        };
        engines.push(eng);
        return eng;
    };
    const makeEngine = () => {
        if (opts.reuse) {                 // CANARY: hand back the dead instance on a heal
            if (reused) return reused;
            reused = build();
            return reused;
        }
        return build();
    };
    return {makeEngine, engines};
}
