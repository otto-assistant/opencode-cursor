/**
 * Mutex (mutual exclusion lock) for serializing async operations.
 *
 * Used to prevent concurrent Cursor API requests for the same conversation
 * from interfering with each other's shared state (blobStore, checkpoints,
 * active bridges). Without serialization, a second request can overwrite
 * the first's state, causing "Blob not found" errors.
 *
 * Waiters may pass an AbortSignal so cancelled OpenCode queue/HTTP requests
 * leave the FIFO without ever holding the lock (otherwise a zombie waiter
 * can run a full Cursor turn after the client is gone and block the queue).
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * Acquire the mutex. Returns a release function.
   * If the mutex is already locked, the caller waits in a FIFO queue
   * until all previous holders have released.
   *
   * If `signal` aborts while waiting (or before grant), the promise rejects
   * with an AbortError and the waiter is removed from the queue.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const removeFromQueue = () => {
        const idx = this.queue.indexOf(wake);
        if (idx >= 0) this.queue.splice(idx, 1);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        removeFromQueue();
        signal?.removeEventListener("abort", onAbort);
        reject(abortError());
      };

      const grant = () => {
        // May be invoked as the initial acquire or as a handoff from release().
        if (settled) {
          // Aborted after being selected — pass the lock to the next waiter.
          this.handOffOrUnlock();
          return;
        }
        if (signal?.aborted) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          this.handOffOrUnlock();
          reject(abortError());
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.locked = true;
        resolve(() => this.handOffOrUnlock());
      };

      const wake = () => grant();

      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      if (!this.locked) {
        grant();
      } else {
        this.queue.push(wake);
      }
    });
  }

  /** True when no holder and no queued waiters remain. */
  isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }

  /** Number of waiters currently blocked on acquire (for tests/diagnostics). */
  waiterCount(): number {
    return this.queue.length;
  }

  private handOffOrUnlock(): void {
    if (this.queue.length > 0) {
      // Stay locked while handing off so another acquire cannot sneak in.
      this.locked = true;
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError")
  );
}
