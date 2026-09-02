// 09-watchlist.test.mjs -- the pooled watchlist plane (S9). Proves park/revive churn at zero
// GC: a watchlist "remove" PARKS the symbol's reactive VM (releaseReactive) over a RETAINED
// scope; a re-"add" REVIVES the SAME object (reinitReactive). scope.shutdown() is never fired
// by a remove. The five acceptance assertions (PLAN-S9 section 3, corrected by the S9
// reconciliation brief: 10 nodes/VM, 80 for a full 8-symbol watchlist, RESET_KEYS of 6,
// alert NOT alertThreshold, the mid-naming negative).
//
// Break control: MM_TORTURE_BREAK=1 arms a deliberate violation in the two conservation/
// retention gates (assertion 1 leaks a scope-registry node per cycle; assertion 2 retains
// the closed scopes) so each goes RED and the process exits non-zero -- the house proof the
// gate is falsifiable, not vacuous. Unset it runs green. The GC-budget asserts need
// --expose-gc; without it they self-skip (npm test runs the node-conservation core, the
// `churn` script runs the GC budget). A gate that cannot go RED is a house FAIL.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel, BurstSystem} from '../kernel.js';
import {toInitials} from '../watchlist.js';
import {reinitReactive, releaseReactive, costOfInstance, snapshotOf, ReactiveDisposedError} from '@zakkster/lite-signal-decorators';
import {SIGNAL_REGISTRY_TOKEN as DI_REGISTRY_TOKEN} from '@zakkster/lite-di-signal';
import {GcProfiler, checkNoGc} from '@zakkster/lite-gc-profiler';
import {createLeakTracker} from '@zakkster/lite-leak';

installRaf();

const BREAK = process.env.MM_TORTURE_BREAK === '1';
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT', 'DOGEUSDT', 'LTCUSDT'];
const VM_NODES = 10;                 // 1 anchor + 5 signals + 1 local + 2 deriveds + 1 effect (S8 spec)
const FULL_NODES = SYMS.length * VM_NODES;   // a full 8-symbol watchlist reads 80 nodes
const retained = [];                 // the MM_TORTURE_BREAK canary parks closed scopes here

async function boot() {
    const {factory} = makeFakeFactory();
    return bootKernel({ctx: null, gl: null, w: 0, h: 0, ringSize: 4096, onEvent() {}, onMode() {}, socketFactory: factory});
}

async function openAll(handle) {
    for (const s of SYMS) await handle.addSymbol(s, 'wss://feed/' + s);
}

// FinalizationRegistry callbacks are best-effort; under the shared node:test process (a
// larger live heap than an isolated run) they need several gc + yield turns to drain. We
// never read tracker.size() inside a gc turn -- unconditional rounds, then the caller reads
// in a clean turn (the torture.mjs settle discipline).
async function gcSettle(rounds = 14) {
    for (let r = 0; r < rounds; r++) {
        global.gc();
        await new Promise((z) => setTimeout(z, 20));
    }
}

