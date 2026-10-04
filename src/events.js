/**
 * Server-Sent Events hub.
 * Each run gets a channel; subscribers receive live log lines, progress and
 * lifecycle events while a test is executing.
 */
class EventHub {
  constructor() {
    /** @type {Map<string, Set<import('node:http').ServerResponse>>} */
    this.channels = new Map();
  }

  subscribe(topic, res, { replay = [] } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    for (const item of replay) {
      this.write(res, item.event, item.data);
    }

    if (!this.channels.has(topic)) this.channels.set(topic, new Set());
    this.channels.get(topic).add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.channels.get(topic)?.delete(res);
      if (this.channels.get(topic)?.size === 0) this.channels.delete(topic);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
  }

  write(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  publish(topic, event, data) {
    const subs = this.channels.get(topic);
    const payload = { ...data, __event: event, __ts: Date.now() };
    if (event === 'log' || event === 'progress' || event === 'status') {
      const buf = this.buffers.get(topic) ?? [];
      if (event !== 'progress' || buf.length < 50) buf.push({ event, data: payload });
      this.buffers.set(topic, buf.slice(-400));
    }
    if (!subs) return;
    for (const res of subs) {
      try {
        this.write(res, event, payload);
      } catch {
        subs.delete(res);
      }
    }
  }

  /** Recent events, so a page reload does not lose the log tail. */
  buffers = new Map();

  recent(topic) {
    return this.buffers.get(topic) ?? [];
  }

  clear(topic) {
    this.buffers.delete(topic);
  }
}

export const events = new EventHub();
