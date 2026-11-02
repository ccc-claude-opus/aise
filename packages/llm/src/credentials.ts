import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRESETS, detectProvider, getPreset } from './presets.ts';

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

export interface Credentials {
  /** Provider used when none is requested explicitly. */
  default?: string;
  providers: Record<string, ProviderConfig>;
}

export function aiseHome(): string {
  return process.env.AISE_HOME ?? path.join(os.homedir(), '.aise');
}

function credentialsPath(): string {
  return path.join(aiseHome(), 'credentials.json');
}

export function loadCredentials(): Credentials {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8')) as Credentials;
  } catch {
    return { providers: {} };
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(aiseHome(), { recursive: true, mode: 0o700 });
  // Owner-only: this file holds API keys.
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export interface LoginOptions {
  provider?: string;
  model?: string;
  baseURL?: string;
  makeDefault?: boolean;
}

/** Store an API key. The provider is detected from the key unless given. Returns the provider id. */
export function login(apiKey: string | undefined, opts: LoginOptions = {}): string {
  const preset = opts.provider ? getPreset(opts.provider) : apiKey ? detectProvider(apiKey) : undefined;
  if (!preset) {
    throw new Error('Cannot tell which provider this key belongs to; pass --provider <id>.');
  }
  if (!apiKey && !preset.keyless) throw new Error(`${preset.name} needs an API key.`);
  if (preset.id === 'custom' && !opts.baseURL) throw new Error('The custom provider needs --base-url.');

  const creds = loadCredentials();
  const entry: ProviderConfig = { ...creds.providers[preset.id] };
  if (apiKey) entry.apiKey = apiKey.trim();
  if (opts.model) entry.model = opts.model;
  if (opts.baseURL) entry.baseURL = opts.baseURL;
  creds.providers[preset.id] = entry;
  if (opts.makeDefault !== false) creds.default = preset.id;
  saveCredentials(creds);
  return preset.id;
}

export interface ResolvedProvider {
  id: string;
  apiKey?: string;
  model: string;
  baseURL?: string;
}

/**
 * Pick the provider to use: explicit id, then AISE_PROVIDER, then the stored default,
 * then the first provider whose API key is set in the environment.
 */
export function resolveProvider(id?: string, creds: Credentials = loadCredentials()): ResolvedProvider {
  const chosen =
    id ??
    process.env.AISE_PROVIDER ??
    creds.default ??
    PRESETS.find((p) => p.envKey && process.env[p.envKey])?.id;
  if (!chosen) {
    throw new Error('No AI provider configured. Run `aise login <api-key>` or set e.g. NVIDIA_API_KEY.');
  }
  const preset = getPreset(chosen);
  const stored = creds.providers[preset.id] ?? {};
  const apiKey = stored.apiKey ?? (preset.envKey ? process.env[preset.envKey] : undefined);
  if (!apiKey && !preset.keyless) {
    throw new Error(`No API key for ${preset.name}. Run \`aise login <api-key>\`.`);
  }
  const model = process.env.AISE_MODEL ?? stored.model ?? preset.defaultModel;
  if (!model) throw new Error(`No model set for ${preset.name}. Run \`aise login --provider ${preset.id} --model <id>\`.`);
  return { id: preset.id, apiKey, model, baseURL: stored.baseURL ?? preset.baseURL };
}

export function maskKey(key: string): string {
  return key.length <= 10 ? '****' : `${key.slice(0, 6)}…${key.slice(-4)}`;
}