// ---- assertion 5: round-trip + the load-bearing filter (no GC) ------------------------
test('A5 round-trip: export -> import restores every signal/local; raw snapshot -> reinit THROWS naming `mid`', async () => {
    const handle = await boot();
    try {
        await openAll(handle);
        const e = handle._watchlist.get('BTCUSDT');
        const vm = e.vm;
        vm.bid = 111.5; vm.ask = 113.25; vm.last = 112; vm.pinAnchor = 112.4; vm.pinned = true; vm.alert = 112.4;
        void vm.mid; void vm.spread;

        const json = handle.exportWatchlist();
        // clobber the live values, then import must restore them bit-identically.
        vm.bid = 0; vm.ask = 0; vm.last = 0; vm.pinned = false; vm.pinAnchor = 0;
        const applied = handle.importWatchlist(json);
        assert.equal(applied, SYMS.length, 'import applied every open symbol');
        assert.equal(vm.bid, 111.5, 'bid restored');
        assert.equal(vm.ask, 113.25, 'ask restored');
        assert.equal(vm.last, 112, 'last restored');
        assert.equal(vm.pinned, true, 'pinned restored');
        assert.equal(vm.pinAnchor, 112.4, 'pinAnchor restored');
        assert.equal(vm.alert, 112.4, 'alert (local) restored');

        // The NEGATIVE: snapshotOf INCLUDES the deriveds mid/spread; feeding the RAW snapshot
        // to reinitReactive (bypassing toInitials) THROWS, naming `mid`. This proves the
        // filter is load-bearing, not decorative.
        const raw = snapshotOf(vm);
        assert.ok(Object.prototype.hasOwnProperty.call(raw, 'mid'), 'snapshot includes the mid derived');
        releaseReactive(vm);                             // reinit needs a parked VM
        assert.throws(() => reinitReactive(vm, raw), (err) => /`mid`/.test(err.message),
            'a raw (unfiltered) snapshot -> reinit throws, naming the derived key mid');
        // toInitials drops mid/spread -> the SAME snapshot now reinits cleanly.
        const scratch = {bid: 0, ask: 0, last: 0, pinned: false, pinAnchor: 0, alert: 0};
        toInitials(raw, scratch);
        assert.ok(!('mid' in scratch), 'toInitials dropped mid');
        assert.ok(!('spread' in scratch), 'toInitials dropped spread');
        reinitReactive(vm, scratch);                     // no throw: the filter made it safe
        handle._watchlist.get('BTCUSDT').live = true;    // (we drove reinit by hand; restore the flag)
    } finally {
        await handle.shutdown();
    }
});

// ---- assertion 3: identity stable across every revive (no GC) -------------------------
test('A3 identity: reinitReactive revives the SAME object at cycles 1, 2048, 4096', async () => {
    const handle = await boot();
    try {
        await openAll(handle);
        const e = handle._watchlist.get('BTCUSDT');
        const vm0 = e.vm;
        // Non-vacuous control: a DIFFERENT symbol's VM is a distinct object -- so `=== vm0`
        // below is a real identity claim, not a tautology any VM would satisfy. (Constructing
        // a throwaway VM here would land its nodes on THIS scope's registry and leak, so we
        // compare against an already-open sibling's VM instead.)
        assert.notEqual(handle._watchlist.get('ETHUSDT').vm, vm0, 'a sibling symbol has a distinct VM');
        for (let i = 1; i <= 4096; i++) {
            handle.parkSymbol('BTCUSDT');
            handle.reviveSymbol('BTCUSDT');
            if (i === 1 || i === 2048 || i === 4096) {
                assert.equal(handle._watchlist.get('BTCUSDT').vm, vm0, 'cycle ' + i + ': the SAME VM object revived');
            }
        }
    } finally {
        await handle.shutdown();
    }
});

