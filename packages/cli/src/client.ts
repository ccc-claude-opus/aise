import fs from 'node:fs';
import path from 'node:path';
import { aiseHome } from '@aise/llm';
import { serverToken } from '@aise/server';

export interface ClientConfig {
  url: string;
  token: string;
}

const clientFile = () => path.join(aiseHome(), 'client.json');

/** Which server to talk to: env, then `aise connect`, then the local default server. */
export function clientConfig(): ClientConfig {
  if (process.env.AISE_URL && process.env.AISE_TOKEN) {
    return { url: process.env.AISE_URL, token: process.env.AISE_TOKEN };
  }
  try {
    return JSON.parse(fs.readFileSync(clientFile(), 'utf8')) as ClientConfig;
  } catch {
    return { url: process.env.AISE_URL ?? 'http://127.0.0.1:7420', token: serverToken() };
  }
}

export function saveClientConfig(cfg: ClientConfig): void {
  fs.mkdirSync(aiseHome(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(clientFile(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export class Client {
  private cfg: ClientConfig;

  constructor(cfg: ClientConfig = clientConfig()) {
    this.cfg = cfg;
  }

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.cfg.url + route, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Cannot reach the AISE server at ${this.cfg.url}. Start it with \`aise serve\`.`);
    }
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`${res.status}: ${data.error ?? res.statusText}`);
    return data;
  }

  /** Follow a task's event stream until it finishes, reconnecting from the last seen event. */
  async *events(taskId: string): AsyncGenerator<{ id: number; type: string; data: any }> {
    let last = 0;
    for (let attempt = 0; ; ) {
      let res: Response;
      try {
        res = await fetch(`${this.cfg.url}/tasks/${taskId}/events`, {
          headers: { authorization: `Bearer ${this.cfg.token}`, 'last-event-id': String(last) },
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        if (++attempt > 5) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      attempt = 0;
      let buf = '';
      let finished = false;
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk as Uint8Array, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const ev = parseEvent(buf.slice(0, i));
            buf = buf.slice(i + 2);
            if (!ev) continue;
            last = ev.id;
            yield ev;
            if (ev.type === 'succeeded' || ev.type === 'failed') finished = true;
          }
        }
      } catch {
        // Dropped mid-stream; reconnect below.
      }
      if (finished) return;
    }
  }
}

function parseEvent(raw: string): { id: number; type: string; data: any } | undefined {
  let id = 0;
  let type = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').replace(/^ /, '');
    if (field === 'id') id = Number(value);
    else if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return undefined;
  return { id, type, data: JSON.parse(data.join('\n')) };
}
