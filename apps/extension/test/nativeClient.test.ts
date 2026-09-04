import { describe, it, expect, vi } from "vitest";
import { NativeClient, NativeClientDisconnectedError, type NativePort } from "../src/background/nativeClient.js";
import type { NativeRequest, NativeResponse } from "@ai-asset-saver/shared";

class FakePort implements NativePort {
  private messageListeners: Array<(msg: NativeResponse) => void> = [];
  private disconnectListeners: Array<(errorMessage?: string) => void> = [];
  public sent: NativeRequest[] = [];

  postMessage(message: NativeRequest): void {
    this.sent.push(message);
  }
  onMessage = { addListener: (cb: (msg: NativeResponse) => void) => this.messageListeners.push(cb) };
  onDisconnect = { addListener: (cb: (errorMessage?: string) => void) => this.disconnectListeners.push(cb) };

  emit(msg: NativeResponse): void {
    for (const cb of this.messageListeners) cb(msg);
  }
  disconnect(errorMessage?: string): void {
    for (const cb of this.disconnectListeners) cb(errorMessage);
  }
}

describe("NativeClient", () => {
  it("correlates concurrent route-file requests by jobId, even when responses arrive out of order", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);

    const p1 = client.send({ type: "route-file", jobId: "a", sourcePath: "", extension: ".png", mediaType: "image", reservedIndex: 1, naming: {} as any });
    const p2 = client.send({ type: "route-file", jobId: "b", sourcePath: "", extension: ".png", mediaType: "image", reservedIndex: 2, naming: {} as any });

    // respond to "b" first, then "a" — client must not mix them up
    port.emit({ type: "route-file-result", jobId: "b", ok: true, finalPath: "/dest/b.png" });
    port.emit({ type: "route-file-result", jobId: "a", ok: true, finalPath: "/dest/a.png" });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ jobId: "a", finalPath: "/dest/a.png" });
    expect(r2).toMatchObject({ jobId: "b", finalPath: "/dest/b.png" });
  });

  it("matches non-route-file requests FIFO by response type", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);

    const p1 = client.send({ type: "ping" });
    const p2 = client.send({ type: "ping" });

    port.emit({ type: "pong" });
    port.emit({ type: "pong" });

    await expect(p1).resolves.toEqual({ type: "pong" });
    await expect(p2).resolves.toEqual({ type: "pong" });
  });

  it("rejects all pending requests when the port disconnects", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);

    const p1 = client.send({ type: "ping" });
    port.disconnect();

    await expect(p1).rejects.toBeInstanceOf(NativeClientDisconnectedError);
  });

  it("includes chrome.runtime.lastError's message in the rejection (e.g. Agent not installed yet)", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);

    const p1 = client.send({ type: "ping" });
    port.disconnect("Specified native messaging host not found.");

    await expect(p1).rejects.toThrow(/Specified native messaging host not found/);
  });

  it("times out a request that never receives a response", async () => {
    vi.useFakeTimers();
    const port = new FakePort();
    const client = new NativeClient(() => port);

    const p1 = client.send({ type: "ping" }, 1000);
    const assertion = expect(p1).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("reconnects lazily after a disconnect (does not eagerly retry)", async () => {
    let connectCount = 0;
    const port = new FakePort();
    const client = new NativeClient(() => {
      connectCount++;
      return port;
    });

    const firstSend = client.send({ type: "ping" }).catch(() => {}); // expected to reject on disconnect below
    expect(connectCount).toBe(1);
    port.disconnect();
    await firstSend;
    expect(connectCount).toBe(1); // no reconnect attempt just from disconnecting

    client.send({ type: "ping" }).catch(() => {});
    expect(connectCount).toBe(2); // only reconnects when a new send() actually happens
  });

  it("delivers organize-progress push messages to subscribers without resolving any pending request", async () => {
    const port = new FakePort();
    const client = new NativeClient(() => port);

    const pending = client.send({ type: "ping" }); // establishes the connection
    const received: Array<{ completed: number; total: number }> = [];
    const unsubscribe = client.onOrganizeProgress((completed, total) => received.push({ completed, total }));

    port.emit({ type: "organize-progress", completed: 1, total: 3 });
    port.emit({ type: "organize-progress", completed: 2, total: 3 });
    expect(received).toEqual([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
    ]);

    unsubscribe();
    port.emit({ type: "organize-progress", completed: 3, total: 3 });
    expect(received).toHaveLength(2); // no longer subscribed after unsubscribe

    // the still-pending "ping" send() must be completely unaffected
    port.emit({ type: "pong" });
    await expect(pending).resolves.toEqual({ type: "pong" });
  });
});