// ---- assertion 4: costOfInstance is a live number; parked throws (no GC) --------------
test('A4 cost row: costOfInstance.nodes === 10 live, 80 for the full watchlist; PARKED throws', async () => {
    const handle = await boot();
    try {
        await openAll(handle);
        let total = 0;
        for (const s of SYMS) {
            const vm = handle._watchlist.get(s).vm;
            void vm.mid; void vm.spread; void vm.alert;   // read every derived once (A1 parity)
            const c = costOfInstance(vm);
            assert.equal(c.nodes, VM_NODES, s + ': a live VM reads ' + VM_NODES + ' nodes');
            total += c.nodes;
        }
        assert.equal(total, FULL_NODES, 'a full 8-symbol watchlist reads ' + FULL_NODES + ' nodes');

        // The parked path is REAL (non-vacuous): costOfInstance on a parked VM THROWS
        // ReactiveDisposedError -- readWatchlist gates on the live flag and renders -1, never
        // try/catching a throw into a blank.
        const parked = handle._watchlist.get('ETHUSDT').vm;
        handle.parkSymbol('ETHUSDT');
        assert.throws(() => costOfInstance(parked), ReactiveDisposedError, 'costOfInstance on a parked VM fails closed');

        // readWatchlist renders the parked entry as -1 without throwing.
        const rows = [];
        for (let i = 0; i < SYMS.length; i++) rows.push({symbol: '', live: false, nodes: 0, links: 0});
        const n = handle.readWatchlist(rows);
        assert.equal(n, SYMS.length, 'readWatchlist filled one row per entry');
        const ethRow = rows.find((r) => r.symbol === 'ETHUSDT');
        assert.equal(ethRow.live, false, 'the parked entry is flagged not-live');
        assert.equal(ethRow.nodes, -1, 'the parked row renders -1 (=> "parked"), never a throw');
        const btcRow = rows.find((r) => r.symbol === 'BTCUSDT');
        assert.equal(btcRow.nodes, VM_NODES, 'a live row renders its real node count');
        handle.reviveSymbol('ETHUSDT');
    } finally {
        await handle.shutdown();
    }
});

// ---- BLOCKER 1: a PARKED VM is never written or read by the live feed --------------------
// A watchlist park (releaseReactive) does NOT stop the scope's socket -- the feed keeps
// dispatching. A reactive WRITE or READ on a parked VM THROWS ReactiveDisposedError, so
// AggApply.handle and state() gate on the scope's feedGate.live flag. This is the feature's
// MAIN path (you park a live-fed symbol). The gate is NON-vacuous: remove the `if
// (!this.feedGate.live) return;` in AggApply.handle and the first injected tick throws, the
// activeNodes assertion trips, and readState() on the parked-active symbol throws -- RED.
test('BLOCKER1 parked feed: 100 ticks to a PARKED symbol -- no throw, no node growth, state safe; revive resumes', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('BTCUSDT', 'wss://feed/btc');
        const h = handle._scopes.get('BTCUSDT');
        const reg = h.scope.get(DI_REGISTRY_TOKEN);
        handle.parkSymbol('BTCUSDT');                        // releaseReactive -> feedGate.live = false
        const before = reg.stats().activeNodes;
        // Deliver ticks straight through the REAL dispatch seam the socket uses. Ungated,
        // the first write to the parked VM would throw out of inject().
        for (let i = 0; i < 100; i++) h.inject(100 + (i & 7), 99.5, 100.5);
        assert.equal(reg.stats().activeNodes, before, 'no reactive node formed on the parked VM (feed gate held)');
        const st = handle.readState();                       // active AND parked -> must not throw
        assert.equal(st.mid, 0, 'a parked active symbol reads zero for its reactive fields, never a throw');
        // Revive re-opens the gate and the same object resumes reacting to the feed.
        handle.reviveSymbol('BTCUSDT');
        h.inject(250, 249.5, 250.5);
        assert.ok(handle.readState().mid > 0, 'revive re-opens the feed gate and the VM reacts again');
    } finally {
        await handle.shutdown();
    }
});

