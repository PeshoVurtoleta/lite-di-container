// 09b-watchlist-boundary.test.mjs -- QA boundary sweep for the S9 pooled watchlist
// (planner PLAN-S9.md section 3 + S9-RECONCILIATION.md). This file does NOT touch
// 09-watchlist.test.mjs; it only ADDS coverage for entry points the planner's own
// suite left unverified: capacity fail-closed (N-1/N/N+1 + the "park does not free
// capacity" adversarial case), idempotency of add/remove on live/parked/unknown
// symbols, importWatchlist's skip/park/partial-snapshot paths, toInitials' own
// input matrix (null/undefined/non-object/empty), readWatchlist's row-shortfall
// fail-closed clamp, the S8 localTo ABA contract surviving a park/revive, and a
// GC-provable check that a closed symbol's feedGate leaves no dangling retention
// path. Every assertion here is either a plain input/output boundary (falsifiable
// by construction -- a wrong implementation fails it) or, where GC is involved,
// gated the same way 09-watchlist.test.mjs gates A2 (self-skip under plain `npm
// test`; real assertions run under `npm run churn`, which passes --expose-gc).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel, makeSymbolVM} from '../kernel.js';
import {createWatchlist, toInitials} from '../watchlist.js';
import {createRegistry} from '@zakkster/lite-signal';

installRaf();

// ---- a lightweight watchlist fixture (no DI container, no sockets) --------------------
// Mirrors kernel.js's own per-scope construction exactly: one fresh scope registry + one
// fresh makeSymbolVM(registry) class per symbol (defineReactive forbids re-installing on
// the same prototype). maxNodes/maxLinks generous (kernel.js's own module-load probe uses
// the same 64/128 ceiling for a single VM -- kernel.js:159).
function makeFakeScope() {
    const registry = createRegistry({maxNodes: 64, maxLinks: 128, prealloc: 'eager', onCapacityExceeded: 'throw'});
    const VM = makeSymbolVM(registry);
    return {scope: {}, registry, feedGate: {live: true}, vm: new VM()};
}

function makeFixture(capacity) {
    const scopes = new Map();
    const vms = new Map();
    const lastTicks = new Map();
    const lastTickOf = (sym) => {
        let rec = lastTicks.get(sym);
        if (!rec) {
            rec = {bid: 0, ask: 0, last: 0, pinned: false, pinAnchor: 0, alert: 0};
            lastTicks.set(sym, rec);
        }
        return rec;
    };
    const openSymbol = (sym) => {
        const {scope, registry, feedGate, vm} = makeFakeScope();
        scopes.set(sym, {scope, registry, feedGate});
        vms.set(sym, vm);
    };
    const wl = createWatchlist({scopes, SymbolVMOf: (sym) => vms.get(sym) || null, lastTickOf, capacity});
    return {wl, openSymbol, scopes, vms};
}

async function boot() {
    const {factory} = makeFakeFactory();
    return bootKernel({ctx: null, gl: null, w: 0, h: 0, ringSize: 4096, onEvent() {}, onMode() {}, socketFactory: factory});
}

// ---- constructor boundary: 0 / negative / null / undefined / NaN / -0 -----------------
test('createWatchlist({capacity}) fails closed on every non-positive-integer capacity (0, -1, null, undefined, NaN, -0)', () => {
    const scopes = new Map();
    const base = {scopes, SymbolVMOf: () => null, lastTickOf: () => ({})};
    for (const bad of [0, -1, null, undefined, NaN, -0]) {
        assert.throws(() => createWatchlist({...base, capacity: bad}), RangeError,
            'capacity=' + String(bad) + ' must throw RangeError, not silently accept a non-positive pool size');
    }
    // The positive-integer floor is a real boundary: 1 is the smallest legal capacity.
    assert.doesNotThrow(() => createWatchlist({...base, capacity: 1}), 'capacity=1 is the minimum legal size');
});

// ---- capacity: N-1 / N / N+1, and the adversarial "park does not free a slot" case ----
test('watchlist.add: capacity is fail-closed at N-1/N/N+1, and stays consistent after the throw', () => {
    const {wl, openSymbol} = makeFixture(2);
    openSymbol('A'); openSymbol('B'); openSymbol('C');

    assert.equal(wl.add('A'), true, 'N-1: first slot fills');
    assert.equal(wl.entries.size, 1);
    assert.equal(wl.add('B'), true, 'N: second (last) slot fills exactly at capacity');
    assert.equal(wl.entries.size, 2);

    assert.throws(() => wl.add('C'), RangeError, 'N+1: a third distinct symbol over capacity throws RangeError');
    assert.equal(wl.entries.size, 2, 'the throw did not corrupt the index -- size stays at capacity');
    assert.equal(wl.entries.has('C'), false, 'the rejected symbol never got a partial entry');

    // Consistency after the throw: existing entries are still fully usable.
    assert.equal(wl.remove('A'), true, 'A still parks cleanly after the failed add of C');
    assert.equal(wl.add('A'), true, 'A still revives cleanly after the failed add of C');
});

