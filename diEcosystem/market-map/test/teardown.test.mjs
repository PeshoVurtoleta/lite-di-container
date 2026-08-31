// teardown.test.mjs -- headless proof that a clean shutdown narrates its teardown in
// reverse-topological order through the onEvent seam and NEVER touches the real console.
//
// The demo narrates teardown via onEvent/log, not console. Both narration seams observe
// REALITY, so this gate can go RED: (1) each scope emits a single 'closed -- teardown:'
// line whose walk is built from the ORDER THE CONTAINER ACTUALLY FIRES each disposable's
// onTeardown (kernel.js teardownWalk), and (2) the parent cron disposables narrate
// PER-ITEM as the container fires them. We deep-equal both against expectations derived
// INDEPENDENTLY here from the known resolution/registration order -- reorder the real
// resolves or registrations in kernel.js and one of these deep-equals fails.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

// Expected reverse-resolve order, derived independently of any kernel constant. The scope
// resolves the signal-registry FIRST (pinned index 0), then bus, traceBus, and finally
// feed (opened by sup.start()). Reverse-topological teardown therefore fires the real
// disposables feed -> traceBus -> bus, with the registry LAST. tape/agg/book are in the
// resolution order but carry no narration onTeardown hook, so they do not appear.
const SCOPE_TEARDOWN = ['feed', 'traceBus', 'bus', 'signal-registry'];
const CRON_REGISTER = ['aggregate', 'prune', 'heartbeat', 'perf'];          // cron job registration order (bootKernel)

test('clean shutdown narrates reverse teardown order and never touches console', async () => {
    const {factory} = makeFakeFactory();
    const events = [];
    const handle = await bootKernel({
        ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
        onEvent: (k, m) => events.push(m), onMode() {}, socketFactory: factory,
    });
    events.length = 0;                                          // drop boot narration; capture only shutdown

    const orig = {log: console.log, info: console.info, warn: console.warn, error: console.error};
    const cap = [];
    console.log = console.info = console.warn = console.error = (...a) => cap.push(a.join(' '));
    try {
        await handle.shutdown();
    } finally {
        console.log = orig.log;
        console.info = orig.info;
        console.warn = orig.warn;
        console.error = orig.error;
    }

    assert.equal(cap.length, 0, 'a clean shutdown logs to onEvent, never the real console');

    const walkLine = events.find((m) => m.includes('closed -- teardown:'));
    assert.ok(walkLine, 'the scope narrates its teardown walk');
    const walk = walkLine.split('teardown:')[1].trim().split(' -> ');
    assert.deepEqual(walk, SCOPE_TEARDOWN, 'scope disposables fire in reverse-topological order');

    const cronOrder = events
        .filter((m) => m.startsWith('teardown: cron:'))
        .map((m) => m.slice('teardown: cron:'.length));
    assert.deepEqual(cronOrder, CRON_REGISTER.slice().reverse(), 'cron disposables tear down in reverse registration order');
});
