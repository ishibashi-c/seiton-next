/**
 * Seiton Next (plugin id: seiton-next)
 * 個人用の記録・整理・再発見プラグイン。
 * 既存のSeiton (id: seiton) とは別プラグインとして動く。
 */

import type { EventRef, Menu } from "obsidian";
import { Notice, Plugin, TFile } from "obsidian";
import {
  LINKS_FILE,
  VIEW_TYPE_BOOKSHELF,
  VIEW_TYPE_HOME,
  VIEW_TYPE_LIBRARY,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_PROMPT,
  VIEW_TYPE_TSUBUYAKI,
} from "./config";
import { embedCoverInDocument, hasCoverEmbed } from "./domain/book";
import { isSeitonError, userMessageOf } from "./domain/errors";
import { addLink, importLinks } from "./domain/linkList";
import { domainOf } from "./domain/network";
import { parseSharedWebText } from "./domain/webclip";
import {
  AddBookModal,
  BookBulkEditModal,
  BookDetailModal,
} from "./platform/bookModals";
import { SeitonBookshelfView } from "./platform/bookshelfView";
import { BulkIsbnModal } from "./platform/bulkIsbnModal";
import { CalilBulkModal } from "./platform/calilBulkModal";
import { registerCommands } from "./platform/commands";
import { ConfirmModal } from "./platform/confirmModal";
import { CoverCacheModal } from "./platform/coverCacheModal";
import { renderPlaceholderCover } from "./platform/coverPlaceholder";
import { registerFormatting } from "./platform/formatting";
import { SeitonHomeView } from "./platform/homeView";
import { SeitonLibraryView } from "./platform/libraryView";
import { MemoCaptureModal } from "./platform/memoCaptureModal";
import {
  createObsidianMigrationPort,
  MigrationModal,
} from "./platform/migrationModal";
import { NewNoteModal } from "./platform/newNoteModal";
import { ObsidianVaultPort } from "./platform/obsidianVaultPort";
import { SeitonProjectsView } from "./platform/projectsView";
import { PromptWorkbenchView } from "./platform/promptView";
import { openSeitonView } from "./platform/seitonNav";
import { SeitonSettingTab } from "./platform/settingsTab";
import { TriageModal } from "./platform/triageModal";
import { SeitonTsubuyakiView } from "./platform/tsubuyakiView";
import { handleSeitonUri } from "./platform/uri";
import {
  type WebClipCaptureInput,
  WebClipCaptureModal,
} from "./platform/webClipCaptureModal";
import { WebClipPreviewModal } from "./platform/webClipModal";
import { ensureBasesViews, openBasesView } from "./services/basesService";
import { BookService } from "./services/bookService";
import { CoverStore } from "./services/coverStore";
import { ObsidianHttpClient } from "./services/http";
import { LinkListService } from "./services/linkListService";
import { MemoService } from "./services/memoService";
import { MigrationService } from "./services/migrationService";
import { NoteService } from "./services/noteService";
import { PromptService } from "./services/promptService";
import { PropertyService } from "./services/propertyService";
import type { SeitonSettings } from "./services/settings";
import { normalizeSettings } from "./services/settings";
import { TriageService } from "./services/triageService";
import type { NoteRecord } from "./services/vaultIndex";
import { VaultIndexService } from "./services/vaultIndex";
import { WebClipService } from "./services/webClipService";

export default class SeitonNextPlugin extends Plugin {
  override settings: SeitonSettings = normalizeSettings(null);

  private memoService!: MemoService;
  private promptService!: PromptService;
  private indexService!: VaultIndexService;
  private covers!: CoverStore;
  private properties!: PropertyService;
  private notes!: NoteService;
  private webClips!: WebClipService;
  private books!: BookService;
  private migration!: MigrationService;
  private links!: LinkListService;
  private pendingMemoDraft = "";
  private captureOpen = false;

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    const vault = new ObsidianVaultPort(this.app);
    const logError = (context: string, error: unknown): void => {
      if (isSeitonError(error)) {
        console.error(`[Seiton] ${context}: ${error.code} ${error.message}`);
        return;
      }
      console.error(`[Seiton] ${context}`, error);
    };

