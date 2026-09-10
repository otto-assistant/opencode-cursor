import type { Plugin } from "@opencode/plugin";
import { record } from "./history.js";

interface Watch {
  sessionID: string;
  callID: string;
  settled: () => void;
  failed: (error: Error) => void;
  requests: Set<string>;
}

/** Observe scheduling only. Results must come from the next host model request. */
export class HostToolObserver {
  private readonly abort = new AbortController();
  private readonly watches = new Set<Watch>();
  private readonly sessions = new Set<{
    sessionID: string;
    ended: () => void;
    failed: (error: Error) => void;
  }>();
  private readonly task: Promise<void>;
  private failure?: Error;

  constructor(domain: Plugin.Context["event"]) {
    this.task = (async () => {
      while (!this.abort.signal.aborted) {
        try {
          this.failure = undefined;
          for await (const event of domain.subscribe({
            signal: this.abort.signal,
          })) {
          if (
            event.type === "session.execution.interrupted" ||
            event.type === "session.execution.failed" ||
            event.type === "session.execution.succeeded"
          ) {
            for (const session of this.sessions)
              if (session.sessionID === event.data.sessionID) session.ended();
          }
          for (const watch of this.watches) {
            const settle = () => {
              this.watches.delete(watch);
              watch.settled();
            };
            if (
              event.type === "session.tool.success" ||
              event.type === "session.tool.failed"
            ) {
              if (
                event.data.sessionID === watch.sessionID &&
                event.data.id === watch.callID
              )
                settle();
            } else if (event.type === "permission.asked") {
              if (
                event.data.sessionID === watch.sessionID &&
                event.data.source?.id === watch.callID
              )
                this.request(watch, `permission:${event.data.id}`);
            } else if (event.type === "permission.replied") {
              if (event.data.sessionID !== watch.sessionID) continue;
              if (
                watch.requests.delete(`permission:${event.data.requestID}`) &&
                event.data.reply === "reject"
              )
                settle();
            } else if (event.type === "form.created") {
              const form = event.data.form;
              if (
                form.sessionID === watch.sessionID &&
                record(form.metadata?.tool)?.id === watch.callID
              )
                this.request(watch, `form:${form.id}`);
            } else if (
              event.type === "form.cancelled" ||
              event.type === "form.replied"
            ) {
              if (event.data.sessionID !== watch.sessionID) continue;
              if (
                watch.requests.delete(`form:${event.data.id}`) &&
                event.type === "form.cancelled"
              )
                settle();
            }
          }
        }
      } catch {
        // Public events can carry private tool data. Do not include them in errors.
      } finally {
        const failure = new Error("Cursor host tool observation ended");
        if (this.abort.signal.aborted) this.failure = failure;
        for (const session of this.sessions) session.failed(failure);
        this.sessions.clear();
        for (const watch of this.watches) watch.failed(failure);
        this.watches.clear();
      }
      if (this.abort.signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })();
}

  private request(watch: Watch, id: string) {
    if (watch.requests.size >= 64)
      throw new Error("Host tool request capacity exceeded");
    watch.requests.add(id);
  }

  watch(
    sessionID: string,
    callID: string,
    settled: () => void,
    failed: (error: Error) => void,
  ): () => void {
    if (this.failure || this.abort.signal.aborted)
      throw this.failure ?? new Error("Cursor host observer disposed");
    const watch: Watch = {
      sessionID,
      callID,
      settled,
      failed,
      requests: new Set(),
    };
    this.watches.add(watch);
    return () => this.watches.delete(watch);
  }

  watchSession(
    sessionID: string,
    ended: () => void,
    failed: (error: Error) => void,
  ): () => void {
    if (this.failure || this.abort.signal.aborted)
      throw this.failure ?? new Error("Cursor host observer disposed");
    const session = { sessionID, ended, failed };
    this.sessions.add(session);
    return () => this.sessions.delete(session);
  }

  async dispose(): Promise<void> {
    this.abort.abort();
    await this.task;
  }
}
