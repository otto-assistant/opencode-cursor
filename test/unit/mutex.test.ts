import { describe, expect, test } from "bun:test";
import { Mutex } from "../../src/promise-queue";

describe("Mutex", () => {
  test("basic acquire/release cycle", async () => {
    const mutex = new Mutex();
    expect(mutex.isIdle()).toBe(true);
    const release = await mutex.acquire();
    expect(mutex.isIdle()).toBe(false);
    release();
    expect(mutex.isIdle()).toBe(true);
  });

  test("concurrent acquire waits in queue", async () => {
    const mutex = new Mutex();
    const release1 = await mutex.acquire();
    let secondAcquired = false;
    const waiter = mutex.acquire().then((release2) => {
      secondAcquired = true;
      release2();
    });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    release1();
    await waiter;
    expect(secondAcquired).toBe(true);
    expect(mutex.isIdle()).toBe(true);
  });

  test("enforces FIFO ordering", async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    const releaseFirst = await mutex.acquire();
    const p1 = mutex.acquire().then((release) => {
      order.push(1);
      release();
    });
    const p2 = mutex.acquire().then((release) => {
      order.push(2);
      release();
    });
    const p3 = mutex.acquire().then((release) => {
      order.push(3);
      release();
    });
    releaseFirst();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("isIdle reflects lock and queue states", async () => {
    const mutex = new Mutex();
    const release = await mutex.acquire();
    expect(mutex.isIdle()).toBe(false);
    const waiter = mutex.acquire();
    await Promise.resolve();
    expect(mutex.isIdle()).toBe(false);
    release();
    const release2 = await waiter;
    expect(mutex.isIdle()).toBe(false);
    release2();
    expect(mutex.isIdle()).toBe(true);
  });

  test("supports multiple sequential operations", async () => {
    const mutex = new Mutex();
    const results: string[] = [];
    for (const label of ["a", "b", "c", "d"]) {
      const release = await mutex.acquire();
      results.push(label);
      release();
    }
    expect(results).toEqual(["a", "b", "c", "d"]);
    expect(mutex.isIdle()).toBe(true);
  });
});
