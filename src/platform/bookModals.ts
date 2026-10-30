/**
 * 本棚（BOOK）のUI。Obsidian標準の Modal / Setting / ButtonComponent だけを使う。
 * 見た目は `seiton-book-*` クラスを付けるのみで、styles.css は変更しない。
 */

import type { App } from "obsidian";
import {
  ButtonComponent,
  Modal,
  Notice,
  Setting,
  type TextAreaComponent,
  type TextComponent,
  TFile,
} from "obsidian";
import {
  BOOK_OWNERSHIP_LABELS,
  BOOK_OWNERSHIPS,
  type BookInfo,
  bookInfoFromFrontmatter,
  CALIL_TIME_DEPENDENT_NOTICE,
  isValidIsbn,
  normalizeIsbn,
  parseReadingStatus,
  READING_STATUS_LABELS,
  READING_STATUSES,
  type ReadingStatus,
  replaceBookBody,
  stripCoverEmbed,
  trimBookBody,
  withCoverEmbed,
} from "../domain/book";
import {
  type CalilBranch,
  calilBestBranch,
  calilBookUrl,
  calilLibraryPageUrl,
  calilMapUrl,
} from "../domain/calil";
import {
  type CalilSummary,
  calilBadgeText,
  calilCheckedLabel,
  calilSummaryFromFrontmatter,
  summarizeCalil,
} from "../domain/calilStatus";
import { userMessageOf } from "../domain/errors";
import { bodyAfterFrontmatter } from "../domain/frontmatter";
import { isAllowedRemoteUrl } from "../domain/network";
import type {
  BookPatch,
  BookService,
  CalilSearchResult,
  CreateBookResult,
} from "../services/bookService";
import type { NoteRecord } from "../services/vaultIndex";

const RATING_NONE = "";

function ratingStars(value: number | null): string {
  return value === null ? "" : `${value}/5`;
}

function coverNameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

// ---------------------------------------------------------------------------
// 追加
// ---------------------------------------------------------------------------

export interface AddBookModalOptions {
  initialIsbn?: string;
  onCreated?: (result: CreateBookResult) => void;
}

export class AddBookModal extends Modal {
  private readonly bookService: BookService;
  private readonly options: AddBookModalOptions;
  private isbn: string;
  private title = "";
  private authors = "";
  private publisher = "";
  private category = "";
  private status: ReadingStatus = "tbr";
  private coverUrl = "";
  private statusEl: HTMLElement | null = null;
  private isbnText: TextComponent | null = null;
  private titleText: TextComponent | null = null;
  private authorsText: TextComponent | null = null;
  private publisherText: TextComponent | null = null;
  private categoryText: TextComponent | null = null;
  private lookupButton: ButtonComponent | null = null;
  private saveButton: ButtonComponent | null = null;
  private busy = false;

