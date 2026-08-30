// feed-server.mjs -- a zero-dependency WebSocket tick server for the market-map demo.
// Streams synthetic market ticks as JSON text frames so the browser can consume a REAL
// socket via @zakkster/lite-ws. Node builtins only (http + crypto for the WS handshake).
//
//   node feed-server.mjs            # listens on ws://127.0.0.1:8100
//
// SEAM: this stands in for a real exchange feed. Point lite-ws at wss://<exchange> instead.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.FEED_PORT || 8100);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Encode a single unmasked text frame (server->client). Payloads here are small JSON.
function textFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
        header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127;
        header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
    }
    return Buffer.concat([header, payload]);
}

const server = http.createServer((_req, res) => { res.writeHead(426); res.end('WebSocket only'); });

server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    // per-connection random walk. Emits the SAME shapes as the live Binance combined
    // stream: a depth20 partial snapshot every 100ms and an aggTrade roughly every 300ms.
    // (This is the LOCAL synthetic feed; allocation here is irrelevant -- it is a dev tool,
    // not a browser hot path.) A 20-level depth payload exceeds 126 bytes, so it exercises
    // the 2-byte extended-length branch in textFrame that the old top-of-book shape never hit.
    let mid = 100 + Math.random() * 40, seq = 0, aggId = 0, tick = 0, alive = true;
    const emitDepth = () => {
        mid += (Math.random() - 0.5) * 0.8;
        const half = 0.4 + Math.random() * 0.3;
        const bids = [], asks = [];
        for (let i = 0; i < 20; i++) {
            bids.push([(mid - half - i * 0.01).toFixed(2), (Math.random() * 5).toFixed(5)]);
            asks.push([(mid + half + i * 0.01).toFixed(2), (Math.random() * 5).toFixed(5)]);
        }
        const msg = JSON.stringify({ stream: 'btcusdt@depth20@100ms', data: { lastUpdateId: ++seq, bids, asks } });
        try { socket.write(textFrame(msg)); } catch { /* backpressure/closed */ }
    };
    const emitAgg = () => {
        const now = Date.now();
        const msg = JSON.stringify({
            stream: 'btcusdt@aggTrade',
            data: { e: 'aggTrade', E: now, s: 'BTCUSDT', a: ++aggId,
                p: (mid + (Math.random() - 0.5)).toFixed(2), q: (Math.random() * 0.5).toFixed(5),
                m: Math.random() < 0.5, M: true, T: now },
        });
        try { socket.write(textFrame(msg)); } catch { /* backpressure/closed */ }
    };
    const timer = setInterval(() => {
        if (!alive) return;
        emitDepth();
        if ((tick % 3) === 0) emitAgg();
        tick++;
    }, 100);

    // respond to a client heartbeat ping (lite-ws sends an app-level payload the server echoes)
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // minimal frame parse: opcode in low nibble of byte 0; 0x8 = close
        if (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            if (opcode === 0x8) { alive = false; clearInterval(timer); try { socket.end(); } catch {} }
            buf = Buffer.alloc(0);   // demo: we don't need masked-payload decode
        }
    });
    const shut = () => { alive = false; clearInterval(timer); };
    socket.on('close', shut); socket.on('error', shut);
});

server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write('feed-server: streaming ticks on ws://127.0.0.1:' + PORT + '\n');
});
