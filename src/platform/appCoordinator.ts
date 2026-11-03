import type { App } from "obsidian";
import { TFile } from "obsidian";
import {
  LINKS_FILE,
  VIEW_TYPE_BOOKSHELF,
  VIEW_TYPE_HOME,
  VIEW_TYPE_LIBRARY,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_PROMPT,
  VIEW_TYPE_TSUBUYAKI,
} from "../config";
import { embedCoverInDocument, hasCoverEmbed } from "../domain/bookCoverEmbed";
import { userMessageOf } from "../domain/errors";
import { addLink, importLinks } from "../domain/linkList";
import { domainOf } from "../domain/network";
import { ensureBasesViews, openBasesView } from "../services/basesService";
import type { BookService } from "../services/bookService";
import type { CoverStore } from "../services/coverStore";
import type { LinkListService } from "../services/linkListService";
import type { MemoService } from "../services/memoService";
import type { MigrationService } from "../services/migrationService";
import type { NoteService } from "../services/noteService";
import type { PropertyService } from "../services/propertyService";
import type { SeitonSettings } from "../services/settings";
import { TriageService } from "../services/triageService";
import type { NoteRecord, VaultIndexService } from "../services/vaultIndex";
import type { WebClipService } from "../services/webClipService";
import { AddBookModal } from "./books/addBookModal";
import { BookBulkEditModal } from "./books/bookBulkEditModal";
import { BookDetailModal } from "./books/bookDetailModal";
import { BulkIsbnModal } from "./bulkIsbnModal";
import { CalilBulkModal } from "./calilBulkModal";
import { ConfirmModal } from "./confirmModal";
import { CoverCacheModal } from "./coverCacheModal";
import { SeitonHomeView } from "./homeView";
import { SeitonLibraryView } from "./libraryView";
import { MemoCaptureModal } from "./memoCaptureModal";
import { MigrationModal } from "./migrationModal";
import { NewNoteModal } from "./newNoteModal";
import { SeitonProjectsView } from "./projectsView";
import { PromptWorkbenchView } from "./promptView";
import { openSeitonView } from "./seitonNav";
import { TriageModal } from "./triageModal";
import { showToast } from "./ui/toast";
import {
  type WebClipCaptureInput,
  WebClipCaptureModal,
} from "./webClipCaptureModal";
import { WebClipPreviewModal } from "./webClipModal";

export interface AppCoordinatorContext {
  app: App;
  books: BookService;
  covers: CoverStore;
  getSettings: () => SeitonSettings;
  indexService: VaultIndexService;
  links: LinkListService;
  memoService: MemoService;
  migration: MigrationService;
  notes: NoteService;
  properties: PropertyService;
  saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>;
  webClips: WebClipService;
}

export class AppCoordinator {
  private readonly app: App;
  private readonly books: BookService;
  private readonly covers: CoverStore;
  private readonly getSettings: () => SeitonSettings;
  private readonly indexService: VaultIndexService;
  private readonly links: LinkListService;
  private readonly memoService: MemoService;
  private readonly migration: MigrationService;
  private readonly notes: NoteService;
  private readonly properties: PropertyService;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private readonly webClips: WebClipService;

  private pendingMemoDraft = "";
  private captureOpen = false;

  constructor(ctx: AppCoordinatorContext) {
    this.app = ctx.app;
    this.books = ctx.books;
    this.covers = ctx.covers;
    this.getSettings = ctx.getSettings;
    this.indexService = ctx.indexService;
    this.links = ctx.links;
    this.memoService = ctx.memoService;
    this.migration = ctx.migration;
    this.notes = ctx.notes;
    this.properties = ctx.properties;
    this.saveSettings = ctx.saveSettings;
    this.webClips = ctx.webClips;
  }

