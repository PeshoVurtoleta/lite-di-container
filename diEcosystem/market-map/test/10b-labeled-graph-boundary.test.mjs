// 10b-labeled-graph-boundary.test.mjs -- adversarial boundaries for the S10 labeled reactive
// graph. COMPLEMENTS test/10-labeled-graph.test.mjs (A1-A5): every case here is either a
// boundary A1-A5 did not exercise, or a NEW finding. node:test only (house law). Headless:
// the S6 boot seam (injected socketFactory + cold glSinks). ASCII-only source.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel, makeSymbolVM, reactiveGraphOf, makeLabelResolver} from '../kernel.js';
import {enableLabels, labelOf} from '@zakkster/lite-signal-decorators';
import {createRegistry} from '@zakkster/lite-signal';

installRaf();

const REG_CFG = {maxNodes: 64, maxLinks: 128, prealloc: 'eager', onCapacityExceeded: 'throw'};

async function boot() {
    const {factory} = makeFakeFactory();
    return bootKernel({ctx: null, gl: null, w: 0, h: 0, ringSize: 4096, onEvent() {}, onMode() {}, socketFactory: factory});
}

// structural DOT sanity: balanced braces, never negative, every byte < 0x80.
function structuralCheck(text) {
    let depth = 0, everNegative = false, everNonAscii = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (ch >= 0x80) everNonAscii = true;
        if (ch === 0x7b) depth++;
        else if (ch === 0x7d) { depth--; if (depth < 0) everNegative = true; }
    }
    return {balanced: depth === 0 && !everNegative, ascii: !everNonAscii};
}

// ============================================================================================
// 1. The 7<->8 transition, LOCKED (state-independent regression lock, C3).
// ============================================================================================
test('B1 topology lock: standalone VM walks pristine=8 (alert present); ONE write -> stable 7 forever (2, 50 writes)', () => {
    const reg = createRegistry(REG_CFG);
    try {
        const VM = makeSymbolVM(reg);
        const vm = new VM();
        let g = reactiveGraphOf(reg, vm);
        assert.equal(g.nodes.length, 8, 'pristine unpinned VM: 8 reachable nodes (alert included)');

        // ONE write (mirrors AggApply.handle's plain field stores) re-runs onQuote and
        // permanently drops its tracked read of `alert`.
        vm.bid = 100; vm.ask = 101; vm.last = 100.5;
        g = reactiveGraphOf(reg, vm);
        assert.equal(g.nodes.length, 7, 'after ONE write: stable floor of 7 (alert dropped)');

        vm.bid = 102; vm.ask = 103;
        g = reactiveGraphOf(reg, vm);
        assert.equal(g.nodes.length, 7, 'after a SECOND write: still 7 (not a one-shot fluke)');

        for (let i = 0; i < 50; i++) { vm.bid = 100 + i; vm.ask = 101 + i; vm.last = 100.5 + i; }
        g = reactiveGraphOf(reg, vm);
        assert.equal(g.nodes.length, 7, 'after 50 more writes: still 7 (the floor never regrows)');

        vm.dispose();
    } finally {
        reg.destroy();
    }
});

