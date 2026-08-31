// scope-churn.test.mjs -- headless retention gate: 256 open/close symbol-scope cycles
// must reclaim EVERY scope (tracker.size() === 0). The non-vacuous control in the same
// file deliberately retains one closed scope and proves the gate CAN go red (size 1) --
// without it the retention check is a tautology (the house VACUOUS-LEAK-GATE).
//
// Needs --expose-gc. Each cycle runs inside a helper that fully returns before gc, so no
// loop-local binding pins the last scope (the WeakRef/liveness lesson from torture.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';
import {createLeakTracker} from '@zakkster/lite-leak';

installRaf();

const CYCLES = 256;
const retained = [];                                           // the control parks a closed scope here

async function gcSettle(rounds = 5) {
    for (let r = 0; r < rounds; r++) {
        global.gc();
        await new Promise((z) => setTimeout(z, 15));
    }
}

if (typeof global.gc !== 'function') {
    test('scope-churn (needs --expose-gc; skipped)', () => {});
} else {
    test('256 open/close scope cycles retain nothing', async () => {
        const {factory} = makeFakeFactory();
        const handle = await bootKernel({
            ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
            onEvent() {}, onMode() {}, socketFactory: factory,
        });
        const tracker = createLeakTracker({name: 'scope-churn'});
        // cleanup + tag close over neither the scope handle nor a target-derived value.
        async function cycle(i) {
            const sc = await handle.addSymbol('CHURN' + i, 'wss://feed/' + i);
            tracker.track(sc, () => {}, 'scope#' + i);
            await handle.closeSymbol('CHURN' + i);
        }
        try {
            for (let i = 0; i < CYCLES; i++) await cycle(i);
            await gcSettle();
            assert.equal(tracker.size(), 0, 'every closed scope was reclaimed');
        } finally {
            await handle.shutdown();
        }
    });

    test('non-vacuous control: a deliberately retained scope keeps size() at 1', async () => {
        const {factory} = makeFakeFactory();
        const handle = await bootKernel({
            ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
            onEvent() {}, onMode() {}, socketFactory: factory,
        });
        const tracker = createLeakTracker({name: 'scope-churn-control'});
        async function leakOne() {
            const sc = await handle.addSymbol('LEAK', 'wss://feed/leak');
            tracker.track(sc, () => {}, 'leaked-scope');
            await handle.closeSymbol('LEAK');
            retained.push(sc);                                 // strong ref -> cannot finalize -> gate stays red
        }
        try {
            await leakOne();
            await gcSettle();
            assert.equal(tracker.size(), 1, 'a retained scope proves the gate can go red');
        } finally {
            retained.length = 0;
            await handle.shutdown();
        }
    });
}
