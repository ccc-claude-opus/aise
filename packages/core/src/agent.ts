import type { Message, Part, Provider, Usage } from '@aise/llm';
import type { Tool } from './tools.ts';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'done'; answer: string; usage: Usage; model: string; provider: string };

export interface RunOptions {
  provider: Provider;
  system: string;
  prompt: string;
  tools: Tool[];
  root: string;
  maxTurns?: number;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

/** Provider-neutral tool loop: call the model, run the tools it asks for, repeat until it answers. */
export async function runAgent(opts: RunOptions): Promise<string> {
  const { provider, tools, root, onEvent = () => {} } = opts;
  const byName = new Map(tools.map((t) => [t.def.name, t]));
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: opts.prompt }] }];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let model = provider.model;

  for (let turn = 0; turn < (opts.maxTurns ?? 20); turn++) {
    const res = await provider.chat({
      system: opts.system,
      messages,
      tools: tools.map((t) => t.def),
      onText: (delta) => onEvent({ type: 'text', delta }),
      signal: opts.signal,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    model = res.model;
    messages.push({ role: 'assistant', content: res.content });

    const calls = res.content.filter((p) => p.type === 'tool_call');
    const answer = res.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
    if (res.stop === 'refusal') throw new Error('The model declined this request.');
    // A tool input cut off at max_tokens may parse as a partial object; never run it.
    if (res.stop === 'max_tokens') throw new Error('The model response hit max_tokens.');
    if (calls.length === 0) {
      onEvent({ type: 'done', answer, usage, model, provider: provider.id });
      return answer;
    }

    // All results for this turn go back in a single message.
    const results: Part[] = [];
    for (const call of calls) {
      onEvent({ type: 'tool_call', name: call.name, input: call.input });
      const { content, isError } = await runTool(byName.get(call.name), call.name, call.input, root);
      onEvent({ type: 'tool_result', name: call.name, ok: !isError, preview: content.slice(0, 200) });
      results.push({ type: 'tool_result', id: call.id, content, isError });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error(`Gave up after ${opts.maxTurns ?? 20} turns without an answer.`);
}

async function runTool(tool: Tool | undefined, name: string, input: unknown, root: string) {
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  // Providers may hand back truncated or malformed input; validate before running.
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    return { content: `Invalid input for ${name}: ${parsed.error.message}`, isError: true };
  }
  try {
    return { content: await tool.run(parsed.data, root), isError: false };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
