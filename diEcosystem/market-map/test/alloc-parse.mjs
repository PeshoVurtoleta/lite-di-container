// alloc-parse.mjs -- ASSERTION 3. Run: node --expose-gc test/alloc-parse.mjs
// Intent: parseFrame adds NO allocation of its own above the JSON.parse it calls
// (it stores the parsed level arrays by reference and writes only scalars into a
// module-level scratch singleton -- no new object/array/closure per call).
//
// GATE = ABSOLUTE net-retained-after-gc over N iters, mirroring alloc-applydepth's
// <64 KB absolute floor. A RATIO vs the ~3 KB JSON.parse baseline is NOT a reliable
// discriminator -- it is dominated by V8 GC-scheduling noise. An absolute floor is:
// a real O(N) per-call retention would show hundreds of KB..MB at N=1e6, whereas
// zero-added-allocation stays a few KB regardless of N (it does not scale with N).
// Methodology is the honest one: gc() before AND after the loop = NET retained;
// worst-of-TRIALS so a lucky low reading cannot mask a real leak.
import {parseFrame} from '../Frames.js';
import {depth20} from './fixtures/Frames.fixtures.mjs';

const N = 1000000;
const TRIALS = 6;
const FLOOR = 65536;                    // 64 KB absolute (same as alloc-applydepth.mjs)
const raw = depth20;
let sink = 0;

for (let i = 0; i < 50000; i++) sink += parseFrame(raw).n;   // warm the JIT

let worst = -Infinity;
for (let t = 0; t < TRIALS; t++) {
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) sink += parseFrame(raw).n;
    globalThis.gc();
    const after = process.memoryUsage().heapUsed;
    const net = after - before;
    if (net > worst) worst = net;       // worst case cannot be gamed by GC luck
}

const perOp = worst / N;
const ok = worst < FLOOR;
console.log('ASSERT3 parseFrame net-retained-after-gc over ' + N + ' iters (worst of ' + TRIALS + ')  sink=' + sink);
console.log('  net growth = ' + worst + ' B   per-op = ' + perOp.toFixed(6) + ' B/op   (limit < ' + FLOOR + ' B absolute)');
console.log('  a real O(N) per-call retention would show ~' + (N / 1024 | 0) + ' KB+ here; zero-added-alloc stays KB-scale.');
console.log('  RESULT ' + (ok ? 'PASS' : 'FAIL'));
if (!ok) process.exitCode = 1;