// ---- BLOCKER 3: the pre-lane BurstSystem must not read a PARKED active VM ----------------
// The active symbol is parkable (releaseReactive does NOT switch `active` away). While burst
// is enabled, BurstSystem.update() reads the active scope's `a.vm.mid` derived every frame --
// a parked VM throws ReactiveDisposedError, which is uncaught in the ticker's system loop AND
// allocates an Error(stack) per frame. So BurstSystem gates on the active holder's feedGate,
// same idiom as AggApply. The ticker does not expose its resolved system instances, so this
// runs the REAL BurstSystem.update() against the REAL parked active holder (handle._c's viz,
// whose `active` is the shared holder the ticker feeds). Remove the gate -> update() throws.
test('BLOCKER3 burst on parked active: BurstSystem.update() over a PARKED active VM -- no throw, no node growth', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('BTCUSDT', 'wss://feed/btc');   // becomes the active symbol
        const h = handle._scopes.get('BTCUSDT');
        const reg = h.scope.get(DI_REGISTRY_TOKEN);
        const viz = handle._c.get('viz');                      // the real ticker-fed viz (value binding)
        viz.burstN = 50;                                       // arm the synthetic-tick count (handle.burst sets this)
        handle.parkSymbol('BTCUSDT');                          // park the ACTIVE symbol -> feedGate.live = false
        assert.equal(viz.active.feedGate.live, false, 'the shared active holder sees the park (feedGate flipped)');
        const before = reg.stats().activeNodes;
        const burst = new BurstSystem(viz);                    // the exact system class the ticker resolves
        burst.update();                                        // ungated, a.vm.mid on the parked VM throws here
        assert.equal(reg.stats().activeNodes, before, 'burst injected nothing into the parked VM (gate held)');
        // Revive and confirm burst resumes feeding the now-live VM.
        handle.reviveSymbol('BTCUSDT');
        burst.update();
        assert.ok(h.tape.count > 0, 'after revive, burst feeds the live VM through the real dispatch seam');
    } finally {
        await handle.shutdown();
    }
});

// ---- assertion 2 / BLOCKER 2: forget() drops the entry; no entry outlives its scope ------
// closeSymbol calls watchlist.forget(sym). Two independent proofs it is NOT a vacuous gate:
//   (a) DETERMINISTIC (no GC): after each close, handle._watchlist.has(sym) === false. Remove
//       forget() from closeSymbol and this trips immediately.
//   (b) RETENTION (GC): the entries Map is the ONLY structure that references the entry
//       RECORD ({vm, scope, registry, feedGate, live}); tracking THAT record and asserting
//       size()===0 after churn proves no entry outlives its scope -- remove forget() and the
//       Map retains every record -> nonzero -> RED. (Tracking the vm/scope would NOT isolate
//       forget: scope internals retain those regardless. The entry record is the clean seam.)
// MM_TORTURE_BREAK=1 retains the records in a module array -> the retention gate goes RED,
// proving the leak tracker is falsifiable.
const CHURN2 = 64;
if (typeof global.gc !== 'function') {
    test('A2 retention (needs --expose-gc; skipped)', async () => {
        // The deterministic forget() proof still runs without GC.
        const handle = await boot();
        try {
            await handle.addSymbol('WLX', 'wss://feed/wlx');
            assert.ok(handle._watchlist.has('WLX'), 'entry created on open');
            await handle.closeSymbol('WLX');
            assert.equal(handle._watchlist.has('WLX'), false, 'closeSymbol -> forget dropped the entry');
        } finally {
            await handle.shutdown();
        }
    });
} else {
    test('A2 retention: forget() drops every entry across ' + CHURN2 + ' open/close cycles; BREAK retains -> RED', async () => {
        const handle = await boot();
        const tracker = createLeakTracker({name: 'watchlist-retention'});
        try {
            for (let i = 0; i < CHURN2; i++) {
                const sym = 'WL' + i;
                await handle.addSymbol(sym, 'wss://feed/' + i);
                assert.ok(handle._watchlist.has(sym), sym + ': entry created on open');
                // Track the ENTRY RECORD (only the entries Map holds it). cleanup + tag close
                // over nothing target-derived.
                tracker.track(handle._watchlist.get(sym), () => {}, 'entry#' + i);
                if (BREAK) retained.push(handle._watchlist.get(sym));   // canary: strong ref -> cannot finalize -> RED
                await handle.closeSymbol(sym);
                assert.equal(handle._watchlist.has(sym), false, sym + ': closeSymbol -> forget dropped the entry (deterministic)');
            }
            await gcSettle();
            assert.equal(tracker.size(), 0, 'no watchlist entry record outlived its scope (remove forget() -> Map retains -> RED)');
        } finally {
            retained.length = 0;
            await handle.shutdown();
        }
    });
}