  constructor(
    app: App,
    bookService: BookService,
    options: AddBookModalOptions = {}
  ) {
    super(app);
    this.bookService = bookService;
    this.options = options;
    this.isbn = options.initialIsbn ?? "";
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-book-modal");
    this.modalEl.addClass("seiton-book-add-modal");
    this.setTitle("本を追加");

    this.contentEl.createEl("p", {
      cls: "seiton-book-hint",
      text: "ISBNは先頭ゼロを保った文字列として保存します。書誌を取得できなくても、タイトルだけで登録できます。",
    });

    const isbnSetting = new Setting(this.contentEl)
      .setName("ISBN")
      .setDesc("ハイフン付きでも構いません。照会は任意です。");
    isbnSetting.settingEl.addClass("seiton-book-field");
    isbnSetting.addText((text) => {
      this.isbnText = text;
      text.inputEl.addClass("seiton-book-isbn");
      text.setPlaceholder("978-4-7741-9242-1");
      text.setValue(this.isbn);
      text.onChange((value) => {
        this.isbn = value;
        this.coverUrl = "";
        this.setStatus("");
      });
    });
    isbnSetting.addButton((button) => {
      this.lookupButton = button;
      button.setButtonText("照会").onClick(() => {
        void this.lookup();
      });
    });

    const titleSetting = new Setting(this.contentEl)
      .setName("タイトル")
      .setDesc("必須");
    titleSetting.settingEl.addClass("seiton-book-field");
    titleSetting.addText((text) => {
      this.titleText = text;
      text.inputEl.addClass("seiton-book-title");
      text.setPlaceholder("本のタイトル");
      text.onChange((value) => {
        this.title = value;
        this.setStatus("");
      });
    });

    const authorsSetting = new Setting(this.contentEl).setName("著者");
    authorsSetting.settingEl.addClass("seiton-book-field");
    authorsSetting.addText((text) => {
      this.authorsText = text;
      text.setPlaceholder("複数は「 / 」区切り");
      text.onChange((value) => {
        this.authors = value;
      });
    });

    const publisherSetting = new Setting(this.contentEl).setName("出版社");
    publisherSetting.settingEl.addClass("seiton-book-field");
    publisherSetting.addText((text) => {
      this.publisherText = text;
      text.setPlaceholder("出版社");
      text.onChange((value) => {
        this.publisher = value;
      });
    });

    const categorySetting = new Setting(this.contentEl).setName("カテゴリ");
    categorySetting.settingEl.addClass("seiton-book-field");
    categorySetting.addText((text) => {
      this.categoryText = text;
      text.setPlaceholder("例: 技術書");
      text.onChange((value) => {
        this.category = value;
      });
    });

    const statusSetting = new Setting(this.contentEl)
      .setName("読書状態")
      .setDesc("積読・読書中・読了を保存します。");
    statusSetting.settingEl.addClass("seiton-book-field");
    statusSetting.addDropdown((dropdown) => {
      for (const value of READING_STATUSES) {
        dropdown.addOption(value, READING_STATUS_LABELS[value]);
      }
      dropdown.setValue(this.status);
      dropdown.onChange((value) => {
        this.status = parseReadingStatus(value) ?? "tbr";
      });
    });

    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-book-modal-status",
    });

    const footer = this.contentEl.createDiv({
      cls: "seiton-book-modal-footer",
    });
    new ButtonComponent(footer)
      .setButtonText("キャンセル")
      .onClick(() => this.close());
    this.saveButton = new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        void this.save();
      });

    this.scope.register(["Mod"], "Enter", (event) => {
      event.preventDefault();
      void this.save();
      return false;
    });

    window.setTimeout(() => {
      this.isbnText?.inputEl.focus();
    }, 60);
  }

  override onClose(): void {
    this.isbnText = null;
    this.titleText = null;
    this.authorsText = null;
    this.publisherText = null;
    this.categoryText = null;
    this.lookupButton = null;
    this.saveButton = null;
    this.statusEl = null;
    this.busy = false;
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.lookupButton?.setDisabled(busy);
    this.saveButton?.setDisabled(busy);
    this.isbnText?.setDisabled(busy);
  }

  private async lookup(): Promise<void> {
    if (this.busy) {
      return;
    }
    const isbn = normalizeIsbn(this.isbn);
    if (!isValidIsbn(isbn)) {
      this.setStatus(
        "ISBNの形式が正しくありません。ハイフンやチェックディジットを確認してください。",
        true
      );
      this.isbnText?.inputEl.focus();
      return;
    }

    this.coverUrl = "";
    this.setBusy(true);
    this.setStatus("書誌を照会中…");
    try {
      const result = await this.bookService.lookupIsbn(isbn);
      const candidate = result.candidate;
      if (!candidate) {
        const reasons = result.attempts
          .filter((attempt) => attempt.status !== "ok")
          .map((attempt) => attempt.message)
          .join(" / ");
        this.setStatus(
          `書誌を取得できませんでした。${reasons} タイトルを入力して登録できます。`,
          true
        );
        return;
      }

      if (this.title.trim() === "") {
        this.title = candidate.title;
        this.titleText?.setValue(candidate.title);
      }
      if (this.authors.trim() === "" && candidate.authors.length > 0) {
        this.authors = candidate.authors.join(" / ");
        this.authorsText?.setValue(this.authors);
      }
      if (this.publisher.trim() === "" && candidate.publisher !== "") {
        this.publisher = candidate.publisher;
        this.publisherText?.setValue(candidate.publisher);
      }
      if (this.category.trim() === "" && candidate.category !== "") {
        this.category = candidate.category;
        this.categoryText?.setValue(candidate.category);
      }
      if (candidate.isbn !== "") {
        this.isbn = candidate.isbn;
        this.isbnText?.setValue(candidate.isbn);
      }
      this.coverUrl = candidate.coverUrl;

      const source =
        candidate.source === "openbd"
          ? "openBD"
          : candidate.source === "googlebooks"
            ? "Google Books"
            : "Open Library";
      this.setStatus(
        `書誌を取得しました（${source}）。内容を確認して保存してください。`
      );
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
    } finally {
      this.setBusy(false);
    }
  }

  private async save(): Promise<void> {
    if (this.busy) {
      return;
    }
    const title = this.title.trim();
    if (title === "") {
      this.setStatus("タイトルを入力してください。", true);
      this.titleText?.inputEl.focus();
      return;
    }

    this.setBusy(true);
    this.setStatus("保存中…");
    try {
      const result = await this.bookService.createBook({
        authors: this.authors.trim() === "" ? null : this.authors,
        category: this.category.trim() === "" ? null : this.category,
        coverUrl: this.coverUrl.trim() === "" ? null : this.coverUrl,
        isbn: this.isbn.trim() === "" ? null : this.isbn,
        publisher: this.publisher.trim() === "" ? null : this.publisher,
        readingStatus: this.status,
        title,
      });
      try {
        this.options.onCreated?.(result);
      } catch (error) {
        console.error("[Seiton] book created callback failed", error);
      }
      const message =
        result.coverError === null
          ? `本を追加しました: ${result.title}`
          : `本を追加しました（表紙は未保存: ${result.coverError}）`;
      new Notice(message);
      this.close();
    } catch (error) {
      this.setBusy(false);
      this.setStatus(userMessageOf(error), true);
    }
  }
}

