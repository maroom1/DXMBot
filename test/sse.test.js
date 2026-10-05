import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openSSE } from '../src/server/sse.js';

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('SSE drops a client that stops reading instead of buffering without limit', async () => {
  let handle;
  const { server, port } = await serve((req, res) => {
    handle = openSSE(req, res, { maxBufferedBytes: 64 * 1024 });
    const chunk = 'x'.repeat(16 * 1024);
    for (let i = 0; i < 2000 && !handle.closed; i++) handle.send('entry', chunk);
  });
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      res.pause(); // never read
      const wait = setInterval(() => {
        if (handle?.closed) {
          clearInterval(wait);
          req.destroy();
          resolve();
        }
      }, 10);
    });
    req.on('error', () => {});
  });
  assert.equal(handle.closed, true);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test('SSE refuses streams beyond the client cap with 503', async () => {
  const registry = new Set();
  const handles = [];
  const { server, port } = await serve((req, res) => handles.push(openSSE(req, res, { registry, maxClients: 1 })));
  const open = () =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => resolve({ req, status: res.statusCode }));
    });
  const first = await open();
  const second = await open();
  assert.equal(first.status, 200);
  assert.equal(second.status, 503);
  assert.equal(handles[1].closed, true);
  let ran = false;
  handles[1].onClose(() => (ran = true));
  assert.equal(ran, true, 'onClose runs immediately for a refused stream');
  first.req.destroy();
  second.req.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
