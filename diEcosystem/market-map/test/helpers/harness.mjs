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
export function makeFakeFactory() {
    const created = [];
    const factory = (reg) => ({
        createSocket(url, opts) {
            const sock = {
                disposed: false,
                url, opts,
                send() {},
                close() {},
                dispose() { this.disposed = true; },
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