    this.memoService = new MemoService({ logError, vault });
    this.promptService = new PromptService({ logError, vault });
    this.indexService = new VaultIndexService(this.app);
    this.covers = new CoverStore(this.app, this.indexService);
    this.properties = new PropertyService(this.app);
    this.notes = new NoteService(this.app, this.properties);
    const http = new ObsidianHttpClient();
    this.webClips = new WebClipService(
      this.app,
      http,
      this.properties,
      () => this.settings
    );
    this.books = new BookService({
      app: this.app,
      getSettings: () => this.settings,
      http,
      index: this.indexService,
      logError,
      properties: this.properties,
      renderPlaceholderCover,
    });
    this.migration = new MigrationService({
      logError,
      port: createObsidianMigrationPort(this.app),
    });
    this.links = new LinkListService(vault, LINKS_FILE);

    this.registerView(
      VIEW_TYPE_HOME,
      (leaf) =>
        new SeitonHomeView(
          leaf,
          this.memoService,
          this.indexService,
          this.promptService,
          this.notes,
          () => this.settings,
          this.links
        )
    );
    this.registerView(
      VIEW_TYPE_TSUBUYAKI,
      (leaf) => new SeitonTsubuyakiView(leaf, this.memoService)
    );
    this.registerView(
      VIEW_TYPE_LIBRARY,
      (leaf) =>
        new SeitonLibraryView(
          leaf,
          this.indexService,
          this.properties,
          this.notes,
          this.settings,
          {
            addBook: () => this.openAddBook(),
            openBook: (record) => this.openBookDetail(record),
            openProject: (path) => void this.openProject(path),
            openPrompt: (path) => void this.openPrompt(path),
            previewWebClip: (path, source) =>
              this.openWebClipPreview(path, source),
          },
          this.webClips
        )
    );
    this.registerView(
      VIEW_TYPE_BOOKSHELF,
      (leaf) =>
        new SeitonBookshelfView(leaf, this.indexService, {
          addBook: () => this.openAddBook(),
          bulkEdit: (records) => {
            if (records.length === 0) {
              new Notice("本がありません。");
              return;
            }
            new BookBulkEditModal(this.app, this.books, records, {
              onApplied: () => this.indexService.invalidate(),
            }).open();
          },
          bulkIsbn: () => this.openBulkIsbn(),
          calilBulk: (records) => this.openCalilBulk(records),
          manageCovers: (records) => this.openCoverCache(records),
          openBook: (record) => this.openBookDetail(record),
          openNote: (path) => void this.openFile(path),
        })
    );
    this.registerView(
      VIEW_TYPE_PROJECTS,
      (leaf) =>
        new SeitonProjectsView(
          leaf,
          this.indexService,
          this.properties,
          this.notes,
          this.promptService,
          { openPrompt: (path) => void this.openPrompt(path) }
        )
    );
    this.registerView(
      VIEW_TYPE_PROMPT,
      (leaf) => new PromptWorkbenchView(leaf, this.promptService)
    );

