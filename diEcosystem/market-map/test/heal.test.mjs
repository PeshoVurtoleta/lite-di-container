// heal.test.mjs -- headless proof that the per-scope supervisor heals the feed:
// a fault dials a FRESH socket, disposes the faulted one, and counts the restart.
// No network, no canvas: the injected fake socketFactory carries the whole feed surface.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installRaf, makeFakeFactory} from './helpers/harness.mjs';
import {bootKernel} from '../kernel.js';

installRaf();

test('supervisor heals the feed: fresh socket, old disposed, restart counted', async () => {
    const {factory, created} = makeFakeFactory();
    const handle = await bootKernel({
        ctx: null, gl: null, w: 0, h: 0, ringSize: 4096,
        onEvent() {}, onMode() {}, socketFactory: factory,
    });
    try {
        const scope = handle._scopes.get('BTCUSDT');           // boot opens one live symbol scope
        assert.ok(scope, 'boot opens the BTCUSDT scope');
        assert.equal(created.length, 1, 'boot dialed exactly one socket');
        assert.equal(scope.state().restarts, 0, 'no restarts before the fault');

        await scope.sup.reportFault('feed');                   // supervisor re-resolves the feed child

        assert.equal(scope.state().restarts, 1, 'one restart recorded');
        assert.equal(created.length, 2, 'a second (fresh) socket was dialed');
        assert.equal(created[0].disposed, true, 'the faulted socket was disposed');
        assert.equal(created[1].disposed, false, 'the fresh socket is live');
    } finally {
        await handle.shutdown();
    }
});
