import type { App } from "obsidian";
import { Modal } from "obsidian";
import {
  parseReadingStatus,
  READING_STATUS_LABELS,
  READING_STATUSES,
  type ReadingStatus,
} from "../../domain/book";
import { userMessageOf } from "../../domain/errors";
import { isValidIsbn, normalizeIsbn } from "../../domain/isbn";
import type { BookService, CreateBookResult } from "../../services/bookService";
import { markSeitonModal } from "../ui/modal";
import { ButtonComponent, Setting, type TextComponent } from "../ui/setting";
import { showToast } from "../ui/toast";
import { BarcodeScannerModal } from "./barcodeScannerModal";

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
    markSeitonModal(this);
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
    isbnSetting.addButton((button) => {
      button
        .setButtonText("スキャン")
        .setTooltip("バーコードをカメラで読み取る")
        .onClick(() => {
          new BarcodeScannerModal(this.app, this.bookService, {
            onScanSingle: (scannedIsbn) => {
              this.isbn = scannedIsbn;
              this.isbnText?.setValue(scannedIsbn);
              void this.lookup();
            },
            single: true,
          }).open();
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
      showToast(message);
      this.close();
    } catch (error) {
      this.setBusy(false);
      this.setStatus(userMessageOf(error), true);
    }
  }
}
