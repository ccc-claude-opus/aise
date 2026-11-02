import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Task {
  id: string;
  kind: string;
  input: unknown;
  status: TaskStatus;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  seq: number;
  taskId: string;
  type: string;
  data: unknown;
  at: string;
}

interface TaskRow {
  id: string;
  kind: string;
  input: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  task_id: string;
  type: string;
  data: string;
  at: string;
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    kind: r.kind,
    input: JSON.parse(r.input),
    status: r.status,
    result: r.result === null ? null : JSON.parse(r.result),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEvent(r: EventRow): TaskEvent {
  return { seq: r.seq, taskId: r.task_id, type: r.type, data: JSON.parse(r.data), at: r.at };
}

/** Durable task queue and per-task event log, so work survives restarts and clients can catch up. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
    `);
  }

  createTask(kind: string, input: unknown): Task {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO tasks (id, kind, input, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, JSON.stringify(input), 'queued', now, now);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row && toTask(row);
  }

  listTasks(limit = 50): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as TaskRow[];
    return rows.map(toTask);
  }

  /** Atomically take the oldest queued task. */
  claimNext(): Task | undefined {
    const row = this.db
      .prepare(
        `UPDATE tasks SET status = 'running', updated_at = ?
         WHERE id = (SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get(new Date().toISOString()) as TaskRow | undefined;
    return row && toTask(row);
  }

  finishTask(id: string, outcome: { result: unknown } | { error: string }): void {
    const now = new Date().toISOString();
    if ('error' in outcome) {
      this.db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(outcome.error, now, id);
    } else {
      this.db
        .prepare("UPDATE tasks SET status = 'succeeded', result = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(outcome.result), now, id);
    }
  }

  /** Tasks left running by a crash or restart go back to the queue. */
  requeueInterrupted(): number {
    const res = this.db
      .prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(new Date().toISOString());
    return Number(res.changes);
  }

  addEvent(taskId: string, type: string, data: unknown): TaskEvent {
    const row = this.db
      .prepare('INSERT INTO events (task_id, type, data, at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(taskId, type, JSON.stringify(data), new Date().toISOString()) as unknown as EventRow;
    return toEvent(row);
  }

  eventsAfter(taskId: string, afterSeq: number): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq')
      .all(taskId, afterSeq) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  close(): void {
    this.db.close();
  }
}
