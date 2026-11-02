import { AnthropicProvider } from './anthropic.ts';
import { type ResolvedProvider, resolveProvider } from './credentials.ts';
import { MockProvider } from './mock.ts';
import { OpenAICompatProvider } from './openai-compat.ts';
import { getPreset } from './presets.ts';
import type { Provider } from './types.ts';

export * from './types.ts';
export * from './presets.ts';
export * from './credentials.ts';
export { AnthropicProvider } from './anthropic.ts';
export { OpenAICompatProvider } from './openai-compat.ts';
export { MockProvider, type MockStep } from './mock.ts';

export function createProvider(cfg: ResolvedProvider): Provider {
  const preset = getPreset(cfg.id);
  switch (preset.kind) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model, baseURL: cfg.baseURL });
    case 'mock':
      return new MockProvider();
    case 'openai-compatible':
      if (!cfg.baseURL) throw new Error(`Provider ${cfg.id} needs a base URL.`);
      return new OpenAICompatProvider({ id: cfg.id, model: cfg.model, baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }
}

/** Resolve the configured provider (see resolveProvider) and construct it. */
export function getProvider(id?: string): Provider {
  return createProvider(resolveProvider(id));
}
