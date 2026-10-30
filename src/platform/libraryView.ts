import type { App, EventRef, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { ItemView, MarkdownView, Notice, TFile } from "obsidian";
import { VIEW_TYPE_LIBRARY } from "../config";
import { userMessageOf } from "../domain/errors";
import { buildVocabulary } from "../domain/vocabulary";
import type { NoteService } from "../services/noteService";
import type { PropertyService } from "../services/propertyService";
import type { SeitonSettings } from "../services/settings";
import { TriageService } from "../services/triageService";
import type {
  IndexItem,
  IndexProblem,
  NoteRecord,
  VaultIndex,
  VaultIndexService,
} from "../services/vaultIndex";
import type { WebClipService } from "../services/webClipService";
import { ConfirmModal } from "./confirmModal";
import { LibraryControls } from "./library/controls";
import {
  KIND_LABELS,
  memoPreview,
  shortDate,
  shortDateTime,
} from "./library/format";
import { FILTER_LABELS, LibraryIndex } from "./library/indexView";
import { LibraryList } from "./library/list";
import {
  type LibraryFilter,
  type LibraryQueryState,
  queryHits,
  relaxedSuggestions,
} from "./library/query";
import { LibrarySelection } from "./library/selection";
import { NewNoteModal } from "./newNoteModal";
import { OrganizeModal, type OrganizeVocabulary } from "./organizeModal";
import { type QuickSearchItem, QuickSearchModal } from "./quickSearchModal";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { TriageModal } from "./triageModal";

export interface LibraryHost {
  addBook(): void;
  openBook(record: NoteRecord): void;
  openProject(path: string): void;
  openPrompt(path: string): void;
  previewWebClip(path: string, source: string): void;
}

export class SeitonLibraryView extends ItemView {
  private readonly appRef: App;
  private readonly indexService: VaultIndexService;
  private readonly properties: PropertyService;
  private readonly notes: NoteService;
  private readonly settings: SeitonSettings;
  private readonly host: LibraryHost;
  private readonly webClips: WebClipService | null;

  private filter: LibraryFilter = "all";
  private query = "";
  private sort: "updated" | "created" | "lecture" = "updated";
  private tagFilter = "";
  private listFilter = "";
  private projectFilter = "";
  private courseFilter = "";
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private problemsEl: HTMLElement | null = null;
  private activeFiltersEl: HTMLElement | null = null;
  private currentIndex: VaultIndex | null = null;
  private vocabulary: OrganizeVocabulary = {
    lists: [],
    projects: [],
    tags: [],
  };

  private totalDataCount = 0;
  private layout: "cards" | "list" = "cards";
  private readonly controls: LibraryControls;
  private readonly index: LibraryIndex;
  private readonly list: LibraryList;
  private readonly selection: LibrarySelection;
  private refreshTimer: number | null = null;
  private eventRefs: EventRef[] = [];
  private webClipByPath = new Map<
    string,
    import("../services/webClipService").WebClipNote
  >();
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    leaf: WorkspaceLeaf,
    indexService: VaultIndexService,
    properties: PropertyService,
    notes: NoteService,
    settings: SeitonSettings,
    host: LibraryHost,
    webClips: WebClipService | null = null
  ) {
    super(leaf);
    this.appRef = this.app;
    this.indexService = indexService;
    this.properties = properties;
    this.notes = notes;
    this.settings = settings;
    this.host = host;
    this.webClips = webClips;
    this.selection = new LibrarySelection(properties, () => {
      void this.refresh();
    });
    this.controls = new LibraryControls({
      getCourse: () => this.courseFilter,
      getLayout: () => this.layout,
      getList: () => this.listFilter,
      getProject: () => this.projectFilter,
      getSort: () => this.sort,
      getTag: () => this.tagFilter,
      onCourseChange: (value) => {
        this.courseFilter = value;
        if (value && this.sort !== "lecture") {
          this.sort = "lecture";
        } else if (!value && this.sort === "lecture") {
          this.sort = "updated";
        }
        void this.refresh();
      },
      onLayoutChange: (layout) => {
        this.layout = layout;
        void this.refresh();
      },
      onListChange: (value) => {
        this.listFilter = value;
        void this.refresh();
      },
      onProjectChange: (value) => {
        this.projectFilter = value;
        void this.refresh();
      },
      onRefresh: () => {
        void this.refresh();
      },
      onSortChange: (sort) => {
        this.sort = sort;
        void this.refresh();
      },
      onTagChange: (value) => {
        this.tagFilter = value;
        void this.refresh();
      },
      selection: this.selection,
    });
    this.index = new LibraryIndex({
      getFilter: () => this.filter,
      getQuery: () => this.query,
      onFilterChange: (filter) => this.setFilter(filter),
      onQueryChange: (query) => {
        this.query = query;
      },
      onRefresh: () => {
        void this.refresh();
      },
    });

    this.list = new LibraryList({
      app: this.appRef,
      clearFilters: () => this.clearAllFilters(),
      confirmDelete: (note) => this.confirmDelete(note),
      getFilter: () => this.filter,
      getLayout: () => this.layout,
      getQuery: () => this.query,
      getTotalDataCount: () => this.totalDataCount,
      getWebClip: (path) => this.webClipByPath.get(path),
      hasActiveFilters: () => this.hasActiveFilters(),
      host: this.host,
      indexService: this.indexService,
      openOrganize: (note) => this.openOrganize(note),
      openPath: (path, line) => this.openPath(path, line),
      refresh: () => {
        void this.refresh();
      },
      relaxedSuggestions: () => this.relaxedSuggestions(),
      selection: this.selection,
      setQuery: (query) => {
        this.query = query;
        this.index.setQuery(query);
      },
      togglePinned: (note) => this.togglePinned(note),
    });
  }

  override getViewType(): string {
    return "seiton-next-library";
  }

  override getDisplayText(): string {
    return "Seiton ライブラリ";
  }

  override getIcon(): string {
    return "library";
  }

  override async onOpen(): Promise<void> {
    const { body } = mountTabShell(this, {
      actions: [
        {
          kind: "primary",
          label: "新規ノート",
          onClick: () => {
            new NewNoteModal(
              this.appRef,
              this.notes,
              this.indexService,
              "",
              (path) => {
                void this.openPath(path);
                this.invalidateAndRefresh();
              }
            ).open();
          },
        },
        {
          kind: "text",
          label: "本を追加",
          onClick: () => this.host.addBook(),
        },
        {
          kind: "text",
          label: "1件ずつ整理",
          onClick: () => {
            new TriageModal(
              this.appRef,
              new TriageService(
                this.appRef,
                this.properties,
                this.indexService
              ),
              () => this.invalidateAndRefresh()
            ).open();
          },
        },
      ],
      fab: {
        icon: "search",
        label: "ライブラリを検索",
        onClick: () => {
          void this.openQuickSearch();
        },
      },
      rootClasses: ["seiton-home", "seiton-library"],
      tab: "library",
      title: "ライブラリ",
    });
    this.renderLibraryBody(body);
    this.registerVaultEvents();
    await this.refresh();
    finishTabShell(this, VIEW_TYPE_LIBRARY);
  }

  override async onClose(): Promise<void> {
    closeTabShell(this, VIEW_TYPE_LIBRARY);
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const ref of this.eventRefs) {
      this.appRef.vault.offref(ref);
    }
    this.eventRefs = [];
    this.contentEl.empty();
    this.controls.reset();
    this.index.reset();
    this.selection.reset();
    this.listEl = null;
    this.countEl = null;
    this.problemsEl = null;
    this.activeFiltersEl = null;
    this.currentIndex = null;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    this.contentEl.addClass("is-refreshing");
    try {
      const index = await this.indexService.get();
      if (!this.listEl) {
        return;
      }
      if (this.webClips) {
        try {
          const clips = await this.webClips.listWebClips();
          this.webClipByPath = new Map(clips.map((clip) => [clip.path, clip]));
        } catch {
          this.webClipByPath = new Map();
        }
      }
      this.totalDataCount =
        index.notes.filter((note) => !note.archived).length +
        index.memos.filter((memo) => memo.state !== "deleted").length +
        index.prompts.length;
      this.index.renderCounts(index);
      this.controls.refreshOptions(index);
      this.controls.setSortState(this.sort, this.query.trim() !== "");
      this.renderActiveFilters();
      this.currentIndex = index;
      this.vocabulary = {
        lists: buildVocabulary(index.notes.map((note) => note.lists)),
        projects: buildVocabulary(index.notes.map((note) => note.projects)),
        tags: buildVocabulary(index.notes.map((note) => note.tags)),
      };
      const hits = this.queryHits(index);
      this.renderProblems(index.problems);
      this.renderHits(hits);
      const filtered = Boolean(
        this.query ||
          this.filter !== "all" ||
          this.tagFilter ||
          this.listFilter ||
          this.projectFilter ||
          this.courseFilter
      );
      this.index.setTotal(
        hits.length,
        filtered ? `/ ${this.totalDataCount} アイテム` : "アイテム"
      );
      if (this.countEl) {
        const limited = hits.length >= this.settings.maxSearchResults;
        this.countEl.setText(
          limited
            ? `上限${this.settings.maxSearchResults}件まで表示しています。`
            : ""
        );
      }
    } catch (error) {
      new Notice(userMessageOf(error));
    } finally {
      this.refreshing = false;
      this.contentEl.removeClass("is-refreshing");
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private renderLibraryBody(body: HTMLElement): void {
    const tool = body.createDiv({
      cls: "seiton-tool-card seiton-library-tool",
    });
    this.index.mount(tool);
    this.controls.mount(body);
    this.selection.mount(body);
    this.activeFiltersEl = body.createDiv({
      cls: "seiton-active-filters",
    });
    this.countEl = body.createDiv({ cls: "seiton-library-count" });
    this.problemsEl = body.createDiv({ cls: "seiton-problems" });
    this.listEl = body.createDiv({ cls: "seiton-library-list" });
  }

  private setFilter(filter: LibraryFilter): void {
    this.filter = filter;
    this.index.setActive(filter);
    void this.refresh();
  }

  private queryState(query: string): LibraryQueryState {
    return {
      courseFilter: this.courseFilter,
      filter: this.filter,
      listFilter: this.listFilter,
      projectFilter: this.projectFilter,
      query,
      sort: this.sort,
      tagFilter: this.tagFilter,
    };
  }

  private queryHits(index: VaultIndex): IndexItem[] {
    return queryHits(
      index,
      this.queryState(this.query),
      this.settings.maxSearchResults
    );
  }

  private relaxedSuggestions(): Array<{ count: number; token: string }> {
    const index = this.currentIndex;
    if (!index) {
      return [];
    }
    return relaxedSuggestions(index, this.queryState(this.query), 3);
  }

  /** ホームなどから検索語を受け取って開く。 */
  async setSearch(query: string): Promise<void> {
    this.query = query;
    this.index.setQuery(query);
    await this.refresh();
    this.focusSearch();
  }

  private hasActiveFilters(): boolean {
    return Boolean(
      this.query ||
        this.filter !== "all" ||
        this.tagFilter ||
        this.listFilter ||
        this.projectFilter ||
        this.courseFilter
    );
  }

  private clearAllFilters(): void {
    this.filter = "all";
    this.query = "";
    this.tagFilter = "";
    this.listFilter = "";
    this.projectFilter = "";
    this.courseFilter = "";
    this.sort = "updated";
    this.index.setQuery("");
    void this.refresh();
  }

  private renderActiveFilters(): void {
    if (!this.activeFiltersEl) {
      return;
    }
    this.activeFiltersEl.empty();
    if (!this.hasActiveFilters()) {
      return;
    }

    const chips: Array<{ label: string; clear: () => void }> = [];
    if (this.query) {
      chips.push({
        clear: () => {
          this.query = "";
          this.index.setQuery("");
        },
        label: `検索: ${this.query}`,
      });
    }
    if (this.filter !== "all") {
      chips.push({
        clear: () => {
          this.filter = "all";
        },
        label: `種類: ${FILTER_LABELS[this.filter] ?? this.filter}`,
      });
    }
    if (this.courseFilter) {
      chips.push({
        clear: () => {
          this.courseFilter = "";
        },
        label: `科目: ${this.courseFilter}`,
      });
    }
    if (this.tagFilter) {
      chips.push({
        clear: () => {
          this.tagFilter = "";
        },
        label: `タグ: ${this.tagFilter}`,
      });
    }
    if (this.listFilter) {
      chips.push({
        clear: () => {
          this.listFilter = "";
        },
        label: `リスト: ${this.listFilter}`,
      });
    }
    if (this.projectFilter) {
      chips.push({
        clear: () => {
          this.projectFilter = "";
        },
        label: `プロジェクト: ${this.projectFilter}`,
      });
    }

    for (const chip of chips) {
      const button = this.activeFiltersEl.createEl("button", {
        attr: {
          "aria-label": `${chip.label} を解除`,
          type: "button",
        },
        cls: "seiton-active-filter",
      });
      button.createSpan({ text: chip.label });
      button.createSpan({ cls: "seiton-active-filter-remove", text: "×" });
      button.addEventListener("click", () => {
        chip.clear();
        void this.refresh();
      });
    }
    const clear = this.activeFiltersEl.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-active-filter-clear",
      text: "すべて解除",
    });
    clear.addEventListener("click", () => this.clearAllFilters());
  }

  private renderProblems(problems: IndexProblem[]): void {
    if (!this.problemsEl) {
      return;
    }
    this.problemsEl.empty();
    if (problems.length === 0) {
      return;
    }
    const details = this.problemsEl.createEl("details", {
      cls: "seiton-problem-details",
    });
    details.createEl("summary", {
      text: `読み取り時に確認が必要なファイルが ${problems.length} 件あります`,
    });
    const list = details.createEl("ul");
    for (const problem of problems.slice(0, 8)) {
      const item = list.createEl("li");
      item.createSpan({ cls: "seiton-problem-path", text: problem.path });
      item.createSpan({ text: problem.message });
    }
  }

  private renderHits(items: IndexItem[], resetLimit = true): void {
    if (!this.listEl) {
      return;
    }
    this.list.render(this.listEl, items, resetLimit);
  }

  private openOrganize(note: NoteRecord): void {
    new OrganizeModal(
      this.appRef,
      this.properties,
      {
        archived: note.archived,
        kind: note.kind,
        lists: note.lists,
        path: note.path,
        pinned: note.pinned,
        projects: note.projects,
        review: note.review,
        tags: note.tags,
        title: note.title,
      },
      () => this.invalidateAndRefresh(),
      this.vocabulary
    ).open();
  }

  private confirmDelete(note: NoteRecord): void {
    const file = this.appRef.vault.getAbstractFileByPath(note.path);
    if (!(file instanceof TFile)) {
      new Notice("ファイルが見つかりません。");
      return;
    }
    new ConfirmModal(this.appRef, {
      confirmingLabel: "削除",
      message: `「${note.title}」をゴミ箱へ移動します。よろしいですか？`,
      onConfirm: async () => {
        await this.appRef.fileManager.trashFile(file);
        this.indexService.invalidate();
        this.invalidateAndRefresh();
        new Notice("ゴミ箱へ移動しました。");
      },
      title: "削除",
    }).open();
  }

  showReview(): void {
    this.setFilter("review");
  }

  focusSearch(): void {
    this.index.focus();
  }

  private async openQuickSearch(): Promise<void> {
    try {
      const index = this.currentIndex ?? (await this.indexService.get());
      const items: QuickSearchItem[] = [];
      for (const note of index.notes) {
        if (note.archived) {
          continue;
        }
        items.push({
          action:
            note.kind === "book"
              ? () => this.host.openBook(note)
              : () => void this.openPath(note.path),
          meta: `${KIND_LABELS[note.kind] ?? note.kind} · ${shortDate(note.mtime)}`,
          title: note.title,
        });
      }
      for (const memo of index.memos) {
        if (memo.state === "deleted") {
          continue;
        }
        items.push({
          action: () => void this.openPath(memo.path, memo.line),
          meta: `メモ · ${shortDateTime(memo.at)}`,
          title: memoPreview(memo.body) || "メモ",
        });
      }
      for (const prompt of index.prompts) {
        items.push({
          action: () => this.host.openPrompt(prompt.path),
          meta: `プロンプト · ${shortDateTime(prompt.at)}`,
          title: prompt.title,
        });
      }
      new QuickSearchModal(this.appRef, {
        items,
        placeholder: "タイトル、本文、タグ",
        title: "ライブラリを検索",
      }).open();
    } catch (error) {
      new Notice(userMessageOf(error));
    }
  }

  private async togglePinned(note: NoteRecord): Promise<void> {
    try {
      await this.properties.update(note.path, { pinned: !note.pinned });
      this.invalidateAndRefresh();
    } catch (error) {
      new Notice(userMessageOf(error));
    }
  }

  async openPath(path: string, line?: number): Promise<void> {
    const file = this.appRef.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("ファイルが見つかりません。");
      return;
    }
    const leaf = this.appRef.workspace.getLeaf(false);
    await leaf.openFile(file);
    if (line !== undefined && leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      editor.setCursor({ ch: 0, line: Math.max(0, line - 1) });
      editor.scrollIntoView(
        { from: { ch: 0, line: Math.max(0, line - 1) }, to: { ch: 0, line } },
        true
      );
    }
  }

  private invalidateAndRefresh(): void {
    this.indexService.invalidate();
    void this.refresh();
  }

  private registerVaultEvents(): void {
    const handler = (file: TAbstractFile): void => {
      if (!file.path.endsWith(".md")) {
        return;
      }
      this.indexService.invalidate();
      if (this.refreshTimer !== null) {
        window.clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        void this.refresh();
      }, 450);
    };
    this.eventRefs.push(
      this.appRef.vault.on("modify", handler),
      this.appRef.vault.on("create", handler),
      this.appRef.vault.on("delete", handler),
      this.appRef.vault.on("rename", handler)
    );
    for (const ref of this.eventRefs) {
      this.registerEvent(ref);
    }
  }
}
