import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { Result, TaskStatus } from "@modelcontextprotocol/sdk/types.js";

/** Local task lifecycle glue. Hosted deployments can replace this store at composition. */
export class CancellableTaskStore extends InMemoryTaskStore {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();

  bind(taskId: string, controller: AbortController) {
    this.controllers.set(taskId, controller);
  }

  release(taskId: string) {
    this.controllers.delete(taskId);
    this.cancelled.delete(taskId);
  }

  override async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ) {
    if (this.cancelled.has(taskId)) return;
    return super.storeTaskResult(taskId, status, result, sessionId);
  }

  override async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    statusMessage?: string,
    sessionId?: string,
  ) {
    if (status === "cancelled") {
      this.cancelled.add(taskId);
      this.controllers.get(taskId)?.abort(
        new DOMException("Dataset task was cancelled.", "AbortError"),
      );
    }
    return super.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }
}
