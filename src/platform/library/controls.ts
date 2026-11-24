import { setIcon } from "obsidian";
import { createSelect, type SelectControl } from "../ui/select";
import type { LibraryFilter, LibrarySort } from "./query";
import type { LibrarySelection } from "./selection";

export const SORT_LABELS: Array<{ key: LibrarySort; label: string }> = [
  { key: "updated", label: "更新順" },
  { key: "created", label: "作成順" },
  { key: "lecture", label: "講義日順" },
  { key: "random", label: "シャッフル" },
];

const QUICK_KINDS: Array<{ id: LibraryFilter; label: string }> = [
  { id: "all", label: "すべて" },
  { id: "memo", label: "メモ" },
  { id: "class", label: "授業" },
  { id: "webclip", label: "Web" },
  { id: "book", label: "本" },
  { id: "other", label: "ノート" },
  { id: "prompt", label: "プロンプト" },
];

export interface LibraryControlsOptions {
  getActiveFilterCount: () => number;
  getFilter: () => LibraryFilter;
  getLayout: () => "cards" | "list";
  getQuery: () => string;
  getSort: () => LibrarySort;
  onFilterChange: (filter: LibraryFilter) => void;
  onLayoutChange: (layout: "cards" | "list") => void;
  onOpenFilterModal: () => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSortChange: (sort: LibrarySort) => void;
  selection: LibrarySelection;
}

export class LibraryControls {
  private readonly options: LibraryControlsOptions;
  private searchInput: HTMLInputElement | null = null;
  private filterBadge: HTMLElement | null = null;
  private filterBtn: HTMLButtonElement | null = null;
  private sortSelect: SelectControl | null = null;
  private kindButtons = new Map<LibraryFilter, HTMLButtonElement>();
  private unreadWebBtn: HTMLButtonElement | null = null;
  private searchTimer: number | null = null;

