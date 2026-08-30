// alloc-applydepth.mjs -- ASSERTION 4. Run: node --expose-gc test/alloc-applydepth.mjs
// OrderBook.applyDepth over a PRE-PARSED frame, 1_000_000 iterations. Post-gc
// heapUsed growth must be < 64 KB (~0 B/op), and the bidPx ArrayBuffer identity
// must be stable (no typed-array reallocation).
import {parseFrame, OrderBook} from '../Frames.js';
import {depth20} from './fixtures/Frames.fixtures.mjs';

const N = 1000000;
const book = new OrderBook();
const f = parseFrame(depth20);          // pre-parsed ONCE, outside the loop

const bufBefore = book.bidPx.buffer;

// warm
for (let i = 0; i < 50000; i++) book.applyDepth(f);

globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) book.applyDepth(f);
globalThis.gc();
const after = process.memoryUsage().heapUsed;

const bufAfter = book.bidPx.buffer;
const growth = after - before;
const bufStable = bufBefore === bufAfter;
const underBudget = growth < 65536;

console.log('ASSERT4 applyDepth over ' + N + ' iters');
console.log('  post-gc heapUsed growth = ' + growth + ' B (limit < 65536)');
console.log('  bidPx.buffer identity stable = ' + bufStable);
console.log('  RESULT ' + (underBudget && bufStable ? 'PASS' : 'FAIL'));
if (!(underBudget && bufStable)) process.exitCode = 1;
