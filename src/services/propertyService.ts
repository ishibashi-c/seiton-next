import type { App, TFile } from "obsidian";
import { normalizePath, TFile as TFileClass } from "obsidian";
import { normalizeLink } from "../domain/links";

export type PropertyValue =
  | string
  | number
  | boolean
  | string[]
  | null
  | undefined;

/** Obsidian の Properties を、未知のキーを残したまま更新する。 */
export class PropertyService {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  async update(
    path: string,
    patch: Record<string, PropertyValue>
  ): Promise<void> {
    const file = this.getFile(path);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      for (const [key, value] of Object.entries(patch)) {
        if (
          value === null ||
          value === undefined ||
          value === "" ||
          (Array.isArray(value) && value.length === 0)
        ) {
          delete frontmatter[key];
        } else {
          frontmatter[key] = value;
        }
      }
    });
  }

  getFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFileClass)) {
      throw new Error(`Markdownファイルがありません: ${path}`);
    }
    return file;
  }

  async appendLink(path: string, key: string, link: string): Promise<void> {
    const file = this.getFile(path);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const current = Array.isArray(frontmatter[key]) ? frontmatter[key] : [];
      const normalized = normalizeLink(link);
      const exists = current.some(
        (value: unknown) =>
          typeof value === "string" && normalizeLink(value) === normalized
      );
      if (!exists) {
        frontmatter[key] = [...current, link];
      }
    });
  }

  async removeLink(path: string, key: string, link: string): Promise<void> {
    const file = this.getFile(path);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (!Array.isArray(frontmatter[key])) {
        return;
      }
      const normalized = normalizeLink(link);
      const next = frontmatter[key].filter(
        (value: unknown) =>
          !(typeof value === "string" && normalizeLink(value) === normalized)
      );
      if (next.length === 0) {
        delete frontmatter[key];
      } else {
        frontmatter[key] = next;
      }
    });
  }
}