// ---------------------------------------------------------------------------
// 詳細
// ---------------------------------------------------------------------------

export interface BookDetailModalOptions {
  onSaved?: () => void;
}

export class BookDetailModal extends Modal {
  private readonly bookService: BookService;
  private readonly record: NoteRecord;
  private readonly options: BookDetailModalOptions;
  private readonly info: BookInfo;
  private title: string;
  private authors: string;
  private publisher: string;
  private category: string;
  private series: string;
  private status: ReadingStatus | "";
  private ownership: string;
  private rating: string;
  private finished: string;
  private isbn: string;
  private coverPath: string;
  private memo = "";
  private initialMemo = "";
  private statusEl: HTMLElement | null = null;
  private coverEl: HTMLElement | null = null;
  private calilEl: HTMLElement | null = null;
  private calilSummary: CalilSummary = {
    checkedAt: "",
    hits: 0,
    library: "",
    state: "unknown",
    total: 0,
  };
  private memoInput: TextAreaComponent | null = null;
  private saveButton: ButtonComponent | null = null;
  private coverButton: ButtonComponent | null = null;
  private calilButton: ButtonComponent | null = null;
  private openState = false;
  private busy = false;

  constructor(
    app: App,
    bookService: BookService,
    record: NoteRecord,
    options: BookDetailModalOptions = {}
  ) {
    super(app);
    this.bookService = bookService;
    this.record = record;
    this.options = options;
    this.info = bookInfoFromFrontmatter(record.frontmatter);
    this.title = record.title;
    this.authors = this.info.authors.join(" / ");
    this.publisher = this.info.publisher;
    this.category = this.info.category;
    this.series = this.info.series;
    this.status = this.info.readingStatus;
    this.ownership = this.info.ownership;
    this.rating = this.info.rating === null ? "" : String(this.info.rating);
    this.finished = this.info.finished;
    this.isbn = this.info.isbn;
    this.coverPath = this.info.cover || record.cover;
  }

