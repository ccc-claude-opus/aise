import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { aiseHome, getProvider, type Provider } from '@aise/llm';
import { Store, type TaskEvent } from './store.ts';
import { Worker } from './worker.ts';

export { Store, type Task, type TaskEvent, type TaskStatus } from './store.ts';
export { Worker } from './worker.ts';

export interface ServerOptions {
  /** Repository the agents work on. */
  root: string;
  host?: string;
  port?: number;
  token: string;
  /** Data directory for the database; default AISE_HOME. */
  home?: string;
  provider?: () => Provider;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** The token clients present; created on first use and kept in AISE_HOME/server.json. */
export function serverToken(home = aiseHome()): string {
  const file = path.join(home, 'server.json');
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { token: string }).token;
  } catch {
    const token = randomBytes(24).toString('base64url');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ token }, null, 2) + '\n', { mode: 0o600 });
    return token;
  }
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const home = opts.home ?? aiseHome();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(home, 'aise.db'));
  const worker = new Worker({ store, root: opts.root, provider: opts.provider ?? (() => getProvider()) });
  const app = Fastify();

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!sameToken(token, opts.token)) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/health', async () => ({ ok: true }));

  app.post<{ Body: { kind?: string; input?: unknown } }>('/tasks', async (req, reply) => {
    const { kind, input } = req.body ?? {};
    if (!kind || !Worker.kinds.includes(kind)) {
      return reply.code(400).send({ error: `kind must be one of: ${Worker.kinds.join(', ')}` });
    }
    if (kind === 'ask' && typeof (input as { question?: unknown })?.question !== 'string') {
      return reply.code(400).send({ error: 'ask needs input.question' });
    }
    const task = store.createTask(kind, input);
    worker.poke();
    return reply.code(201).send(task);
  });

  app.get('/tasks', async () => store.listTasks());

  app.get<{ Params: { id: string } }>('/tasks/:id', async (req, reply) => {
    return store.getTask(req.params.id) ?? reply.code(404).send({ error: 'not found' });
  });

  // Server-sent events. Replays the log after Last-Event-ID (or ?after=) so a phone
  // that drops its connection picks up exactly where it left off.
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/tasks/:id/events', (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: 'not found' });
    let last = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (ev: TaskEvent) => {
      if (ev.seq <= last) return;
      last = ev.seq;
      res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      if (ev.type === 'succeeded' || ev.type === 'failed') end();
    };
    const onEvent = (ev: TaskEvent) => ev.taskId === task.id && send(ev);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const end = () => {
      clearInterval(ping);
      worker.events.off('event', onEvent);
      res.end();
    };
    // Subscribe before replaying so nothing slips between the two.
    worker.events.on('event', onEvent);
    req.raw.on('close', end);
    for (const ev of store.eventsAfter(task.id, last)) send(ev);
    const now = store.getTask(task.id)!;
    if (now.status === 'succeeded' || now.status === 'failed') end();
  });

  const host = opts.host ?? '127.0.0.1';
  await app.listen({ host, port: opts.port ?? 7420 });
  worker.start();
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    async close() {
      await worker.stop();
      await app.close();
      store.close();
    },
  };
}
