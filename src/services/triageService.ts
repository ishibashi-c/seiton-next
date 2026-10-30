import type { App } from "obsidian";
import { TFile } from "obsidian";
import type { PropertyService, PropertyValue } from "./propertyService";
import type { NoteRecord, VaultIndexService } from "./vaultIndex";

interface UndoEntry {
  patch: Record<string, PropertyValue>;
  path: string;
}

/**
 * 未整理（review: true）を1件ずつ処理する。
 * 書き込みと取り消しの履歴だけを持ち、UIから独立させる。
 */
export class TriageService {
  private readonly app: App;
  private readonly properties: PropertyService;
  private readonly indexService: VaultIndexService;
  private undoEntry: UndoEntry | null = null;

  constructor(
    app: App,
    properties: PropertyService,
    indexService: VaultIndexService
  ) {
    this.app = app;
    this.properties = properties;
    this.indexService = indexService;
  }

  async queue(): Promise<NoteRecord[]> {
    const index = await this.indexService.get();
    return index.notes
      .filter((note) => note.review && !note.archived)
      .sort((left, right) => left.mtime - right.mtime);
  }

  canUndo(): boolean {
    return this.undoEntry !== null;
  }

  async decide(
    note: NoteRecord,
    patch: Record<string, PropertyValue>
  ): Promise<void> {
    // 変更したキーだけを元へ戻す。false は「未設定」へ戻す。
    const undoPatch: Record<string, PropertyValue> = {
      review: note.review ? true : null,
    };
    for (const key of Object.keys(patch)) {
      if (key === "review") {
        continue;
      }
      const previous = (note as unknown as Record<string, PropertyValue>)[key];
      undoPatch[key] =
        previous === false || previous === "" || previous === undefined
          ? null
          : previous;
    }
    this.undoEntry = { patch: undoPatch, path: note.path };
    await this.properties.update(note.path, { ...patch, review: false });
    this.indexService.invalidate();
  }

  /** 直前の1件を元へ戻し、そのパスを返す。 */
  async undo(): Promise<string | null> {
    const entry = this.undoEntry;
    if (!entry) {
      return null;
    }
    this.undoEntry = null;
    await this.properties.update(entry.path, entry.patch);
    this.indexService.invalidate();
    return entry.path;
  }

  async open(note: NoteRecord): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(note.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }
}
