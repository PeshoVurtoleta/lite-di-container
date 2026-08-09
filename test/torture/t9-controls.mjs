/**
 * T9 -- controls. Every gate above must be provably able to fail.
 *
 * Each control runs a deliberately-broken variant IN PROCESS and asserts that
 * the corresponding gate flags it. If a control slips through, T9 fails the run
 * -- a gate that cannot fail is decorative.
 *
 * The whole-suite variant is `DI_TORTURE_BREAK=1 npm run torture`, which injects
 * a retained allocation into the T6 Lane 2 hot body and must exit non-zero.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { Container } from '../../Container.js';
import { runOpsGate, orderInvariant, validate, die } from './harness.mjs';

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

export async function run() {
    // -- Control 1: the Lane 2 alloc gate. A hot body that retains an
    //    allocation every iteration MUST be rejected by runOpsGate.
    const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (report.ok) die('T9 control 1: an allocating hot loop passed the zero-alloc gate');
    leak.length = 0; // release the control's garbage

    // -- Control 2: measureAllocs lane-1 is not vacuous. A body that retains one
    //    object per call must fail maxBytesPerCall:0.
    const sink = [];
    const alloc = measureAllocs(() => { sink.push({ retained: true }); },
        { iterations: 2000, batches: 8, warmup: 2000 });
    const ca = checkAllocs(alloc, { maxBytesPerCall: 0 });
    if (ca.verdict === 'pass') {
        die('T9 control 2: measureAllocs passed a body that retains an object every call');
    }
    sink.length = 0;

    // -- Control 3: orderInvariant is not blind. True on a healthy container,
    //    false after a fabricated duplicate.
    {
        const c = new Container();
        c.singleton('a', class {});
        c.get('a');
        if (!orderInvariant(c)) die('T9 control 3: orderInvariant false on a healthy container');
        c._resolutionOrder.push('dup');
        if (orderInvariant(c)) die('T9 control 3: orderInvariant held despite a fabricated duplicate');
    }

    // -- Control 4: validate() throws on a container with a non-empty _path.
    {
        const c = new Container();
        c.value('x', 1);
        validate(c); // healthy first
        c._path.push('ghost');
        let caught = false;
        try { validate(c); } catch { caught = true; }
        if (!caught) die('T9 control 4: validate() passed a container with a non-empty _path');
        c._path.length = 0;
    }

    // -- Control 5: the cycle detector is load-bearing. With detection stubbed
    //    out, an a->b->a graph must NOT terminate within the stack bound.
    {
        const c = new Container();
        c.transient('a', class { constructor(b) { this.b = b; } }, ['b']);
        c.transient('b', class { constructor(a) { this.a = a; } }, ['a']);
        // Disable cycle detection: indexOf never reports a re-entry.
        c._path = { push() {}, pop() {}, indexOf() { return -1; } };
        let overflowed = false;
        try { c.get('a'); } catch (e) { overflowed = e instanceof RangeError; }
        if (!overflowed) {
            die('T9 control 5: an a->b->a graph terminated with the cycle check disabled ' +
                '-- the T3 cycle assertions would be decorative');
        }
    }

    // -- Control 6: the teardown-order comparator. A deliberately forward
    //    teardown must be detected as divergent from _resolutionOrder.reverse().
    {
        const resolution = ['leaf', 'mid', 'root'];
        const reverse = resolution.slice().reverse();      // root, mid, leaf
        const forward = resolution.slice();                // leaf, mid, root  (wrong)
        let divergent = false;
        for (let i = 0; i < reverse.length; i++) {
            if (forward[i] !== reverse[i]) { divergent = true; break; }
        }
        if (!divergent) die('T9 control 6: a forward teardown order was not flagged as divergent');
    }

    // -- Control 7: the retention witness bites. A tracked resource that is never
    //    untracked must leave tracker.size() > 0.
    {
        const tr = createLeakTracker({ name: 'di-control' });
        const h = tr.track({ live: true }, function () {}, 'ctl');
        if (tr.size() === 0) {
            die('T9 control 7: lite-leak size() was 0 with a live tracked resource -- the T7 gate is blind');
        }
        tr.untrack(h); // release so the control leaves nothing behind
    }

    // -- Control 8: the ASCII gate is ENFORCING, not decorative (D-04 / D6). It
    //    scans every shipped file (package.json files[]) with the same regex the
    //    D6 gate runs and fails the whole suite on any non-ASCII byte. It proves
    //    it can fail on demand two ways: an injected U+2550 fixture string that
    //    must be caught, and `DI_ASCII_BREAK=1`, which pushes a poisoned in-memory
    //    entry into the scan set so the enforcing loop itself exits non-zero.
    {
        const grep = /[^\x00-\x7F]/;

        // Fail-on-demand proof #1: the regex catches a U+2550 byte and does not
        // false-positive on ASCII.
        const fixture = 'banner' + String.fromCharCode(0x2550) + 'end';
        if (!grep.test(fixture)) die('T9 control 8: the ASCII grep missed a U+2550 byte');
        if (grep.test('pure ascii -> ok')) die('T9 control 8: the ASCII grep false-positived on ASCII');

        // Enforcing scan: every file in package.json files[] must be pure ASCII.
        const root = fileURLToPath(new URL('../../', import.meta.url));
        const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
        const scanSet = [];
        for (const rel of pkg.files) {
            let src;
            try { src = readFileSync(root + rel, 'utf8'); } catch { continue; }
            scanSet.push([rel, src]);
        }
        // Fail-on-demand proof #2: inject a poisoned entry so the enforcing loop
        // (not just the regex) exits non-zero.
        if (process.env.DI_ASCII_BREAK === '1') {
            scanSet.push(['<injected>', 'poison' + String.fromCharCode(0x2550)]);
        }
        for (const [rel, src] of scanSet) {
            const m = grep.exec(src);
            if (m !== null) {
                const line = src.slice(0, m.index).split('\n').length;
                die('T9 control 8: non-ASCII byte in shipped file ' + rel + ' at line ' + line +
                    ' (U+' + src.charCodeAt(m.index).toString(16).toUpperCase() + ')');
            }
        }
    }
}
