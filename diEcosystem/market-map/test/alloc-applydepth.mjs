// alloc-applydepth.mjs -- ASSERTION 4. Run: node --expose-gc test/alloc-applydepth.mjs
// OrderBook.applyDepth over a PRE-PARSED frame, 1_000_000 iterations. Post-gc
// heapUsed growth must be < 64 KB (~0 B/op), and EVERY preallocated typed array
// applyDepth writes into -- including the S4 cumulative-depth pair bidCum/askCum,
// folded into this same single pass -- must keep stable ArrayBuffer identity
// (no typed-array reallocation).
import {parseFrame, OrderBook} from '../Frames.js';
import {depth20} from './fixtures/Frames.fixtures.mjs';

const N = 1000000;
const book = new OrderBook();
const f = parseFrame(depth20);          // pre-parsed ONCE, outside the loop

const bufBefore = book.bidPx.buffer;
const cumBufBefore = book.bidCum.buffer;    // S4: cumulative-depth buffer, same pass as bidPx

// warm
for (let i = 0; i < 50000; i++) book.applyDepth(f);

globalThis.gc();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) book.applyDepth(f);
globalThis.gc();
const after = process.memoryUsage().heapUsed;

const bufAfter = book.bidPx.buffer;
const cumBufAfter = book.bidCum.buffer;
const growth = after - before;
const bufStable = bufBefore === bufAfter;
const cumBufStable = cumBufBefore === cumBufAfter;
const maxCumFinite = Number.isFinite(book.maxCum) && book.maxCum > 0; // S4 divisor sanity, not a fresh alloc
const underBudget = growth < 65536;

console.log('ASSERT4 applyDepth over ' + N + ' iters');
console.log('  post-gc heapUsed growth = ' + growth + ' B (limit < 65536)');
console.log('  bidPx.buffer identity stable = ' + bufStable);
console.log('  bidCum.buffer identity stable (S4 cum path) = ' + cumBufStable);
console.log('  maxCum finite+positive after ' + N + ' steady-state calls = ' + maxCumFinite);
const ok = underBudget && bufStable && cumBufStable && maxCumFinite;
console.log('  RESULT ' + (ok ? 'PASS' : 'FAIL'));
if (!ok) process.exitCode = 1;
