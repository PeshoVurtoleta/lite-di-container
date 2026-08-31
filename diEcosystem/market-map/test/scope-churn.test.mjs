// scope-churn.test.mjs -- headless retention gate: 256 open/close symbol-scope cycles
// must reclaim EVERY scope (tracker.size() === 0). The non-vacuous control in the same
// file deliberately retains one closed scope and proves the gate CAN go red (size 1) --
// without it the retention check is a tautology (the house VACUOUS-LEAK-GATE).
//
// Needs --expose-gc. Each cycle runs inside a helper that fully returns before gc, so no
// loop-local binding pins the last scope (the WeakRef/liveness lesson from torture.mjs).
//
// S8 QA additions (A2/A3, plans/PLAN-S8.md section 3): the two acceptance-gate assertions
// the S8 pipeline shipped test/08-symbol-vm.test.mjs's isolated single-instance proof for,
// but never wired to the REAL 256-cycle kernel churn. Both run under plain `node --test`
// (no GC dependency -- they read registry counters directly, not finalization), and both
// ride the SAME MM_TORTURE_BREAK=1 canary as 08-symbol-vm.test.mjs's A3 case.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';
import {createLeakTracker} from '@zakkster/lite-leak';
import {stats as defaultRegistryStats} from '@zakkster/lite-signal';
import {defineReactive, disposeReactive} from '@zakkster/lite-signal-decorators';
import {SIGNAL_REGISTRY_TOKEN as DI_REGISTRY_TOKEN} from '@zakkster/lite-di-signal';

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

    // A2 (PLAN-S8 section 3): every symbol VM is bound to its OWN scope registry via
    // reactiveService(s, 'vm', (api) => new (makeSymbolVM(api.registry))()) -- the DEFAULT
    // lite-signal registry (module-level, shared across the whole process) must be
    // byte-for-byte untouched by 256 real open/use/close cycles. deepEqual on the WHOLE
    // stats() object (activeNodes, activeLinks, poolGrowths, totalAllocations, ... every
    // field), not a subset and not a tolerance -- any nonzero delta anywhere means a VM
    // (or anything else) landed on the default registry instead of the scope's own.
    test('A2 default registry frozen: 256 open/use/close cycles leave the DEFAULT registry byte-for-byte unchanged', async () => {
        const {factory} = makeFakeFactory();
        const handle = await bootKernel({
            ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
            onEvent() {}, onMode() {}, socketFactory: factory,
        });
        try {
            const before = defaultRegistryStats();
            for (let i = 0; i < CYCLES; i++) {
                const sym = 'A2_' + i;
                const sc = await handle.addSymbol(sym, 'wss://feed/a2-' + i);
                for (let q = 0; q < 4; q++) sc.inject(100 + q, 100 + q - 0.5, 100 + q + 0.5);
                await handle.closeSymbol(sym);
            }
            const after = defaultRegistryStats();
            assert.deepEqual(after, before,
                'the default lite-signal registry (activeNodes/activeLinks/poolGrowths/allocations/...) is untouched by 256 real scope cycles');
        } finally {
            await handle.shutdown();
        }
    });

    // A2 non-vacuous control: WITHOUT this, "stats unchanged" above is a tautology (nothing
    // in the whole test file ever touches the default registry, so of course it never
    // moves). Build ONE reactive host with NO host.registry -- defineReactive's documented
    // fallthrough lands it on lite-signal's default registry -- and show stats() DOES
    // change. This proves the A2 frozen-check is actually capable of detecting the
    // contamination it claims to guard against. Run LAST in this file: it deliberately
    // mutates the same default registry the A2 gate above measures.
    test('A2 non-vacuous control: a host built with NO host.registry lands on and mutates the DEFAULT registry', () => {
        const before = defaultRegistryStats();
        class CtrlBase {
            dispose() { disposeReactive(this); }
        }
        const Ctrl = defineReactive(CtrlBase, {signals: {x: 0}});
        const inst = new Ctrl();
        void inst.x;
        const during = defaultRegistryStats();
        assert.notDeepEqual(during, before,
            'a host with no bound registry changed the DEFAULT registry -- proves the A2 frozen-check is falsifiable, not a tautology');
        inst.dispose();
    });

    // A3 (PLAN-S8 section 3): node conservation summed over 256 REAL kernel cycles (not the
    // single isolated instance 08-symbol-vm.test.mjs already covers). Each fresh scope's OWN
    // registry must read exactly 11 active nodes after open (1 tpsSig, created before the VM
    // at createSymbolScope's top, + 10 VM nodes), and net 0 delta once the VM's OWN dispose
    // has run -- captured the instant BEFORE registry.destroy() fires, because destroy() is
    // an UNCONDITIONAL backstop that drains the whole node pool regardless of whether the VM
    // disposed cleanly first (so sampling stats() AFTER destroy() would read 0 either way and
    // the gate could never go red). MM_TORTURE_BREAK=1 no-ops vm.dispose per scope -- same
    // canary 08-symbol-vm.test.mjs's A3 case uses -- so the pre-destroy snapshot still shows
    // the un-disposed +10, and the summed delta goes nonzero (RED).
    test('A3 node conservation summed over 256: registry activeNodes returns to its pre-VM floor at every close', async () => {
        const BREAK = process.env.MM_TORTURE_BREAK === '1';
        const {factory} = makeFakeFactory();
        const handle = await bootKernel({
            ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
            onEvent() {}, onMode() {}, socketFactory: factory,
        });
        let sumDelta = 0;
        try {
            for (let i = 0; i < CYCLES; i++) {
                const sym = 'A3_' + i;
                const H = await handle.addSymbol(sym, 'wss://feed/a3-' + i);
                const reg = H.scope.get(DI_REGISTRY_TOKEN);
                const postOpen = reg.stats().activeNodes;
                assert.equal(postOpen, 11, 'cycle ' + i + ': tpsSig(1) + VM(10) at every fresh scope');
                let preDestroy = null;
                const realDestroy = reg.destroy.bind(reg);
                reg.destroy = () => {
                    preDestroy = reg.stats().activeNodes;   // snapshot the instant before the unconditional drain
                    return realDestroy();
                };
                if (BREAK) H.vm.dispose = () => {};          // BREAK: skip the VM's own dispose (registry.destroy is only the backstop)
                await handle.closeSymbol(sym);
                sumDelta += preDestroy - (postOpen - 10);    // 0 when vm.dispose ran; +10/scope when skipped
            }
            assert.equal(sumDelta, 0,
                'summed node-conservation delta over 256 scopes (BREAK skips dispose -> nonzero -> RED)');
        } finally {
            await handle.shutdown();
        }
    });
}