test('ADVERSARIAL: parking a symbol does NOT free a watchlist capacity slot -- only forget() does', () => {
    const {wl, openSymbol} = makeFixture(1);
    openSymbol('A'); openSymbol('B');

    assert.equal(wl.add('A'), true, 'the single slot fills with A');
    assert.throws(() => wl.add('B'), RangeError, 'B is rejected: capacity counts ALL entries, live or parked');

    assert.equal(wl.remove('A'), true, 'A parks (releaseReactive) -- the entry is retained, not dropped');
    assert.throws(() => wl.add('B'), RangeError,
        'PARKING A DID NOT FREE THE SLOT: B is still rejected while A is merely parked, not forgotten');
    assert.equal(wl.entries.size, 1, 'the parked A entry still occupies the one slot');

    assert.equal(wl.forget('A'), true, 'forget() (scope close) is the ONLY thing that frees a slot');
    assert.equal(wl.add('B'), true, 'B now succeeds once the slot is genuinely freed');
});

// ---- idempotency: double-park, revive-of-live, and the unknown-symbol paths -----------
test('idempotency: double-remove is a no-op false, revive-of-live is a no-op false, unknown symbols fail predictably', () => {
    const {wl, openSymbol} = makeFixture(4);
    openSymbol('A');

    assert.equal(wl.add('A'), true, 'first sighting: live entry created');
    assert.equal(wl.add('A'), false, 'revive-of-live is idempotent: returns false, does not throw, does not re-run reinit');

    assert.equal(wl.remove('A'), true, 'first remove: live -> parked');
    assert.equal(wl.remove('A'), false, 'DOUBLE-PARK: second remove on an already-parked entry returns false, does not throw');
    assert.equal(wl.remove('A'), false, 'a THIRD remove is still a clean idempotent false (not a one-shot fluke)');

    assert.equal(wl.remove('NEVER_OPENED'), false, 'remove() of an unknown symbol returns false, never throws');
    assert.throws(() => wl.add('NEVER_OPENED'), Error,
        'add() of a symbol with no open scope fails closed (named throw), never silently creates a phantom entry');
    assert.equal(wl.entries.has('NEVER_OPENED'), false, 'the failed add left no partial entry behind');
});

// ---- toInitials: the pure filter's own input matrix -----------------------------------
test('toInitials: null/undefined/non-object/empty snapshot all fail closed; a full snapshot still round-trips', () => {
    const scratch = {bid: 0, ask: 0, last: 0, pinned: false, pinAnchor: 0, alert: 0};
    assert.throws(() => toInitials(null, scratch), TypeError, 'null snapshot: fail closed (null is not empty)');
    assert.throws(() => toInitials(undefined, scratch), TypeError, 'undefined snapshot: fail closed');
    assert.throws(() => toInitials(5, scratch), TypeError, 'a non-object snapshot: fail closed');
    assert.throws(() => toInitials('bid', scratch), TypeError, 'a string snapshot: fail closed (no hasOwnProperty coercion trap)');
    assert.throws(() => toInitials({}, scratch), (err) => /`bid`/.test(err.message),
        'an EMPTY snapshot is a partial snapshot: throws naming the first missing resettable key');
    const full = {bid: 1, ask: 2, last: 1.5, pinned: true, pinAnchor: 1.5, alert: 1.5, mid: 1.5, spread: 1};
    const out = toInitials(full, scratch);
    assert.equal(out, scratch, 'toInitials returns the SAME scratch object (zero-alloc contract)');
    assert.ok(!('mid' in scratch) && !('spread' in scratch), 'deriveds never land in the scratch');
});

// ---- importWatchlist: skip-not-open, {parked:true}, and the partial-snapshot fail-closed (NIT 1) ----
test('importWatchlist: a symbol not open this session is skipped, not a throw', () => {
    const {wl, openSymbol} = makeFixture(4);
    openSymbol('A'); openSymbol('B');
    wl.add('A'); wl.add('B');
    const json = wl.exportWatchlist();
    const data = JSON.parse(json);
    data.symbols['NOT_OPEN_THIS_SESSION'] = {parked: true};
    const applied = wl.importWatchlist(JSON.stringify(data));
    assert.equal(applied, 2, 'only the two open symbols were applied; the unknown symbol was silently skipped');
});

test('importWatchlist: a {parked:true} entry parks a currently-live entry', () => {
    const {wl, openSymbol, vms} = makeFixture(4);
    openSymbol('A');
    wl.add('A');
    const data = {version: 1, symbols: {A: {parked: true}}};
    const applied = wl.importWatchlist(JSON.stringify(data));
    assert.equal(applied, 1);
    assert.equal(wl.entries.get('A').live, false, 'import applied the park');
    assert.throws(() => vms.get('A').mid, Error, 'the underlying VM is actually parked (getter throws), not just flagged');
});