  override onOpen(): void {
    this.openState = true;
    this.modalEl.addClass("seiton-book-modal");
    this.modalEl.addClass("seiton-book-detail-modal");
    this.setTitle("本の詳細");

    this.contentEl.createEl("p", {
      cls: "seiton-book-hint",
      text: "タイトルを変更してもファイル名は変わりません。本文は感想・引用メモとしてそのまま残します。",
    });

    this.coverEl = this.contentEl.createDiv({ cls: "seiton-book-cover" });
    this.renderCover();
    this.renderBib();
    this.renderFields();
    this.renderActions();
    this.calilEl = this.contentEl.createDiv({ cls: "seiton-book-calil" });
    this.calilSummary = calilSummaryFromFrontmatter(this.record.frontmatter);
    this.renderCalilSaved();
    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-book-modal-status",
    });
    this.renderFooter();
    void this.loadBody();
  }

  override onClose(): void {
    this.openState = false;
    this.statusEl = null;
    this.coverEl = null;
    this.calilEl = null;
    this.memoInput = null;
    this.saveButton = null;
    this.coverButton = null;
    this.calilButton = null;
    this.busy = false;
  }

  private renderBib(): void {
    const bib = this.contentEl.createDiv({ cls: "seiton-book-bib" });
    const rows: [string, string][] = [
      ["ISBN", this.isbn === "" ? "未登録" : this.isbn],
      ["出版社", this.publisher],
      ["出版日", this.info.published],
      ["シリーズ", this.series],
    ];
    for (const [label, value] of rows) {
      if (label !== "ISBN" && value.trim() === "") {
        continue;
      }
      const line = bib.createDiv({ cls: "seiton-book-bib-line" });
      line.createSpan({ cls: "seiton-book-bib-label", text: label });
      line.createSpan({ text: value.trim() === "" ? "—" : value });
    }
  }

  private renderCover(): void {
    const container = this.coverEl;
    if (!container) {
      return;
    }
    container.empty();
    if (this.coverPath === "") {
      const fallback = container.createDiv({
        cls: "seiton-book-cover-fallback",
      });
      fallback.createDiv({
        cls: "seiton-book-cover-fallback-title",
        text: this.title,
      });
      fallback.createDiv({
        cls: "seiton-book-cover-fallback-note",
        text: "表紙なし",
      });
      return;
    }
    container.createEl("img", {
      attr: {
        alt: `${this.title} の表紙`,
        src: this.app.vault.adapter.getResourcePath(this.coverPath),
      },
      cls: "seiton-book-cover-image",
    });
    container.createDiv({
      cls: "seiton-book-cover-name",
      text: coverNameOf(this.coverPath),
    });
  }

  private renderFields(): void {
    const titleSetting = new Setting(this.contentEl).setName("タイトル");
    titleSetting.settingEl.addClass("seiton-book-field");
    titleSetting.addText((text) => {
      text.inputEl.addClass("seiton-book-title");
      text.setValue(this.title).onChange((value) => {
        this.title = value;
        this.setStatus("");
      });
    });

    const authorsSetting = new Setting(this.contentEl).setName("著者");
    authorsSetting.settingEl.addClass("seiton-book-field");
    authorsSetting.addText((text) => {
      text.setValue(this.authors).onChange((value) => {
        this.authors = value;
      });
    });

    const publisherSetting = new Setting(this.contentEl).setName("出版社");
    publisherSetting.settingEl.addClass("seiton-book-field");
    publisherSetting.addText((text) => {
      text.setValue(this.publisher).onChange((value) => {
        this.publisher = value;
      });
    });

    const categorySetting = new Setting(this.contentEl).setName("カテゴリ");
    categorySetting.settingEl.addClass("seiton-book-field");
    categorySetting.addText((text) => {
      text
        .setPlaceholder("例: 技術書")
        .setValue(this.category)
        .onChange((value) => {
          this.category = value;
        });
    });

    const seriesSetting = new Setting(this.contentEl).setName("シリーズ");
    seriesSetting.settingEl.addClass("seiton-book-field");
    seriesSetting.addText((text) => {
      text.setValue(this.series).onChange((value) => {
        this.series = value;
      });
    });

    const statusSetting = new Setting(this.contentEl).setName("読書状態");
    statusSetting.settingEl.addClass("seiton-book-field");
    statusSetting.addDropdown((dropdown) => {
      dropdown.addOption("", "未設定");
      for (const value of READING_STATUSES) {
        dropdown.addOption(value, READING_STATUS_LABELS[value]);
      }
      dropdown.setValue(this.status);
      dropdown.onChange((value) => {
        this.status = value === "" ? "" : (parseReadingStatus(value) ?? "");
      });
    });

    const ownershipSetting = new Setting(this.contentEl).setName("所有");
    ownershipSetting.settingEl.addClass("seiton-book-field");
    ownershipSetting.addDropdown((dropdown) => {
      dropdown.addOption("", "未設定");
      for (const value of BOOK_OWNERSHIPS) {
        dropdown.addOption(value, BOOK_OWNERSHIP_LABELS[value]);
      }
      if (
        this.ownership !== "" &&
        !(BOOK_OWNERSHIPS as readonly string[]).includes(this.ownership)
      ) {
        // 旧データの未知の値を勝手に消さない。
        dropdown.addOption(this.ownership, this.ownership);
      }
      dropdown.setValue(this.ownership);
      dropdown.onChange((value) => {
        this.ownership = value;
      });
    });

    const ratingSetting = new Setting(this.contentEl).setName("評価");
    ratingSetting.settingEl.addClass("seiton-book-field");
    ratingSetting.addDropdown((dropdown) => {
      dropdown.addOption(RATING_NONE, "なし");
      for (let value = 1; value <= 5; value += 1) {
        dropdown.addOption(String(value), ratingStars(value));
      }
      dropdown.setValue(this.rating);
      dropdown.onChange((value) => {
        this.rating = value;
      });
    });

    const finishedSetting = new Setting(this.contentEl)
      .setName("読了日")
      .setDesc("YYYY-MM-DD");
    finishedSetting.settingEl.addClass("seiton-book-field");
    finishedSetting.addText((text) => {
      text
        .setPlaceholder("2026-10-26")
        .setValue(this.finished)
        .onChange((value) => {
          this.finished = value;
        });
    });

    const memoSetting = new Setting(this.contentEl)
      .setName("メモ")
      .setDesc("感想・引用など。ノート本文として保存します。");
    memoSetting.settingEl.addClass("seiton-book-field");
    memoSetting.addTextArea((textarea) => {
      this.memoInput = textarea;
      textarea.inputEl.addClass("seiton-book-memo");
      textarea.inputEl.rows = 6;
      textarea.setPlaceholder("感想・引用メモ").onChange((value) => {
        this.memo = value;
      });
    });
  }

  private renderActions(): void {
    const actions = this.contentEl.createDiv({ cls: "seiton-book-actions" });
    this.coverButton = new ButtonComponent(actions)
      .setButtonText("表紙取得")
      .onClick(() => {
        void this.downloadCover();
      });
    this.calilButton = new ButtonComponent(actions)
      .setButtonText("カーリル照会")
      .onClick(() => {
        void this.searchCalil();
      });
    new ButtonComponent(actions).setButtonText("ノートを開く").onClick(() => {
      void this.app.workspace.openLinkText(this.record.path, "", false);
    });
  }

  private renderFooter(): void {
    const footer = this.contentEl.createDiv({
      cls: "seiton-book-modal-footer",
    });
    new ButtonComponent(footer)
      .setButtonText("閉じる")
      .onClick(() => this.close());
    this.saveButton = new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        void this.save();
      });

    this.scope.register(["Mod"], "Enter", (event) => {
      event.preventDefault();
      void this.save();
      return false;
    });
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.saveButton?.setDisabled(busy);
    this.coverButton?.setDisabled(busy);
    this.calilButton?.setDisabled(busy);
  }

  private async loadBody(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.record.path);
    if (!(file instanceof TFile)) {
      return;
    }
    try {
      const content = await this.app.vault.cachedRead(file);
      if (!this.openState) {
        return;
      }
      const body = stripCoverEmbed(
        trimBookBody(bodyAfterFrontmatter(content)),
        this.coverPath
      );
      const edited = this.memo !== this.initialMemo;
      this.initialMemo = body;
      if (!edited) {
        this.memo = body;
        this.memoInput?.setValue(body);
      }
    } catch {
      this.setStatus("本文を読み込めませんでした。", true);
    }
  }

  private async downloadCover(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!isValidIsbn(this.isbn)) {
      this.setStatus(
        "ISBNがないため表紙を取得できません。ISBNを登録してください。",
        true
      );
      return;
    }
    this.setBusy(true);
    this.setStatus("表紙を取得中…");
    try {
      const result = await this.bookService.fetchCover(
        this.isbn,
        undefined,
        this.title
      );
      if (!result.downloaded) {
        this.setStatus(result.error ?? "表紙を取得できませんでした。", true);
        return;
      }
      await this.bookService.updateBook(this.record.path, {
        cover: result.path,
      });
      this.coverPath = result.path;
      this.renderCover();
      this.setStatus(`表紙を保存しました: ${result.path}`);
      try {
        this.options.onSaved?.();
      } catch (error) {
        console.error("[Seiton] book saved callback failed", error);
      }
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
    } finally {
      this.setBusy(false);
    }
  }

  private async searchCalil(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (!isValidIsbn(this.isbn)) {
      this.setStatus(
        "ISBNがないためカーリルを照会できません。ISBNを登録してください。",
        true
      );
      return;
    }
    this.setBusy(true);
    this.setStatus("カーリルを照会中…");
    this.renderCalilMessage("カーリルに問い合わせています…");
    try {
      const result = await this.bookService.searchCalil(this.isbn);
      this.renderCalilResult(result);
      this.calilSummary = summarizeCalil({
        branches: result.branches,
        checkedAt: result.fetchedAt,
        library: result.configuredLibrary,
      });
      if (this.isbn !== "") {
        await this.bookService.saveCalilState(
          this.record.path,
          this.isbn,
          this.calilSummary,
          result.branches
        );
      }
      this.setStatus(
        `カーリルを照会し、本棚に反映しました（${result.fetchedAt} 時点）`
      );
    } catch (error) {
      const message = userMessageOf(error);
      this.renderCalilMessage(message, true);
      this.setStatus(message, true);
    } finally {
      this.setBusy(false);
    }
  }

  /** frontmatter に保存されている「前回の結果」と、保存済みの館を出す。 */
  private renderCalilSaved(): void {
    const container = this.calilEl;
    if (!container) {
      return;
    }
    container.empty();
    const top = container.createDiv({ cls: "seiton-book-calil-top" });
    top.createDiv({ cls: "seiton-book-calil-title", text: "蔵書を調べる" });

    const line = container.createDiv({ cls: "seiton-calil-saved" });
    line.createSpan({
      cls: `seiton-calil-badge is-${this.calilSummary.state}`,
      text: calilBadgeText(this.calilSummary, new Date()),
    });
    if (this.calilSummary.checkedAt === "") {
      line.createSpan({
        cls: "seiton-calil-saved-note",
        text: " まだ調べていません。「カーリル照会」で確認できます",
      });
      return;
    }
    line.createSpan({
      cls: "seiton-calil-saved-note",
      text: ` ${this.calilSummary.hits}館が貸出可 / 調べた${this.calilSummary.total}館 · 最終確認 ${calilCheckedLabel(this.calilSummary.checkedAt)}`,
    });
    void this.renderCalilBranches();
  }

  /** 保存済みの館を、貸出可の順に数件だけ出す。 */
  private async renderCalilBranches(): Promise<void> {
    if (this.isbn === "") {
      return;
    }
    const branches = await this.bookService.readCalilDetail(this.isbn);
    const container = this.calilEl;
    if (!branches || branches.length === 0 || !container) {
      return;
    }
    const available = branches.filter((branch) =>
      branch.state.includes("貸出可")
    );
    const shown = (available.length > 0 ? available : branches).slice(0, 3);
    const list = container.createDiv({ cls: "seiton-calil-branches" });
    for (const branch of shown) {
      const row = list.createDiv({ cls: "seiton-calil-branch" });
      row.createSpan({
        cls: "seiton-calil-branch-name",
        text: branch.formal || branch.systemname || branch.systemid,
      });
      row.createSpan({
        cls: "seiton-calil-branch-state",
        text: branch.state,
      });
    }
    const rest = branches.length - shown.length;
    if (rest > 0) {
      list.createDiv({
        cls: "seiton-calil-saved-note",
        text: `ほか${rest}館（カーリルで見る）`,
      });
    }
  }

  private renderCalilMessage(message: string, isError = false): void {
    const container = this.calilEl;
    if (!container) {
      return;
    }
    container.empty();
    const line = container.createDiv({
      cls: "seiton-book-calil-message",
      text: message,
    });
    line.toggleClass("is-error", isError);
  }

  private renderCalilResult(result: CalilSearchResult): void {
    const container = this.calilEl;
    if (!container) {
      return;
    }
    container.empty();

    const top = container.createDiv({ cls: "seiton-book-calil-top" });
    top.createDiv({ cls: "seiton-book-calil-title", text: "蔵書を調べる" });
    const bookLink = top.createEl("a", {
      cls: "seiton-book-calil-link",
      href: calilBookUrl(result.isbn),
      text: "カーリルで見る",
    });
    bookLink.setAttr("rel", "noopener noreferrer");
    bookLink.setAttr("target", "_blank");

    container.createDiv({
      cls: "seiton-book-calil-meta",
      text: `取得日時: ${result.fetchedAt}（この端末の時刻）`,
    });
    container.createDiv({
      cls: "seiton-book-calil-notice",
      text: result.notice === "" ? CALIL_TIME_DEPENDENT_NOTICE : result.notice,
    });
    if (result.continuePending) {
      container.createDiv({
        cls: "seiton-book-calil-pending",
        text: "カーリル側で検索が続いています。時間をおいて再照会してください。",
      });
    }

    const best = calilBestBranch(result.branches);
    if (!best) {
      container.createDiv({
        cls: "seiton-book-calil-empty",
        text: "設定した図書館には見つかりませんでした。",
      });
      return;
    }

    const summary = container.createDiv({ cls: "seiton-book-calil-summary" });
    summary.createDiv({
      cls: "seiton-book-calil-summary-place",
      text: `${best.formal || best.libkey}で${best.state}`,
    });
    if (best.address !== "") {
      summary.createDiv({
        cls: "seiton-book-calil-address",
        text: best.address,
      });
    }
    const actions = summary.createDiv({ cls: "seiton-book-calil-actions" });
    this.calilLink(actions, calilLibraryPageUrl(best), "カーリル");
    this.calilLink(actions, calilMapUrl(best), "地図");
    if (best.reserveUrl !== "") {
      this.calilLink(actions, best.reserveUrl, "予約");
    }

    const rest = result.branches.filter((branch) => branch !== best);
    if (rest.length > 0) {
      const details = container.createEl("details", {
        cls: "seiton-book-calil-details",
      });
      details.createEl("summary", {
        text: `ほか${rest.length}館を表示`,
      });
      const list = details.createDiv({ cls: "seiton-book-calil-list" });
      for (const branch of rest) {
        this.renderCalilBranch(list, branch);
      }
    }
  }

  private renderCalilBranch(parent: HTMLElement, branch: CalilBranch): void {
    const item = parent.createDiv({ cls: "seiton-book-calil-branch" });
    const head = item.createDiv({ cls: "seiton-book-calil-branch-head" });
    head.createSpan({
      cls: "seiton-book-calil-system",
      text: branch.systemname,
    });
    if (branch.configured) {
      head.createSpan({
        cls: "seiton-book-calil-configured",
        text: "設定した図書館",
      });
    }
    head.createSpan({
      cls: "seiton-book-calil-state",
      text: branch.libkey ? `${branch.libkey}: ${branch.state}` : branch.state,
    });

    if (branch.formal !== "" && branch.formal !== branch.libkey) {
      item.createDiv({ cls: "seiton-book-calil-library", text: branch.formal });
    }
    if (branch.address !== "") {
      item.createDiv({
        cls: "seiton-book-calil-address",
        text: branch.address,
      });
    }
    const actions = item.createDiv({ cls: "seiton-book-calil-actions" });
    this.calilLink(actions, calilLibraryPageUrl(branch), "カーリル");
    this.calilLink(actions, calilMapUrl(branch), "地図");
    if (branch.reserveUrl !== "") {
      this.calilLink(actions, branch.reserveUrl, "予約");
    }
  }

  private calilLink(parent: HTMLElement, href: string, label: string): void {
    if (!isAllowedRemoteUrl(href)) {
      return;
    }
    const link = parent.createEl("a", {
      cls: "seiton-book-calil-link",
      href,
      text: label,
    });
    link.setAttr("rel", "noopener noreferrer");
    link.setAttr("target", "_blank");
  }

  private async save(): Promise<void> {
    if (this.busy) {
      return;
    }
    const title = this.title.trim();
    if (title === "") {
      this.setStatus("タイトルを入力してください。", true);
      return;
    }

    this.setBusy(true);
    this.setStatus("保存中…");
    try {
      const patch: BookPatch = {
        authors: this.authors.trim() === "" ? null : this.authors,
        category: this.category,
        finished: this.finished,
        ownership: this.ownership,
        publisher: this.publisher,
        rating: this.rating,
        readingStatus: this.status,
        series: this.series,
        title,
      };
      await this.bookService.updateBook(this.record.path, patch);

      if (this.memo !== this.initialMemo) {
        await this.saveBody();
      }

      try {
        this.options.onSaved?.();
      } catch (error) {
        console.error("[Seiton] book saved callback failed", error);
      }
      new Notice("本を更新しました。");
      this.close();
    } catch (error) {
      this.setBusy(false);
      this.setStatus(userMessageOf(error), true);
    }
  }

  private async saveBody(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.record.path);
    if (!(file instanceof TFile)) {
      throw new Error(`本のノートがありません: ${this.record.path}`);
    }
    await this.app.vault.process(file, (data) =>
      replaceBookBody(data, withCoverEmbed(this.memo, this.coverPath))
    );
    this.initialMemo = this.memo;
  }
}

