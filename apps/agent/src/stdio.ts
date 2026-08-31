// Native Messaging stdio framing: each message is a 4-byte little-endian length
// prefix followed by that many bytes of UTF-8 JSON. See:
// https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Per the documented limits, a single message from the host to the extension is
// capped at 1 MiB; we only ever send small JSON status objects (§F-2 protocol has
// no bulk-data messages), so this is never a practical constraint.

import type { Readable, Writable } from "node:stream";

const MAX_HOST_TO_EXTENSION_MESSAGE_BYTES = 1024 * 1024;

export function writeMessage(output: Writable, message: unknown): void {
  const json = Buffer.from(JSON.stringify(message), "utf-8");
  if (json.length > MAX_HOST_TO_EXTENSION_MESSAGE_BYTES) {
    throw new Error(`Outgoing native message exceeds 1MiB limit (${json.length} bytes)`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  output.write(header);
  output.write(json);
}

/**
 * Listens for framed messages on `input` and invokes `onMessage` for each
 * successfully-parsed one. Malformed frames are dropped rather than crashing the
 * host process — a malformed message from a legitimate paired Extension should
 * never happen, and crashing would abandon every other in-flight job too.
 */
export function readMessages(input: Readable, onMessage: (msg: unknown) => void): void {
  let buffer = Buffer.alloc(0);

  input.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;

      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      try {
        onMessage(JSON.parse(body.toString("utf-8")));
      } catch {
        // drop malformed frame, keep the host alive
      }
    }
  });
}