  async openHome(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_HOME);
  }

  async openTsubuyaki(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_TSUBUYAKI);
  }

  async openLibrary(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_LIBRARY);
  }

  openTriage(): void {
    new TriageModal(
      this.app,
      new TriageService(this.app, this.properties, this.indexService),
      () => {
        this.indexService.invalidate();
        this.refreshHomeViews();
      }
    ).open();
  }

  async openReviewTray(): Promise<void> {
    await this.openLibrary();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    const view = leaf?.view;
    if (view instanceof SeitonLibraryView) {
      view.showReview();
    }
  }

  async searchLibrary(): Promise<void> {
    await this.openLibrary();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    const view = leaf?.view;
    if (view instanceof SeitonLibraryView) {
      view.focusSearch();
    }
  }

  async runCalilBulk(): Promise<void> {
    const records = await this.books.listBooks();
    this.openCalilBulk(records);
  }

  /** 表紙が無い本に、書名入りの仮表紙を作って割り当てる。 */
  async makePlaceholderCovers(): Promise<void> {
    const index = await this.indexService.get();
    const targets = index.notes.filter(
      (note) =>
        note.kind === "book" &&
        (note.book.book_cover ?? "").trim() === "" &&
        (note.book.book_isbn ?? "").trim() !== ""
    );
    if (targets.length === 0) {
      showToast("表紙が無い本はありません。");
      return;
    }
    new ConfirmModal(this.app, {
      confirmingLabel: "作る",
      message: `${targets.length}冊に仮表紙を作ります。`,
      onConfirm: async () => {
        let done = 0;
        for (const note of targets) {
          const ok = await this.books.applyPlaceholderCover(note);
          if (ok) {
            done += 1;
          }
        }
        showToast(`${done}冊に仮表紙を作りました。`);
        this.indexService.invalidate();
      },
      title: "仮表紙を作る",
    }).open();
  }

  /** 既存の本の本文先頭に、保存済みの表紙をまとめて埋め込む。 */
  async embedBookCovers(): Promise<void> {
    const index = await this.indexService.get();
    const targets: { cover: string; file: TFile }[] = [];
    for (const note of index.notes) {
      const cover = (note.book.book_cover ?? "").trim();
      if (note.kind !== "book" || cover === "") {
        continue;
      }
      const file = this.app.vault.getAbstractFileByPath(note.path);
      if (!(file instanceof TFile)) {
        continue;
      }
      const text = await this.app.vault.read(file);
      if (!hasCoverEmbed(text, cover)) {
        targets.push({ cover, file });
      }
    }
    if (targets.length === 0) {
      showToast("表紙はすべて埋め込み済みです。");
      return;
    }
    new ConfirmModal(this.app, {
      confirmingLabel: "埋め込む",
      message: `${targets.length}冊のノート本文の先頭に表紙を追加します。`,
      onConfirm: async () => {
        let done = 0;
        for (const target of targets) {
          await this.app.vault.process(target.file, (data) =>
            embedCoverInDocument(data, target.cover)
          );
          done += 1;
        }
        showToast(`${done}冊に表紙を埋め込みました。`);
        this.indexService.invalidate();
      },
      title: "表紙をノートに埋め込む",
    }).open();
  }

  async openCoverCacheForAll(): Promise<void> {
    const records = await this.books.listBooks();
    this.openCoverCache(records);
  }

  openWebClipCapture(input: WebClipCaptureInput): void {
    new WebClipCaptureModal(this.app, this.webClips, input, () => {
      this.indexService.invalidate();
      this.refreshHomeViews();
    }).open();
  }

  /** スマホの共有シートやブックマークレットから、リンク集に1行足す。 */
  async addShortcutLink(url: string, title: string): Promise<void> {
    const label = title.trim() || domainOf(url) || url;
    try {
      const edit = await this.links.edit((content) =>
        addLink(content, { group: null, label, target: url })
      );
      if (edit.status === "added") {
        showToast(`「${label}」を追加しました。`);
      } else if (edit.status === "duplicate") {
        showToast("同じリンクがすでにあります。");
      } else {
        showToast("追加できませんでした。");
      }
      this.refreshHomeViews();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }

  /** 旧設定（data.json）のショートカットをノートへ移す。何度実行しても重複しない。 */
  async importShortcutSettings(): Promise<void> {
    const items = this.getSettings().shortcuts.map((shortcut) => ({
      label: shortcut.label,
      target: shortcut.target,
    }));
    if (items.length === 0) {
      showToast("移すショートカットはありません。");
      return;
    }
    let added = 0;
    try {
      await this.links.edit((content) => {
        const result = importLinks(content, items);
        added = result.added;
        return {
          content: result.content,
          status: result.added > 0 ? "added" : "duplicate",
        };
      });
    } catch (error) {
      showToast(userMessageOf(error));
      return;
    }
    showToast(`${added}件をノートへ移しました。`);
    this.refreshHomeViews();
  }

  async openLinkList(): Promise<void> {
    try {
      await this.links.ensure();
    } catch (error) {
      showToast(userMessageOf(error));
      return;
    }
    await this.app.workspace.openLinkText(LINKS_FILE, "", false);
  }

  openBulkIsbn(): void {
    new BulkIsbnModal(this.app, this.books, () => {
      this.indexService.invalidate();
    }).open();
  }

  openBookBulkEdit(records: NoteRecord[]): void {
    new BookBulkEditModal(this.app, this.books, records, {
      onApplied: () => this.indexService.invalidate(),
    }).open();
  }

  openCalilBulk(records: NoteRecord[]): void {
    if (records.length === 0) {
      showToast("本がありません。");
      return;
    }
    new CalilBulkModal(
      this.app,
      this.books,
      records,
      () => this.getSettings(),
      (patch) => this.saveSettings(patch)
    ).open();
  }

  openCoverCache(records: NoteRecord[]): void {
    new CoverCacheModal(this.app, this.covers, this.books, records, () => {
      this.indexService.invalidate();
    }).open();
  }

  async openBookshelf(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_BOOKSHELF);
  }

  async openProjects(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROJECTS);
  }

  async openProject(path: string): Promise<void> {
    await this.openProjects();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
    if (leaf?.view instanceof SeitonProjectsView) {
      await leaf.view.selectProject(path);
    }
  }

  async openPromptView(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
  }

  async openPrompt(path?: string): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROMPT)[0];
    const view = leaf?.view;
    if (view instanceof PromptWorkbenchView) {
      await view.openPath(path ?? null);
    }
  }

  async newPromptSession(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROMPT)[0];
    const view = leaf?.view;
    if (view instanceof PromptWorkbenchView) {
      view.newSession();
    }
  }

  openNewNote(): void {
    new NewNoteModal(this.app, this.notes, this.indexService, "", (path) => {
      void this.openFile(path);
    }).open();
  }

  async openBases(): Promise<void> {
    try {
      const result = await ensureBasesViews(this.app);
      const first = result.paths[0];
      if (first) {
        await openBasesView(this.app, first);
      }
      if (result.created.length > 0) {
        showToast("Basesビューを作成しました。");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }

  openAddBook(isbn = ""): void {
    new AddBookModal(this.app, this.books, {
      ...(isbn === "" ? {} : { initialIsbn: isbn }),
      onCreated: (result) => {
        this.indexService.invalidate();
        void this.openFile(result.path);
      },
    }).open();
  }

  openBookDetail(record: NoteRecord): void {
    new BookDetailModal(this.app, this.books, record, {
      onSaved: () => this.indexService.invalidate(),
    }).open();
  }

  async bulkEditBooks(): Promise<void> {
    try {
      const records = await this.books.listBooks();
      if (records.length === 0) {
        showToast("本棚に書籍がありません。");
        return;
      }
      new BookBulkEditModal(this.app, this.books, records, {
        onApplied: () => this.indexService.invalidate(),
      }).open();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }

  openMigration(): void {
    new MigrationModal(this.app, this.migration, {
      onConverted: () => {
        this.indexService.invalidate();
        showToast("移行結果を確認してください。元ファイルは変更していません。");
      },
    }).open();
  }

  openWebClipPreview(path: string, source: string): void {
    new WebClipPreviewModal(this.app, this.webClips, {
      initialUrl: source,
      notePath: path,
      onChanged: () => this.indexService.invalidate(),
    }).open();
  }

  openActiveWebClipPreview(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      showToast("Webクリップのノートを開いてください。");
      return;
    }
    const frontmatter =
      (this.app.metadataCache.getFileCache(file)?.frontmatter as
        | Record<string, unknown>
        | undefined) ?? {};
    if (frontmatter.kind !== "webclip") {
      showToast("現在のノートはWebクリップではありません。");
      return;
    }
    const source =
      typeof frontmatter.source === "string" ? frontmatter.source : "";
    this.openWebClipPreview(file.path, source);
  }

  async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      showToast("ファイルが見つかりません。");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  openMemoCapture(): void {
    if (this.captureOpen) {
      showToast("一言メモの入力画面は既に開いています。");
      return;
    }
    this.captureOpen = true;

    new MemoCaptureModal(this.app, this.memoService, {
      initialValue: this.pendingMemoDraft,
      onClosed: () => {
        this.captureOpen = false;
      },
      onDraftChange: (value) => {
        this.pendingMemoDraft = value;
      },
      onSaved: () => {
        this.pendingMemoDraft = "";
        this.refreshHomeViews();
      },
    }).open();
  }

  async openCurrentWeek(): Promise<void> {
    const path = this.memoService.currentWeekPath();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      showToast("今週の一言メモはまだありません。一言メモを追加してください。");
      return;
    }
    await this.app.workspace.openLinkText(path, "", true);
  }

  refreshHomeViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HOME)) {
      const view = leaf.view;
      if (view instanceof SeitonHomeView) {
        void view.refresh();
      }
    }
    this.indexService.invalidate();
  }
}
