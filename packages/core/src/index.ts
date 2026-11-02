import type { Provider } from '@aise/llm';
import { type AgentEvent, runAgent } from './agent.ts';
import { READ_ONLY_TOOLS } from './tools.ts';

export * from './agent.ts';
export * from './tools.ts';

const ASK_SYSTEM = `You are AISE, an assistant that answers questions about a software repository.
Use the tools to look at the actual files before answering; do not guess about code you have not read.
Cite files as path:line. Answer in the same language as the question.`;

export interface AskOptions {
  provider: Provider;
  root: string;
  question: string;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}

/** Answer a question about the repository at `root`, reading files as needed. */
export function ask(opts: AskOptions): Promise<string> {
  return runAgent({
    provider: opts.provider,
    system: ASK_SYSTEM,
    prompt: opts.question,
    tools: READ_ONLY_TOOLS,
    root: opts.root,
    onEvent: opts.onEvent,
    signal: opts.signal,
  });
}
