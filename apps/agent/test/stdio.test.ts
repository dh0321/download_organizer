import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { readMessages, writeMessage } from "../src/stdio.js";

describe("native messaging stdio framing", () => {
  it("round-trips a message through write -> read", async () => {
    const stream = new PassThrough();
    const received: unknown[] = [];
    readMessages(stream, (msg) => received.push(msg));

    writeMessage(stream, { type: "pong" });

    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([{ type: "pong" }]);
  });

  it("handles multiple messages arriving in a single chunk", async () => {
    const stream = new PassThrough();
    const received: unknown[] = [];
    readMessages(stream, (msg) => received.push(msg));

    writeMessage(stream, { type: "ping" });
    writeMessage(stream, { type: "pong" });

    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([{ type: "ping" }, { type: "pong" }]);
  });

  it("handles a message split across multiple chunks", async () => {
    const stream = new PassThrough();
    const received: unknown[] = [];
    readMessages(stream, (msg) => received.push(msg));

    const json = Buffer.from(JSON.stringify({ type: "pong" }), "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    const full = Buffer.concat([header, json]);

    stream.write(full.subarray(0, 3)); // split mid-header
    stream.write(full.subarray(3, 6)); // split mid-body
    stream.write(full.subarray(6));

    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([{ type: "pong" }]);
  });

  it("drops a malformed frame without crashing and keeps processing later ones", async () => {
    const stream = new PassThrough();
    const received: unknown[] = [];
    readMessages(stream, (msg) => received.push(msg));

    const badJson = Buffer.from("not json", "utf-8");
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32LE(badJson.length, 0);
    stream.write(Buffer.concat([badHeader, badJson]));

    writeMessage(stream, { type: "pong" });

    await new Promise((r) => setImmediate(r));
    expect(received).toEqual([{ type: "pong" }]);
  });
});
