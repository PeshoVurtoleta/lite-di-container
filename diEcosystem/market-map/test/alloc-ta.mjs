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
import {TaPlane, IchimokuEval, AlligatorEval, TA_WARM, ALLIGATOR_WARM} from '../kernel.js';

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

// ---- lane C: 200k warm flat bar closes in mode ALLIGATOR (0-alloc, 0 signals) ----
//   The Alligator's evaluate() + alligatorLine() run ONLY at bar close (~1 Hz). On flat data
//   the three SMMA lines converge to the flat close so the mouth spread is 0 (< GATOR_SPREAD_MIN
//   -> sleeping) AND price == lips -- doubly silent. Scalars only, one O(count) backward pass
//   per line: post-gc steady-state growth must be < 64 KB and ZERO signals must fire.
const gatorInst = new AlligatorEval();
let gatorSignals = 0;
const gatorEmit = () => { gatorSignals++; };
plane.onBar = () => gatorInst.evaluate(plane, gatorEmit);
// plane is already warmed past both thresholds by lane B; confirm before the measured loop.
const gatorWarmed = plane.count >= ALLIGATOR_WARM;

globalThis.gc();
const gatorSigBefore = gatorSignals;
const beforeC = process.memoryUsage().heapUsed;
for (let i = 0; i < M; i++) {
    plane.applyMid(60000);              // flat tick
    now += BAR;
    plane.roll(now);                    // one bar close -> one alligator evaluate()
}
globalThis.gc();
const afterC = process.memoryUsage().heapUsed;
const growthC = afterC - beforeC;
const gatorSignalsDuring = gatorSignals - gatorSigBefore;

// Ring identities AFTER all lanes (closeBar writes in-place; never a fresh Float32Array).
const ringsStable = plane.o.buffer === oBuf && plane.h.buffer === hBuf
    && plane.l.buffer === lBuf && plane.c.buffer === cBuf;

console.log('ASSERT1 TaPlane applyMid x ' + N + ' + warm roll x ' + M + ' (modes ichimoku + alligator)');
console.log('  applyMid post-gc heapUsed growth   = ' + growthA + ' B (limit < 65536)');
console.log('  roll post-gc heapUsed growth (ichi)= ' + growthB + ' B (limit < 65536)');
console.log('  roll post-gc heapUsed growth (gator)= ' + growthC + ' B (limit < 65536)');
console.log('  four candle rings identity stable = ' + ringsStable);
console.log('  warmed past TA_WARM before lane B  = ' + warmed);
console.log('  warmed past ALLIGATOR_WARM (lane C)= ' + gatorWarmed);
console.log('  ichimoku signals on flat data      = ' + signalsDuring + ' (must be 0)');
console.log('  alligator signals on flat data     = ' + gatorSignalsDuring + ' (must be 0)');
const ok = growthA < 65536 && growthB < 65536 && growthC < 65536 && ringsStable
    && warmed && gatorWarmed && signalsDuring === 0 && gatorSignalsDuring === 0;
console.log('  RESULT ' + (ok ? 'PASS' : 'FAIL'));
if (!ok) process.exitCode = 1;
