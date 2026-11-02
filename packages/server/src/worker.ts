import { EventEmitter } from 'node:events';
import { ask, type AgentEvent } from '@aise/core';
import type { Provider } from '@aise/llm';
import type { Store, Task, TaskEvent } from './store.ts';

export interface WorkerOptions {
  store: Store;
  root: string;
  provider: () => Provider;
  concurrency?: number;
}

type Emit = (type: string, data: unknown) => void;
type Handler = (task: Task, emit: Emit, signal: AbortSignal) => Promise<unknown>;

const TEXT_FLUSH_MS = 150;

/** Runs queued tasks in the background, independent of any client connection. */
export class Worker {
  /** Emits "event" with every TaskEvent as it is stored. */
  readonly events = new EventEmitter();
  private opts: WorkerOptions;
  private running = new Map<string, { ac: AbortController; done: Promise<void> }>();
  private handlers: Record<string, Handler>;
  private stopped = false;

  constructor(opts: WorkerOptions) {
    this.opts = opts;
    this.events.setMaxListeners(0);
    this.handlers = {
      ask: async (task, emit, signal) => {
        const { question } = task.input as { question: string };
        const provider = opts.provider();
        emit('started', { provider: provider.id, model: provider.model });
        const answer = await ask({
          provider,
          root: opts.root,
          question,
          signal,
          onEvent: (e: AgentEvent) => emit(e.type, e),
        });
        return { answer };
      },
    };
  }

  static kinds = ['ask'];

  start(): void {
    const n = this.opts.store.requeueInterrupted();
    if (n) console.log(`requeued ${n} interrupted task(s)`);
    this.poke();
  }

  /** Start as many queued tasks as concurrency allows. */
  poke(): void {
    while (!this.stopped && this.running.size < (this.opts.concurrency ?? 2)) {
      const task = this.opts.store.claimNext();
      if (!task) return;
      const ac = new AbortController();
      const done = this.run(task, ac.signal).finally(() => {
        this.running.delete(task.id);
        this.poke();
      });
      this.running.set(task.id, { ac, done });
    }
  }

  /** Abort running tasks and wait for them to settle; they are requeued on next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    const all = [...this.running.values()];
    for (const r of all) r.ac.abort();
    await Promise.allSettled(all.map((r) => r.done));
  }

  private record(taskId: string, type: string, data: unknown): void {
    const ev: TaskEvent = this.opts.store.addEvent(taskId, type, data);
    this.events.emit('event', ev);
  }

  private async run(task: Task, signal: AbortSignal): Promise<void> {
    // Model output arrives token by token; batch it so the event log stays small.
    let text = '';
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (text) this.record(task.id, 'text', { delta: text });
      text = '';
    };
    const emit: Emit = (type, data) => {
      if (type === 'text') {
        text += (data as { delta: string }).delta;
        timer ??= setTimeout(flush, TEXT_FLUSH_MS);
        return;
      }
      flush();
      this.record(task.id, type, data);
    };

    try {
      const handler = this.handlers[task.kind];
      if (!handler) throw new Error(`Unknown task kind: ${task.kind}`);
      const result = await handler(task, emit, signal);
      flush();
      // Interrupted by shutdown: leave it "running" so the next start requeues it.
      if (this.stopped) return;
      this.opts.store.finishTask(task.id, { result });
      this.record(task.id, 'succeeded', result);
    } catch (err) {
      flush();
      if (this.stopped) return;
      const error = err instanceof Error ? err.message : String(err);
      this.opts.store.finishTask(task.id, { error });
      this.record(task.id, 'failed', { error });
    }
  }
}
