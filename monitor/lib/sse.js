// Server-sent events: one-way live updates to the page, no dependencies. Messages are {type, data, timestamp}.
'use strict';

function createStream() {
  const clients = new Set();
  const ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);
  ping.unref();
  return {
    handler(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },
    broadcast(msg) {
      const line = `data: ${JSON.stringify(msg)}\n\n`;
      for (const res of clients) res.write(line);
    },
    size: () => clients.size,
  };
}

module.exports = { createStream };
