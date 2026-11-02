// Provider-neutral chat format. Every provider adapter converts to and from these types,
// so the rest of AISE never depends on one vendor's SDK.

export type Part =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean }
  // A provider-specific block (e.g. Anthropic thinking) that must be replayed unchanged
  // to the same provider and is dropped for any other provider.
  | { type: 'opaque'; provider: string; block: unknown };

export interface Message {
  role: 'user' | 'assistant';
  content: Part[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  schema: Record<string, unknown>;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: Part[];
  stop: StopReason;
  usage: Usage;
  model: string;
}

export interface Provider {
  /** Preset id, e.g. "anthropic" or "nvidia". */
  readonly id: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  listModels(): Promise<string[]>;
}

export function textOf(parts: Part[]): string {
  return parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
}
