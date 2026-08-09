/**
 * @zakkster/lite-di-container -- torture gate.
 *
 * The DONE-WHEN of every session below D0 is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Tiers share one shape (ROADMAP_v2.md section 3) and run STRICTLY SEQUENTIALLY
 * -- lite-gc-profiler is one-measurement-at-a-time, never nested, never
 * concurrent. D1 wires:
 *
 *     T0  metamorphic resolution laws     T1  degenerate tokens / defs / deps
 *     T3  adversarial sequences           T4  lifecycle + teardown + scope abuse
 *     T6  the zero-alloc gate, per lane   T7  scope-churn soak + lite-leak
 *     T9  controls (must be able to fail)
 *
 * T5 (differential fuzz, D5) and T8 (dependents, X1) are registered but empty so
 * the sequence is stable when later sessions add content, not plumbing.
 *
 * A tier signals failure via die() (which exits non-zero). A thrown error is an
 * unexpected fault -- surfaced with the replay seed. In BREAK mode the whole
 * suite must exit non-zero; if T6's control did not trip, the backstop below does.
 *
 * @license MIT
 */

import { SEED, BREAK, STATS } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t1 } from './torture/t1-degenerate.mjs';
import { run as t3 } from './torture/t3-adversarial.mjs';
import { run as t4 } from './torture/t4-lifecycle.mjs';
import { run as t5 } from './torture/t5-fuzz.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t8 } from './torture/t8-dependents.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T1 degenerate', t1],
    ['T3 adversarial', t3],
    ['T4 lifecycle', t4],
    ['T5 fuzz', t5],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T8 dependents', t8],
    ['T9 controls', t9],
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            await run();
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means T6's control did not trip -- a fault.
    if (BREAK) {
        process.stderr.write(
            'torture: FAIL -- DI_TORTURE_BREAK set but the gate still passed\n');
        process.exit(1);
    }

    // One machine-readable GATE line on stderr; stdout stays exactly "ok".
    process.stderr.write(
        'GATE leak=size ' + STATS.leakSize + '/' + STATS.leakTarget +
        ' findings=' + STATS.findings + ' warnings=' + STATS.warnings +
        ' | gc major=' + STATS.gcMajor + ' minor=' + STATS.gcMinor +
        ' maxMs=' + STATS.gcMaxMs.toFixed(2) +
        ' | alloc=' + STATS.allocBytesPerOp.toFixed(3) + ' B/op\n');

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
