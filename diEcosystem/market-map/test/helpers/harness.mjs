// test/helpers/harness.mjs -- headless seams shared by the S6 node:test files.
//
// lite-raf fails closed without a global requestAnimationFrame (correct behavior); a
// headless kernel boot must install a shim first. The shim is setTimeout-backed and
// cancelAnimationFrame clears the pending timer, so ticker.stop() inside handle.shutdown()
// lets the process exit with no hanging frame. Idempotent: installed once per process.
export function installRaf() {
    if (typeof globalThis.requestAnimationFrame !== 'function') {
        globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
        globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    }
}

// A scripted socket factory matching the exact lite-ws surface the kernel pulls
// (status/isOpen/latency/reconnectAttempts/poll/dispose) plus send/close. Every socket
// it hands out is pushed to the observable `created` array; dispose() flips `disposed`
// so a heal (fresh socket) is provable. No network, no timers.
//
// dispose() drops `opts` (and its `onMessage`) on release. Faithful to the REAL
// @zakkster/lite-ws socket: its dispose() nulls the live WebSocket (`ws = null`), which
// was the only thing keeping `ws.onmessage` (closing over the kernel's onMessage ->
// dispatch -> the whole per-symbol scope) reachable once the scope itself is torn down.
// Without this, `created[]` -- a TEST-ONLY diagnostic array, pinned for the whole
// kernel-instance lifetime by the injected socketFactory closure -- would keep every
// HISTORICAL socket's onMessage->dispatch->scope chain reachable forever, long after
// closeSymbol/forget() drop their own references. That is a harness artifact, not a
// production retention path (a real socket's dispose() releases it; the DI container
// never pins a torn-down child -- Container.js's _liveChildren is a count, not a ref
// array). Nulling opts here makes `created[]` an inert dead-socket record (url/disposed
// only), matching the real socket's post-dispose shape, so scope-internal retention
// gates (e.g. a park/revive feedGate check) measure the real system, not this fixture.
export function makeFakeFactory() {
    const created = [];
    const factory = (reg) => ({
        createSocket(url, opts) {
            const sock = {
                disposed: false,
                url, opts,
                send() {},
                close() {},
                dispose() { this.disposed = true; this.opts = null; },
                status() { return 'open'; },
                isOpen() { return true; },
                latency() { return 1; },
                reconnectAttempts() { return 0; },
                poll() {},
            };
            created.push(sock);
            return sock;
        },
    });
    return {factory, created};
}
