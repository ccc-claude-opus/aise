import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse, Message, Part, Provider, StopReason } from './types.ts';

type BlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

export interface AnthropicOptions {
  apiKey?: string;
  model: string;
  baseURL?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly model: string;
  private client: Anthropic;
  private effort: NonNullable<AnthropicOptions['effort']>;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.effort = opts.effort ?? 'high';
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 64000,
        system: req.system,
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools?.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
          eager_input_streaming: true,
        })),
        thinking: { type: 'adaptive' },
        output_config: { effort: this.effort },
        // On a safety decline, the API re-runs the request on a fallback model it picks.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal: req.signal },
    );
    if (req.onText) stream.on('text', req.onText);
    const msg = await stream.finalMessage();

    const content: Part[] = msg.content.map((b): Part => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_call', id: b.id, name: b.name, input: b.input };
      return { type: 'opaque', provider: this.id, block: b };
    });
    return {
      content,
      stop: mapStop(msg.stop_reason),
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      model: msg.model,
    };
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}

function toAnthropicMessage(m: Message): Anthropic.Beta.Messages.BetaMessageParam {
  const content = m.content.flatMap((p): BlockParam[] => {
    switch (p.type) {
      case 'text':
        return [{ type: 'text', text: p.text }];
      case 'tool_call':
        return [{ type: 'tool_use', id: p.id, name: p.name, input: p.input }];
      case 'tool_result':
        return [{ type: 'tool_result', tool_use_id: p.id, content: p.content, is_error: p.isError }];
      case 'opaque':
        // Response blocks are valid request params; replay them unchanged (thinking, fallback).
        return p.provider === 'anthropic' ? [p.block as BlockParam] : [];
    }
  });
  return { role: m.role, content };
}
