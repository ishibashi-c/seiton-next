import type { App } from "obsidian";
import { normalizeLink } from "../../domain/links";
import { isAllowedRemoteUrl } from "../../domain/network";
import { findYoutubeThumbnail } from "../../domain/video";
import { webClipDuplicateKey } from "../../domain/webclip";
import type {
  IndexItem,
  MemoIndexItem,
  NoteRecord,
  PromptIndexItem,
  VaultIndexService,
} from "../../services/vaultIndex";
import type { WebClipNote } from "../../services/webClipService";
import { renderBookCoverFallback, resolveCover } from "../bookCover";
import { makeCardClickable } from "../cardClick";
import { addCardAction, type ItemAction, renderItemCard } from "./cards";
import {
  bookFallbackMeta,
  KIND_LABELS,
  memoPreview,
  readingStatusLabel,
  shortDate,
  shortDateTime,
} from "./format";
import type { LibraryFilter } from "./query";
import type { LibrarySelection } from "./selection";

export interface LibraryListOptions {
  app: App;
  clearFilters: () => void;
  confirmDelete: (note: NoteRecord) => void;
  getFilter: () => LibraryFilter;
  getLayout: () => "cards" | "list";
  getQuery: () => string;
  getTotalDataCount: () => number;
  getWebClip: (path: string) => WebClipNote | undefined;
  hasActiveFilters: () => boolean;
  host: {
    openBook: (record: NoteRecord) => void;
    openProject: (path: string) => void;
    openPrompt: (path: string) => void;
    previewWebClip: (path: string, source: string) => void;
  };
  indexService: VaultIndexService;
  openOrganize: (note: NoteRecord) => void;
  openPath: (path: string, line?: number) => Promise<void>;
  refresh: () => void;
  relaxedSuggestions: () => Array<{ count: number; token: string }>;
  selection: LibrarySelection;
  setQuery: (query: string) => void;
  togglePinned: (note: NoteRecord) => Promise<void>;
}

export class LibraryList {
  private readonly options: LibraryListOptions;
  private currentHits: IndexItem[] = [];
  private renderLimit = 60;

  constructor(options: LibraryListOptions) {
    this.options = options;
  }

