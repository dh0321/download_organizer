// Minimal file logger. Necessary because Chrome launches the Agent as a child
// process per Native Messaging connection (§D) — there is no visible console
// window to read stderr from on Windows, so a log file is the only practical way
// to debug a real installation. Local-only, never transmitted anywhere (§F-2 Privacy).

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export class FileLogger {
  constructor(private readonly logPath: string) {}

  async log(message: string): Promise<void> {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      await mkdir(path.dirname(this.logPath), { recursive: true });
      await appendFile(this.logPath, line, "utf-8");
    } catch {
      // best-effort only — a logging failure must never crash the Agent
    }
  }
}
