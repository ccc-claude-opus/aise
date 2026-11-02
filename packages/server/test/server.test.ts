import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@aise/llm';
import { Store, startServer, type RunningServer } from '../src/index.ts';

const TOKEN = 'test-token';
let server: RunningServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function tmp(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function api(method: string, route: string, body?: unknown, token = TOKEN) {
  const res = await fetch(server!.url + route, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function readEvents(id: string, after = 0) {
  const res = await fetch(`${server!.url}/tasks/${id}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, 'last-event-id': String(after) },
  });
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((b) => ({
      id: Number(/^id: (\d+)/m.exec(b)![1]),
      type: /^event: (.+)$/m.exec(b)![1],
      data: JSON.parse(/^data: (.+)$/m.exec(b)![1]),
    }));
}

describe('server', () => {
  it('rejects requests without the token', async () => {
    const root = tmp('aise-repo-');
    server = await startServer({ root, home: tmp('aise-home-'), port: 0, token: TOKEN, provider: () => new MockProvider() });
    expect((await api('GET', '/tasks', undefined, 'wrong')).status).toBe(401);
    expect((await fetch(server.url + '/health')).status).toBe(200);
  });

  it('runs an ask task in the background and streams its events', async () => {
    const root = tmp('aise-repo-');
    fs.writeFileSync(path.join(root, 'README.md'), '# demo');
    server = await startServer({ root, home: tmp('aise-home-'), port: 0, token: TOKEN, provider: () => new MockProvider() });

    const created = await api('POST', '/tasks', { kind: 'ask', input: { question: 'what is here?' } });
    expect(created.status).toBe(201);
    const events = await readEvents(created.body.id);
    expect(events.map((e) => e.type)).toEqual(['started', 'tool_call', 'tool_result', 'text', 'done', 'succeeded']);
    expect(events.at(-1)!.data.answer).toContain('README.md');

    const task = await api('GET', `/tasks/${created.body.id}`);
    expect(task.body).toMatchObject({ status: 'succeeded', result: { answer: expect.stringContaining('README.md') } });

    // A reconnecting client only gets what it missed.
    const tail = await readEvents(created.body.id, events[3].id);
    expect(tail.map((e) => e.type)).toEqual(['done', 'succeeded']);
  });

  it('validates task input', async () => {
    server = await startServer({ root: tmp('r'), home: tmp('h'), port: 0, token: TOKEN, provider: () => new MockProvider() });
    expect((await api('POST', '/tasks', { kind: 'nope' })).status).toBe(400);
    expect((await api('POST', '/tasks', { kind: 'ask', input: {} })).status).toBe(400);
  });

  it('reports provider errors as a failed task', async () => {
    server = await startServer({
      root: tmp('r'),
      home: tmp('h'),
      port: 0,
      token: TOKEN,
      provider: () => {
        throw new Error('No AI provider configured.');
      },
    });
    const created = await api('POST', '/tasks', { kind: 'ask', input: { question: 'q' } });
    const events = await readEvents(created.body.id);
    expect(events.at(-1)).toMatchObject({ type: 'failed', data: { error: 'No AI provider configured.' } });
  });

  it('requeues tasks interrupted by a restart', async () => {
    const home = tmp('aise-home-');
    const store = new Store(path.join(home, 'aise.db'));
    const t = store.createTask('ask', { question: 'q' });
    store.claimNext(); // simulate a crash while running
    store.close();

    server = await startServer({ root: tmp('r'), home, port: 0, token: TOKEN, provider: () => new MockProvider() });
    const events = await readEvents(t.id);
    expect(events.at(-1)!.type).toBe('succeeded');
  });
});
