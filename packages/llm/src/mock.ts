import type { ChatRequest, ChatResponse, Part, Provider } from './types.ts';

export type MockStep = (req: ChatRequest) => Part[];

/**
 * Offline provider for tests and demos. With no script it explores the repo once
 * (list_files) and then answers with what it saw.
 */
export class MockProvider implements Provider {
  readonly id = 'mock';
  readonly model = 'mock';
  private script?: MockStep[];
  private turn = 0;

  constructor(script?: MockStep[]) {
    this.script = script;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const content = this.script ? this.scripted(req) : defaultStep(req);
    for (const p of content) if (p.type === 'text') req.onText?.(p.text);
    const stop = content.some((p) => p.type === 'tool_call') ? 'tool_use' : 'end';
    return { content, stop, usage: { inputTokens: 0, outputTokens: 0 }, model: this.model };
  }

  async listModels(): Promise<string[]> {
    return ['mock'];
  }

  private scripted(req: ChatRequest): Part[] {
    const step = this.script![this.turn++];
    if (!step) throw new Error('MockProvider script exhausted');
    return step(req);
  }
}

function defaultStep(req: ChatRequest): Part[] {
  const last = req.messages.at(-1);
  const result = last?.content.find((p) => p.type === 'tool_result');
  if (!result && req.tools?.some((t) => t.name === 'list_files')) {
    return [{ type: 'tool_call', id: 'mock_1', name: 'list_files', input: {} }];
  }
  const files = result?.type === 'tool_result' ? result.content : '(none)';
  return [{ type: 'text', text: `[mock] The repository contains:\n${files}` }];
}
