import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { Result, TaskStatus } from "@modelcontextprotocol/sdk/types.js";

/** Local task lifecycle glue. Hosted deployments can replace this store at composition. */
export class CancellableTaskStore extends InMemoryTaskStore {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  bind(taskId: string, controller: AbortController, ttl: number | null) {
    this.controllers.set(taskId, controller);
    if (ttl) {
      this.expiryTimers.set(taskId, setTimeout(() => {
        this.cancelled.add(taskId);
        this.controllers.get(taskId)?.abort(
          new DOMException("Dataset task expired.", "AbortError"),
        );
        this.controllers.delete(taskId);
        this.expiryTimers.delete(taskId);
      }, ttl));
    }
  }

  release(taskId: string) {
    this.controllers.delete(taskId);
    this.cancelled.delete(taskId);
    const timer = this.expiryTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(taskId);
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

  override cleanup() {
    for (const [taskId, controller] of this.controllers) {
      this.cancelled.add(taskId);
      controller.abort(new DOMException("MCP session closed.", "AbortError"));
    }
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.controllers.clear();
    this.expiryTimers.clear();
    super.cleanup();
  }
}
