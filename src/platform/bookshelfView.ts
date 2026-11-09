import type { EventRef, WorkspaceLeaf } from "obsidian";
import { ItemView, setIcon } from "obsidian";
import { VIEW_TYPE_BOOKSHELF } from "../config";
import {
  type BookDisplayGroup,
  type BookFilters,
  type BookShelfItem,
  bookCategories,
  bookOwnershipLabel,
  bookStatusLabel,
  computeBookStats,
  DEFAULT_BOOK_FILTERS,
  filterBooks,
  groupBooksBySeries,
} from "../domain/bookshelf";
import {
  calilBadgeText,
  calilCheckedLabel,
  calilSummaryFromFrontmatter,
} from "../domain/calilStatus";
import type { NoteRecord, VaultIndexService } from "../services/vaultIndex";
import { renderBookCoverFallback, resolveCover } from "./bookCover";
import { makeCardClickable } from "./cardClick";
import { QuickSearchModal } from "./quickSearchModal";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import {
  createSelect as createUiSelect,
  type SelectControl,
} from "./ui/select";

export interface BookshelfHost {
  addBook(): void;
  bulkEdit(records: NoteRecord[]): void;
  bulkIsbn(): void;
  calilBulk(records: NoteRecord[]): void;
  manageCovers(records: NoteRecord[]): void;
  openBook(record: NoteRecord): void;
  openNote(path: string): void;
  scanBarcode(): void;
}

const STATUS_OPTIONS: Array<{ label: string; value: BookFilters["status"] }> = [
  { label: "状態: すべて", value: "all" },
  { label: "積読", value: "tbr" },
  { label: "読書中", value: "reading" },
  { label: "読了", value: "read" },
];

const OWNERSHIP_OPTIONS: Array<{
  label: string;
  value: BookFilters["owned"];
}> = [
  { label: "所有: すべて", value: "all" },
  { label: "所持", value: "owned" },
  { label: "未所持", value: "unowned" },
];

const SORT_OPTIONS: Array<{ label: string; value: BookFilters["sort"] }> = [
  { label: "更新順", value: "updated" },
  { label: "書名順", value: "title" },
  { label: "著者順", value: "author" },
  { label: "読了日順", value: "finished" },
];

/** 本棚。表紙中心で読書記録を眺める独立ビュー。 */
export class SeitonBookshelfView extends ItemView {
  private readonly indexService: VaultIndexService;
  private readonly host: BookshelfHost;
  private readonly filters: BookFilters = { ...DEFAULT_BOOK_FILTERS };
  private groupBySeries = false;
  private records: NoteRecord[] = [];
  private gridEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private statsEl: HTMLElement | null = null;
  private seriesToggleBtn: HTMLButtonElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private categorySelect: SelectControl | null = null;
  private eventRefs: EventRef[] = [];
  private refreshTimer: number | null = null;
  private refreshing = false;
  private refreshAgain = false;

  constructor(
    leaf: WorkspaceLeaf,
    indexService: VaultIndexService,
    host: BookshelfHost
  ) {
    super(leaf);
    this.indexService = indexService;
    this.host = host;
  }

  override getViewType(): string {
    return VIEW_TYPE_BOOKSHELF;
  }

  override getDisplayText(): string {
    return "Seiton 本棚";
  }

  override getIcon(): string {
    return "book-open";
  }

  override async onOpen(): Promise<void> {
    const { body } = mountTabShell(this, {
      actions: [
        {
          kind: "primary",
          label: "本を追加",
          onClick: () => this.host.addBook(),
        },
        {
          kind: "text",
          label: "バーコード読取",
          onClick: () => this.host.scanBarcode(),
        },
        {
          kind: "text",
          label: "表示中の本を一括編集",
          onClick: () => this.host.bulkEdit(this.records),
        },
      ],
      fab: {
        icon: "search",
        label: "本棚を検索",
        onClick: () => this.openQuickSearch(),
      },
      rootClasses: ["seiton-home", "seiton-bookshelf"],
      tab: "bookshelf",
      title: "本棚",
    });
    this.renderControls(body);
    this.renderTools(body);
    this.gridEl = body.createDiv({ cls: "seiton-bookshelf-body" });
    this.registerVaultEvents();
    finishTabShell(this, VIEW_TYPE_BOOKSHELF);
    void this.refresh();
  }

  override async onClose(): Promise<void> {
    closeTabShell(this, VIEW_TYPE_BOOKSHELF);
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    this.contentEl.empty();
    this.gridEl = null;
    this.countEl = null;
    this.statsEl = null;
    this.seriesToggleBtn = null;
    this.searchInput = null;
    this.categorySelect = null;
  }

  private openQuickSearch(): void {
    const items = this.records.map((record) => ({
      action: () => this.host.openBook(record),
      meta: [
        record.book.book_author,
        bookStatusLabel(record.book.book_status ?? ""),
      ]
        .filter((value) => value && value !== "")
        .join(" · "),
      title: record.title,
    }));
    new QuickSearchModal(this.app, {
      items,
      placeholder: "書名、著者",
      title: "本棚を検索",
    }).open();
  }

