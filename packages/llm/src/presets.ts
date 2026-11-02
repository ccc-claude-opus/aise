// Known providers. Anything else that speaks the OpenAI chat-completions protocol
// works through the "custom" preset with an explicit base URL.

export type ProviderKind = 'anthropic' | 'openai-compatible' | 'mock';

export interface Preset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseURL?: string;
  /** Environment variable holding the API key. */
  envKey?: string;
  /** API key prefix used to recognise a pasted key. */
  keyPrefix?: string;
  defaultModel: string;
  /** Whether the provider works without an API key (e.g. a local server). */
  keyless?: boolean;
}

// Default models change often; override per provider with `aise login --model` or `aise models`.
export const PRESETS: Preset[] = [
  { id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', envKey: 'ANTHROPIC_API_KEY', keyPrefix: 'sk-ant-', defaultModel: 'claude-opus-5-5' },
  { id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai-compatible', baseURL: 'https://integrate.api.nvidia.com/v1', envKey: 'NVIDIA_API_KEY', keyPrefix: 'nvapi-', defaultModel: 'nvidia/nemotron-3-super-120b-a12b' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', keyPrefix: 'sk-or-', defaultModel: 'openrouter/auto' },
  { id: 'groq', name: 'Groq', kind: 'openai-compatible', baseURL: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', keyPrefix: 'gsk_', defaultModel: 'openai/gpt-oss-120b' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', envKey: 'GEMINI_API_KEY', keyPrefix: 'AIza', defaultModel: 'gemini-2.5-flash' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
  // Last among the keyed presets: "sk-" is also used by other vendors.
  { id: 'openai', name: 'OpenAI', kind: 'openai-compatible', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', keyPrefix: 'sk-', defaultModel: 'gpt-5' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible', baseURL: 'http://localhost:11434/v1', defaultModel: 'llama3.1', keyless: true },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai-compatible', defaultModel: '' },
  { id: 'mock', name: 'Mock (offline testing)', kind: 'mock', defaultModel: 'mock', keyless: true },
];

export function getPreset(id: string): Preset {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Unknown provider "${id}". Known: ${PRESETS.map((p) => p.id).join(', ')}`);
  }
  return preset;
}

/** Guess the provider from the shape of an API key. */
export function detectProvider(apiKey: string): Preset | undefined {
  const key = apiKey.trim();
  return PRESETS.find((p) => p.keyPrefix && key.startsWith(p.keyPrefix));
}
