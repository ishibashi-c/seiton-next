import type { App } from "obsidian";
import { normalizePath, TFile, TFolder } from "obsidian";
import type { VaultPort } from "../services/vaultPort";

/** Obsidian Vault API の実装。サービス層はこのクラスを直接知らない。 */
export class ObsidianVaultPort implements VaultPort {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  exists(path: string): boolean {
    return (
      this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile
    );
  }

  async read(path: string): Promise<string> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new Error(`ファイルがありません: ${normalized}`);
    }
    return this.app.vault.read(file);
  }

  async create(path: string, data: string): Promise<void> {
    const normalized = normalizePath(path);
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : "";
    if (parent !== "") {
      await this.ensureFolder(parent);
    }
    await this.app.vault.create(normalized, data);
  }

  async process(
    path: string,
    transform: (data: string) => string
  ): Promise<string> {
    const normalized = normalizePath(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) {
      throw new Error(`ファイルがありません: ${normalized}`);
    }
    return this.app.vault.process(file, transform);
  }

  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = `${normalizePath(folder)}/`;
    return this.app.vault
      .getMarkdownFiles()
      .map((file) => file.path)
      .filter((path) => path.startsWith(prefix));
  }

  mtime(path: string): number {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return file instanceof TFile ? file.stat.mtime : 0;
  }

  async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path)
      .split("/")
      .filter((segment) => segment !== "");
    let current = "";

    for (const segment of segments) {
      current = current === "" ? segment : `${current}/${segment}`;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`フォルダの代わりにファイルがあります: ${current}`);
      }
      try {
        await this.app.vault.createFolder(current);
      } catch (error) {
        if (
          !(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)
        ) {
          throw error;
        }
      }
    }
  }
}
