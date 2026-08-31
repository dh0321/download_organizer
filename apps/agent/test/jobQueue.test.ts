import { describe, it, expect } from "vitest";
import { JobWorkerPool } from "../src/jobQueue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("JobWorkerPool", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const pool = new JobWorkerPool(2);
    let active = 0;
    let maxObserved = 0;

    const task = async () => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await delay(20);
      active--;
    };

    await Promise.all([1, 2, 3, 4, 5, 6].map(() => pool.submit(task)));

    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("isolates failures — one task's rejection does not affect other tasks (§F-1 Failure Isolation)", async () => {
    const pool = new JobWorkerPool(2);
    const results: Array<{ ok: boolean; n: number }> = [];

    const jobs = [1, 2, 3, 4, 5].map((n) =>
      pool
        .submit(async () => {
          await delay(5);
          if (n === 2) throw new Error("job 2 failed");
          return n;
        })
        .then(
          (n) => results.push({ ok: true, n }),
          () => results.push({ ok: false, n }),
        ),
    );

    await Promise.all(jobs);

    expect(results).toHaveLength(5);
    expect(results.find((r) => r.n === 2)).toEqual({ ok: false, n: 2 });
    // every other job still succeeded — no rollback, no blocking
    expect(results.filter((r) => r.ok)).toHaveLength(4);
  });

  it("continues draining the queue after a failure", async () => {
    const pool = new JobWorkerPool(1); // force strict sequencing to prove drain() still runs
    const order: number[] = [];

    await Promise.allSettled(
      [1, 2, 3].map((n) =>
        pool.submit(async () => {
          if (n === 1) throw new Error("boom");
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([2, 3]);
  });
});
