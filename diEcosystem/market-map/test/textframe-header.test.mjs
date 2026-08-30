// textframe-header.test.mjs -- ASSERTION 6. node:test only, node builtins only.
// feed-server.mjs's textFrame() is not exported (it is an internal wire-encode
// helper), so this drives the REAL running server over a REAL TCP socket and
// inspects the raw bytes on the wire -- it proves the actual emitted frame,
// not a reimplementation of the header-encode logic.
//
// Claim under test: a 20-level depth20 payload exceeds 126 bytes, so
// textFrame's 2-byte extended-length branch fires and the frame's SECOND
// header byte is exactly 126 (RFC 6455 extended-length marker).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'feed-server.mjs');
const PORT = 8177; // fixed, unlikely-conflicting dev port for this test only

function waitForListening(child) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('feed-server did not report listening')), 5000);
        child.stdout.on('data', (chunk) => {
            if (chunk.toString('utf8').includes('streaming ticks')) {
                clearTimeout(timer);
                resolve();
            }
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('feed-server exited early with code ' + code));
        });
    });
}

// Scan a byte buffer for RFC 6455 unmasked server text frames. Returns the
// first frame whose header takes the 2-byte extended-length branch (the
// second header byte === 126), or null if the buffer holds no such frame yet.
function findExtendedLengthFrame(buf) {
    let offset = 0;
    while (offset + 2 <= buf.length) {
        const b0 = buf[offset], b1 = buf[offset + 1];
        if ((b0 & 0x0f) !== 0x1 && (b0 & 0x0f) !== 0x2) return {incomplete: true}; // not a text/binary frame -- desync
        const lenIndicator = b1 & 0x7f;
        if (lenIndicator === 126) {
            if (offset + 4 > buf.length) return {incomplete: true};
            const payloadLen = buf.readUInt16BE(offset + 2);
            return {found: true, secondByte: b1, payloadLen, frameEnd: offset + 4 + payloadLen};
        }
        if (lenIndicator === 127) {
            if (offset + 10 > buf.length) return {incomplete: true};
            const payloadLen = Number(buf.readBigUInt64BE(offset + 2));
            offset += 10 + payloadLen;
            continue;
        }
        offset += 2 + lenIndicator;
    }
    return {incomplete: true};
}

test('feed-server: a real depth20 frame on the wire takes the extended-length branch (header byte 2 === 126)', async () => {
    const child = spawn(process.execPath, [SERVER_PATH], {
        env: {...process.env, FEED_PORT: String(PORT)},
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

    try {
        await waitForListening(child);

        const result = await new Promise((resolve, reject) => {
            const sock = net.connect(PORT, '127.0.0.1');
            let buf = Buffer.alloc(0);
            let handshakeDone = false;
            const key = crypto.randomBytes(16).toString('base64');
            const timer = setTimeout(() => reject(new Error('timed out waiting for an extended-length frame')), 4000);

            sock.on('connect', () => {
                sock.write(
                    'GET / HTTP/1.1\r\n' +
                    'Host: 127.0.0.1:' + PORT + '\r\n' +
                    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                    'Sec-WebSocket-Key: ' + key + '\r\n' +
                    'Sec-WebSocket-Version: 13\r\n\r\n');
            });

            sock.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                if (!handshakeDone) {
                    const idx = buf.indexOf('\r\n\r\n');
                    if (idx === -1) return;
                    assert.match(buf.slice(0, idx).toString('utf8'), /101 Switching Protocols/);
                    buf = buf.slice(idx + 4); // keep any wire-frame bytes that arrived right after the response
                    handshakeDone = true;
                }
                const r = findExtendedLengthFrame(buf);
                if (r.found) {
                    clearTimeout(timer);
                    sock.destroy();
                    resolve(r);
                }
                // else: incomplete (short frames like aggTrade, or a partial depth frame) -- keep buffering
            });

            sock.on('error', (e) => {
                clearTimeout(timer);
                reject(e);
            });
        });

        assert.equal(result.secondByte, 126, 'expected the extended-length marker byte 126');
        assert.ok(result.payloadLen > 126 && result.payloadLen < 65536,
            'expected a depth20 payload strictly between 126 and 65536 bytes, got ' + result.payloadLen);
    } finally {
        child.kill();
    }
});
