import { describe, it, expect } from "vitest";
import { IndexReservationCounter, buildIndexKey } from "../src/indexReservation.js";

describe("IndexReservationCounter", () => {
  it("assigns unique, sequential indices for 5 near-simultaneous reservations on the same key", () => {
    const counter = new IndexReservationCounter();
    const key = buildIndexKey({ project: "Galaxy_S27", sequence: "SQ010", shot: "SH020", bucketId: "generated", mediaType: "image" });

    // Simulates 5 onDeterminingFilename callbacks firing back-to-back: since this is
    // called synchronously with no `await` in between, this is exactly what the
    // MV3 service worker's single-threaded event loop guarantees (§F-1).
    const reserved = [1, 2, 3, 4, 5].map(() => counter.reserveNext(key));

    expect(reserved).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(reserved).size).toBe(5); // no duplicates
  });

  it("keeps the reserved index fixed regardless of completion order", () => {
    const counter = new IndexReservationCounter();
    const key = buildIndexKey({ project: "P", sequence: "", shot: "SH020", mediaType: "image" });

    const jobs = [1, 2, 3, 4, 5].map((n) => ({ n, index: counter.reserveNext(key) }));
    // completion order is scrambled (025, 023, 027, 024, 026 in the spec's example) —
    // the counter has already handed out fixed values at detection time, so shuffling
    // the array here (simulating out-of-order completion) changes nothing about the
    // values themselves.
    const completedOutOfOrder = [jobs[2], jobs[0], jobs[4], jobs[1], jobs[3]];
    expect(completedOutOfOrder.map((j) => j.index)).toEqual([3, 1, 5, 2, 4]);
  });

  it("tracks independent counters per key", () => {
    const counter = new IndexReservationCounter();
    const keyA = buildIndexKey({ project: "A", sequence: "", shot: "SH010", mediaType: "image" });
    const keyB = buildIndexKey({ project: "A", sequence: "", shot: "SH020", mediaType: "image" });

    expect(counter.reserveNext(keyA)).toBe(1);
    expect(counter.reserveNext(keyB)).toBe(1);
    expect(counter.reserveNext(keyA)).toBe(2);
  });

  it("reconcile only ever moves the counter forward, never backward", () => {
    const counter = new IndexReservationCounter();
    const key = "k";
    counter.reserveNext(key); // 1
    counter.reserveNext(key); // 2

    counter.reconcile(key, 10); // disk already has up to 10 -> jump forward
    expect(counter.reserveNext(key)).toBe(11);

    counter.reconcile(key, 3); // a stale/lower report must never rewind
    expect(counter.reserveNext(key)).toBe(12);
  });

  it("restores from a persisted snapshot after a simulated service worker restart", () => {
    const counter = new IndexReservationCounter();
    const key = "k";
    counter.reserveNext(key);
    counter.reserveNext(key);
    const snapshot = counter.snapshot();

    const restarted = new IndexReservationCounter(snapshot);
    expect(restarted.reserveNext(key)).toBe(3);
  });
});
