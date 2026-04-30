/**
 * Mutex (mutual exclusion lock) for serializing async operations.
 *
 * Used to prevent concurrent Cursor API requests for the same conversation
 * from interfering with each other's shared state (blobStore, checkpoints,
 * active bridges). Without serialization, a second request can overwrite
 * the first's state, causing "Blob not found" errors.
 */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * Acquire the mutex. Returns a release function.
   * If the mutex is already locked, the caller waits in a FIFO queue
   * until all previous holders have released.
   */
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      // Hand off directly to the next waiter — stays locked.
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  /** True when no holder and no queued waiters remain. */
  isIdle(): boolean {
    return !this.locked && this.queue.length === 0;
  }
}