// ---------------------------------------------------------------------------
// 一括編集
// ---------------------------------------------------------------------------

export interface BookBulkEditModalOptions {
  onApplied?: (updated: number, failed: number) => void;
}

export class BookBulkEditModal extends Modal {
  private readonly bookService: BookService;
  private readonly records: NoteRecord[];
  private readonly options: BookBulkEditModalOptions;
  private status: ReadingStatus | "" = "";
  private category = "";
  private categoryEnabled = false;
  private statusEl: HTMLElement | null = null;
  private categoryText: TextComponent | null = null;
  private applyButton: ButtonComponent | null = null;
  private busy = false;

  constructor(
    app: App,
    bookService: BookService,
    records: NoteRecord[],
    options: BookBulkEditModalOptions = {}
  ) {
    super(app);
    this.bookService = bookService;
    this.records = records;
    this.options = options;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-book-modal");
    this.modalEl.addClass("seiton-book-bulk-modal");
    this.setTitle("表示中の本を一括編集");

    this.contentEl.createEl("p", {
      cls: "seiton-book-bulk-summary",
      text: `表示中の${this.records.length}冊が対象です。変更する項目だけを指定してください。`,
    });

    const titles = this.contentEl.createDiv({
      cls: "seiton-book-bulk-titles",
    });
    for (const record of this.records.slice(0, 8)) {
      titles.createDiv({
        cls: "seiton-book-bulk-title",
        text: record.title,
      });
    }
    if (this.records.length > 8) {
      titles.createDiv({
        cls: "seiton-book-bulk-more",
        text: `ほか ${this.records.length - 8} 冊`,
      });
    }

    const statusSetting = new Setting(this.contentEl).setName("読書状態");
    statusSetting.settingEl.addClass("seiton-book-field");
    statusSetting.addDropdown((dropdown) => {
      dropdown.addOption("", "変更しない");
      for (const value of READING_STATUSES) {
        dropdown.addOption(value, READING_STATUS_LABELS[value]);
      }
      dropdown.setValue("");
      dropdown.onChange((value) => {
        this.status = value === "" ? "" : (parseReadingStatus(value) ?? "");
        this.setStatus("");
      });
    });

    const categoryToggle = new Setting(this.contentEl)
      .setName("カテゴリを変更する")
      .setDesc("空にするとカテゴリを削除します。");
    categoryToggle.settingEl.addClass("seiton-book-field");
    categoryToggle.addToggle((toggle) => {
      toggle.setValue(false).onChange((value) => {
        this.categoryEnabled = value;
        this.categoryText?.setDisabled(!value);
        this.setStatus("");
      });
    });

    const categorySetting = new Setting(this.contentEl).setName("カテゴリ");
    categorySetting.settingEl.addClass("seiton-book-field");
    categorySetting.addText((text) => {
      this.categoryText = text;
      text.setPlaceholder("例: 技術書");
      text.setDisabled(true);
      text.onChange((value) => {
        this.category = value;
      });
    });

    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-book-modal-status",
    });

    const footer = this.contentEl.createDiv({
      cls: "seiton-book-modal-footer",
    });
    new ButtonComponent(footer)
      .setButtonText("キャンセル")
      .onClick(() => this.close());
    this.applyButton = new ButtonComponent(footer)
      .setButtonText(`${this.records.length}冊を一括変更`)
      .setCta()
      .onClick(() => {
        void this.apply();
      });
  }

  override onClose(): void {
    this.statusEl = null;
    this.categoryText = null;
    this.applyButton = null;
    this.busy = false;
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }

  private async apply(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (this.status === "" && !this.categoryEnabled) {
      this.setStatus("変更する項目を選んでください。", true);
      return;
    }

    const patch: BookPatch = {};
    if (this.status !== "") {
      patch.readingStatus = this.status;
    }
    if (this.categoryEnabled) {
      patch.category = this.category;
    }

    this.busy = true;
    this.applyButton?.setDisabled(true);
    this.setStatus(
      `${this.records.length}冊を一括変更中…（1冊ずつ保存します）`
    );

    let updated = 0;
    const failures: string[] = [];
    for (const record of this.records) {
      try {
        await this.bookService.updateBook(record.path, patch);
        updated += 1;
      } catch (error) {
        failures.push(`${record.title}: ${userMessageOf(error)}`);
      }
    }

    this.busy = false;
    try {
      this.options.onApplied?.(updated, failures.length);
    } catch (error) {
      console.error("[Seiton] book bulk callback failed", error);
    }

    if (failures.length > 0) {
      this.applyButton?.setDisabled(false);
      this.setStatus(
        `${updated}冊を更新し、${failures.length}冊は失敗しました。${failures
          .slice(0, 3)
          .join(" / ")}`,
        true
      );
      new Notice(
        `一括変更: ${updated}冊を更新、${failures.length}冊は失敗しました。`
      );
      return;
    }

    new Notice(`${updated}冊を一括変更しました。`);
    this.close();
  }
}
