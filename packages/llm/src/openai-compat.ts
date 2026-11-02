import OpenAI from 'openai';
import type { ChatRequest, ChatResponse, Message, Part, Provider, StopReason } from './types.ts';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface OpenAICompatOptions {
  id: string;
  model: string;
  baseURL: string;
  apiKey?: string;
}

/**
 * Any OpenAI chat-completions endpoint: NVIDIA NIM, OpenAI, OpenRouter, Groq,
 * Gemini, DeepSeek, Ollama, vLLM, ...
 */
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.model = opts.model;
    // Keyless local servers still need a non-empty key for the SDK.
    this.client = new OpenAI({ apiKey: opts.apiKey || 'none', baseURL: opts.baseURL });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: ChatMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(...toOpenAIMessages(m));

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        max_tokens: req.maxTokens,
        tools: req.tools?.length
          ? req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.schema },
            }))
          : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    );

    let text = '';
    let finish: string | null = null;
    let model = this.model;
    const usage = { inputTokens: 0, outputTokens: 0 };
    // Tool call deltas arrive in pieces keyed by index.
    const calls = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens;
        usage.outputTokens = chunk.usage.completion_tokens;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        req.onText?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const call = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
        calls.set(tc.index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const content: Part[] = [];
    if (text) content.push({ type: 'text', text });
    for (const [index, call] of [...calls].sort((a, b) => a[0] - b[0])) {
      content.push({
        type: 'tool_call',
        id: call.id || `call_${index}`,
        name: call.name,
        input: parseArgs(call.args),
      });
    }

    let stop = mapStop(finish);
    // Some servers report "stop" even when they returned tool calls.
    if (stop === 'end' && calls.size > 0) stop = 'tool_use';
    return { content, stop, usage, model };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids.sort();
  }
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Leave it to the tool's schema validation to report the bad input.
    return { __invalid_json: raw };
  }
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end';
  }
}

function toOpenAIMessages(m: Message): ChatMessage[] {
  const text = m.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
  if (m.role === 'assistant') {
    const toolCalls = m.content.flatMap((p) =>
      p.type === 'tool_call'
        ? [{ id: p.id, type: 'function' as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }]
        : [],
    );
    return [{ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
  }
  // Tool results become separate "tool" messages, which must come before any user text.
  const out: ChatMessage[] = m.content.flatMap((p) =>
    p.type === 'tool_result'
      ? [{ role: 'tool' as const, tool_call_id: p.id, content: p.isError ? `ERROR: ${p.content}` : p.content }]
      : [],
  );
  if (text) out.push({ role: 'user', content: text });
  return out;
}