  constructor(options: LibraryControlsOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "seiton-library-toolbar" });

    // 1. 検索バー
    const searchWrap = toolbar.createDiv({
      cls: "seiton-search seiton-library-search-box",
    });
    const searchIcon = searchWrap.createSpan({ cls: "seiton-search-icon" });
    setIcon(searchIcon, "search");

    const search = searchWrap.createEl("input", {
      attr: {
        "aria-label": "ライブラリを検索",
        placeholder: "ライブラリを検索...",
        type: "search",
      },
      cls: "seiton-library-search",
    });
    this.searchInput = search;
    search.value = this.options.getQuery();

    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && search.value !== "") {
        event.preventDefault();
        search.value = "";
        this.options.onQueryChange("");
        this.options.onRefresh();
      }
    });

    search.addEventListener("input", () => {
      this.options.onQueryChange(search.value);
      if (this.searchTimer !== null) {
        window.clearTimeout(this.searchTimer);
      }
      this.searchTimer = window.setTimeout(() => {
        this.searchTimer = null;
        this.options.onRefresh();
      }, 200);
    });

    // 2. アクションボタン群
    const actions = toolbar.createDiv({ cls: "seiton-library-actions" });

    // 絞り込みボタン
    const filterBtn = actions.createEl("button", {
      attr: {
        "aria-label": "絞り込み条件を設定",
        type: "button",
      },
      cls: "seiton-filter-trigger-btn",
    });
    this.filterBtn = filterBtn;
    const filterIcon = filterBtn.createSpan({ cls: "seiton-btn-icon" });
    setIcon(filterIcon, "sliders-horizontal");
    filterBtn.createSpan({ cls: "seiton-btn-label", text: "絞り込み" });

    this.filterBadge = filterBtn.createSpan({
      cls: "seiton-filter-badge is-hidden",
      text: "0",
    });
    filterBtn.addEventListener("click", () => {
      this.options.onOpenFilterModal();
    });

    // 並び順
    this.sortSelect = createSelect({
      choices: SORT_LABELS.map((item) => ({
        label: item.label,
        value: item.key,
      })),
      onChange: (value) => {
        const match = SORT_LABELS.find((item) => item.key === value);
        this.options.onSortChange(match ? match.key : "updated");
      },
      title: "並び順",
      value: this.options.getSort(),
    });
    this.sortSelect.element.addClass("seiton-library-select", "is-quiet");
    actions.append(this.sortSelect.element);

    // 表示切替（カード / リスト）
    const layout = actions.createDiv({
      attr: { "aria-label": "表示", role: "group" },
      cls: "seiton-segmented",
    });
    const cardsButton = layout.createEl("button", {
      attr: { type: "button" },
      cls: this.options.getLayout() === "cards" ? "is-active" : "",
      text: "カード",
    });
    const listButton = layout.createEl("button", {
      attr: { type: "button" },
      cls: this.options.getLayout() === "list" ? "is-active" : "",
      text: "リスト",
    });
    const applyLayout = (next: "cards" | "list"): void => {
      cardsButton.classList.toggle("is-active", next === "cards");
      listButton.classList.toggle("is-active", next === "list");
      cardsButton.setAttribute("aria-pressed", String(next === "cards"));
      listButton.setAttribute("aria-pressed", String(next === "list"));
      this.options.onLayoutChange(next);
    };
    cardsButton.setAttribute(
      "aria-pressed",
      String(this.options.getLayout() === "cards")
    );
    listButton.setAttribute(
      "aria-pressed",
      String(this.options.getLayout() === "list")
    );
    cardsButton.addEventListener("click", () => applyLayout("cards"));
    listButton.addEventListener("click", () => applyLayout("list"));

    // 選択ボタン
    const selectToggle = actions.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-select-toggle",
      text: "選択",
    });
    this.options.selection.bindToggle(selectToggle);

    // 2段目: 左に種類プリセット、右にクイックアクション
    const subbar = parent.createDiv({ cls: "seiton-library-subbar" });
    const kindStrip = subbar.createDiv({
      attr: { "aria-label": "種類で絞り込み", role: "group" },
      cls: "seiton-library-kinds",
    });
    this.kindButtons.clear();
    const activeFilter = this.options.getFilter();
    for (const kind of QUICK_KINDS) {
      const btn = kindStrip.createEl("button", {
        attr: {
          "aria-pressed": activeFilter === kind.id ? "true" : "false",
          type: "button",
        },
        cls: `seiton-library-kind-btn${activeFilter === kind.id ? " is-active" : ""}`,
        text: kind.label,
      });
      btn.addEventListener("click", () => {
        this.options.onFilterChange(kind.id);
      });
      this.kindButtons.set(kind.id, btn);
    }

    const quickBar = subbar.createDiv({ cls: "seiton-library-quick-pills" });
    const unreadWebBtn = quickBar.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-library-quick-pill",
      text: "未読Web",
    });
    const unreadWebIcon = unreadWebBtn.createSpan({ cls: "seiton-btn-icon" });
    setIcon(unreadWebIcon, "globe");
    unreadWebBtn.prepend(unreadWebIcon);
    unreadWebBtn.addEventListener("click", () => {
      const next =
        this.options.getQuery().trim() === "kind:webclip" ? "" : "kind:webclip";
      this.options.onQueryChange(next);
      this.setQuery(next);
      this.options.onRefresh();
    });
    this.unreadWebBtn = unreadWebBtn;

    const shuffleBtn = quickBar.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action seiton-library-quick-pill",
      text: "シャッフル",
    });
    const shuffleIcon = shuffleBtn.createSpan({ cls: "seiton-btn-icon" });
    setIcon(shuffleIcon, "shuffle");
    shuffleBtn.prepend(shuffleIcon);
    shuffleBtn.addEventListener("click", () => {
      this.options.onSortChange("random");
      this.setSortState("random", false);
      this.options.onRefresh();
    });

    this.setActiveFilter(activeFilter, this.options.getQuery());
    this.updateFilterBadge();
  }

  setActiveFilter(filter: LibraryFilter, query = ""): void {
    for (const [id, btn] of this.kindButtons.entries()) {
      const active = id === filter;
      btn.toggleClass("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (this.unreadWebBtn) {
      const isWebQuery = query.trim() === "kind:webclip";
      this.unreadWebBtn.toggleClass("is-active", isWebQuery);
      this.unreadWebBtn.setAttribute(
        "aria-pressed",
        isWebQuery ? "true" : "false"
      );
    }
  }

  setQuery(query: string): void {
    if (this.searchInput) {
      this.searchInput.value = query;
    }
  }

  focusSearch(): void {
    this.searchInput?.focus();
    this.searchInput?.select();
  }

  updateFilterBadge(): void {
    const count = this.options.getActiveFilterCount();
    if (this.filterBadge && this.filterBtn) {
      if (count > 0) {
        this.filterBadge.setText(String(count));
        this.filterBadge.removeClass("is-hidden");
        this.filterBtn.addClass("has-active-filters");
      } else {
        this.filterBadge.addClass("is-hidden");
        this.filterBtn.removeClass("has-active-filters");
      }
    }
  }

  setSortState(sort: LibrarySort, searching: boolean): void {
    if (!this.sortSelect) {
      return;
    }
    this.sortSelect.setValue(sort);
    this.sortSelect.element.toggleClass("is-disabled", searching);
    this.sortSelect.element.title = searching
      ? "検索中は関連度順で表示します"
      : "並び順";
  }

  reset(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.searchInput = null;
    this.filterBadge = null;
    this.filterBtn = null;
    this.sortSelect = null;
    this.kindButtons.clear();
    this.unreadWebBtn = null;
  }
}