  render(container: HTMLElement, items: IndexItem[], resetLimit = true): void {
    if (resetLimit) {
      this.renderLimit = 60;
    }
    this.currentHits = items;
    container.empty();
    if (items.length === 0) {
      this.renderEmpty(container);
      return;
    }

    const shelf =
      this.options.getFilter() === "book" &&
      this.options.getLayout() === "cards";
    const visible = items.slice(0, this.renderLimit);
    const grid = container.createDiv({
      cls: `seiton-card-grid${
        this.options.getLayout() === "list" ? " is-list" : ""
      }${shelf ? " is-shelf" : ""}`,
    });
    for (const item of visible) {
      let card: HTMLElement;
      if (item.type === "note") {
        card =
          shelf && item.kind === "book"
            ? this.renderBookShelfCard(item)
            : this.renderNoteCard(item);
      } else if (item.type === "memo") {
        card = this.renderMemoCard(item);
      } else {
        card = this.renderPromptCard(item);
      }
      grid.appendChild(card);
    }
    if (items.length > this.renderLimit) {
      const more = container.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-more-button",
        text: `さらに表示（${this.renderLimit} / ${items.length}）`,
      });
      more.addEventListener("click", () => {
        this.renderLimit += 60;
        this.render(container, this.currentHits, false);
      });
    }
  }

  private renderEmpty(container: HTMLElement): void {
    const empty = container.createDiv({ cls: "seiton-empty" });
    const hasConditions = this.options.hasActiveFilters();
    const query = this.options.getQuery().trim();
    if (this.options.getTotalDataCount() === 0) {
      empty.createDiv({
        text: "ライブラリは、メモ・ノート・本・プロンプトを横断して探す場所です。ホームで記録するか、本棚で本を追加すると、ここに集まります。",
      });
    } else if (query) {
      empty.createDiv({
        text: `「${query}」に一致する項目がありません。`,
      });
      const suggestions = this.options.relaxedSuggestions();
      if (suggestions.length > 0) {
        const box = empty.createDiv({ cls: "seiton-empty-suggestions" });
        box.createSpan({
          cls: "seiton-empty-suggestions-label",
          text: "もしかして",
        });
        for (const suggestion of suggestions) {
          const chip = box.createEl("button", {
            attr: { type: "button" },
            cls: "seiton-empty-suggestion",
            text: `「${suggestion.token}」${suggestion.count}件`,
          });
          chip.addEventListener("click", () => {
            this.options.setQuery(suggestion.token);
            this.options.refresh();
          });
        }
      }
    } else if (hasConditions) {
      empty.createDiv({ text: "条件に合う項目がありません。" });
    } else {
      empty.createDiv({ text: "表示できる項目がありません。" });
    }
    if (hasConditions) {
      const clear = empty.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-empty-clear",
        text: "条件をすべて解除",
      });
      clear.addEventListener("click", () => this.options.clearFilters());
    }
  }

  private renderBookShelfCard(note: NoteRecord): HTMLElement {
    const article = document.createElement("article");
    article.className = "seiton-book-card";
    article.dataset.kind = "book";

    const openDetail = (): void => this.options.host.openBook(note);
    const coverWrap = article.createDiv({ cls: "seiton-book-cover-wrap" });
    const cover = resolveCover(this.options.app, note.cover);
    if (cover) {
      const image = coverWrap.createEl("img", {
        cls: "seiton-book-cover-image",
      });
      image.src = cover;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => {
        image.remove();
        renderBookCoverFallback(coverWrap, note.title, bookFallbackMeta(note));
      });
    } else {
      renderBookCoverFallback(coverWrap, note.title, bookFallbackMeta(note));
    }
    coverWrap.setAttribute("role", "button");
    coverWrap.tabIndex = 0;
    coverWrap.setAttribute("aria-label", `${note.title} の詳細を開く`);
    coverWrap.addEventListener("click", openDetail);
    coverWrap.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });
    if (this.options.selection.mode) {
      const select = document.createElement("button");
      select.type = "button";
      select.className = `seiton-select seiton-select-cover${
        this.options.selection.selected.has(note.path) ? " is-selected" : ""
      }`;
      select.setAttribute("aria-label", `${note.title} を選択`);
      select.setAttribute(
        "aria-pressed",
        String(this.options.selection.selected.has(note.path))
      );
      select.addEventListener("click", (event) => {
        event.stopPropagation();
        this.options.selection.toggle(note.path, select);
      });
      coverWrap.appendChild(select);
    }

    const body = article.createDiv({ cls: "seiton-book-card-body" });
    const title = body.createEl("button", {
      cls: "seiton-book-card-title",
      text: note.title,
    });
    title.type = "button";
    title.addEventListener("click", openDetail);
    const statusLabels: Record<string, string> = {
      read: "読了",
      reading: "読書中",
      tbr: "積読",
    };
    body.createDiv({
      cls: "seiton-book-card-meta",
      text: [
        note.book.book_author,
        statusLabels[note.book.reading_status ?? ""] ??
          note.book.reading_status,
      ]
        .filter(Boolean)
        .join(" · "),
    });
    const actions = body.createDiv({ cls: "seiton-item-actions" });
    addCardAction(actions, "詳細", openDetail);
    addCardAction(actions, "開く", () => {
      void this.options.openPath(note.path);
    });
    makeCardClickable(article, openDetail);
    return article;
  }

  private renderNoteCard(note: NoteRecord): HTMLElement {
    const clip =
      note.kind === "webclip" ? this.options.getWebClip(note.path) : undefined;
    const cover = resolveCover(this.options.app, note.cover);
    const coverUrl =
      clip?.image && isAllowedRemoteUrl(clip.image) ? clip.image : null;
    // 表紙が無いYouTubeクリップは、動画IDからサムネイルを引く。
    const youtubeThumb =
      cover === null && coverUrl === null
        ? findYoutubeThumbnail(`${note.source}\n${note.searchText}`)
        : null;
    const remoteCover = coverUrl ?? youtubeThumb;
    const isVideo = youtubeThumb !== null;
    const cardLayout = this.options.getLayout() === "cards";

    let media: HTMLElement | null = null;
    let banner: HTMLElement | null = null;
    if (cover || remoteCover) {
      const image = document.createElement("img");
      image.className = isVideo ? "seiton-video-cover" : "seiton-item-cover";
      image.src = cover ?? (remoteCover as string);
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => {
        image.remove();
        banner?.remove();
      });
      if (isVideo && cardLayout) {
        banner = image;
      } else {
        if (isVideo) {
          image.className = "seiton-item-cover is-video";
        }
        media = image;
      }
    } else if (note.kind === "book") {
      const spine = document.createElement("div");
      spine.className = "seiton-book-spine";
      spine.textContent = note.title.slice(0, 1);
      media = spine;
    }

    const readingState =
      note.kind === "book" ? readingStatusLabel(note.book.reading_status) : "";
    const state = note.archived
      ? "アーカイブ"
      : note.review
        ? "整理トレイ"
        : note.pinned
          ? "ピン"
          : readingState ||
            (clip && clip.duplicates > 1 ? `同じURL ${clip.duplicates}件` : "");

    let meta = "";
    if (note.kind === "book") {
      meta = note.book.book_author ?? "";
    } else if (note.kind === "webclip") {
      meta = [clip?.domain || note.source, clip?.description]
        .filter(Boolean)
        .join(" · ");
    } else if (note.kind === "class" && note.course) {
      meta = `科目: ${note.course}`;
    } else if (note.kind === "project") {
      meta = this.projectMetaOf(note) ?? note.excerpt;
    } else {
      meta = note.excerpt;
    }

    const actions: ItemAction[] = [
      {
        label: "開く",
        run: () => void this.options.openPath(note.path),
      },
      { label: "整理", run: () => this.options.openOrganize(note) },
    ];
    if (note.kind === "book") {
      actions.push({
        label: "詳細",
        run: () => this.options.host.openBook(note),
      });
    }
    if (note.kind === "project") {
      actions.push({
        label: "再開",
        run: () => this.options.host.openProject(note.path),
      });
    }
    if (note.kind === "webclip") {
      actions.push({
        label: "プレビュー",
        run: () => this.options.host.previewWebClip(note.path, note.source),
      });
      const otherClip = this.otherWebClipPath(note);
      if (otherClip) {
        actions.push({
          label: "別のクリップ",
          run: () => void this.options.openPath(otherClip),
        });
      }
    }
    actions.push({
      label: note.pinned ? "ピン解除" : "ピン",
      run: () => void this.options.togglePinned(note),
    });
    actions.push({
      danger: true,
      label: "削除",
      run: () => this.options.confirmDelete(note),
    });

    return renderItemCard({
      actions,
      banner: banner ?? undefined,
      date: shortDate(note.mtime),
      kind: note.kind,
      kindLabel: KIND_LABELS[note.kind] ?? note.kind,
      media,
      meta,
      onOpen: () => void this.options.openPath(note.path),
      onSelect: (button) => this.options.selection.toggle(note.path, button),
      selectable: this.options.selection.mode,
      selected: this.options.selection.selected.has(note.path),
      state,
      title: note.title,
    });
  }

  private renderMemoCard(memo: MemoIndexItem): HTMLElement {
    return renderItemCard({
      actions: [
        {
          label: "開く",
          run: () => void this.options.openPath(memo.path, memo.line),
        },
        {
          label: "週ファイル",
          run: () => void this.options.openPath(memo.path),
        },
      ],
      date: shortDateTime(memo.at),
      kind: "memo",
      kindLabel: "メモ",
      meta: memo.week,
      onOpen: () => void this.options.openPath(memo.path, memo.line),
      state: memo.promotedTo ? "ノート化" : "",
      title: memoPreview(memo.body) || "（空のメモ）",
    });
  }

  private renderPromptCard(prompt: PromptIndexItem): HTMLElement {
    return renderItemCard({
      actions: [
        {
          label: "Workbench",
          run: () => this.options.host.openPrompt(prompt.path),
        },
        {
          label: "セッション",
          run: () => void this.options.openPath(prompt.path, prompt.line),
        },
      ],
      date: shortDateTime(prompt.at),
      kind: "prompt",
      kindLabel: "プロンプト",
      meta: prompt.body,
      onOpen: () => this.options.host.openPrompt(prompt.path),
      state: prompt.project ? `プロジェクト: ${prompt.project}` : "",
      title: prompt.title,
    });
  }

  private otherWebClipPath(note: NoteRecord): string | null {
    const index = this.options.indexService.getCached();
    const key = webClipDuplicateKey(note.source);
    if (!(index && key)) {
      return null;
    }
    const other = index.notes.find(
      (candidate) =>
        candidate.kind === "webclip" &&
        candidate.path !== note.path &&
        webClipDuplicateKey(candidate.source) === key
    );
    return other?.path ?? null;
  }

  private projectMetaOf(note: NoteRecord): string | undefined {
    const index = this.options.indexService.getCached();
    if (!index) {
      return undefined;
    }
    const key = normalizeLink(note.title);
    const related = index.notes.filter(
      (candidate) =>
        candidate.path !== note.path &&
        candidate.projects.some((project) => normalizeLink(project) === key)
    ).length;
    return `関連ノート ${related}件`;
  }
}
