import type { App } from "obsidian";
import { TFile } from "obsidian";
import { BOOK_COVERS_FOLDER } from "../domain/book";
import {
  analyzeCoverCache,
  type CoverCacheAnalysis,
} from "../domain/coverCache";
import type { NoteRecord, VaultIndexService } from "./vaultIndex";

/**
 * 表紙キャッシュ（System/Assets/Covers）の統計と削除。
 * 操作対象は必ずこのフォルダ内のファイルに限定する。
 */
export class CoverStore {
  private readonly app: App;
  private readonly indexService: VaultIndexService;

  constructor(app: App, indexService: VaultIndexService) {
    this.app = app;
    this.indexService = indexService;
  }

  async analyze(): Promise<CoverCacheAnalysis> {
    const index = await this.indexService.get();
    const referenced = index.notes
      .filter((note) => note.kind === "book")
      .map((note) => note.cover || note.book.book_cover || "")
      .filter((value) => value !== "");
    const files = this.app.vault
      .getFiles()
      .filter((file) => file.path.startsWith(`${BOOK_COVERS_FOLDER}/`))
      .map((file) => ({ path: file.path, size: file.stat.size }));
    return analyzeCoverCache(files, referenced, BOOK_COVERS_FOLDER);
  }

  async removeFiles(paths: string[]): Promise<number> {
    let removed = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (
        file instanceof TFile &&
        file.path.startsWith(`${BOOK_COVERS_FOLDER}/`)
      ) {
        await this.app.vault.delete(file);
        removed += 1;
      }
    }
    return removed;
  }

  async removeOrphans(): Promise<number> {
    const analysis = await this.analyze();
    return this.removeFiles(analysis.orphans.map((file) => file.path));
  }

  async removeAll(): Promise<number> {
    const analysis = await this.analyze();
    return this.removeFiles(analysis.files.map((file) => file.path));
  }

  /** ISBNがあり、表紙の実体がVaultにない本を返す。 */
  missingCovers(records: NoteRecord[]): NoteRecord[] {
    return records.filter((record) => {
      const isbn = (record.book.book_isbn ?? "").trim();
      if (isbn === "") {
        return false;
      }
      const cover = (record.cover || record.book.book_cover || "").trim();
      if (cover === "") {
        return true;
      }
      if (/^https?:\/\//u.test(cover)) {
        return false;
      }
      const link =
        cover
          .replace(/^!?\[\[|\]\]$/gu, "")
          .split("|")[0]
          ?.trim() ?? "";
      return !(this.app.vault.getAbstractFileByPath(link) instanceof TFile);
    });
  }
}