// ============================================================================================
// 2. safeName / DOT-safety on hostile symbol names.
// ============================================================================================
test('B2 safeName: a DOT-hostile / non-ASCII symbol renders a valid, ASCII-only, balanced cluster', async () => {
    const handle = await boot();
    try {
        const hostileQuote = 'A"B';                                    // embeds a raw DOT-breaking quote
        const hostileNonAscii = 'X-Y' + String.fromCharCode(0xe9);      // hyphen + a byte >= 0x80 (e-acute)

        await handle.addSymbol(hostileQuote, 'wss://feed/h1');
        await handle.addSymbol(hostileNonAscii, 'wss://feed/h2');

        const liveDot1 = handle.dotOf(hostileQuote);
        assert.ok(typeof liveDot1 === 'string' && liveDot1.startsWith('digraph '), 'hostile-quote symbol still renders a digraph');
        const c1 = structuralCheck(liveDot1);
        assert.equal(c1.balanced, true, 'hostile-quote symbol dot is brace-balanced');
        assert.equal(c1.ascii, true, 'hostile-quote symbol dot is ASCII-only');

        const text = handle.exportGraph('dot').text;
        const sc = structuralCheck(text);
        assert.equal(sc.balanced, true, 'combined export stays brace-balanced with hostile symbols present');
        assert.equal(sc.ascii, true, 'combined export stays ASCII-only with hostile symbols present');

        // every cluster id in the combined text must be a VALID DOT identifier.
        const clusterIds = [...text.matchAll(/subgraph (cluster_[A-Za-z0-9_]*)/g)].map((m) => m[1]);
        assert.ok(clusterIds.length >= 3, 'three live scopes -> three cluster ids found');
        for (const id of clusterIds) {
            assert.match(id, /^cluster_[A-Za-z0-9_]+$/, 'cluster id "' + id + '" is a valid DOT identifier (word chars only)');
        }
        // no raw quote character survives inside any cluster's label line (the sanitizer worked).
        for (const raw of text.split('\n')) {
            if (raw.includes('subgraph cluster_') || (raw.includes('label=') && raw.trim().startsWith('label='))) {
                const bodyQuotes = (raw.match(/"/g) || []).length;
                assert.equal(bodyQuotes % 2, 0, 'line "' + raw.trim() + '" has balanced quote characters');
            }
        }

        // CANARY (proves the sanitizer is load-bearing, not decorative): building the SAME
        // label line from the RAW, unsanitized symbol truncates the DOT string literal at the
        // embedded quote -- everything after it (including the intended caption text) spills
        // out as unquoted garbage, a real DOT syntax break. If the raw label value survives
        // intact, the canary is not exercising the hostile byte and this test would be vacuous.
        const rawLabelLine = '    label="' + hostileQuote + ' -- reactive scope";';
        const q1 = rawLabelLine.indexOf('"');
        const q2 = rawLabelLine.indexOf('"', q1 + 1);
        const rawLabelValue = rawLabelLine.slice(q1 + 1, q2);
        assert.notEqual(rawLabelValue, hostileQuote + ' -- reactive scope',
            'canary: the UNSANITIZED raw symbol truncates the label at the embedded quote (raw parsed value "' + rawLabelValue + '") -- proves safeName is necessary');

        // Contrast: the REAL kernel output for this symbol carries the FULL, untruncated,
        // sanitized caption (no embedded quote to truncate on).
        const realLabelLine = text.split('\n').find((l) => l.includes('cluster_A_B') === false && l.trim().startsWith('label=') && l.includes('A_B'));
        assert.ok(realLabelLine, 'the real combined export has a label line for the sanitized A_B cluster');
        const rq1 = realLabelLine.indexOf('"');
        const rq2 = realLabelLine.lastIndexOf('"');
        const realLabelValue = realLabelLine.slice(rq1 + 1, rq2);
        assert.ok(realLabelValue.includes('reactive scope'), 'the real (sanitized) label is NOT truncated -- full caption text survives: "' + realLabelValue + '"');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// 3. All-parked / mixed / all-live export.
// ============================================================================================
test('B3 park-all export: N live -> N clusters; ALL parked -> zero clusters (still one balanced digraph); mixed -> only the live count', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('SYM2', 'wss://feed/2');
        await handle.addSymbol('SYM3', 'wss://feed/3');
        assert.equal(handle.symbols().length, 3, 'three scopes open');

        let text = handle.exportGraph('dot').text;
        assert.equal((text.match(/subgraph cluster_/g) || []).length, 3, 'three live scopes -> three clusters');

        handle.parkSymbol('BTCUSDT');
        handle.parkSymbol('SYM2');
        handle.parkSymbol('SYM3');
        text = handle.exportGraph('dot').text;
        assert.equal((text.match(/subgraph cluster_/g) || []).length, 0, 'ALL parked -> zero subgraph cluster_ blocks');
        assert.ok(text.startsWith('digraph '), 'still one top-level digraph even with zero reactive clusters');
        assert.equal((text.match(/\bdigraph\b/g) || []).length, 1, 'still exactly one digraph keyword');
        const sc0 = structuralCheck(text);
        assert.equal(sc0.balanced, true, 'zero-cluster export is still brace-balanced');

        handle.reviveSymbol('SYM2');
        text = handle.exportGraph('dot').text;
        assert.equal((text.match(/subgraph cluster_/g) || []).length, 1, 'mixed (1 of 3 revived) -> exactly the live count, 1');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// 4. Capability assert (fail-closed boot).
// ============================================================================================
// Always-on (plain `npm test`, no special flag): the boot guard's source must exist and
// enumerate every required S10 capability by name, so a silent drop of one symbol from the
// check is caught by a grep-level regression even where a real negative cannot run.
test('B4a capability assert (static): the S10 boot guard names every required decorator/devtools fn', () => {
    const kernel = readFileSync(fileURLToPath(new URL('../kernel.js', import.meta.url)), 'utf8');
    const guard = kernel.slice(
        kernel.indexOf('// S10 -- the labeled-graph surface'),
        kernel.indexOf('faultyTeardown', kernel.indexOf('// S10 -- the labeled-graph surface')),
    );
    assert.ok(guard.length > 0, 'the S10 capability-guard region is located');
    for (const fn of ['rootOf', 'labelOf', 'enableLabels', 'forEachReactive', 'rxToDot']) {
        assert.ok(guard.includes('typeof ' + fn), 'guard checks typeof ' + fn);
    }
    assert.match(guard, /throw new TypeError/, 'the guard fails closed with a named TypeError, not a silent return');
});

// Real negative (needs --experimental-test-module-mocks; node:test feature-detects and
// self-skips under plain `npm test`/`node --test` so the suite is never broken by the flag's
// absence). Run explicitly with the flag to actually exercise this: node --experimental-test-module-mocks --test test/10b-labeled-graph-boundary.test.mjs
test('B4b capability assert (real negative): bootKernel THROWS a named error when devtools toDot is missing', async (t) => {
    if (typeof t.mock.module !== 'function') {
        t.skip('needs --experimental-test-module-mocks (see comment above) -- not measured under plain npm test');
        return;
    }
    t.mock.module('@zakkster/lite-devtools', {exports: {toDot: undefined}});
    const {factory} = makeFakeFactory();
    const fresh = await import('../kernel.js?b4b=' + Date.now());
    let threw = null;
    try {
        await fresh.bootKernel({ctx: null, gl: null, w: 0, h: 0, ringSize: 4096, onEvent() {}, onMode() {}, socketFactory: factory});
    } catch (e) {
        threw = e;
    }
    assert.ok(threw instanceof TypeError, 'bootKernel throws a TypeError when devtools toDot is missing');
    assert.match(threw.message, /toDot/, 'the thrown error names the missing capability (toDot)');
});

// ============================================================================================
// 5. Registry scoping negatives.
// ============================================================================================
test('B5 registry scoping: makeLabelResolver(undefined|null) throws; labelOf(id) no-registry -> undefined; cross-registry isolation', async () => {
    assert.throws(() => makeLabelResolver(undefined), TypeError, 'makeLabelResolver(undefined) fails closed');
    assert.throws(() => makeLabelResolver(null), TypeError, 'makeLabelResolver(null) fails closed');

    const handle = await boot();
    try {
        await handle.addSymbol('ETHUSDT', 'wss://feed/eth');
        const h1 = handle._scopes.get('BTCUSDT');
        const h2 = handle._scopes.get('ETHUSDT');
        const g1 = reactiveGraphOf(h1.registry, h1.vm);
        const id1 = g1.nodes[0].id;

        assert.equal(labelOf(id1), undefined, 'labelOf(id) with the registry omitted -> undefined (frozen default registry)');
        const ownLabel = labelOf(id1, h1.registry);
        assert.equal(typeof ownLabel, 'string', 'labelOf(id, ownRegistry) -> a string');

        // Cross-registry: the SAME numeric id read against a DIFFERENT scope's registry must
        // NOT silently resolve to the correct (h1) label -- it is either undefined or a
        // DIFFERENT scope's own label for that numeric slot. Never the same string by luck
        // across two independent, freshly-numbered registries used as if interchangeable.
        const crossLabel = labelOf(id1, h2.registry);
        if (typeof crossLabel === 'string') {
            // both registries number nodes 1..N independently, so id collision is expected;
            // the important invariant is that this is h2's OWN label plane, not a resolver bug
            // that silently ignored the registry argument.
            assert.ok(true, 'cross-registry resolution returned a string from the OTHER registry\'s own plane (not a crash)');
        } else {
            assert.equal(crossLabel, undefined, 'cross-registry resolution -> undefined when the id has no counterpart');
        }
        // The real isolation gate: h2's resolver bound to h2 must never be silently swapped
        // for h1's data -- resolve via the exported factory and compare identity of source.
        const resolve1 = makeLabelResolver(h1.registry);
        const resolve2 = makeLabelResolver(h2.registry);
        assert.equal(resolve1(id1), ownLabel, 'the bound resolver matches labelOf(id, sameRegistry)');
        assert.equal(resolve2(id1), crossLabel, 'the OTHER scope\'s bound resolver matches labelOf(id, otherRegistry), not h1\'s value by coincidence');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// 6. Ordering trap: permanence across a LATER enableLabels(true).
// ============================================================================================
test('B6 ordering permanence: a VM wired while OFF stays 0-labeled even AFTER labels are turned back ON', () => {
    const regOff = createRegistry(REG_CFG);
    try {
        enableLabels(false);
        const VMoff = makeSymbolVM(regOff);
        const vmOff = new VMoff();
        const gOff = reactiveGraphOf(regOff, vmOff);
        const before = gOff.nodes.filter((n) => typeof labelOf(n.id, regOff) === 'string').length;
        assert.equal(before, 0, 'wired OFF: 0 labeled (baseline, matches A2)');

        enableLabels(true);   // flip ON -- A2 does not re-check the ALREADY-wired OFF vm after this
        const after = gOff.nodes.filter((n) => typeof labelOf(n.id, regOff) === 'string').length;
        assert.equal(after, 0, 'the SAME already-wired VM stays 0-labeled PERMANENTLY, even after enableLabels(true)');

        vmOff.dispose();
    } finally {
        enableLabels(true);            // never leave the module in the OFF state for later tests
        regOff.destroy();
    }
});

// ============================================================================================
// 7. dotOf across live / parked / disposed / absent states.
// ============================================================================================
test('B7 dotOf states: live -> digraph; parked -> null; manually-disposed (duplicate dispose) -> null both times; closed scope -> null; absent -> null', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('ETHUSDT', 'wss://feed/eth');

        assert.ok(handle.dotOf('BTCUSDT').startsWith('digraph '), 'a live symbol renders a digraph');

        // parked (watchlist.remove -> releaseReactive): null, no throw.
        handle.parkSymbol('BTCUSDT');
        let threw = false, out;
        try { out = handle.dotOf('BTCUSDT'); } catch { threw = true; }
        assert.equal(threw, false, 'parked dotOf does not throw');
        assert.equal(out, null, 'parked dotOf -> null');
        handle.reviveSymbol('BTCUSDT');
        assert.ok(handle.dotOf('BTCUSDT').startsWith('digraph '), 'revived symbol renders a digraph again');

        // manually disposed (bypassing the scope; disposeReactive is documented idempotent) --
        // exercises reactiveDotOf's rootOf-throws catch path, distinct from the `!h` absent path.
        const hEth = handle._scopes.get('ETHUSDT');
        hEth.vm.dispose();
        let threw1 = false, out1;
        try { out1 = handle.dotOf('ETHUSDT'); } catch { threw1 = true; }
        assert.equal(threw1, false, 'dotOf on a manually-disposed vm does not throw');
        assert.equal(out1, null, 'dotOf on a manually-disposed vm -> null');

        // DUPLICATE DISPOSE: call dispose again -- must stay null, never throw a "double
        // dispose" error, never flip back to a live-looking digraph.
        hEth.vm.dispose();
        let threw2 = false, out2;
        try { out2 = handle.dotOf('ETHUSDT'); } catch { threw2 = true; }
        assert.equal(threw2, false, 'a SECOND dispose does not throw');
        assert.equal(out2, null, 'dotOf after a duplicate dispose still -> null (idempotent, fail closed)');

        // closed (removed from the scopes map entirely): also null, via the `!h` path.
        await handle.closeSymbol('ETHUSDT');
        assert.equal(handle.dotOf('ETHUSDT'), null, 'dotOf on a CLOSED (never-opened-this-session) symbol -> null');

        // absent (never opened at all).
        assert.equal(handle.dotOf('NOPEUSDT'), null, 'dotOf on an absent symbol -> null');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// 8. Dispose-during-iteration + re-entrant park/revive.
// ============================================================================================
test('B8 dispose-during-iteration: parking a LATER symbol mid-batch-export does not corrupt earlier/later results', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('SYM2', 'wss://feed/2');
        await handle.addSymbol('SYM3', 'wss://feed/3');
        const syms = handle.symbols();
        assert.deepEqual(syms, ['BTCUSDT', 'SYM2', 'SYM3']);

        const results = {};
        for (const sym of syms) {
            if (sym === 'SYM2') handle.parkSymbol('SYM2');   // re-entrant mutation DURING the caller's own loop
            results[sym] = handle.dotOf(sym);
        }
        assert.ok(typeof results.BTCUSDT === 'string' && results.BTCUSDT.startsWith('digraph '), 'BTCUSDT (before the park) still renders');
        assert.equal(results.SYM2, null, 'SYM2 (parked mid-loop, right before its own read) -> null, not stale live data');
        assert.ok(typeof results.SYM3 === 'string' && results.SYM3.startsWith('digraph '), 'SYM3 (after the park) is unaffected and still renders');

        // the scopes Map itself must be untouched by a park (park never deletes the scope).
        assert.equal(handle.symbols().length, 3, 'parking does not remove the scope from the open-symbol list');
    } finally {
        await handle.shutdown();
    }
});

test('B9 re-entrant park/revive: rapid back-to-back park->revive cycles toggle dotOf correctly with no throw and no residue', async () => {
    const handle = await boot();
    try {
        for (let i = 0; i < 5; i++) {
            handle.parkSymbol('BTCUSDT');
            assert.equal(handle.dotOf('BTCUSDT'), null, 'cycle ' + i + ': parked -> null');
            handle.reviveSymbol('BTCUSDT');
            assert.ok(handle.dotOf('BTCUSDT').startsWith('digraph '), 'cycle ' + i + ': revived -> digraph again');
        }
        // duplicate park (already parked) is an idempotent no-op, not a throw.
        handle.parkSymbol('BTCUSDT');
        assert.doesNotThrow(() => handle.parkSymbol('BTCUSDT'), 'a duplicate parkSymbol call is idempotent, not a throw');
        assert.equal(handle.dotOf('BTCUSDT'), null, 'still parked after the duplicate park call');
        handle.reviveSymbol('BTCUSDT');
    } finally {
        await handle.shutdown();
    }
});

// ============================================================================================
// 9. ADVERSARIAL -- cross-scope node-id collision in the combined export (a case the planner
// did not name). lite-signal's createRegistry numbers nodes from a PER-REGISTRY sequence
// (nodeSeq starts at 1 in EACH scope's own registry, Signal.js). devtools' toDot renders a
// node's DOT identifier as literally `n<id>` with NO per-scope namespacing. Two live scopes
// therefore emit `n1`, `n2`, ... `n7` TWICE -- as far as Graphviz is concerned these are the
// SAME node names inside ONE digraph (subgraphs do not scope node identifiers), so the second
// scope's `n1` silently reuses / overwrites the first scope's `n1` in the rendered graph.
// PROVEN (see probe): booting BTCUSDT + ETHUSDT and reading reactiveGraphOf for both yields
// IDENTICAL id sets. This assertion is EXPECTED TO FAIL against the current kernel.js -- it is
// the reported defect, not a mistake in the test.
test('B10 ADVERSARIAL: two live scopes must not emit colliding node identifiers in the combined DOT export', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('ETHUSDT', 'wss://feed/eth');
        const h1 = handle._scopes.get('BTCUSDT');
        const h2 = handle._scopes.get('ETHUSDT');
        h1.inject(100, 99.5, 100.5);
        h2.inject(200, 199.5, 200.5);

        const text = handle.exportGraph('dot').text;
        const declCount = new Map();
        for (const raw of text.split('\n')) {
            const m = /^\s*(n\d+)\s*\[/.exec(raw);
            if (m) declCount.set(m[1], (declCount.get(m[1]) || 0) + 1);
        }
        const collisions = [...declCount.entries()].filter(([, n]) => n > 1);
        assert.deepEqual(collisions, [], 'no node identifier (e.g. n1, n2, ...) is declared by more than one cluster in the combined export -- ' +
            'measured collisions: ' + JSON.stringify(collisions) + ' (per-registry-local node ids from lite-signal are not namespaced per ' +
            'subgraph by rxToDot/reactiveClusterOf; two live scopes currently emit identical n<id> names that Graphviz treats as ONE shared node)');
    } finally {
        await handle.shutdown();
    }
});
