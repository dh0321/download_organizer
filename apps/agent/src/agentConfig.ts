// Agent's own local, authoritative configuration store. See PLAN.md §F-2 (Root
// Sandbox Policy) — this file is the *only* source of truth for defaultRoot /
// folderTemplate / assetBuckets / conflictPolicy / maxConcurrentFileOps. The
// Extension never dictates these per-request; it can only ask to change them via
// a "sync-settings" message, handled here.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentConfig, FolderTemplate, AssetBucket } from "@ai-asset-saver/shared";

export const DEFAULT_FOLDER_TEMPLATE: FolderTemplate = {
  id: "default",
  name: "Project / Sequence / Shot",
  levels: [
    { key: "project", label: "Project", order: 0, required: true },
    { key: "sequence", label: "Sequence", order: 1, required: false },
    { key: "shot", label: "Shot", order: 2, required: false },
  ],
};

export const DEFAULT_ASSET_BUCKETS: AssetBucket[] = [
  { id: "generated", label: "Generated", order: 0 },
  { id: "reference", label: "Reference", order: 1 },
  { id: "select", label: "Select", order: 2 },
  { id: "final", label: "Final", order: 3 },
];

export function defaultAgentConfig(allowedExtensionId: string): AgentConfig {
  return {
    defaultRoot: "",
    folderTemplate: DEFAULT_FOLDER_TEMPLATE,
    assetBuckets: DEFAULT_ASSET_BUCKETS,
    conflictPolicy: "uniquify",
    maxConcurrentFileOps: 2,
    allowedExtensionId,
  };
}

export class AgentConfigStore {
  private config: AgentConfig;

  constructor(
    private readonly configPath: string,
    initial: AgentConfig,
  ) {
    this.config = initial;
  }

  static async load(configPath: string, allowedExtensionId: string): Promise<AgentConfigStore> {
    try {
      const raw = await readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as AgentConfig;
      return new AgentConfigStore(configPath, parsed);
    } catch {
      // No config yet (first run) — start with an unconfigured default. defaultRoot
      // stays "" until the installer or the user explicitly sets one; file-router
      // must treat an empty defaultRoot as ROOT_NOT_CONFIGURED, never as "no
      // restriction" (§F-2 fail-closed).
      return new AgentConfigStore(configPath, defaultAgentConfig(allowedExtensionId));
    }
  }

  get(): Readonly<AgentConfig> {
    return this.config;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2), "utf-8");
  }

  /**
   * Applies a "sync-settings" request. Only the fields the protocol allows to be
   * synced are touched — allowedExtensionId is never settable remotely (§F-2
   * Minimum Privilege: it is fixed at install time only).
   */
  async applySyncSettings(settings: Omit<AgentConfig, "allowedExtensionId">): Promise<void> {
    this.config = { ...this.config, ...settings, allowedExtensionId: this.config.allowedExtensionId };
    await this.save();
  }
}
