import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDef } from '@aise/llm';

const IGNORED = new Set(['.git', 'node_modules', '.aise', '.DS_Store', 'dist', 'build', '.next', 'coverage']);
const MAX_OUTPUT = 20_000;
const MAX_FILES = 500;

export interface Tool<T = any> {
  def: ToolDef;
  input: z.ZodType<T>;
  run(input: T, root: string): Promise<string>;
}

function tool<T>(name: string, description: string, input: z.ZodType<T>, run: Tool<T>['run']): Tool<T> {
  return { def: { name, description, schema: z.toJSONSchema(input) as Record<string, unknown> }, input, run };
}

/** Resolve a model-supplied path and refuse anything outside the workspace root. */
export function confine(root: string, p = '.'): string {
  const target = path.resolve(root, p);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${p}`);
  }
  return target;
}

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… (truncated, ${s.length} chars total)` : s;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (IGNORED.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else if (e.isFile()) out.push(path.relative(root, full));
  }
}

export const listFiles = tool(
  'list_files',
  'List files under a directory of the repository, recursively (skips .git, node_modules, build output).',
  z.object({ path: z.string().optional().describe('Directory relative to the repo root; default ".".') }),
  async ({ path: p }, root) => {
    const files: string[] = [];
    await walk(root, confine(root, p), files);
    const note = files.length >= MAX_FILES ? `\n… (stopped at ${MAX_FILES} files)` : '';
    return files.join('\n') + note || '(empty)';
  },
);

export const readFile = tool(
  'read_file',
  'Read a text file from the repository. Lines are numbered. Use offset/limit for large files.',
  z.object({
    path: z.string().describe('File path relative to the repo root.'),
    offset: z.number().int().min(1).optional().describe('First line to read (1-based).'),
    limit: z.number().int().min(1).optional().describe('Number of lines to read.'),
  }),
  async ({ path: p, offset = 1, limit = 400 }, root) => {
    const lines = (await fs.readFile(confine(root, p), 'utf8')).split('\n');
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
    const more = offset - 1 + limit < lines.length ? `\n… (${lines.length} lines total)` : '';
    return clip(body + more);
  },
);

export const grep = tool(
  'grep',
  'Search file contents in the repository with a JavaScript regular expression. Returns path:line: text.',
  z.object({
    pattern: z.string().describe('Regular expression.'),
    path: z.string().optional().describe('Directory to search; default ".".'),
  }),
  async ({ pattern, path: p }, root) => {
    const re = new RegExp(pattern);
    const files: string[] = [];
    await walk(root, confine(root, p), files);
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = await fs.readFile(path.join(root, f), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue; // binary
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
      if (hits.length > 200) break;
    }
    return clip(hits.join('\n') || '(no matches)');
  },
);

export const READ_ONLY_TOOLS: Tool[] = [listFiles, readFile, grep];
