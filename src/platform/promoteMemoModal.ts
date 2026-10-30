/**
 * 一言メモを独立ノートへ昇格する。元の本文は週次ファイルに残し、
 * 昇格先へのリンクだけを追記する（失敗時も元メモを失わない）。
 */

import type { App } from "obsidian";
import {
  ButtonComponent,
  Component,
  MarkdownRenderer,
  Modal,
  Setting,
  type TextComponent,
} from "obsidian";
import { userMessageOf } from "../domain/errors";
import { titleFromMemoBody } from "../domain/notes";
import type {
  MemoListItem,
  MemoService,
  PromoteMemoResult,
} from "../services/memoService";

const KIND_OPTIONS: Record<string, string> = {
  class: "授業",
  collection: "コレクション",
  idea: "アイデア",
  note: "ノート",
  reading: "読書",
};

export class PromoteMemoModal extends Modal {
  private readonly memoService: MemoService;
  private readonly item: MemoListItem;
  private readonly onPromoted: (result: PromoteMemoResult) => void;
  private title: string;
  private kind = "idea";
  private statusEl: HTMLElement | null = null;
  private submitButton: ButtonComponent | null = null;
  private previewComponent: Component | null = null;
  private busy = false;

  constructor(
    app: App,
    memoService: MemoService,
    item: MemoListItem,
    onPromoted: (result: PromoteMemoResult) => void
  ) {
    super(app);
    this.memoService = memoService;
    this.item = item;
    this.onPromoted = onPromoted;
    this.title = titleFromMemoBody(item.entry.body);
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-promote-modal");
    this.setTitle("ノート化");

    this.contentEl.createEl("p", {
      cls: "seiton-promote-description",
      text: "新しいMarkdownノートを作成し、元のメモにはリンクを追記します。元の本文は消しません。",
    });

    new Setting(this.contentEl)
      .setName("ノート名")
      .setDesc("空にすると本文の先頭から自動で付けます。")
      .addText((text: TextComponent) => {
        text.setValue(this.title).onChange((value) => {
          this.title = value;
        });
      });

    new Setting(this.contentEl)
      .setName("種類")
      .setDesc("kind プロパティの初期値です。")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions(KIND_OPTIONS)
          .setValue(this.kind)
          .onChange((value) => {
            this.kind = value;
          });
      });

    const preview = this.contentEl.createDiv({
      cls: "seiton-promote-preview",
    });
    preview.createDiv({
      cls: "seiton-promote-preview-label",
      text: "本文プレビュー",
    });
    this.previewComponent = new Component();
    this.previewComponent.load();
    void MarkdownRenderer.render(
      this.app,
      this.item.entry.body,
      preview,
      this.item.path,
      this.previewComponent
    ).catch(() => {
      preview.setText(this.item.entry.body);
    });

    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    new ButtonComponent(footer)
      .setButtonText("キャンセル")
      .onClick(() => this.close());
    this.submitButton = new ButtonComponent(footer)
      .setButtonText("作成する")
      .setCta()
      .onClick(() => {
        void this.submit();
      });
  }

  override onClose(): void {
    this.previewComponent?.unload();
    this.previewComponent = null;
    this.statusEl = null;
    this.submitButton = null;
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.submitButton?.setDisabled(true);
    this.setStatus("作成中…");

    let result: PromoteMemoResult;
    try {
      result = await this.memoService.promoteMemo({
        id: this.item.entry.id,
        kind: this.kind,
        title: this.title,
        week: this.item.week,
      });
    } catch (error) {
      this.busy = false;
      this.submitButton?.setDisabled(false);
      this.setStatus(userMessageOf(error), true);
      return;
    }

    this.busy = false;
    try {
      this.onPromoted(result);
    } catch (error) {
      console.error("[Seiton] promote callback failed", error);
    }
    this.close();
  }
}
