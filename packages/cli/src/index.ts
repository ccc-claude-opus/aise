import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  PRESETS,
  getPreset,
  getProvider,
  loadCredentials,
  login,
  maskKey,
  saveCredentials,
} from '@aise/llm';
import { serverToken, startServer, type Task } from '@aise/server';
import { Client, saveClientConfig } from './client.ts';

const HELP = `aise — AI software engineering

Providers
  aise login <api-key> [--provider id] [--model id] [--base-url url]
                                  Save a key; the provider is detected from the key
  aise providers                  List providers and which are configured
  aise use <provider> [--model id]
                                  Switch the default provider
  aise models [--provider id]     List models the provider offers

Server
  aise serve [--root dir] [--host addr] [--port n]
                                  Run the server; tasks keep running without a client
  aise connect <url> --token t    Point this CLI at a remote server

Tasks
  aise ask <question>             Ask about the repository (streams the answer)
  aise ask --detach <question>    Queue it and return the task id
  aise tasks                      List recent tasks
  aise show <task-id>             Show one task, following it if still running
`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'login':
      return cmdLogin(rest);
    case 'providers':
      return cmdProviders();
    case 'use':
      return cmdUse(rest);
    case 'models':
      return cmdModels(rest);
    case 'serve':
      return cmdServe(rest);
    case 'connect':
      return cmdConnect(rest);
    case 'ask':
      return cmdAsk(rest);
    case 'tasks':
      return cmdTasks();
    case 'show':
      return cmdShow(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      throw new Error(`Unknown command "${cmd}". Run \`aise help\`.`);
  }
}

function cmdLogin(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' } },
  });
  // AISE_API_KEY keeps the key out of shell history: `AISE_API_KEY=... aise login`.
  const key = positionals[0] ?? process.env.AISE_API_KEY;
  const id = login(key, { provider: values.provider, model: values.model, baseURL: values['base-url'] });
  const preset = getPreset(id);
  const cfg = loadCredentials().providers[id];
  console.log(`Saved ${preset.name} as the default provider (model: ${cfg?.model ?? preset.defaultModel}).`);
}

function cmdProviders(): void {
  const creds = loadCredentials();
  for (const p of PRESETS) {
    const stored = creds.providers[p.id];
    const envKey = p.envKey && process.env[p.envKey];
    const key = stored?.apiKey ?? envKey;
    const status = key ? `key ${maskKey(key)}${stored?.apiKey ? '' : ` (from ${p.envKey})`}` : p.keyless ? 'no key needed' : '-';
    const mark = creds.default === p.id ? '*' : ' ';
    const model = stored?.model ?? p.defaultModel;
    console.log(`${mark} ${p.id.padEnd(11)} ${p.name.padEnd(26)} ${status.padEnd(42)} ${model}`);
  }
}

function cmdUse(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { model: { type: 'string' } } });
  const preset = getPreset(positionals[0] ?? '');
  const creds = loadCredentials();
  creds.default = preset.id;
  if (values.model) creds.providers[preset.id] = { ...creds.providers[preset.id], model: values.model };
  saveCredentials(creds);
  console.log(`Default provider: ${preset.name}`);
}

async function cmdModels(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { provider: { type: 'string' } } });
  const provider = getProvider(values.provider);
  for (const id of await provider.listModels()) console.log(id === provider.model ? `* ${id}` : `  ${id}`);
}

async function cmdServe(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { root: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' } },
  });
  const root = path.resolve(values.root ?? '.');
  const server = await startServer({
    root,
    host: values.host,
    port: values.port ? Number(values.port) : undefined,
    token: process.env.AISE_TOKEN ?? serverToken(),
  });
  console.log(`AISE server on ${server.url}  (repo: ${root})`);
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function cmdConnect(args: string[]): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { token: { type: 'string' } } });
  if (!positionals[0] || !values.token) throw new Error('Usage: aise connect <url> --token <token>');
  saveClientConfig({ url: positionals[0].replace(/\/$/, ''), token: values.token });
  console.log(`Using AISE server ${positionals[0]}`);
}

async function cmdAsk(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { detach: { type: 'boolean' } } });
  const question = positionals.join(' ').trim();
  if (!question) throw new Error('Usage: aise ask <question>');
  const client = new Client();
  const task = await client.request<Task>('POST', '/tasks', { kind: 'ask', input: { question } });
  if (values.detach) {
    console.log(task.id);
    return;
  }
  await follow(client, task.id);
}

async function cmdTasks(): Promise<void> {
  const tasks = await new Client().request<Task[]>('GET', '/tasks');
  for (const t of tasks) {
    const q = (t.input as { question?: string }).question ?? '';
    console.log(`${t.id}  ${t.status.padEnd(9)} ${t.createdAt.slice(0, 19)}  ${t.kind}  ${q.slice(0, 60)}`);
  }
}

async function cmdShow(args: string[]): Promise<void> {
  if (!args[0]) throw new Error('Usage: aise show <task-id>');
  await follow(new Client(), args[0]);
}

async function follow(client: Client, taskId: string): Promise<void> {
  const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
  for await (const ev of client.events(taskId)) {
    switch (ev.type) {
      case 'started':
        process.stderr.write(dim(`[${ev.data.provider} · ${ev.data.model}]\n`));
        break;
      case 'text':
        process.stdout.write(ev.data.delta);
        break;
      case 'tool_call':
        process.stderr.write(dim(`\n→ ${ev.data.name} ${JSON.stringify(ev.data.input)}\n`));
        break;
      case 'tool_result':
        if (!ev.data.ok) process.stderr.write(dim(`  ✗ ${ev.data.preview}\n`));
        break;
      case 'done': {
        const u = ev.data.usage;
        process.stderr.write(dim(`\n[${u.inputTokens} in / ${u.outputTokens} out tokens]\n`));
        break;
      }
      case 'failed':
        throw new Error(ev.data.error);
    }
  }
  process.stdout.write('\n');
}
