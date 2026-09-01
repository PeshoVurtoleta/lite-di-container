// watchlist.js -- the pooled watchlist plane (S9). Subscribe/unsubscribe churn at ZERO GC.
//
// A watchlist "remove" PARKS the symbol's reactive VM (releaseReactive); a re-"add" REVIVES
// the SAME object (reinitReactive) with fresh initials pulled from the last live tick. The
// child scope, its scoped lite-signal registry, and its per-scope defineReactive wrapper
// class ALL survive the park -- scope.shutdown() stays the S8 death story and is NEVER fired
// by a watchlist remove. Tabs = scope OPEN/SHUTDOWN; the watchlist = VM PARK/REVIVE over a
// RETAINED scope. Two different lifetimes, one demo.
//
// HAND-ROLLED, not lite-signal-decorators' createFleet, on three grounds (PLAN-S9 T3):
//   1. createFleet owns its OWN registry and destroys it in dispose() -- that collides with
//      the S8 law "one scope = one scoped registry, torn down by scope.shutdown() alone".
//   2. the fleet fixes capacity at construction with eager prefill of every member; the
//      watchlist is user-driven and sparse.
//   3. the fleet keys identity by an opaque slot stamp; the demo keys by ticker symbol and
//      must expose THAT identity (symbol -> {vm, scope, registry, live}) as S10's label seam.
//
// The park-guard ordering (borrowed from fleetAcquire's fail-closed discipline): run the
// FALLIBLE reinitReactive/releaseReactive FIRST, mutate the index only AFTER it returns, so
// a throw never leaves the entry claiming a state the VM does not hold.

import {releaseReactive, reinitReactive, costOfInstance, snapshotOf} from '@zakkster/lite-signal-decorators';
// The ONE source of truth for the resettable key set. kernel.js and watchlist.js import each
// other (kernel wires the watchlist; the watchlist derives its keys from the kernel's spec),
// so a module-load-time derivation would read SYMBOL_VM_SPEC before kernel.js finishes
// initializing it (ESM circular TDZ). RESET_KEYS is therefore derived LAZILY, the first time
// it is needed -- by then both modules are fully evaluated -- then frozen and cached.
import {SYMBOL_VM_SPEC} from './kernel.js';

let RESET_KEYS = null;
// The resettable set is EXACTLY the VM's @reactive signals + @localTo locals, in spec order:
// bid, ask, last, pinned, pinAnchor, alert (6 keys). The deriveds mid/spread are NOT here:
// reinitReactive rejects any key that is not a signal or a local, naming it in the throw.
function ensureResetKeys() {
    if (RESET_KEYS === null) {
        if (!SYMBOL_VM_SPEC || !SYMBOL_VM_SPEC.signals || !SYMBOL_VM_SPEC.locals) {
            throw new Error('watchlist: SYMBOL_VM_SPEC unavailable -- cannot derive RESET_KEYS (fail closed)');
        }
        RESET_KEYS = Object.freeze([
            ...Object.keys(SYMBOL_VM_SPEC.signals),
            ...Object.keys(SYMBOL_VM_SPEC.locals),
        ]);
    }
    return RESET_KEYS;
}

// The MANDATORY signal/local filter (PLAN-S9 T6). snapshotOf INCLUDES the deriveds mid/spread;
// reinitReactive THROWS on either. toInitials copies ONLY the resettable keys from a snapshot
// into a caller-owned scratch object, dropping mid/spread -- so a round-trip survives. Named
// and exported so the test can assert the UNFILTERED path (raw snapshot -> reinit) throws,
// proving the filter is load-bearing, not decorative. Zero-alloc when `scratch` is preallocated.
export function toInitials(snap, scratch) {
    if (!snap || typeof snap !== 'object') {
        throw new TypeError('toInitials: a snapshot object is required (fail closed; null is not empty)');
    }
    const keys = ensureResetKeys();
    // Fail closed on a PARTIAL snapshot: a missing RESET_KEY would leave the PRIOR symbol's
    // stale value in the shared scratch (cross-symbol bleed). Every resettable key must be
    // present -- reject with a named throw rather than silently carry a stale field.
    for (let i = 0; i < keys.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(snap, keys[i])) {
            throw new TypeError('toInitials: snapshot is missing resettable key `' + keys[i]
                + '` -- refusing a partial import (would bleed a stale value from the shared scratch)');
        }
    }
    for (let i = 0; i < keys.length; i++) scratch[keys[i]] = snap[keys[i]];
    return scratch;
}

