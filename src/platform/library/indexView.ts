import { setIcon } from "obsidian";
import type { VaultIndex } from "../../services/vaultIndex";
import { type LibraryFilter, OTHER_KINDS } from "./query";

const INDEX_TYPES: Array<{ id: LibraryFilter; label: string }> = [
  { id: "memo", label: "メモ" },
  { id: "class", label: "授業" },
  { id: "webclip", label: "Web" },
  { id: "book", label: "本" },
  { id: "other", label: "ノート" },
  { id: "prompt", label: "プロンプト" },
];

const TYPE_FILTERS: Array<{ id: LibraryFilter; label: string }> = [
  ...INDEX_TYPES,
  { id: "idea", label: "アイデア" },
  { id: "article", label: "記事" },
];

const STATUS_FILTERS: Array<{ id: LibraryFilter; label: string }> = [
  { id: "inbox", label: "受信箱" },
  { id: "review", label: "整理トレイ" },
  { id: "pinned", label: "ピン" },
  { id: "archived", label: "アーカイブ" },
];

export const FILTER_LABELS: Record<string, string> = {
  all: "すべて",
  archived: "アーカイブ",
  article: "記事",
  book: "本",
  class: "授業",
  idea: "アイデア",
  inbox: "受信箱",
  memo: "メモ",
  other: "ノート",
  pinned: "ピン",
  prompt: "プロンプト",
  review: "整理トレイ",
  webclip: "Web",
};

export interface LibraryIndexOptions {
  getFilter: () => LibraryFilter;
  getQuery: () => string;
  onFilterChange: (filter: LibraryFilter) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}

export class LibraryIndex {
  private readonly options: LibraryIndexOptions;
  private filterEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private labelEl: HTMLElement | null = null;
  private searchTimer: number | null = null;
  private totalEl: HTMLElement | null = null;

  constructor(options: LibraryIndexOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    const index = parent.createDiv({ cls: "seiton-index" });
    this.filterEl = index;

    const top = index.createDiv({ cls: "seiton-index-top" });
    const total = top.createDiv({
      attr: { "aria-live": "polite" },
      cls: "seiton-index-total",
    });
    this.totalEl = total.createSpan({
      cls: "seiton-index-total-number",
      text: "0",
    });
    this.labelEl = total.createSpan({
      cls: "seiton-index-total-label",
      text: "アイテム",
    });

    const searchWrap = top.createDiv({ cls: "seiton-search" });
    const searchIcon = searchWrap.createSpan({ cls: "seiton-search-icon" });
    setIcon(searchIcon, "search");
    const search = searchWrap.createEl("input", {
      attr: {
        "aria-label": "ライブラリを検索",
        placeholder: "検索",
        type: "search",
      },
      cls: "seiton-library-search",
    });
    this.inputEl = search;
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
      }, 220);
    });

    const toggle = top.createEl("button", {
      attr: { "aria-expanded": "false", type: "button" },
      cls: "seiton-index-toggle",
      text: "種類",
    });
    toggle.addEventListener("click", () => {
      const expanded = index.classList.toggle("is-expanded");
      toggle.setAttribute("aria-expanded", String(expanded));
    });

    const labels = index.createDiv({ cls: "seiton-index-labels" });
    const typeGroup = labels.createDiv({ cls: "seiton-index-group" });
    typeGroup.createSpan({
      cls: "seiton-index-group-title",
      text: "種類",
    });
    const typeItems = typeGroup.createDiv({
      cls: "seiton-index-group-items",
    });
    for (const item of [
      { id: "all" as LibraryFilter, label: "すべて" },
      ...TYPE_FILTERS,
    ]) {
      const active = this.options.getFilter() === item.id;
      const label = typeItems.createEl("button", {
        attr: {
          "aria-label": item.label,
          "aria-pressed": active ? "true" : "false",
          type: "button",
        },
        cls: `seiton-index-label${active ? " is-active" : ""}`,
      });
      label.dataset.filter = item.id;
      label.createSpan({ text: item.label });
      label.createSpan({ cls: "seiton-index-count", text: "0" });
      label.addEventListener("click", () =>
        this.options.onFilterChange(item.id)
      );
    }

    const statusGroup = labels.createDiv({ cls: "seiton-index-group" });
    statusGroup.createSpan({
      cls: "seiton-index-group-title",
      text: "整理状態",
    });
    const statusItems = statusGroup.createDiv({
      cls: "seiton-index-group-items",
    });
    for (const item of STATUS_FILTERS) {
      const active = this.options.getFilter() === item.id;
      const button = statusItems.createEl("button", {
        attr: {
          "aria-pressed": active ? "true" : "false",
          type: "button",
        },
        cls: `seiton-status-filter${active ? " is-active" : ""}`,
      });
      button.dataset.filter = item.id;
      button.createSpan({ text: item.label });
      button.createSpan({ cls: "seiton-index-count", text: "0" });
      button.addEventListener("click", () =>
        this.options.onFilterChange(item.id)
      );
    }
  }

  renderCounts(index: VaultIndex): void {
    if (!this.filterEl) {
      return;
    }
    const activeNotes = index.notes.filter((note) => !note.archived);
    const counts: Record<LibraryFilter, number> = {
      all:
        activeNotes.length +
        index.memos.filter((memo) => memo.state !== "deleted").length +
        index.prompts.length,
      archived: index.notes.filter((note) => note.archived).length,
      article: activeNotes.filter((note) => note.kind === "article").length,
      book: activeNotes.filter((note) => note.kind === "book").length,
      class: activeNotes.filter((note) => note.kind === "class").length,
      idea: activeNotes.filter((note) => note.kind === "idea").length,
      inbox: activeNotes.filter((note) => note.tags.includes("受信箱")).length,
      memo: index.memos.filter((memo) => memo.state !== "deleted").length,
      other: activeNotes.filter((note) => OTHER_KINDS.includes(note.kind))
        .length,
      pinned: index.notes.filter((note) => note.pinned && !note.archived)
        .length,
      prompt: index.prompts.length,
      review: index.notes.filter((note) => note.review && !note.archived)
        .length,
      webclip: activeNotes.filter((note) => note.kind === "webclip").length,
    };

    this.totalEl?.setText(String(counts.all));

    for (const element of Array.from(
      this.filterEl.querySelectorAll<HTMLElement>("[data-filter]")
    )) {
      const id = element.dataset.filter as LibraryFilter | undefined;
      if (!id) {
        continue;
      }
      const count = counts[id] ?? 0;
      element.setAttribute(
        "aria-label",
        `${FILTER_LABELS[id] ?? id} ${count}件`
      );
      element
        .querySelector<HTMLElement>(".seiton-index-count")
        ?.setText(String(count));
    }
  }

  setActive(filter: LibraryFilter): void {
    if (!this.filterEl) {
      return;
    }
    for (const element of Array.from(
      this.filterEl.querySelectorAll<HTMLElement>("[data-filter]")
    )) {
      const active = element.dataset.filter === filter;
      element.classList.toggle("is-active", active);
      element.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  setTotal(count: number, label: string): void {
    this.totalEl?.setText(String(count));
    this.labelEl?.setText(label);
  }

  setQuery(query: string): void {
    if (this.inputEl) {
      this.inputEl.value = query;
    }
  }

  focus(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  reset(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.filterEl = null;
    this.inputEl = null;
    this.labelEl = null;
    this.totalEl = null;
  }
}
