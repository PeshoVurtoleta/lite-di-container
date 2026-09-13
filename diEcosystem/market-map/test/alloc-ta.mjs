// alloc-ta.mjs -- ASSERTION 1 (S11). Run: node --expose-gc test/alloc-ta.mjs
// The TA plane's two hot/steady-state lanes, modeled on alloc-applydepth.mjs:
//   (A) TaPlane.applyMid over 1_000_000 iters -- the HOT tick body (2 compares + a store).
//       Post-gc heapUsed growth must be < 64 KB, and the four candle rings (o/h/l/c) must
//       keep stable ArrayBuffer identity (they are written in-place by closeBar, never
//       reallocated) across BOTH lanes.
//   (B) roll() over 200_000 warm flat bars in mode ICHIMOKU -- the cold bar-close lane that
//       must STILL be steady-state 0-alloc (preallocated readout fields, O(52) ring scans),
//       and must emit ZERO signals on flat data (chikou needs price != priceD strictly, and
//       flat closes are always equal -> no edge can ever fire). growth < 64 KB, signals 0.
import {TaPlane, IchimokuEval, TA_WARM} from '../kernel.js';

const N = 1000000;                      // applyMid hot iterations
const M = 200000;                       // warm flat bar-close iterations
const BAR = 1000;                       // synthetic timeframe (ms)
const plane = new TaPlane(BAR);

// Ring buffer identities BEFORE any work -- must be unchanged at the very end.
const oBuf = plane.o.buffer, hBuf = plane.h.buffer, lBuf = plane.l.buffer, cBuf = plane.c.buffer;

// ---- lane A: applyMid x 1M (HOT) -----------------------------------------
for (let i = 0; i < 50000; i++) plane.applyMid(60000 + (i & 15));   // warm both compare branches
globalThis.gc();
const beforeA = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) plane.applyMid(60000 + (i & 255));
globalThis.gc();
const afterA = process.memoryUsage().heapUsed;
const growthA = afterA - beforeA;

// ---- lane B: 200k warm flat bar closes in mode ichimoku (0-alloc, 0 signals) ----
const evalInst = new IchimokuEval();
let signals = 0;
const emit = () => { signals++; };
plane.onBar = () => evalInst.evaluate(plane, emit);

let now = 0;
plane.applyMid(60000);
plane.roll(now);                        // first call only stamps barStart
for (let bar = 0; bar < TA_WARM + 8; bar++) {   // warm past the 78-bar threshold on flat data
    plane.applyMid(60000);
    now += BAR;
    plane.roll(now);
}
const warmed = plane.count >= TA_WARM;

globalThis.gc();
const sigBefore = signals;
const beforeB = process.memoryUsage().heapUsed;
for (let i = 0; i < M; i++) {
    plane.applyMid(60000);              // flat tick
    now += BAR;
    plane.roll(now);                    // exactly one bar close -> one evaluate()
}
globalThis.gc();
const afterB = process.memoryUsage().heapUsed;
const growthB = afterB - beforeB;
const signalsDuring = signals - sigBefore;

// Ring identities AFTER both lanes (closeBar writes in-place; never a fresh Float32Array).
const ringsStable = plane.o.buffer === oBuf && plane.h.buffer === hBuf
    && plane.l.buffer === lBuf && plane.c.buffer === cBuf;

console.log('ASSERT1 TaPlane applyMid x ' + N + ' + warm roll x ' + M + ' (mode ichimoku)');
console.log('  applyMid post-gc heapUsed growth = ' + growthA + ' B (limit < 65536)');
console.log('  roll post-gc heapUsed growth      = ' + growthB + ' B (limit < 65536)');
console.log('  four candle rings identity stable = ' + ringsStable);
console.log('  warmed past TA_WARM before lane B  = ' + warmed);
console.log('  signals emitted on flat data       = ' + signalsDuring + ' (must be 0)');
const ok = growthA < 65536 && growthB < 65536 && ringsStable && warmed && signalsDuring === 0;
console.log('  RESULT ' + (ok ? 'PASS' : 'FAIL'));
if (!ok) process.exitCode = 1;