// ---- assertion 1: churn / GC budget -- 4096 park/revive conserve every node ------------
// The node-conservation core (registry stats deltas) needs NO gc -- it runs under npm test.
// The GC budget (maxMajor 0, bounded heap growth) rides GcProfiler and self-skips without
// --expose-gc. MM_TORTURE_BREAK=1 leaks ONE scope-registry node per cycle so the dNodes
// assertion goes RED: the proof the conservation gate can detect a leak.
test('A1 conservation: 4096 park/revive keep per-scope activeNodes/activeLinks/poolGrowths flat; BREAK leaks -> RED', async () => {
    const handle = await boot();
    try {
        await openAll(handle);
        const regs = SYMS.map((s) => handle._scopes.get(s).scope.get(DI_REGISTRY_TOKEN));
        // Warm to steady state (the deriveds re-form their links on the first revive), THEN
        // snapshot the baseline -- conservation is measured against the exercised graph.
        for (const s of SYMS) { handle.parkSymbol(s); handle.reviveSymbol(s); }
        const base = regs.map((r) => r.stats());

        // Clear ambient garbage from the earlier tests BEFORE arming the profiler -- a
        // global.gc() inside the window would itself register as a major collection.
        const gcCapable = typeof global.gc === 'function';
        if (gcCapable) { global.gc(); global.gc(); }
        const gc = gcCapable ? new GcProfiler().start() : null;
        const heap0 = process.memoryUsage().heapUsed;
        for (let c = 0; c < 512; c++) {
            for (let k = 0; k < SYMS.length; k++) {
                const s = SYMS[k];
                handle.parkSymbol(s);
                handle.reviveSymbol(s);
                if (BREAK) regs[k].signal(0);                // canary: one leaked node per cycle -> dNodes RED
            }
            if (gc && (c & 63) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
        const after = regs.map((r) => r.stats());

        for (let k = 0; k < SYMS.length; k++) {
            const b = base[k], a = after[k];
            assert.equal(a.activeNodes - b.activeNodes, 0, SYMS[k] + ': activeNodes back to baseline exactly');
            assert.equal(a.activeLinks - b.activeLinks, 0, SYMS[k] + ': activeLinks back to baseline exactly');
            assert.equal(a.poolGrowths - b.poolGrowths, 0, SYMS[k] + ': the node/link pool never grew');
            assert.equal(a.totalAllocations - b.totalAllocations, a.totalDisposals - b.totalDisposals,
                SYMS[k] + ': allocations delta === disposals delta (conservation)');
        }

        if (gc) {
            await new Promise((r) => setTimeout(r, 50));
            const s = gc.summary();
            const report = checkNoGc(s, {maxMajor: 0, maxPauseMs: 8});
            gc.stop();                                       // window closed -- a gc() is now safe to measure retention
            assert.ok(report.ok, 'no major GC across 4096 park/revive cycles');
            global.gc();
            // COARSE cross-environment backstop only. The AUTHORITATIVE zero-GC proof is the
            // exact node/link/allocation conservation asserted above (activeNodes/activeLinks/
            // poolGrowths deltas === 0, allocations === disposals) -- deterministic registry
            // counters, and the path the BREAK canary reds through. This `heapUsed` byte-delta
            // is pure GC-accounting jitter: measured across runs/platforms it swings from about
            // -76 to +65 B/cycle (a NEGATIVE reading means gc freed more than the window
            // allocated). node 22/linux read 65.0 where node 26/macOS read < 64, so the old
            // 64 B ceiling failed CI on noise, not a leak. The ceiling here only catches a
            // GROSS linear leak (orders of magnitude above the jitter); the real gate is above.
            const perCycle = (process.memoryUsage().heapUsed - heap0) / 4096;
            assert.ok(perCycle <= 512, 'retained heap growth is not a gross linear leak (<= 512 B/cycle; was ' + perCycle.toFixed(1) + ')');
        }
    } finally {
        await handle.shutdown();
    }
});
