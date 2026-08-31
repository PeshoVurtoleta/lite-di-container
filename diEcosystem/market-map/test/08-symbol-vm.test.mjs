// 08-symbol-vm.test.mjs -- the decorated symbol plane (S8). Proves the per-scope reactive
// VM (lite-signal-decorators' defineReactive on the scope's OWN registry): spec shape, the
// 10-node cost, the pin/unpin lattice + the shipped ABA contract, ordered teardown (VM
// disposed while the registry is still live), and effect-dirty-marks-never-renders (A5).
//
// Break control: MM_TORTURE_BREAK=1 arms the broken path in the A3 gate (skips vm.dispose)
// so the node-conservation assertion goes RED and the process exits non-zero -- the proof
// the gate is falsifiable. Reverted (unset) it runs green. A gate that cannot go RED is a
// house FAIL. (The kernel's per-scope registry.destroy is an unconditional backstop, so the
// break is expressed here at the registry/VM level where the gate actually measures.)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel, makeSymbolVM, SYMBOL_VM_SPEC} from '../kernel.js';
import {createRegistry} from '@zakkster/lite-signal';
import {costOf, ReactiveDisposedError} from '@zakkster/lite-signal-decorators';
import {SIGNAL_REGISTRY_TOKEN as DI_REGISTRY_TOKEN} from '@zakkster/lite-di-signal';

installRaf();

const BREAK = process.env.MM_TORTURE_BREAK === '1';
const mkReg = () => createRegistry({maxNodes: 64, maxLinks: 128, prealloc: 'eager', onCapacityExceeded: 'throw'});

test('spec shape: the four defineReactive sections, verbatim key names', () => {
    assert.deepEqual(Object.keys(SYMBOL_VM_SPEC), ['signals', 'deriveds', 'locals', 'effects'],
        'spec-object keys are signals/deriveds/locals/effects');
    assert.deepEqual(Object.keys(SYMBOL_VM_SPEC.signals), ['bid', 'ask', 'last', 'pinned', 'pinAnchor']);
    assert.deepEqual(Object.keys(SYMBOL_VM_SPEC.deriveds), ['mid', 'spread']);
    assert.deepEqual(Object.keys(SYMBOL_VM_SPEC.locals), ['alert']);
    assert.equal(typeof SYMBOL_VM_SPEC.locals.alert.source, 'function', 'localTo alert has a source');
    assert.equal(SYMBOL_VM_SPEC.locals.alert.initial, undefined, 'no initial -> localCopy flavor (follows upstream)');
    assert.deepEqual(Object.keys(SYMBOL_VM_SPEC.effects), ['onQuote']);
    assert.ok(Object.isFrozen(SYMBOL_VM_SPEC), 'spec is frozen -- shared by all scopes, mutated by none');
});

test('node count === 10 (costOf .nodes = 1 anchor + 5 signals + 1 local + 2 deriveds + 1 effect)', () => {
    const reg = mkReg();
    const cost = costOf(makeSymbolVM(reg));      // costOf's total-node field is `.nodes`
    assert.equal(cost.nodes, 10, 'ten reactive nodes per instance');
    assert.equal(cost.signals, 5);
    assert.equal(cost.locals, 1);
    assert.equal(cost.deriveds, 2);
    assert.equal(cost.effects, 1);
    reg.destroy();
});

test('A3 node conservation: +10 at construct, net 0 after dispose', () => {
    const reg = mkReg();
    const floor = reg.stats().activeNodes;
    const vm = new (makeSymbolVM(reg))();
    assert.equal(reg.stats().activeNodes - floor, 10, '+10 reactive nodes at construction');
    if (!BREAK) vm.dispose();                    // BREAK skips dispose -> net stays +10 -> next assert RED
    assert.equal(reg.stats().activeNodes - floor, 0, 'net 0 nodes after dispose (BREAK skips dispose -> RED)');
    reg.destroy();
});

