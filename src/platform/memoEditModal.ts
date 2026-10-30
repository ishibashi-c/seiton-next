/**
 * 既存の一言メモを編集・ソフト削除・復元するモーダル。
 */

import type { App } from "obsidian";
import { ButtonComponent, Modal, TextAreaComponent } from "obsidian";
import { userMessageOf } from "../domain/errors";
import type { MemoListItem, MemoService } from "../services/memoService";

export class MemoEditModal extends Modal {
  private readonly memoService: MemoService;
  private readonly item: MemoListItem;
  private readonly onChanged: () => void;
  private value: string;
  private statusEl: HTMLElement | null = null;
  private saveButton: ButtonComponent | null = null;
  private deleteButton: ButtonComponent | null = null;
  private busy = false;

  constructor(
    app: App,
    memoService: MemoService,
    item: MemoListItem,
    onChanged: () => void
  ) {
    super(app);
    this.memoService = memoService;
    this.item = item;
    this.onChanged = onChanged;
    this.value = item.entry.body;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-edit-modal");
    this.setTitle("メモを編集");

    const meta = this.contentEl.createDiv({ cls: "seiton-edit-meta" });
    meta.createSpan({
      text: `${this.item.week} / ${this.item.entry.at.replace("T", " ")}`,
    });
    meta.createSpan({
      cls: "seiton-id-label",
      text: `ID: ${this.item.entry.id}`,
    });

    if (this.item.entry.promotedTo) {
      this.contentEl.createEl("p", {
        cls: "seiton-edit-note",
        text: "このメモはノート化済みです。ここでの編集は週次メモ側だけに反映されます。",
      });
    }

    const textarea = new TextAreaComponent(this.contentEl);
    textarea.inputEl.addClass("seiton-edit-textarea");
    textarea.inputEl.rows = 10;
    textarea.inputEl.spellcheck = false;
    textarea.setValue(this.value);
    textarea.onChange((next) => {
      this.value = next;
      this.setStatus("");
    });

    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    footer.createSpan({
      cls: "seiton-keyhint",
      text: "⌘/Ctrl + Enter で保存",
    });

    this.deleteButton = new ButtonComponent(footer)
      .setButtonText(
        this.item.entry.state === "deleted" ? "復元" : "削除（復元できます）"
      )
      .onClick(() => {
        void this.toggleDeleted();
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
      if (this.containerEl.isConnected) {
        textarea.inputEl.focus();
      }
    }, 40);
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
    this.deleteButton?.setDisabled(busy);
  }

  private async save(): Promise<void> {
    if (this.busy) {
      return;
    }
    if (this.value.trim() === "") {
      this.setStatus("空の本文には更新できません。");
      return;
    }

    this.setBusy(true);
    this.setStatus("保存中…");
    try {
      await this.memoService.updateMemoBody(
        this.item.week,
        this.item.entry.id,
        this.value
      );
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
      this.setBusy(false);
      return;
    }

    this.setBusy(false);
    try {
      this.onChanged();
    } catch (error) {
      console.error("[Seiton] edit callback failed", error);
    }
    this.close();
  }

  private async toggleDeleted(): Promise<void> {
    if (this.busy) {
      return;
    }
    const restore = this.item.entry.state === "deleted";
    this.setBusy(true);
    this.setStatus(restore ? "復元中…" : "削除中…");
    try {
      await this.memoService.setMemoDeleted(
        this.item.week,
        this.item.entry.id,
        !restore
      );
    } catch (error) {
      this.setStatus(userMessageOf(error), true);
      this.setBusy(false);
      return;
    }

    this.setBusy(false);
    try {
      this.onChanged();
    } catch (error) {
      console.error("[Seiton] delete callback failed", error);
    }
    this.close();
  }
}
