import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAICompatProvider, detectProvider, loadCredentials, login, resolveProvider } from '../src/index.ts';

describe('detectProvider', () => {
  it.each([
    ['nvapi-abc123', 'nvidia'],
    ['sk-ant-api03-xyz', 'anthropic'],
    ['sk-or-v1-xyz', 'openrouter'],
    ['gsk_xyz', 'groq'],
    ['AIzaSyXYZ', 'gemini'],
    ['sk-proj-xyz', 'openai'],
  ])('%s -> %s', (key, id) => {
    expect(detectProvider(key)?.id).toBe(id);
  });

  it('returns undefined for unknown keys', () => {
    expect(detectProvider('hello')).toBeUndefined();
  });
});

describe('credentials', () => {
  let home: string;
  const saved = { ...process.env };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-'));
    process.env.AISE_HOME = home;
    for (const k of ['AISE_PROVIDER', 'AISE_MODEL', 'NVIDIA_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('login with a NVIDIA key makes NVIDIA the default', () => {
    expect(login('nvapi-secret-key')).toBe('nvidia');
    const r = resolveProvider();
    expect(r).toMatchObject({ id: 'nvidia', apiKey: 'nvapi-secret-key', baseURL: 'https://integrate.api.nvidia.com/v1' });
    const mode = fs.statSync(path.join(home, 'credentials.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps several providers and an explicit model', () => {
    login('nvapi-1');
    login('sk-ant-2', { model: 'claude-sonnet-5-5' });
    expect(loadCredentials().default).toBe('anthropic');
    expect(resolveProvider().model).toBe('claude-sonnet-5-5');
    expect(resolveProvider('nvidia').apiKey).toBe('nvapi-1');
  });

  it('falls back to environment keys', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-env';
    expect(resolveProvider()).toMatchObject({ id: 'nvidia', apiKey: 'nvapi-env' });
  });

  it('asks for --provider when the key is unrecognised', () => {
    expect(() => login('mystery')).toThrow(/--provider/);
    expect(login('mystery', { provider: 'deepseek' })).toBe('deepseek');
  });

  it('custom provider needs a base URL', () => {
    expect(() => login('k', { provider: 'custom', model: 'm' })).toThrow(/base-url/);
    login('k', { provider: 'custom', model: 'm', baseURL: 'http://localhost:8000/v1' });
    expect(resolveProvider()).toMatchObject({ id: 'custom', model: 'm', baseURL: 'http://localhost:8000/v1' });
  });
});

describe('OpenAICompatProvider', () => {
  // A fake chat-completions server that streams one tool call split across chunks.
  let server: http.Server;
  let baseURL: string;
  let lastBody: any;
  let lastAuth: string | undefined;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastBody = JSON.parse(body);
        lastAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = [
          { choices: [{ index: 0, delta: { content: 'Let me look' } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'nvidia/test', ...c })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    baseURL = `http://127.0.0.1:${addr.port}/v1`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('streams text and reassembles tool calls', async () => {
    const p = new OpenAICompatProvider({ id: 'nvidia', model: 'nvidia/test', baseURL, apiKey: 'nvapi-k' });
    let streamed = '';
    const res = await p.chat({
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'tool_call', id: 't0', name: 'list_files', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', id: 't0', content: 'a.ts' }] },
      ],
      tools: [{ name: 'read_file', description: 'read', schema: { type: 'object' } }],
      onText: (d) => (streamed += d),
    });

    expect(lastAuth).toBe('Bearer nvapi-k');
    expect(lastBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't0', type: 'function', function: { name: 'list_files', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't0', content: 'a.ts' },
    ]);
    expect(lastBody.tools[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } });
    expect(streamed).toBe('Let me look');
    expect(res.stop).toBe('tool_use');
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(res.content).toEqual([
      { type: 'text', text: 'Let me look' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });
});