test('pin/unpin lattice: follows mid, pin holds across moves, unpin resets to mid', () => {
    const reg = mkReg();
    const vm = new (makeSymbolVM(reg))();
    vm.bid = 100; vm.ask = 102;
    assert.equal(vm.mid, 101);
    assert.equal(vm.spread, 2);
    assert.equal(vm.alert, 101, 'unpinned alert follows mid');
    vm.pinAnchor = vm.mid; vm.pinned = true; vm.alert = 101;
    vm.bid = 200; vm.ask = 204;                  // mid moves to 202
    assert.equal(vm.mid, 202);
    assert.equal(vm.alert, 101, 'pinned alert holds the anchor across mid moves');
    vm.pinned = false;
    assert.equal(vm.alert, 202, 'unpin swings the alert back to live mid');
    vm.dispose();
    reg.destroy();
});

test('ABA contract: upstream A -> write X -> B -> back to A keeps the STALE local X', () => {
    const reg = mkReg();
    const vm = new (makeSymbolVM(reg))();
    vm.bid = 10; vm.ask = 10; void vm.alert;     // mid = A(10), adopt
    vm.alert = 999;                              // local write X
    vm.bid = 20; vm.ask = 20; void vm.alert;     // mid = B(20)
    vm.bid = 10; vm.ask = 10;                    // mid back to an equals-A value
    assert.equal(vm.alert, 999, 'reset keys on change-since-adoption, not mere movement -- stale X survives');
    vm.dispose();
    reg.destroy();
});

test('teardown order: reactiveService disposes the VM BEFORE the registry is destroyed', async () => {
    const {factory} = makeFakeFactory();
    const handle = await bootKernel({
        ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
        onEvent() {}, onMode() {}, socketFactory: factory,
    });
    const H = handle._scopes.get('BTCUSDT');
    const reg = H.scope.get(DI_REGISTRY_TOKEN);
    const order = [];
    // Spy the two teardown steps in place: the reactiveService onTeardown calls svc.dispose()
    // (own-property spy shadows the prototype method); createSignalScope's registry teardown
    // calls reg.destroy(). The order array is OBSERVED, so a resolution-order regression that
    // tore the registry down first would flip it -- this gate can go RED.
    const realDispose = H.vm.dispose.bind(H.vm);
    H.vm.dispose = () => { order.push('vm.dispose'); return realDispose(); };
    const realDestroy = reg.destroy.bind(reg);
    reg.destroy = () => { order.push('registry.destroy'); return realDestroy(); };

    await handle.closeSymbol('BTCUSDT');
    assert.deepEqual(order, ['vm.dispose', 'registry.destroy'],
        'VM.dispose fires while the registry is still live; registry.destroy drains last');
    await handle.shutdown();
});

test('post-shutdown vm read throws ReactiveDisposedError', async () => {
    const {factory} = makeFakeFactory();
    const handle = await bootKernel({
        ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
        onEvent() {}, onMode() {}, socketFactory: factory,
    });
    const H = handle._scopes.get('BTCUSDT');
    const vm = H.vm;
    await handle.closeSymbol('BTCUSDT');
    assert.throws(() => vm.mid, ReactiveDisposedError, 'a read after the scope shut down fails closed');
    await handle.shutdown();
});

test('A5 effect dirty-marks, never renders: source is DOM-free; 1e5 applies set frameDirty', async () => {
    // The effect body's SOURCE carries zero render surface -- proven statically.
    const src = SYMBOL_VM_SPEC.effects.onQuote.toString();
    assert.ok(!/\bdraw\b/.test(src), 'effect source has no draw');
    assert.ok(!/\bctx\b/.test(src), 'effect source has no ctx');
    assert.ok(!/\bdocument\b/.test(src), 'effect source has no document');

    // Headless (ctx:null) -> RenderSystem.update returns before it could clear frameDirty, so
    // 1e5 quote applies leave the marker SET: the effect fired, the frame never ran.
    const {factory} = makeFakeFactory();
    const handle = await bootKernel({
        ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
        onEvent() {}, onMode() {}, socketFactory: factory,
    });
    const H = handle._scopes.get('BTCUSDT');
    H.vm.frameDirty = false;
    for (let i = 0; i < 100000; i++) H.inject(100 + (i & 15), 100, 101);
    assert.equal(H.vm.frameDirty, true, 'the effect set frameDirty; nothing rendered to clear it');
    await handle.shutdown();
});
