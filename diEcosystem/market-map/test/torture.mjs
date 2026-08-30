// test/torture.mjs -- node --expose-gc test/torture.mjs
// Wired to the demo's HEADLESS hot entry points (Frames.js: parseFrame + OrderBook).
// kernel.js cannot be imported under node (esm.sh specifiers); Frames.js is the
// zero-import seam that carries the real per-frame allocation surface. lite-gc-profiler
// resolves from the parent LiteDiContainer/node_modules -- no package.json is added to
// the demo (owner decision S2 #5).
//
// Phase 1 (retention) does NOT use lite-leak's tracker: track() calls getOwner() and,
// inside an effect/createRoot owner, auto-registers onCleanup(untrack), so size()===0
// would be guaranteed by construction, not by finalization (the house VACUOUS-LEAK-GATE
// class). Instead it proves ACTUAL reclamation with WeakRef + a gc/settle loop, the
// genuine sibling pattern (LiteObserve/LiteColor). Set TORTURE_LEAK=1 to inject a real
// retention and watch the gate go RED -- that is the proof the gate can fail.
import {GcProfiler, checkNoGc} from '@zakkster/lite-gc-profiler';

// >>> WIRE 1: the package under test
import {parseFrame, OrderBook} from '../Frames.js';
import {depth20} from './fixtures/Frames.fixtures.mjs';

const CYCLES = 8192;
const HOT = 1000000;
const LEAK = process.env.TORTURE_LEAK === '1';   // canary: deliberate retention
const leaked = [];                               // holds books ONLY when LEAK is set

// ---- phase 1: retention torture (real reclamation via WeakRef) ------------
// Each book is built, used, and dropped INSIDE a synchronous helper that fully
// returns before any gc/await -- so V8 can actually reclaim it (an async frame
// would pin its locals across the interior await and defeat the WeakRef). We keep
// only WeakRefs (which retain nothing) and count how many still deref after gc.
const seed = parseFrame(depth20);
const refs = [];

function makeBook(s) {
    const book = new OrderBook();
    book.applyDepth(s);
    if (LEAK) leaked.push(book);                 // deliberate leak -> book stays reachable
    return new WeakRef(book);
}

for (let i = 0; i < CYCLES; i++) refs.push(makeBook(seed));

function liveBooks() {
    let n = 0;
    for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) n++;
    return n;
}

// settle: gc + yield across several turns, then deref ONCE. Critical ordering --
// WeakRef.deref() keeps its target alive to the end of the current job, so a deref
// in the same turn as gc() would defeat collection forever (the bug this replaced).
// So we NEVER deref inside a gc turn: unconditional gc+yield rounds, then a single
// final liveCount() in a clean turn. If the books are collectible the gc rounds have
// already reclaimed them (final count 0); if retained (canary), they survive.
async function settle(liveCount, rounds = 12) {
    for (let r = 0; r < rounds; r++) {
        globalThis.gc?.();
        await new Promise((rz) => setTimeout(rz, 5));
    }
    return liveCount();
}

const live = await settle(liveBooks);

// ---- phase 2: allocation + GC torture ------------------------------------
// applyDepth over a PRE-PARSED frame is the zero-alloc steady-state hot body.
const gc = new GcProfiler().start();
const inst = new OrderBook();
const f = parseFrame(depth20);          // pre-parsed ONCE, outside the loop
for (let i = 0; i < HOT; i++) {
    inst.applyDepth(f);
    if ((i & 8191) === 0) {
        gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
}

await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
const report = checkNoGc(s, {maxMajor: 0, maxPauseMs: 4});
gc.stop();

const ok = report.ok && live === 0;
console.log(
    'GATE leak=live ' + live + '/0 churned=' + CYCLES + (LEAK ? ' (LEAK injected)' : '') +
    ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
    ' maxMs=' + s.gc.maxMs.toFixed(2) +
    ' | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
    if (live !== 0) console.error('  retention ' + live + '/' + CYCLES + ' OrderBook(s) still reachable after gc + settle');
    for (const v of report.violations) {
        console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
    }
    process.exitCode = 1;
}