// createWatchlist({ scopes, SymbolVMOf, lastTickOf, capacity }) -- the park/revive plane.
//   - scopes:     the kernel's Map<symbol, scopeHandle>. First-sighting add() reads the
//                 handle here (scope + registry) to build the entry; the scope is
//                 cold-constructed by the kernel's addSymbol BEFORE add() is called.
//   - SymbolVMOf: sym -> the scope's reactive VM (identity is STABLE across park/revive).
//   - lastTickOf: sym -> a PREALLOCATED per-symbol record the watchlist captures the last
//                 live values into at park, and re-seeds the revive from. No per-tick alloc.
//   - capacity:   the max number of retained entries. Fail closed past it.
export function createWatchlist({scopes, SymbolVMOf, lastTickOf, capacity}) {
    if (!scopes || typeof scopes.get !== 'function') {
        throw new TypeError('createWatchlist: {scopes} must be the kernel scope Map (fail closed)');
    }
    if (typeof SymbolVMOf !== 'function') throw new TypeError('createWatchlist: {SymbolVMOf} must be a function');
    if (typeof lastTickOf !== 'function') throw new TypeError('createWatchlist: {lastTickOf} must be a function');
    const cap = capacity | 0;
    if (cap <= 0) throw new RangeError('createWatchlist: {capacity} must be a positive integer');

    const keys = ensureResetKeys();
    // ONE preallocated scratch whose own keys are EXACTLY RESET_KEYS. reinitReactive reads via
    // hasOwnProperty, so overwriting the scratch in place is zero-alloc per revive. [HOT]
    const initialsScratch = {};
    for (let i = 0; i < keys.length; i++) initialsScratch[keys[i]] = 0;

    // The index: symbol -> {vm, scope, registry, live}. This IS S10's label source.
    const entries = new Map();
    let cycles = 0;             // park + revive transitions, for the perf HUD row
    let baseNodes = null;       // lazy baseline for the nodes-delta HUD row (0 in steady state)

    // Copy the live VM's resettable values into its captured record. Called at park (vm LIVE).
    const captureInto = (rec, vm) => {
        for (let i = 0; i < keys.length; i++) rec[keys[i]] = vm[keys[i]];
    };
    // Copy a source record's resettable values into the shared scratch. Called at revive.
    const fillScratch = (rec) => {
        for (let i = 0; i < keys.length; i++) initialsScratch[keys[i]] = rec[keys[i]];
    };

    return {
        // The stable symbol -> {vm, scope, registry, live} map (S10 label seam, test seam).
        entries,
        get RESET_KEYS() { return keys; },
        toInitials,

        // add(sym) [HOT]. First sighting: register a LIVE entry over the kernel's freshly
        // cold-constructed scope (the VM is already live -- do NOT reinit a just-built VM).
        // Thereafter, on a PARKED entry: re-seed the scratch from the captured last tick and
        // REVIVE the same VM. reinitReactive runs FIRST; the live flag flips only after it
        // returns. An already-live entry is an idempotent no-op (returns false).
        add(sym) {
            const e = entries.get(sym);
            if (e) {
                if (e.live) return false;                    // idempotent revive of a live entry
                fillScratch(lastTickOf(sym));                // scratch <- last captured live tick
                reinitReactive(e.vm, initialsScratch);       // fallible FIRST
                e.live = true;                               // mutate the index only after it returns
                if (e.feedGate) e.feedGate.live = true;      // re-open the feed gate AFTER revive succeeds (park-guard order)
                cycles++;
                return true;
            }
            if (entries.size >= cap) {
                throw new RangeError('watchlist.add: capacity ' + cap + ' reached -- close a symbol before adding ' + String(sym));
            }
            const h = scopes.get(sym);
            if (!h) throw new Error('watchlist.add: no open scope for ' + String(sym) + ' -- open it first (fail closed)');
            const vm = SymbolVMOf(sym);
            if (!vm) throw new Error('watchlist.add: scope ' + String(sym) + ' has no VM (fail closed)');
            entries.set(sym, {vm, scope: h.scope, registry: h.registry || null, feedGate: h.feedGate || null, live: true});
            return true;
        },

        // remove(sym) [HOT]. PARK the VM (releaseReactive). The entry, scope, registry, and
        // wrapper class are ALL retained -- scope.shutdown() is never fired here. Captures the
        // last live values into the per-symbol record BEFORE parking (the vm is live now) so a
        // later revive re-seeds correctly. releaseReactive returns FALSE on an already-parked
        // VM -- that false is the idempotent "already parked" signal, NOT an error. An unknown
        // symbol also returns false.
        remove(sym) {
            const e = entries.get(sym);
            if (!e) return false;
            if (!e.live) return false;                       // already parked -> idempotent
            captureInto(lastTickOf(sym), e.vm);              // live -> record (vm still live)
            const wasLive = releaseReactive(e.vm);           // fallible FIRST
            e.live = false;                                  // mutate the index only after it returns
            if (e.feedGate) e.feedGate.live = false;         // close the feed gate AFTER park succeeds -> no post-park vm write throws
            cycles++;
            return wasLive;
        },

        // forget(sym) -- drop the entry entirely (the scope is being SHUT DOWN, not parked).
        // The kernel calls this from closeSymbol so a torn-down scope's VM/registry are not
        // retained by the index (the scope-churn leak gate). Does NOT park or dispose.
        forget(sym) {
            return entries.delete(sym);
        },

        // readWatchlist(rows) -- COLD (1 Hz / on transitions), NEVER the 120 ms poll:
        // costOfInstance is uncached and allocates a frozen row per call. Fills caller-owned
        // preallocated `rows[i]` records in place and returns the count. A PARKED entry is
        // gated on its OWN live flag and rendered with nodes/links = -1 (the HUD prints
        // "parked") -- costOfInstance THROWS on a parked VM, so it is never called there.
        readWatchlist(rows) {
            if (!Array.isArray(rows)) throw new TypeError('readWatchlist: rows must be a preallocated array');
            let i = 0;
            for (const [sym, e] of entries) {
                if (i >= rows.length) break;                 // fail closed: never grow the caller's array
                const row = rows[i];
                row.symbol = sym;
                row.live = e.live;
                if (e.live) {
                    const c = costOfInstance(e.vm);          // COLD: one frozen alloc per live row
                    row.nodes = c.nodes;
                    row.links = c.links;
                } else {
                    row.nodes = -1;                          // -1 => "parked"; never try/catch a throw into a blank
                    row.links = -1;
                }
                i++;
            }
            return i;
        },

        // exportWatchlist() -- a JSON share/save. snapshotOf per LIVE entry (throws on parked,
        // so a parked entry emits {parked:true} instead). COLD (a user save).
        exportWatchlist() {
            const out = {version: 1, symbols: {}};
            for (const [sym, e] of entries) {
                out.symbols[sym] = e.live ? snapshotOf(e.vm) : {parked: true};
            }
            return JSON.stringify(out);
        },

        // importWatchlist(json) -- restore from an exportWatchlist() string/object. For each
        // symbol that is currently OPEN: {parked:true} parks it; a value snapshot is FILTERED
        // through toInitials (dropping mid/spread) then applied via park -> reinit. Symbols
        // that are not open are skipped (a share link may name a symbol this session lacks).
        // COLD (a user load). Returns the number of entries applied.
        importWatchlist(json) {
            const data = typeof json === 'string' ? JSON.parse(json) : json;
            if (!data || typeof data.symbols !== 'object' || data.symbols === null) {
                throw new TypeError('importWatchlist: expected {symbols:{...}} (fail closed)');
            }
            let applied = 0;
            for (const sym in data.symbols) {
                if (!Object.prototype.hasOwnProperty.call(data.symbols, sym)) continue;
                const e = entries.get(sym);
                if (!e) continue;                            // not open this session -> skip
                const snap = data.symbols[sym];
                if (snap && snap.parked) {
                    if (e.live) {
                        releaseReactive(e.vm);
                        e.live = false;
                        if (e.feedGate) e.feedGate.live = false;
                    }
                    applied++;
                    continue;
                }
                toInitials(snap, initialsScratch);           // filter -> scratch (drops mid/spread)
                if (e.live) {                                // reinit THROWS on a live VM -- park first
                    releaseReactive(e.vm);
                    e.live = false;
                    if (e.feedGate) e.feedGate.live = false;
                }
                reinitReactive(e.vm, initialsScratch);       // fallible FIRST
                e.live = true;                               // mutate the index only after it returns
                if (e.feedGate) e.feedGate.live = true;      // re-open the gate AFTER revive succeeds
                cycles++;
                applied++;
            }
            return applied;
        },

        // stats() -- COLD perf-panel snapshot. cycles = park/revive transitions; poolGrowths =
        // summed scoped-registry pool growths (stays 0 = the pool never reallocated under
        // churn); nodesDelta = summed scoped activeNodes vs a lazy baseline (0 in steady state).
        stats() {
            let poolGrowths = 0, nodes = 0, live = 0;
            for (const e of entries.values()) {
                if (e.registry && typeof e.registry.stats === 'function') {
                    const s = e.registry.stats();
                    poolGrowths += s.poolGrowths;
                    nodes += s.activeNodes;
                }
                if (e.live) live++;
            }
            if (baseNodes === null && entries.size > 0) baseNodes = nodes;
            return {cycles, size: entries.size, live, poolGrowths, nodesDelta: nodes - (baseNodes || 0)};
        },
    };
}
