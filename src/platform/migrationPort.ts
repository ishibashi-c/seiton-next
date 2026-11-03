import type { App } from "obsidian";
import type { MigrationPort } from "../services/migrationService";
import { ObsidianVaultPort } from "./obsidianVaultPort";

/**
 * ObsidianのVault APIを移行サービス用のポートへ合わせる。
 * `MigrationService` にはこのポートだけを渡す。
 */
export function createObsidianMigrationPort(app: App): MigrationPort {
  const vault = new ObsidianVaultPort(app);
  return {
    create: (path, data) => vault.create(path, data),
    ensureFolder: (path) => vault.ensureFolder(path),
    exists: (path) => vault.exists(path),
    listMarkdown: async () =>
      app.vault.getMarkdownFiles().map((file) => file.path),
    process: (path, transform) => vault.process(path, transform),
    read: (path) => vault.read(path),
  };
}
