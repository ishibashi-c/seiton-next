import type { App } from "obsidian";
import { Modal } from "obsidian";
import {
  parseReadingStatus,
  READING_STATUS_LABELS,
  READING_STATUSES,
  type ReadingStatus,
} from "../../domain/book";
import { userMessageOf } from "../../domain/errors";
import type { BookPatch, BookService } from "../../services/bookService";
import type { NoteRecord } from "../../services/vaultIndex";
import { markSeitonModal } from "../ui/modal";
import { ButtonComponent, Setting, type TextComponent } from "../ui/setting";
import { showToast } from "../ui/toast";

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
    markSeitonModal(this);
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
      showToast(
        `一括変更: ${updated}冊を更新、${failures.length}冊は失敗しました。`
      );
      return;
    }

    showToast(`${updated}冊を一括変更しました。`);
    this.close();
  }
}
