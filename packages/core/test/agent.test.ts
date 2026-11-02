import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '@aise/llm';
import { type AgentEvent, ask, confine, grep, listFiles, readFile } from '../src/index.ts';

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-repo-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src/app.ts'), 'export function login() {\n  return "ok";\n}\n');
  fs.writeFileSync(path.join(root, 'node_modules/x.js'), 'ignored');
});

describe('tools', () => {
  it('refuses paths outside the workspace', () => {
    expect(() => confine(root, '../etc/passwd')).toThrow(/escapes/);
    expect(() => confine(root, '/etc/passwd')).toThrow(/escapes/);
    expect(confine(root, 'src')).toBe(path.join(root, 'src'));
  });

  it('list_files skips node_modules', async () => {
    expect(await listFiles.run({}, root)).toBe(path.join('src', 'app.ts'));
  });

  it('read_file numbers lines', async () => {
    expect(await readFile.run({ path: 'src/app.ts', offset: 2, limit: 1 }, root)).toBe('2\t  return "ok";\n… (4 lines total)');
  });

  it('grep finds matches', async () => {
    expect(await grep.run({ pattern: 'function \\w+' }, root)).toBe('src/app.ts:1: export function login() {');
  });
});

describe('ask', () => {
  it('runs tools, reports bad input, and returns the answer', async () => {
    const provider = new MockProvider([
      () => [
        { type: 'tool_call', id: '1', name: 'read_file', input: { path: 'src/app.ts' } },
        { type: 'tool_call', id: '2', name: 'read_file', input: { nope: true } },
      ],
      (req) => {
        const results = req.messages.at(-1)!.content;
        expect(results.map((r) => r.type === 'tool_result' && r.isError)).toEqual([false, true]);
        return [{ type: 'text', text: 'login() is in src/app.ts:1' }];
      },
    ]);
    const events: AgentEvent[] = [];
    const answer = await ask({ provider, root, question: 'where is login?', onEvent: (e) => events.push(e) });
    expect(answer).toBe('login() is in src/app.ts:1');
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result', 'text', 'done']);
  });

  it('stops on refusal', async () => {
    const provider = new MockProvider([() => []]);
    provider.chat = async () => ({ content: [], stop: 'refusal', usage: { inputTokens: 0, outputTokens: 0 }, model: 'm' });
    await expect(ask({ provider, root, question: 'x' })).rejects.toThrow(/declined/);
  });
});