    this.addRibbonIcon("notebook", "Seiton ホームを開く", () => {
      void this.openHome();
    });
    this.registerObsidianProtocolHandler("seiton-next", (params) => {
      void handleSeitonUri(
        {
          addShortcutLink: (url, title) => this.addShortcutLink(url, title),
          app: this.app,
          indexService: this.indexService,
          memoService: this.memoService,
          openAddBook: (isbn) => this.openAddBook(isbn),
          openBookDetail: (record) => this.openBookDetail(record),
          openBookshelf: () => this.openBookshelf(),
          openHome: () => this.openHome(),
          openLibrary: () => this.openLibrary(),
          openProjects: () => this.openProjects(),
          openPromptView: () => this.openPromptView(),
          openTsubuyaki: () => this.openTsubuyaki(),
          openWebClipCapture: (input) => this.openWebClipCapture(input),
          refreshHomeViews: () => this.refreshHomeViews(),
          version: this.manifest.version,
        },
        params
      );
    });
    const workspaceWithShareMenu = this.app
      .workspace as typeof this.app.workspace & {
      on(
        name: "receive-text-menu",
        callback: (menu: Menu, sharedText: string) => void
      ): EventRef;
    };
    this.registerEvent(
      workspaceWithShareMenu.on("receive-text-menu", (menu, sharedText) => {
        const parsed = parseSharedWebText(sharedText);
        if (parsed.url === "") {
          return;
        }
        menu.addItem((item) =>
          item
            .setTitle("Seitonに保存")
            .setIcon("bookmark")
            .onClick(() => {
              this.openWebClipCapture({
                capture: "share",
                note: parsed.note,
                title: parsed.title,
                url: parsed.url,
              });
            })
        );
        menu.addItem((item) =>
          item
            .setTitle("ショートカットに追加")
            .setIcon("plus-circle")
            .onClick(() => {
              void this.addShortcutLink(parsed.url, parsed.title);
            })
        );
      })
    );
    this.addRibbonIcon("book-open", "Seiton 本棚を開く", () => {
      void this.openBookshelf();
    });

    registerCommands(this, {
      bulkEditBooks: () => void this.bulkEditBooks(),
      embedBookCovers: () => void this.embedBookCovers(),
      importShortcutSettings: () => this.importShortcutSettings(),
      makePlaceholderCovers: () => void this.makePlaceholderCovers(),
      newPromptSession: () => void this.newPromptSession(),
      openActiveWebClipPreview: () => this.openActiveWebClipPreview(),
      openAddBook: () => this.openAddBook(),
      openBases: () => this.openBases(),
      openBookshelf: () => this.openBookshelf(),
      openBulkIsbn: () => this.openBulkIsbn(),
      openCoverCacheForAll: () => this.openCoverCacheForAll(),
      openCurrentWeek: () => this.openCurrentWeek(),
      openHome: () => this.openHome(),
      openLibrary: () => this.openLibrary(),
      openLinkList: () => this.openLinkList(),
      openMemoCapture: () => this.openMemoCapture(),
      openMigration: () => this.openMigration(),
      openNewNote: () => this.openNewNote(),
      openProjects: () => this.openProjects(),
      openPrompt: () => this.openPrompt(),
      openReviewTray: () => this.openReviewTray(),
      openTriage: () => this.openTriage(),
      openTsubuyaki: () => this.openTsubuyaki(),
      runCalilBulk: () => this.runCalilBulk(),
      searchLibrary: () => this.searchLibrary(),
    });