test('importWatchlist: a snapshot missing a RESET_KEY fails closed (toInitials) and leaves the entry untouched (NIT 1)', () => {
    const {wl, openSymbol, vms} = makeFixture(4);
    openSymbol('A');
    wl.add('A');
    const vm = vms.get('A');
    vm.bid = 10; vm.ask = 12; vm.last = 11;
    const snap = {bid: 10, ask: 12, last: 11, pinned: false, alert: 11};   // missing pinAnchor
    const data = {version: 1, symbols: {A: snap}};
    assert.throws(() => wl.importWatchlist(JSON.stringify(data)), (err) => /`pinAnchor`/.test(err.message),
        'a partial snapshot (missing pinAnchor) throws BEFORE any park/reinit, naming the missing key');
    assert.equal(wl.entries.get('A').live, true, 'the entry was NEVER parked -- toInitials threw before the park step');
    assert.equal(vm.bid, 10, 'the live VM is completely untouched by the rejected import');
});

// ---- readWatchlist: the caller-array clamp is a real fail-closed boundary, not decorative ----
test('readWatchlist: never grows the caller array (rows shorter than entries clamps; empty array is 0; non-array throws)', () => {
    const {wl, openSymbol} = makeFixture(4);
    openSymbol('A'); openSymbol('B'); openSymbol('C');
    wl.add('A'); wl.add('B'); wl.add('C');

    const short = [{symbol: '', live: false, nodes: 0, links: 0}, {symbol: '', live: false, nodes: 0, links: 0}];
    const n = wl.readWatchlist(short);
    assert.equal(n, 2, 'three live entries but only two caller rows -- clamps to 2, never grows the array');
    assert.equal(short.length, 2, 'the caller array itself was never mutated in length');

    assert.equal(wl.readWatchlist([]), 0, 'an empty row array yields 0, no throw');
    assert.throws(() => wl.readWatchlist(null), TypeError, 'null rows fails closed');
    assert.throws(() => wl.readWatchlist(undefined), TypeError, 'undefined rows fails closed');
    assert.throws(() => wl.readWatchlist('not-an-array'), TypeError, 'a non-array rows fails closed');
});

// ---- S8 ABA local contract survives a park/revive (not just an import round-trip) -----
test('S8 ABA local contract: alert re-seeds from the captured tick on revive, then RESUMES tracking mid', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('BTCUSDT', 'wss://feed/btc');
        const h = handle._scopes.get('BTCUSDT');
        const vm = h.vm;

        h.inject(200, 199.5, 200.5);                    // mid=200, unpinned -> alert follows mid
        assert.equal(vm.pinned, false);
        assert.equal(vm.alert, 200, 'sanity: alert tracks mid before any park (unpinned localCopy)');

        handle.parkSymbol('BTCUSDT');                    // captures {alert:200, bid:199.5, ask:200.5, ...}
        handle.reviveSymbol('BTCUSDT');
        assert.equal(vm.alert, 200, 'revive re-seeds alert from the captured tick, before any new feed write');

        h.inject(300, 299.5, 300.5);                     // a fresh tick moves upstream mid to 300
        assert.equal(vm.alert, 300,
            'after revive, alert RESUMES tracking upstream mid on the next tick -- the localTo binding survived, it was not frozen');

        // The pinned path must also survive a revive: a pin taken before park holds through it.
        vm.pinAnchor = vm.mid;                           // pin at the current mid (300)
        vm.pinned = true;
        vm.alert = vm.mid;
        handle.parkSymbol('BTCUSDT');
        handle.reviveSymbol('BTCUSDT');
        assert.equal(vm.pinned, true, 'pinned survives park/revive (pinned is a RESET_KEY)');
        assert.equal(vm.alert, 300, 'the pinned alert survives revive at its pinAnchor');
        h.inject(500, 499.5, 500.5);                     // mid moves far away
        assert.equal(vm.alert, 300, 'a pin taken before park still holds after revive, even as mid moves');
    } finally {
        await handle.shutdown();
    }
});

// ---- retention: a closed symbol's feedGate leaves no dangling path (needs --expose-gc) ----
// Self-skips under plain `npm test` (no global.gc); the real assertion runs under
// `npm run churn`, which passes --expose-gc (house rule: GC-dependent asserts must run
// somewhere real, never only silently skip everywhere).
test('feedGate has no dangling retention path after closeSymbol (WeakRef + gc settle)', async (t) => {
    if (typeof global.gc !== 'function') {
        t.skip('needs --expose-gc -- run under `npm run churn`');
        return;
    }
    const handle = await boot();
    try {
        // Synchronous-scoped helper (torture.mjs discipline): the strong ref to feedGate
        // must be dropped by the time this async call resolves, so nothing outside holds it.
        async function openCloseGetRef(sym) {
            await handle.addSymbol(sym, 'wss://feed/' + sym);
            const fg = handle._scopes.get(sym).feedGate;
            await handle.closeSymbol(sym);
            return new WeakRef(fg);
        }
        const ref = await openCloseGetRef('WLFG');
        for (let r = 0; r < 14; r++) {
            global.gc();
            await new Promise((z) => setTimeout(z, 20));
        }
        assert.equal(ref.deref(), undefined,
            'feedGate reclaimed after closeSymbol -- neither the watchlist entry (forgotten) nor the activeHolder retains it');
    } finally {
        await handle.shutdown();
    }
});
