// 10-labeled-graph.test.mjs -- the labeled reactive graph (S10, terminal). Proves the whole
// kernel renders as ONE self-describing DOT: the di-graph container digraph with, nested
// inside it, one `subgraph cluster_<sym>` per live scope, every reactive node carrying its
// decorated member name (SymbolVMBase@anchor, SymbolVMBase.bid, SymbolVMBase#onQuote, ...).
//
// The assertions are the S10-RECONCILIATION corrected set (C3/C4). The STEADY-STATE floor a
// user actually exports is 7 reactive nodes (anchor, bid, ask, pinned, mid, spread, onQuote).
// `alert` (the @localTo localCopy) is a graph node ONLY in the pristine, never-ticked window:
// on the FIRST quote write the onQuote effect re-runs and PERMANENTLY drops its tracked read
// of alert (stable 7 for every subsequent tick, proven under the pinned versions 1.5.0 x3).
// A1 therefore pumps one quote first (the state the shipped artifact reflects) before asserting
// 7. The real, state-independent gate is unlabeled === 0 -- which the reconciliation designates
// authoritative and which holds in BOTH the pristine (8) and steady (7) windows.
//
// Headless: the S6 boot seam (injected socketFactory + cold glSinks). node:test only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel, makeSymbolVM, reactiveGraphOf, makeLabelResolver} from '../kernel.js';
import {enableLabels, labelOf, rootOf, forEachReactive, ReactiveDisposedError} from '@zakkster/lite-signal-decorators';
import {createRegistry} from '@zakkster/lite-signal';
import {SIGNAL_REGISTRY_TOKEN as DI_REGISTRY_TOKEN} from '@zakkster/lite-di-signal';

installRaf();

