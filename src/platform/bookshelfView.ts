import type { EventRef, WorkspaceLeaf } from "obsidian";
import { ItemView, setIcon } from "obsidian";
import { VIEW_TYPE_BOOKSHELF } from "../config";
import {
  type BookDisplayGroup,
  type BookFilters,
  type BookShelfItem,
  type BookStatusFilter,
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
import { showCardMenu } from "./cardMenu";
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

const STATUS_TABS: Array<{ label: string; value: BookStatusFilter }> = [
  { label: "すべて", value: "all" },
  { label: "読書中", value: "reading" },
  { label: "積読", value: "tbr" },
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

/** 本棚 v2。ステータス起点のツールバーと、表紙ウォール／台帳リストを提供する。 */
export class SeitonBookshelfView extends ItemView {
  private readonly indexService: VaultIndexService;
  private readonly host: BookshelfHost;
  private readonly filters: BookFilters = { ...DEFAULT_BOOK_FILTERS };
  private groupBySeries = false;
  private viewMode: "grid" | "list" = "grid";
  private records: NoteRecord[] = [];
  private items: BookShelfItem[] = [];
  private recordByPath = new Map<string, NoteRecord>();
  private bodyEl: HTMLElement | null = null;
  private kpiEl: HTMLElement | null = null;
  private seriesToggleBtn: HTMLButtonElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private categorySelect: SelectControl | null = null;
  private ownershipSelect: SelectControl | null = null;
  private statusButtons = new Map<BookStatusFilter, HTMLButtonElement>();
  private statusCountEls = new Map<BookStatusFilter, HTMLElement>();
  private viewModeButtons = new Map<"grid" | "list", HTMLButtonElement>();
  private eventRefs: EventRef[] = [];
  private refreshTimer: number | null = null;
  private searchTimer: number | null = null;
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
          label: "管理 ▾",
          onClick: (button) => this.openManageMenu(button),
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

    body.addClass("st2-books");
    this.renderToolbar(body);
    this.bodyEl = body.createDiv({ cls: "st2-books-body" });
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
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    this.records = [];
    this.items = [];
    this.recordByPath.clear();
    this.statusButtons.clear();
    this.statusCountEls.clear();
    this.viewModeButtons.clear();
    this.contentEl.empty();
    this.bodyEl = null;
    this.kpiEl = null;
    this.seriesToggleBtn = null;
    this.searchInput = null;
    this.categorySelect = null;
    this.ownershipSelect = null;
  }

  private openManageMenu(anchor: HTMLElement): void {
    showCardMenu(anchor, [
      {
        label: "表示中の本を一括編集",
        run: () => this.host.bulkEdit(this.records),
      },
      {
        label: "ISBN一括追加",
        run: () => this.host.bulkIsbn(),
      },
      {
        label: "カーリル一括検索",
        run: () => this.host.calilBulk(this.records),
      },
      {
        label: "表紙キャッシュ管理",
        run: () => this.host.manageCovers(this.records),
      },
    ]);
  }

  private openQuickSearch(): void {
    const items = this.records.map((record) => ({
      action: () => this.host.openBook(record),
      meta: [
        record.book.book_author,
        bookStatusLabel(record.book.reading_status ?? ""),
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

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "st2-toolbar" });

    // Row 1: Status tabs + KPI summary
    const row1 = toolbar.createDiv({ cls: "st2-toolbar-row" });
    const statusSeg = row1.createDiv({
      attr: { "aria-label": "読書状態で絞り込み", role: "tablist" },
      cls: "st2-seg",
    });

    this.statusButtons.clear();
    this.statusCountEls.clear();
    for (const tab of STATUS_TABS) {
      const active = this.filters.status === tab.value;
      const btn = statusSeg.createEl("button", {
        attr: {
          "aria-selected": active ? "true" : "false",
          role: "tab",
          type: "button",
        },
        cls: `st2-seg-btn${active ? " is-active" : ""}`,
      });
      btn.createSpan({ text: tab.label });
      const countEl = btn.createSpan({ cls: "st2-seg-count", text: "0" });
      btn.addEventListener("click", () => {
        this.setStatusFilter(tab.value);
      });
      this.statusButtons.set(tab.value, btn);
      this.statusCountEls.set(tab.value, countEl);
    }

    this.kpiEl = row1.createDiv({ cls: "st2-books-kpi" });

    // Row 2: Search input + selects + series + view mode
    const row2 = toolbar.createDiv({ cls: "st2-toolbar-row" });
    const searchBox = row2.createDiv({ cls: "st2-search-box" });
    const searchIcon = searchBox.createSpan({ cls: "st2-search-icon" });
    setIcon(searchIcon, "search");
    this.searchInput = searchBox.createEl("input", {
      attr: {
        "aria-label": "本棚を検索",
        placeholder: "書名・著者・シリーズで検索...",
        type: "search",
      },
      cls: "st2-input",
    });
    this.searchInput.addEventListener("input", () => {
      this.filters.query = this.searchInput?.value ?? "";
      if (this.searchTimer !== null) {
        window.clearTimeout(this.searchTimer);
      }
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        this.render();
      }, 120);
    });

    const controls = row2.createDiv({ cls: "st2-toolbar-group" });
    this.categorySelect = this.createSelect(
      controls,
      "カテゴリ",
      [{ label: "カテゴリ: すべて", value: "all" }],
      (value) => {
        this.filters.category = value;
        this.render();
      }
    );

    this.ownershipSelect = this.createSelect(
      controls,
      "所有",
      OWNERSHIP_OPTIONS,
      (value) => {
        this.filters.owned = value as BookFilters["owned"];
        this.render();
      }
    );

    this.createSelect(controls, "並び順", SORT_OPTIONS, (value) => {
      this.filters.sort = value as BookFilters["sort"];
      this.render();
    });

    this.seriesToggleBtn = controls.createEl("button", {
      attr: { "aria-pressed": "false", type: "button" },
      cls: "st2-btn",
      text: "シリーズ束",
    });
    this.seriesToggleBtn.addEventListener("click", () => {
      this.groupBySeries = !this.groupBySeries;
      this.seriesToggleBtn?.toggleClass("is-active", this.groupBySeries);
      this.seriesToggleBtn?.setAttribute(
        "aria-pressed",
        this.groupBySeries ? "true" : "false"
      );
      this.render();
    });

    const modeSeg = controls.createDiv({
      attr: { "aria-label": "表示形式", role: "group" },
      cls: "st2-seg",
    });
    this.viewModeButtons.clear();
    const modes: Array<{ key: "grid" | "list"; label: string }> = [
      { key: "grid", label: "グリッド" },
      { key: "list", label: "リスト" },
    ];
    for (const mode of modes) {
      const active = this.viewMode === mode.key;
      const btn = modeSeg.createEl("button", {
        attr: {
          "aria-pressed": active ? "true" : "false",
          type: "button",
        },
        cls: `st2-seg-btn${active ? " is-active" : ""}`,
        text: mode.label,
      });
      btn.addEventListener("click", () => {
        if (this.viewMode === mode.key) {
          return;
        }
        this.viewMode = mode.key;
        for (const [key, button] of this.viewModeButtons.entries()) {
          const isSelected = key === this.viewMode;
          button.toggleClass("is-active", isSelected);
          button.setAttribute("aria-pressed", isSelected ? "true" : "false");
        }
        this.render();
      });
      this.viewModeButtons.set(mode.key, btn);
    }
  }

  private setStatusFilter(status: BookStatusFilter): void {
    this.filters.status = status;
    for (const [key, btn] of this.statusButtons.entries()) {
      const active = key === status;
      btn.toggleClass("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    this.render();
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
    control.element.addClass("st2-select");
    parent.append(control.element);
    return control;
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
      this.records = index.notes.filter(
        (note) => note.kind === "book" && !note.archived
      );
      this.items = this.records.map(toItem);
      this.recordByPath = new Map(
        this.records.map((record) => [record.path, record])
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
    const categories = bookCategories(this.items);
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

  private resetFilters(): void {
    this.filters.query = "";
    this.filters.status = "all";
    this.filters.category = "all";
    this.filters.owned = "all";
    this.groupBySeries = false;
    if (this.searchInput) {
      this.searchInput.value = "";
    }
    this.categorySelect?.setValue("all");
    this.ownershipSelect?.setValue("all");
    this.seriesToggleBtn?.toggleClass("is-active", false);
    this.seriesToggleBtn?.setAttribute("aria-pressed", "false");
    this.setStatusFilter("all");
  }

  private updateStatusCountsAndKpi(): void {
    let readingCount = 0;
    let tbrCount = 0;
    let readCount = 0;
    for (const item of this.items) {
      if (item.status === "reading") {
        readingCount += 1;
      } else if (item.status === "tbr") {
        tbrCount += 1;
      } else if (item.status === "read") {
        readCount += 1;
      }
    }

    const countMap: Record<BookStatusFilter, number> = {
      all: this.items.length,
      read: readCount,
      reading: readingCount,
      tbr: tbrCount,
    };
    for (const [key, el] of this.statusCountEls.entries()) {
      el.setText(String(countMap[key]));
    }

    if (this.kpiEl) {
      const stats = computeBookStats(this.items);
      this.kpiEl.setText(
        `今月読了 ${stats.readThisMonth} · 今年読了 ${stats.readThisYear}`
      );
    }
  }

  private render(): void {
    const body = this.bodyEl;
    if (!body) {
      return;
    }
    body.empty();

    this.updateStatusCountsAndKpi();

    const filtered = filterBooks(this.items, this.filters);
    const displayGroups: BookDisplayGroup[] = this.groupBySeries
      ? groupBooksBySeries(filtered)
      : filtered.map((item) => ({ item }));

    const hasFilters =
      this.filters.query.trim() !== "" ||
      this.filters.status !== "all" ||
      this.filters.category !== "all" ||
      this.filters.owned !== "all" ||
      this.groupBySeries;

    if (!hasFilters) {
      const readingItems = this.items
        .filter((item) => item.status === "reading")
        .sort((left, right) => right.updated - left.updated);
      if (readingItems.length > 0) {
        this.renderSpotlight(body, readingItems);
      }
    }

    const section = body.createDiv();
    const head = section.createDiv({ cls: "st2-section-head" });
    head.createEl("h2", {
      cls: "st2-section-title",
      text:
        this.filters.status === "all"
          ? "蔵書"
          : bookStatusLabel(this.filters.status),
    });
    head.createSpan({
      cls: "st2-section-count",
      text:
        this.groupBySeries && displayGroups.length !== filtered.length
          ? `${displayGroups.length}件 (${filtered.length}冊)`
          : `${filtered.length}冊`,
    });
    if (hasFilters) {
      const resetBtn = head.createEl("button", {
        attr: { type: "button" },
        cls: "st2-quiet-btn st2-section-action",
        text: "条件をリセット",
      });
      resetBtn.addEventListener("click", () => this.resetFilters());
    }

    if (displayGroups.length === 0) {
      section.createDiv({
        cls: "st2-empty",
        text:
          this.records.length === 0
            ? "本棚はまだ空です。「本を追加」から登録できます。"
            : "条件に合う本がありません。",
      });
      return;
    }

    if (this.viewMode === "list") {
      const list = section.createDiv({ cls: "st2-ledger-list st2-books-list" });
      for (const group of displayGroups) {
        const record = this.recordByPath.get(group.item.path);
        if (!record) {
          continue;
        }
        list.appendChild(
          this.renderListRow(record, group.item, group.seriesCount)
        );
      }
      return;
    }

    const grid = section.createDiv({ cls: "st2-books-grid" });
    for (const group of displayGroups) {
      const record = this.recordByPath.get(group.item.path);
      if (!record) {
        continue;
      }
      grid.appendChild(
        this.renderGridCard(record, group.item, group.seriesCount)
      );
    }
  }

  private renderSpotlight(
    container: HTMLElement,
    readingItems: BookShelfItem[]
  ): void {
    const section = container.createDiv({ cls: "st2-books-spotlight" });
    const head = section.createDiv({ cls: "st2-section-head" });
    head.createEl("h2", {
      cls: "st2-section-title",
      text: "いま読んでいる本",
    });
    head.createSpan({
      cls: "st2-section-count",
      text: `${readingItems.length}冊`,
    });

    const grid = section.createDiv({ cls: "st2-books-spotlight-grid" });
    for (const item of readingItems) {
      const record = this.recordByPath.get(item.path);
      if (!record) {
        continue;
      }
      const card = grid.createEl("article", {
        cls: "st2-books-spotlight-card",
      });
      const cover = card.createDiv({ cls: "st2-books-spotlight-cover" });
      this.mountCoverImage(cover, record.cover || item.cover, item.title, "");

      const info = card.createDiv({ cls: "st2-books-spotlight-info" });
      const titleBtn = info.createEl("button", {
        attr: { type: "button" },
        cls: "st2-books-spotlight-title",
        text: item.title,
      });
      titleBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.host.openBook(record);
      });
      const meta = [item.author, item.category].filter(Boolean).join(" · ");
      if (meta) {
        info.createDiv({ cls: "st2-books-spotlight-meta", text: meta });
      }
      makeCardClickable(card, () => this.host.openBook(record));
    }
  }

  private renderGridCard(
    record: NoteRecord,
    item: BookShelfItem,
    seriesCount?: number
  ): HTMLElement {
    const card = document.createElement("article");
    card.className = "st2-books-card";

    const coverBtn = card.createEl("button", {
      attr: {
        "aria-label": `${item.title} の詳細を開く`,
        type: "button",
      },
      cls: "st2-books-cover-frame",
    });
    if (seriesCount && seriesCount > 1) {
      coverBtn.createSpan({
        cls: "st2-books-series-tag",
        text: `全${seriesCount}巻`,
      });
    }
    this.mountCoverImage(
      coverBtn,
      record.cover || item.cover,
      item.title,
      "表紙なし"
    );
    coverBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host.openBook(record);
    });

    const body = card.createDiv({ cls: "st2-books-card-body" });
    const titleBtn = body.createEl("button", {
      attr: { type: "button" },
      cls: "st2-books-card-title",
      text: item.title,
    });
    titleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host.openBook(record);
    });
    if (item.author) {
      body.createDiv({ cls: "st2-books-card-author", text: item.author });
    }

    const tags = body.createDiv({ cls: "st2-books-card-tags" });
    if (item.status) {
      tags.createSpan({
        cls: `st2-badge${item.status === "reading" ? " is-focus" : ""}`,
        text: bookStatusLabel(item.status),
      });
    }
    const secondary = [
      item.owned ? bookOwnershipLabel(item.owned) : "",
      item.category,
      seriesCount && seriesCount > 1 ? `全${seriesCount}巻` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    if (secondary) {
      tags.createSpan({
        cls: "st2-books-card-meta-text",
        text: secondary,
      });
    }

    const calil = calilSummaryFromFrontmatter(record.frontmatter);
    if (calil.checkedAt !== "") {
      const when = calilCheckedLabel(calil.checkedAt);
      const calilLabel = [calilBadgeText(calil, new Date()), when]
        .filter(Boolean)
        .join(" · ");
      if (calilLabel) {
        body.createDiv({
          cls: "st2-books-calil-note",
          text: `図書館: ${calilLabel}`,
        });
      }
    }

    makeCardClickable(card, () => this.host.openBook(record));
    return card;
  }

  private renderListRow(
    record: NoteRecord,
    item: BookShelfItem,
    seriesCount?: number
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = `st2-ledger-row st2-books-list-row${item.status === "reading" ? " is-focus" : ""}`;

    const thumb = row.createDiv({ cls: "st2-books-list-thumb" });
    this.mountCoverImage(thumb, record.cover || item.cover, item.title, "");

    const main = row.createDiv({ cls: "st2-books-list-main" });
    const titleBtn = main.createEl("button", {
      attr: { type: "button" },
      cls: "st2-books-card-title",
      text: item.title,
    });
    titleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.host.openBook(record);
    });
    if (item.author) {
      main.createDiv({ cls: "st2-books-card-author", text: item.author });
    }

    const extraText = [
      item.category,
      seriesCount && seriesCount > 1
        ? `${item.series} (全${seriesCount}巻)`
        : item.series,
    ]
      .filter(Boolean)
      .join(" · ");
    row.createDiv({ cls: "st2-books-list-extra", text: extraText });

    const right = row.createDiv({ cls: "st2-books-list-right" });
    if (item.status) {
      right.createSpan({
        cls: `st2-badge${item.status === "reading" ? " is-focus" : ""}`,
        text: bookStatusLabel(item.status),
      });
    }
    if (item.owned) {
      right.createSpan({
        cls: "st2-badge",
        text: bookOwnershipLabel(item.owned),
      });
    }
    right.createSpan({
      cls: "st2-books-list-date",
      text: formatShortDate(item.updated),
    });

    makeCardClickable(row, () => this.host.openBook(record));
    return row;
  }

  private mountCoverImage(
    container: HTMLElement,
    coverSource: string,
    title: string,
    fallbackText: string
  ): void {
    const coverUrl = resolveCover(this.app, coverSource);
    if (coverUrl) {
      const img = container.createEl("img", { attr: { alt: "" } });
      img.src = coverUrl;
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        renderBookCoverFallback(container, title, fallbackText);
      });
      return;
    }
    renderBookCoverFallback(container, title, fallbackText);
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

function formatShortDate(timestamp: number): string {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
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
