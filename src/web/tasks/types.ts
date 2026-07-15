export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskSession {
  id: string; // session uuid (directory name under tasks/)
  name: string; // human name (slug from jsonl, else last segment of projectDir)
  projectDir: string; // decoded absolute path, or empty if unknown
  live: boolean; // true if the session is currently tracked/running
}

export interface TaskPayload {
  sessionId: string;
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  updatedAt: number; // ms epoch (file mtime)
}

export type TaskStreamEvent =
  | { type: "task.upsert"; sessionId: string; task: TaskPayload }
  | { type: "task.delete"; sessionId: string; taskId: string }
  | { type: "session.delete"; sessionId: string };

export interface TasksSnapshot {
  sessions: TaskSession[];
  tasks: TaskPayload[];
}