const LABEL_RE = /^SymbolVMBase([.#@]\w+)$/;
const FLOOR_NODES = 7;                 // steady state: anchor, bid, ask, pinned, mid, spread, onQuote
const REG_CFG = {maxNodes: 64, maxLinks: 128, prealloc: 'eager', onCapacityExceeded: 'throw'};

async function boot() {
    const {factory} = makeFakeFactory();
    return bootKernel({ctx: null, gl: null, w: 0, h: 0, ringSize: 4096, onEvent() {}, onMode() {}, socketFactory: factory});
}

// ---- A1: every rendered node is labeled (the real gate); deterministic floor count -------
test('A1 labeled: post-quote live-scope SymbolVM walk = 7 nodes, EVERY node labelOf(id,reg) is a string (unlabeled === 0), labels match /^SymbolVMBase.../', async () => {
    const handle = await boot();
    try {
        const h = handle._scopes.get('BTCUSDT');
        const reg = h.scope.get(DI_REGISTRY_TOKEN);
        // Pump one quote through the REAL feed seam (inject -> dispatch -> bus -> AggApply ->
        // vm.bid/ask/last). The onQuote effect re-runs and drops its tracked read of `alert`,
        // so the walk settles at the 7-node steady state the shipped export reflects. Asserting
        // the pristine 8 (never-ticked) would be a latent flake -- one quote flips it to 7.
        h.inject(100, 99.5, 100.5);
        const g = reactiveGraphOf(reg, h.vm);

        // THE REAL GATE (state-independent, C3): zero unlabeled rendered nodes.
        const labels = g.nodes.map((n) => labelOf(n.id, reg));
        const unlabeled = labels.filter((l) => typeof l !== 'string').length;
        assert.equal(unlabeled, 0, 'every rendered reactive node carries a string label (unlabeled === 0)');

        // Deterministic steady-state floor count (documented live-topology property): 7 post-quote.
        assert.equal(g.nodes.length, FLOOR_NODES, 'the steady-state floor is ' + FLOOR_NODES + ' reachable reactive nodes');

        // Every label is a decorated member name of the SymbolVMBase class.
        for (const l of labels) {
            assert.match(l, LABEL_RE, 'label "' + l + '" is a SymbolVMBase member name');
        }
        // The anchor is present (proves the walk reaches the reactive root).
        assert.ok(labels.includes('SymbolVMBase@anchor'), 'the anchor node is labeled SymbolVMBase@anchor');
    } finally {
        await handle.shutdown();
    }
});

// ---- A2: the enableLabels ordering trap is load-bearing (falsifiable BOTH ways) ----------
test('A2 ordering: a VM wired with enableLabels(false) -> 0 labeled; enableLabels(true), wire another -> all labeled', () => {
    const regOff = createRegistry(REG_CFG);
    const regOn = createRegistry(REG_CFG);
    try {
        // OFF at wiring time -> the VM's nodes register NO labels, forever.
        enableLabels(false);
        const VMoff = makeSymbolVM(regOff);
        const vmOff = new VMoff();
        const gOff = reactiveGraphOf(regOff, vmOff);
        const labeledOff = gOff.nodes.filter((n) => typeof labelOf(n.id, regOff) === 'string').length;
        assert.ok(gOff.nodes.length > 0, 'the OFF VM still forms its reactive graph');
        assert.equal(labeledOff, 0, 'labels OFF at wiring -> zero labeled nodes (the trap)');

        // ON at wiring time -> every node labeled. (This restores the module default too.)
        enableLabels(true);
        const VMon = makeSymbolVM(regOn);
        const vmOn = new VMon();
        const gOn = reactiveGraphOf(regOn, vmOn);
        const labeledOn = gOn.nodes.filter((n) => typeof labelOf(n.id, regOn) === 'string').length;
        assert.ok(gOn.nodes.length > 0, 'the ON VM forms its reactive graph');
        assert.equal(labeledOn, gOn.nodes.length, 'labels ON at wiring -> every node labeled');

        vmOff.dispose();
        vmOn.dispose();
    } finally {
        enableLabels(true);                          // never leave the module in the OFF state
        regOff.destroy();
        regOn.destroy();
    }
});

// ---- A3: labelOf's registry argument is mandatory (registry scoping) ---------------------
test('A3 scoping: labelOf(id) with the registry omitted -> undefined for a scoped id; labelOf(id, reg) -> the string', async () => {
    const handle = await boot();
    try {
        const h = handle._scopes.get('BTCUSDT');
        const reg = h.scope.get(DI_REGISTRY_TOKEN);
        const g = reactiveGraphOf(reg, h.vm);
        const id = g.nodes[0].id;

        assert.equal(labelOf(id), undefined, 'a scoped id against the frozen default registry -> undefined');
        assert.equal(typeof labelOf(id, reg), 'string', 'the same id against its scope registry -> a string');
        // The exported resolver binds the registry so callers cannot forget it.
        const resolve = makeLabelResolver(reg);
        assert.equal(resolve(id), labelOf(id, reg), 'makeLabelResolver(reg) resolves against the scope registry');
    } finally {
        await handle.shutdown();
    }
});

// ---- A4: the combined DOT is structurally valid + ASCII (no Graphviz needed) -------------
test('A4 DOT: combined export starts with `digraph `, balanced braces, exactly one digraph + N clusters for N live scopes, no dangling edge, ASCII', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('ETHUSDT', 'wss://feed/ETHUSDT');   // two live scopes
        const liveScopes = handle.symbols().length;
        assert.equal(liveScopes, 2, 'two live scopes are open');

        const out = handle.exportGraph('dot');
        assert.ok(out && typeof out.text === 'string', 'exportGraph(dot) returns a text artifact');
        const text = out.text;

        assert.ok(text.startsWith('digraph '), 'the artifact is one top-level digraph');

        // exactly one `digraph` (the container); the reactive planes are `subgraph`s.
        assert.equal((text.match(/\bdigraph\b/g) || []).length, 1, 'exactly one digraph keyword');
        // one `subgraph cluster_` per live scope.
        assert.equal((text.match(/subgraph cluster_/g) || []).length, liveScopes, 'one cluster per live scope');

        // balanced, never-negative brace nesting.
        let depth = 0, everNegative = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            if (ch === 0x7b) depth++;                // {
            else if (ch === 0x7d) { depth--; if (depth < 0) everNegative = true; }   // }
            assert.ok(ch < 0x80, 'byte at ' + i + ' is ASCII (< 0x80)');
        }
        assert.equal(everNegative, false, 'brace nesting never goes negative');
        assert.equal(depth, 0, 'braces balance to zero');

        // no dangling edge endpoint: every id in an edge is a declared node id.
        const declared = new Set();
        const edges = [];
        for (const raw of text.split('\n')) {
            const line = raw.trim();
            const em = /^"?([A-Za-z_]\w*)"?\s*->\s*"?([A-Za-z_]\w*)"?/.exec(line);
            if (em) { edges.push([em[1], em[2]]); continue; }
            // a node declaration: leading token followed by `[`, and NOT the default-attr line.
            const nm = /^"?([A-Za-z_]\w*)"?\s*\[/.exec(line);
            if (nm && nm[1] !== 'node') declared.add(nm[1]);
        }
        assert.ok(edges.length > 0, 'the combined graph carries reactive edges');
        for (const [from, to] of edges) {
            assert.ok(declared.has(from), 'edge tail ' + from + ' is a declared node');
            assert.ok(declared.has(to), 'edge head ' + to + ' is a declared node');
        }
    } finally {
        await handle.shutdown();
    }
});