    registerFormatting(this);
    this.addSettingTab(new SeitonSettingTab(this.app, this));
  }

  override onunload(): void {
    for (const type of [
      VIEW_TYPE_HOME,
      VIEW_TYPE_TSUBUYAKI,
      VIEW_TYPE_LIBRARY,
      VIEW_TYPE_BOOKSHELF,
      VIEW_TYPE_PROJECTS,
      VIEW_TYPE_PROMPT,
    ]) {
      this.app.workspace.detachLeavesOfType(type);
    }
  }

  async saveSettings(patch: Partial<SeitonSettings>): Promise<void> {
    Object.assign(
      this.settings,
      normalizeSettings({ ...this.settings, ...patch })
    );
    await this.saveData(this.settings);
  }

  private async openHome(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_HOME);
  }

  private async openTsubuyaki(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_TSUBUYAKI);
  }

  private async openLibrary(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_LIBRARY);
  }

  private openTriage(): void {
    new TriageModal(
      this.app,
      new TriageService(this.app, this.properties, this.indexService),
      () => {
        this.indexService.invalidate();
        this.refreshHomeViews();
      }
    ).open();
  }

  private async openReviewTray(): Promise<void> {
    await this.openLibrary();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    const view = leaf?.view;
    if (view instanceof SeitonLibraryView) {
      view.showReview();
    }
  }

  private async searchLibrary(): Promise<void> {
    await this.openLibrary();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    const view = leaf?.view;
    if (view instanceof SeitonLibraryView) {
      view.focusSearch();
    }
  }

  private async runCalilBulk(): Promise<void> {
    const records = await this.books.listBooks();
    this.openCalilBulk(records);
  }

  /** 表紙が無い本に、書名入りの仮表紙を作って割り当てる。 */
  private async makePlaceholderCovers(): Promise<void> {
    const index = await this.indexService.get();
    const targets = index.notes.filter(
      (note) =>
        note.kind === "book" &&
        (note.book.book_cover ?? "").trim() === "" &&
        (note.book.book_isbn ?? "").trim() !== ""
    );
    if (targets.length === 0) {
      new Notice("表紙が無い本はありません。");
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
        new Notice(`${done}冊に仮表紙を作りました。`);
        this.indexService.invalidate();
      },
      title: "仮表紙を作る",
    }).open();
  }

  /** 既存の本の本文先頭に、保存済みの表紙をまとめて埋め込む。 */
  private async embedBookCovers(): Promise<void> {
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
      new Notice("表紙はすべて埋め込み済みです。");
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
        new Notice(`${done}冊に表紙を埋め込みました。`);
        this.indexService.invalidate();
      },
      title: "表紙をノートに埋め込む",
    }).open();
  }

  private async openCoverCacheForAll(): Promise<void> {
    const records = await this.books.listBooks();
    this.openCoverCache(records);
  }

  private openWebClipCapture(input: WebClipCaptureInput): void {
    new WebClipCaptureModal(this.app, this.webClips, input, () => {
      this.indexService.invalidate();
      this.refreshHomeViews();
    }).open();
  }

  /** スマホの共有シートやブックマークレットから、リンク集に1行足す。 */
  private async addShortcutLink(url: string, title: string): Promise<void> {
    const label = title.trim() || domainOf(url) || url;
    try {
      const edit = await this.links.edit((content) =>
        addLink(content, { group: null, label, target: url })
      );
      if (edit.status === "added") {
        new Notice(`「${label}」を追加しました。`);
      } else if (edit.status === "duplicate") {
        new Notice("同じリンクがすでにあります。");
      } else {
        new Notice("追加できませんでした。");
      }
      this.refreshHomeViews();
    } catch (error) {
      new Notice(userMessageOf(error));
    }
  }

  /** 旧設定（data.json）のショートカットをノートへ移す。何度実行しても重複しない。 */
  async importShortcutSettings(): Promise<void> {
    const items = this.settings.shortcuts.map((shortcut) => ({
      label: shortcut.label,
      target: shortcut.target,
    }));
    if (items.length === 0) {
      new Notice("移すショートカットはありません。");
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
      new Notice(userMessageOf(error));
      return;
    }
    new Notice(`${added}件をノートへ移しました。`);
    this.refreshHomeViews();
  }

  async openLinkList(): Promise<void> {
    try {
      await this.links.ensure();
    } catch (error) {
      new Notice(userMessageOf(error));
      return;
    }
    await this.app.workspace.openLinkText(LINKS_FILE, "", false);
  }

  private openBulkIsbn(): void {
    new BulkIsbnModal(this.app, this.books, () => {
      this.indexService.invalidate();
    }).open();
  }

  private openCalilBulk(records: NoteRecord[]): void {
    if (records.length === 0) {
      new Notice("本がありません。");
      return;
    }
    new CalilBulkModal(
      this.app,
      this.books,
      records,
      () => this.settings,
      (patch) => this.saveSettings(patch)
    ).open();
  }

  private openCoverCache(records: NoteRecord[]): void {
    new CoverCacheModal(this.app, this.covers, this.books, records, () => {
      this.indexService.invalidate();
    }).open();
  }

  private async openBookshelf(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_BOOKSHELF);
  }

  private async openProjects(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROJECTS);
  }

  private async openProject(path: string): Promise<void> {
    await this.openProjects();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECTS)[0];
    if (leaf?.view instanceof SeitonProjectsView) {
      await leaf.view.selectProject(path);
    }
  }

  private async openPromptView(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
  }

  private async openPrompt(path?: string): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROMPT)[0];
    const view = leaf?.view;
    if (view instanceof PromptWorkbenchView) {
      await view.openPath(path ?? null);
    }
  }

  private async newPromptSession(): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_PROMPT);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROMPT)[0];
    const view = leaf?.view;
    if (view instanceof PromptWorkbenchView) {
      view.newSession();
    }
  }

  private openNewNote(): void {
    new NewNoteModal(this.app, this.notes, this.indexService, "", (path) => {
      void this.openFile(path);
    }).open();
  }

  private async openBases(): Promise<void> {
    try {
      const result = await ensureBasesViews(this.app);
      const first = result.paths[0];
      if (first) {
        await openBasesView(this.app, first);
      }
      if (result.created.length > 0) {
        new Notice("Basesビューを作成しました。");
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private openAddBook(isbn = ""): void {
    new AddBookModal(this.app, this.books, {
      ...(isbn === "" ? {} : { initialIsbn: isbn }),
      onCreated: (result) => {
        this.indexService.invalidate();
        void this.openFile(result.path);
      },
    }).open();
  }

  private openBookDetail(
    record: import("./services/vaultIndex").NoteRecord
  ): void {
    new BookDetailModal(this.app, this.books, record, {
      onSaved: () => this.indexService.invalidate(),
    }).open();
  }

  private async bulkEditBooks(): Promise<void> {
    try {
      const records = await this.books.listBooks();
      if (records.length === 0) {
        new Notice("本棚に書籍がありません。");
        return;
      }
      new BookBulkEditModal(this.app, this.books, records, {
        onApplied: () => this.indexService.invalidate(),
      }).open();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }

  private openMigration(): void {
    new MigrationModal(this.app, this.migration, {
      onConverted: () => {
        this.indexService.invalidate();
        new Notice(
          "移行結果を確認してください。元ファイルは変更していません。"
        );
      },
    }).open();
  }

  private openWebClipPreview(path: string, source: string): void {
    new WebClipPreviewModal(this.app, this.webClips, {
      initialUrl: source,
      notePath: path,
      onChanged: () => this.indexService.invalidate(),
    }).open();
  }

  private openActiveWebClipPreview(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Webクリップのノートを開いてください。");
      return;
    }
    const frontmatter =
      (this.app.metadataCache.getFileCache(file)?.frontmatter as
        | Record<string, unknown>
        | undefined) ?? {};
    if (frontmatter.kind !== "webclip") {
      new Notice("現在のノートはWebクリップではありません。");
      return;
    }
    const source =
      typeof frontmatter.source === "string" ? frontmatter.source : "";
    this.openWebClipPreview(file.path, source);
  }

  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("ファイルが見つかりません。");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private openMemoCapture(): void {
    if (this.captureOpen) {
      new Notice("一言メモの入力画面は既に開いています。");
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

  private async openCurrentWeek(): Promise<void> {
    const path = this.memoService.currentWeekPath();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(
        "今週の一言メモはまだありません。一言メモを追加してください。"
      );
      return;
    }
    await this.app.workspace.openLinkText(path, "", true);
  }

  private refreshHomeViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_HOME)) {
      const view = leaf.view;
      if (view instanceof SeitonHomeView) {
        void view.refresh();
      }
    }
    this.indexService.invalidate();
  }
}
