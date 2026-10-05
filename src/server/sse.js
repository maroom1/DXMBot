// Minimal Server-Sent Events helper. One call per streaming response:
//   const sse = openSSE(req, res);  sse.send('entry', {...});  sse.close();
// Heartbeat comments keep proxies and idle-timeouts from dropping the stream;
// everything is cleaned up automatically when the client disconnects.

export const DEFAULT_HEARTBEAT_MS = 15000;
// A client that stops reading is dropped once this much is buffered for it
// (it can reconnect; audit streams resume via Last-Event-ID).
export const MAX_BUFFERED_BYTES = 1024 * 1024;
// Open streams per server (registry); more are refused with 503.
export const MAX_SSE_CLIENTS = 64;

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
}

function refusedHandle() {
  const handle = {
    closed: true,
    send: () => false,
    comment: () => false,
    onClose(fn) {
      fn();
      return handle;
    },
    close() {},
  };
  return handle;
}

export function openSSE(req, res, { heartbeatMs = DEFAULT_HEARTBEAT_MS, retryMs = 3000, registry = null, maxClients = MAX_SSE_CLIENTS, maxBufferedBytes = MAX_BUFFERED_BYTES } = {}) {
  if (registry && registry.size >= maxClients) {
    const body = JSON.stringify({ error: 'Too many open event streams; try again later' });
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Retry-After': '5' });
    res.end(body);
    return refusedHandle();
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  req.socket?.setNoDelay?.(true);
  res.write(`retry: ${retryMs}\n\n`);

  let closed = false;
  const closeHandlers = [];

  // Writes one frame; drops a client that is not reading (unbounded buffering otherwise).
  function write(chunk) {
    res.write(chunk);
    if (res.writableLength > maxBufferedBytes) {
      handle.close();
      res.destroy();
    }
  }

  const timer = setInterval(() => {
    if (!closed) write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, heartbeatMs);
  timer.unref?.();

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    registry?.delete(handle);
    for (const fn of closeHandlers.splice(0)) {
      try {
        fn();
      } catch {
        // A failing listener must not prevent the others from running.
      }
    }
  }

  const handle = {
    get closed() {
      return closed;
    },
    // data: any JSON-serialisable value (strings are sent verbatim).
    send(event, data, { id } = {}) {
      if (closed || res.writableEnded || res.destroyed) return false;
      const payload = data === undefined ? '' : typeof data === 'string' ? data : JSON.stringify(data);
      let frame = '';
      if (id !== undefined && id !== null) frame += `id: ${oneLine(id)}\n`;
      if (event) frame += `event: ${oneLine(event)}\n`;
      for (const line of payload.split(/\r\n|\r|\n/)) frame += `data: ${line}\n`;
      write(frame + '\n');
      return !closed;
    },
    comment(text = '') {
      if (closed || res.writableEnded || res.destroyed) return false;
      write(`: ${oneLine(text)}\n\n`);
      return !closed;
    },
    onClose(fn) {
      if (closed) fn();
      else closeHandlers.push(fn);
      return handle;
    },
    close() {
      if (closed) return;
      cleanup();
      if (!res.writableEnded) res.end();
    },
  };

  // `res` (not `req`) 'close' is the reliable client-disconnect signal in Node >= 16.
  res.on('close', cleanup);
  res.on('error', cleanup);
  registry?.add(handle);
  return handle;
}