// ---- A5: cold path only + parked returns null (never throws) -----------------------------
test('A5 cold+parked: dotOf on a parked symbol returns null (no throw); parked scope is skipped in the combined export; no cold-graph call in RenderSystem.update', async () => {
    const handle = await boot();
    try {
        await handle.addSymbol('ETHUSDT', 'wss://feed/ETHUSDT');

        // a LIVE symbol renders a real digraph.
        const liveDot = handle.dotOf('ETHUSDT');
        assert.ok(typeof liveDot === 'string' && liveDot.startsWith('digraph '), 'a live symbol renders a digraph');

        // PARK it (releaseReactive): dotOf must return null, not throw (rootOf throws
        // ReactiveDisposedError on a parked VM; reactiveDotOf catches it).
        handle.parkSymbol('ETHUSDT');
        let parkedDot, threw = false;
        try { parkedDot = handle.dotOf('ETHUSDT'); } catch { threw = true; }
        assert.equal(threw, false, 'dotOf on a parked symbol does not throw');
        assert.equal(parkedDot, null, 'dotOf on a parked symbol returns null (fail closed)');

        // an absent symbol also returns null.
        assert.equal(handle.dotOf('NOPEUSDT'), null, 'dotOf on an unopened symbol returns null');

        // the combined export SKIPS the parked scope -> one cluster (BTCUSDT), not two.
        const text = handle.exportGraph('dot').text;
        assert.equal((text.match(/subgraph cluster_/g) || []).length, 1, 'the parked scope is skipped in the combined export');
    } finally {
        await handle.shutdown();
    }
});

// ---- A5 (static): no cold-graph call leaks into ANY tick consumer ------------------------
// The cold-path law covers every per-tick body, not just RenderSystem.update: AggApply.handle
// (per emitted tick), BurstSystem.update (per frame while bursting), the dispatch seam (per
// decoded frame), RenderSystem.update (per frame), and index.html's HUD interval (every 120ms).
// A carve helper slices each named region by literal boundary markers and proves none of the
// cold-graph functions appear in it. Matching how the export button (cold, click-only) is the
// ONLY legitimate caller.
test('A5 cold-path grep: no rxToDot/reactiveGraphOf/reactiveDotOf/reactiveClusterOf/dotOf/labelOf appears in any tick consumer', () => {
    const kernel = readFileSync(fileURLToPath(new URL('../kernel.js', import.meta.url)), 'utf8');
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const FORBIDDEN = ['rxToDot', 'reactiveGraphOf', 'reactiveDotOf', 'reactiveClusterOf', 'dotOf', 'labelOf'];

    const carve = (src, from, to, name) => {
        const a = src.indexOf(from);
        assert.ok(a >= 0, name + ': start marker "' + from + '" located');
        const b = src.indexOf(to, a + from.length);
        assert.ok(b > a, name + ': end marker "' + to + '" located');
        return src.slice(a, b);
    };

    const regions = [
        ['AggApply.handle', carve(kernel, 'class AggApply {', 'class TradeApply {', 'AggApply')],
        ['BurstSystem.update', carve(kernel, 'export class BurstSystem {', 'function drawFrame', 'BurstSystem')],
        ['dispatch seam', carve(kernel, 'const dispatch = (f) => {', '// S5 burst: ONE reused', 'dispatch')],
        ['RenderSystem.update', carve(kernel, 'class RenderSystem {', 'function createSymbolScope', 'RenderSystem')],
        ['HUD interval', carve(html, 'let hudTick = 0;', '}, 120);', 'HUD')],
    ];

    for (const [name, body] of regions) {
        for (const tok of FORBIDDEN) {
            assert.equal(body.includes(tok), false, tok + ' must not appear in ' + name + ' (cold only)');
        }
    }
});
