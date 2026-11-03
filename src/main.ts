/**
 * Seiton Next (plugin id: seiton-next)
 * 個人用の記録・整理・再発見プラグイン。
 * 既存のSeiton (id: seiton) とは別プラグインとして動く。
 */

import type { EventRef, Menu } from "obsidian";
import { Plugin } from "obsidian";
import {
  LINKS_FILE,
  VIEW_TYPE_BOOKSHELF,
  VIEW_TYPE_HOME,
  VIEW_TYPE_LIBRARY,
  VIEW_TYPE_PROJECTS,
  VIEW_TYPE_PROMPT,
  VIEW_TYPE_TSUBUYAKI,
} from "./config";
import { isSeitonError } from "./domain/errors";
import { parseSharedWebText } from "./domain/webclip";
import { AppCoordinator } from "./platform/appCoordinator";
import { SeitonBookshelfView } from "./platform/bookshelfView";
import { registerCommands } from "./platform/commands";
import { renderPlaceholderCover } from "./platform/coverPlaceholder";
import { registerFormatting } from "./platform/formatting";
import { SeitonHomeView } from "./platform/homeView";
import { SeitonLibraryView } from "./platform/libraryView";
import { createObsidianMigrationPort } from "./platform/migrationPort";
import { ObsidianVaultPort } from "./platform/obsidianVaultPort";
import { SeitonProjectsView } from "./platform/projectsView";
import { PromptWorkbenchView } from "./platform/promptView";
import { SeitonSettingTab } from "./platform/settingsTab";
import { SeitonTsubuyakiView } from "./platform/tsubuyakiView";
import { showToast } from "./platform/ui/toast";
import { handleSeitonUri } from "./platform/uri";
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
  private coordinator!: AppCoordinator;

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

    this.coordinator = new AppCoordinator({
      app: this.app,
      books: this.books,
      covers: this.covers,
      getSettings: () => this.settings,
      indexService: this.indexService,
      links: this.links,
      memoService: this.memoService,
      migration: this.migration,
      notes: this.notes,
      properties: this.properties,
      saveSettings: (patch) => this.saveSettings(patch),
      webClips: this.webClips,
    });

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
            addBook: () => this.coordinator.openAddBook(),
            openBook: (record) => this.coordinator.openBookDetail(record),
            openProject: (path) => void this.coordinator.openProject(path),
            openPrompt: (path) => void this.coordinator.openPrompt(path),
            previewWebClip: (path, source) =>
              this.coordinator.openWebClipPreview(path, source),
          },
          this.webClips
        )
    );
    this.registerView(
      VIEW_TYPE_BOOKSHELF,
      (leaf) =>
        new SeitonBookshelfView(leaf, this.indexService, {
          addBook: () => this.coordinator.openAddBook(),
          bulkEdit: (records) => {
            if (records.length === 0) {
              showToast("本がありません。");
              return;
            }
            this.coordinator.openBookBulkEdit(records);
          },
          bulkIsbn: () => this.coordinator.openBulkIsbn(),
          calilBulk: (records) => this.coordinator.openCalilBulk(records),
          manageCovers: (records) => this.coordinator.openCoverCache(records),
          openBook: (record) => this.coordinator.openBookDetail(record),
          openNote: (path) => void this.coordinator.openFile(path),
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
          { openPrompt: (path) => void this.coordinator.openPrompt(path) }
        )
    );
    this.registerView(
      VIEW_TYPE_PROMPT,
      (leaf) => new PromptWorkbenchView(leaf, this.promptService)
    );

    this.addRibbonIcon("notebook", "Seiton ホームを開く", () => {
      void this.coordinator.openHome();
    });
    this.registerObsidianProtocolHandler("seiton-next", (params) => {
      void handleSeitonUri(
        {
          addShortcutLink: (url, title) =>
            this.coordinator.addShortcutLink(url, title),
          app: this.app,
          indexService: this.indexService,
          memoService: this.memoService,
          openAddBook: (isbn) => this.coordinator.openAddBook(isbn),
          openBookDetail: (record) => this.coordinator.openBookDetail(record),
          openBookshelf: () => this.coordinator.openBookshelf(),
          openHome: () => this.coordinator.openHome(),
          openLibrary: () => this.coordinator.openLibrary(),
          openProjects: () => this.coordinator.openProjects(),
          openPromptView: () => this.coordinator.openPrompt(),
          openTsubuyaki: () => this.coordinator.openTsubuyaki(),
          openWebClipCapture: (input) =>
            this.coordinator.openWebClipCapture(input),
          refreshHomeViews: () => this.coordinator.refreshHomeViews(),
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
              this.coordinator.openWebClipCapture({
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
              void this.coordinator.addShortcutLink(parsed.url, parsed.title);
            })
        );
      })
    );
    this.addRibbonIcon("book-open", "Seiton 本棚を開く", () => {
      void this.coordinator.openBookshelf();
    });

    registerCommands(this, {
      bulkEditBooks: () => void this.coordinator.bulkEditBooks(),
      embedBookCovers: () => void this.coordinator.embedBookCovers(),
      importShortcutSettings: () => this.coordinator.importShortcutSettings(),
      makePlaceholderCovers: () =>
        void this.coordinator.makePlaceholderCovers(),
      newPromptSession: () => void this.coordinator.newPromptSession(),
      openActiveWebClipPreview: () =>
        this.coordinator.openActiveWebClipPreview(),
      openAddBook: () => this.coordinator.openAddBook(),
      openBases: () => this.coordinator.openBases(),
      openBookshelf: () => this.coordinator.openBookshelf(),
      openBulkIsbn: () => this.coordinator.openBulkIsbn(),
      openCoverCacheForAll: () => this.coordinator.openCoverCacheForAll(),
      openCurrentWeek: () => this.coordinator.openCurrentWeek(),
      openHome: () => this.coordinator.openHome(),
      openLibrary: () => this.coordinator.openLibrary(),
      openLinkList: () => this.coordinator.openLinkList(),
      openMemoCapture: () => this.coordinator.openMemoCapture(),
      openMigration: () => this.coordinator.openMigration(),
      openNewNote: () => this.coordinator.openNewNote(),
      openProjects: () => this.coordinator.openProjects(),
      openPrompt: () => this.coordinator.openPrompt(),
      openReviewTray: () => this.coordinator.openReviewTray(),
      openTriage: () => this.coordinator.openTriage(),
      openTsubuyaki: () => this.coordinator.openTsubuyaki(),
      runCalilBulk: () => this.coordinator.runCalilBulk(),
      searchLibrary: () => this.coordinator.searchLibrary(),
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

  async openLinkList(): Promise<void> {
    await this.coordinator.openLinkList();
  }
}