  private renderTools(parent: HTMLElement): void {
    const subbar = parent.createDiv({
      cls: "seiton-bookshelf-subbar seiton-books-subbar",
    });
    this.countEl = subbar.createDiv({ cls: "seiton-bookshelf-count" });
    this.statsEl = subbar.createDiv({ cls: "seiton-books-stats-summary" });

    const tools = subbar.createDiv({ cls: "seiton-bookshelf-tools" });
    this.seriesToggleBtn = tools.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-series-toggle-btn",
      text: "シリーズ集約",
    });
    this.seriesToggleBtn.addEventListener("click", () => {
      this.groupBySeries = !this.groupBySeries;
      this.seriesToggleBtn?.toggleClass("is-active", this.groupBySeries);
      this.render();
    });

    this.renderTool(tools, "一括ISBN", () => this.host.bulkIsbn());
    this.renderTool(tools, "カーリル一括検索", () =>
      this.host.calilBulk(this.records)
    );
    this.renderTool(tools, "表紙キャッシュ管理", () =>
      this.host.manageCovers(this.records)
    );
  }

  private renderTool(
    parent: HTMLElement,
    label: string,
    action: () => void
  ): void {
    const button = parent.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: label,
    });
    button.addEventListener("click", action);
  }

  private renderControls(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: "seiton-bookshelf-controls" });

    const search = controls.createDiv({ cls: "seiton-search" });
    const icon = search.createSpan({ cls: "seiton-search-icon" });
    setIcon(icon, "search");
    this.searchInput = search.createEl("input", {
      attr: {
        "aria-label": "本棚を検索",
        placeholder: "書名・著者で検索...",
        type: "search",
      },
      cls: "seiton-library-search",
    });
    this.searchInput.addEventListener("input", () => {
      this.filters.query = this.searchInput?.value ?? "";
      this.render();
    });

    const filtersGroup = controls.createDiv({
      cls: "seiton-bookshelf-filters-group",
    });

    this.categorySelect = this.createSelect(
      filtersGroup,
      "カテゴリ",
      [{ label: "カテゴリ: すべて", value: "all" }],
      (value) => {
        this.filters.category = value;
        this.render();
      }
    );

    this.createSelect(filtersGroup, "読書状態", STATUS_OPTIONS, (value) => {
      this.filters.status = value as BookFilters["status"];
      this.render();
    });

    this.createSelect(filtersGroup, "所有", OWNERSHIP_OPTIONS, (value) => {
      this.filters.owned = value as BookFilters["owned"];
      this.render();
    });

    this.createSelect(filtersGroup, "並び順", SORT_OPTIONS, (value) => {
      this.filters.sort = value as BookFilters["sort"];
      this.render();
    });
  }

  private createSelect(
    parent: HTMLElement,
    label: string,
    options: Array<{ label: string; value: string }>,
    onChange: (value: string) => void
  ): SelectControl {
    const control = createUiSelect({
      choices: options,
      onChange,
      title: label,
      value: options[0]?.value ?? "",
    });
    control.element.addClass("seiton-library-select");
    control.element.addClass("seiton-bookshelf-pill-select");
    control.element.addClass("is-quiet");
    parent.append(control.element);
    return control;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    this.contentEl.addClass("is-refreshing");
    try {
      const index = await this.indexService.get();
      this.records = index.notes.filter(
        (note) => note.kind === "book" && !note.archived
      );
      this.syncCategoryOptions();
      this.render();
    } finally {
      this.refreshing = false;
      this.contentEl.removeClass("is-refreshing");
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    }
  }

  private syncCategoryOptions(): void {
    if (!this.categorySelect) {
      return;
    }
    const categories = bookCategories(this.records.map(toItem));
    const current = this.filters.category;
    this.categorySelect.setChoices([
      { label: "カテゴリ: すべて", value: "all" },
      ...categories.map((category) => ({ label: category, value: category })),
    ]);
    if (current !== "all" && !categories.includes(current)) {
      this.filters.category = "all";
    }
    this.categorySelect.setValue(this.filters.category);
  }

  private render(): void {
    const grid = this.gridEl;
    if (!grid) {
      return;
    }
    grid.empty();

    const allItems = this.records.map(toItem);
    const stats = computeBookStats(allItems);
    if (this.statsEl) {
      this.statsEl.setText(
        `読書中 ${stats.readingCount}冊 · 今月読了 ${stats.readThisMonth}冊 · 今年読了 ${stats.readThisYear}冊`
      );
    }

    const filtered = filterBooks(allItems, this.filters);
    const displayGroups: BookDisplayGroup[] = this.groupBySeries
      ? groupBooksBySeries(filtered)
      : filtered.map((item) => ({ item }));

    if (this.countEl) {
      this.countEl.setText(
        this.groupBySeries && displayGroups.length !== filtered.length
          ? `${displayGroups.length}件 (${filtered.length}冊)`
          : `${filtered.length}冊`
      );
    }
    if (displayGroups.length === 0) {
      const empty = grid.createDiv({ cls: "seiton-empty" });
      empty.setText(
        this.records.length === 0
          ? "本棚は読む本を管理する場所です。「本を追加」から登録できます。"
          : "条件に合う本がありません。"
      );
      return;
    }
    const shelf = grid.createDiv({ cls: "seiton-card-grid is-shelf" });
    for (const group of displayGroups) {
      const record = this.records.find((note) => note.path === group.item.path);
      if (!record) {
        continue;
      }
      shelf.appendChild(this.renderCard(record, group.item, group.seriesCount));
    }
  }

  private renderCard(
    record: NoteRecord,
    item: BookShelfItem,
    seriesCount?: number
  ): HTMLElement {
    const card = document.createElement("article");
    card.className = "seiton-book-card";

    const cover = card.createEl("button", {
      attr: {
        "aria-label": `${item.title} の詳細を開く`,
        type: "button",
      },
      cls: "seiton-book-cover-wrap",
    });
    if (seriesCount && seriesCount > 1) {
      cover.createSpan({
        cls: "seiton-book-series-badge",
        text: `全${seriesCount}巻`,
      });
    }
    const coverUrl = resolveCover(this.app, record.cover || item.cover);
    if (coverUrl) {
      const image = cover.createEl("img", {
        attr: { alt: "" },
        cls: "seiton-book-cover-image",
      });
      image.src = coverUrl;
      image.loading = "lazy";
      image.addEventListener("error", () => {
        image.remove();
        renderBookCoverFallback(
          cover,
          item.title,
          "表紙を取得できませんでした"
        );
      });
    } else {
      renderBookCoverFallback(cover, item.title, "表紙を取得できませんでした");
    }
    cover.addEventListener("click", () => this.host.openBook(record));

    const body = card.createDiv({ cls: "seiton-book-card-body" });
    const title = body.createEl("button", {
      cls: "seiton-book-card-title",
      text: item.title,
      type: "button",
    });
    title.addEventListener("click", () => this.host.openBook(record));
    if (item.author) {
      body.createDiv({ cls: "seiton-book-card-meta", text: item.author });
    }
    const seriesMeta =
      seriesCount && seriesCount > 1
        ? `シリーズ: ${item.series} (全${seriesCount}巻)`
        : item.series
          ? `シリーズ: ${item.series}`
          : "";
    const state = [
      bookStatusLabel(item.status),
      item.category,
      item.owned ? bookOwnershipLabel(item.owned) : "",
      item.rating ? `評価 ${item.rating}` : "",
      seriesMeta,
    ]
      .filter(Boolean)
      .join(" · ");
    if (state) {
      body.createDiv({ cls: "seiton-book-card-state", text: state });
    }
    // 直近のカーリル結果をカードに出す。未確認の本には何も足さない。
    const calil = calilSummaryFromFrontmatter(record.frontmatter);
    if (calil.checkedAt !== "") {
      const line = body.createDiv({ cls: "seiton-book-card-calil" });
      line.createSpan({
        cls: `seiton-calil-badge is-${calil.state}`,
        text: calilBadgeText(calil, new Date()),
      });
      const when = calilCheckedLabel(calil.checkedAt);
      if (when !== "") {
        line.createSpan({ cls: "seiton-calil-when", text: ` ${when}` });
      }
    }
    const actions = body.createDiv({ cls: "seiton-item-actions" });
    const detail = actions.createEl("button", {
      cls: "seiton-item-action",
      text: "詳細",
      type: "button",
    });
    detail.addEventListener("click", () => this.host.openBook(record));
    const note = actions.createEl("button", {
      cls: "seiton-item-action",
      text: "ノート",
      type: "button",
    });
    note.addEventListener("click", () => this.host.openNote(item.path));
    makeCardClickable(card, () => this.host.openBook(record));
    return card;
  }

  private registerVaultEvents(): void {
    const handler = (file: { path: string }, oldPath?: string): void => {
      if (oldPath) {
        this.indexService.invalidate(oldPath);
      }
      this.indexService.invalidate(file.path);
      if (this.refreshTimer !== null) {
        window.clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = null;
        void this.refresh();
      }, 500);
    };
    this.eventRefs.push(
      this.app.vault.on("create", (file) => handler(file)),
      this.app.vault.on("delete", (file) => handler(file)),
      this.app.vault.on("modify", (file) => handler(file)),
      this.app.vault.on("rename", (file, oldPath) => handler(file, oldPath))
    );
    for (const ref of this.eventRefs) {
      this.registerEvent(ref);
    }
  }
}

function toItem(record: NoteRecord): BookShelfItem {
  const book = record.book;
  return {
    author: book.book_author ?? "",
    category: book.book_category ?? "",
    cover: record.cover || book.book_cover || "",
    finished: book.book_finished ?? "",
    isbn: book.book_isbn ?? "",
    owned: book.book_ownership ?? "",
    path: record.path,
    rating: book.book_rating ?? "",
    series: book.book_series ?? "",
    status: book.reading_status ?? "",
    title: record.title,
    updated: record.mtime,
  };
}
