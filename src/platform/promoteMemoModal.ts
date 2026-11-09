/**
 * 一言メモを独立ノートへ昇格する。元の本文は週次ファイルに残し、
 * 昇格先へのリンクだけを追記する（失敗時も元メモを失わない）。
 */

import type { App } from "obsidian";
import { Component, MarkdownRenderer, Modal, type TFile } from "obsidian";
import { SYSTEM_FOLDER } from "../config";
import { userMessageOf } from "../domain/errors";
import { titleFromMemoBody } from "../domain/notes";
import { normalizeNewlines } from "../domain/text";
import { clockOf, dateKeyOf } from "../domain/time";
import type {
  MemoListItem,
  MemoService,
  PromoteMemoResult,
} from "../services/memoService";
import { buildSeitonModal, markSeitonModal } from "./ui/modal";
import { ButtonComponent, Setting, type TextComponent } from "./ui/setting";
import { showToast } from "./ui/toast";

const KIND_OPTIONS: Record<string, string> = {
  class: "授業",
  collection: "コレクション",
  idea: "アイデア",
  note: "ノート",
  reading: "読書",
};

export class PromoteMemoModal extends Modal {
  private readonly memoService: MemoService;
  private readonly items: MemoListItem[];
  private readonly onPromoted: (result: PromoteMemoResult | TFile) => void;
  private title: string;
  private kind = "idea";
  private statusEl: HTMLElement | null = null;
  private submitButton: ButtonComponent | null = null;
  private previewComponent: Component | null = null;
  private busy = false;

  constructor(
    app: App,
    memoService: MemoService,
    itemOrItems: MemoListItem | MemoListItem[],
    onPromoted: (result: PromoteMemoResult | TFile) => void
  ) {
    super(app);
    this.memoService = memoService;
    this.items = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    this.onPromoted = onPromoted;
    if (this.items.length === 1 && this.items[0]) {
      this.title = titleFromMemoBody(this.items[0].entry.body);
    } else {
      const first = this.items[0];
      const dateKey = first ? dateKeyOf(first.entry.at) : "";
      this.title = dateKey ? `まとめ ${dateKey}` : "まとめノート";
    }
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-promote-modal");
    const isMultiple = this.items.length > 1;
    this.setTitle(
      isMultiple ? `まとめノート化（${this.items.length}件）` : "ノート化"
    );

    this.contentEl.createEl("p", {
      cls: "seiton-promote-description",
      text: isMultiple
        ? `${this.items.length}件のつぶやきを結合した新しいMarkdownノートを作成し、元のメモにはリンクを追記します。元の本文は消しません。`
        : "新しいMarkdownノートを作成し、元のメモにはリンクを追記します。元の本文は消しません。",
    });

    new Setting(this.contentEl)
      .setName("ノート名")
      .setDesc("空にすると自動で付けます。")
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

    const previewText = isMultiple
      ? [...this.items]
          .sort((a, b) => a.entry.at.localeCompare(b.entry.at))
          .map((item) => {
            const date = dateKeyOf(item.entry.at) || "日付不明";
            const time = clockOf(item.entry.at) || "時刻不明";
            const lines = normalizeNewlines(item.entry.body).split("\n");
            const indented = lines
              .map((line, idx) => (idx === 0 ? line : `  ${line}`))
              .join("\n");
            return `- **${date} ${time}**\n  ${indented}`;
          })
          .join("\n\n")
      : (this.items[0]?.entry.body ?? "");

    const previewPath = this.items[0]?.path ?? "";
    void MarkdownRenderer.render(
      this.app,
      previewText,
      preview,
      previewPath,
      this.previewComponent
    ).catch(() => {
      preview.setText(previewText);
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

    let result: PromoteMemoResult | TFile;
    try {
      if (this.items.length === 1 && this.items[0]) {
        result = await this.memoService.promoteMemo({
          id: this.items[0].entry.id,
          kind: this.kind,
          title: this.title,
          week: this.items[0].week,
        });
      } else {
        result = await this.memoService.promoteMultipleMemos(
          this.items.map((i) => i.entry),
          { kind: this.kind, title: this.title }
        );
      }
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

/** 既存ノートを選択してメモを追記するモーダル */
export class AppendToNoteModal extends Modal {
  private readonly memoService: MemoService;
  private readonly item: MemoListItem;
  private readonly onAppended: () => void;

  constructor(
    app: App,
    memoService: MemoService,
    item: MemoListItem,
    onAppended: () => void
  ) {
    super(app);
    this.memoService = memoService;
    this.item = item;
    this.onAppended = onAppended;
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description: "追記先のノートを選択してください",
      title: "既存ノートへ追記",
    });
    this.modalEl.addClass("seiton-append-modal");

    const searchInput = body.createEl("input", {
      attr: {
        placeholder: "追記先のノートを検索…",
        type: "search",
      },
      cls: "st-input seiton-context-picker-search",
    });

    const listEl = body.createDiv({ cls: "seiton-context-picker-list" });

    const allFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => !file.path.startsWith(`${SYSTEM_FOLDER}/`))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const renderList = (filterQuery: string) => {
      listEl.empty();
      const q = filterQuery.toLowerCase().trim();
      const filtered =
        q === ""
          ? allFiles.slice(0, 30)
          : allFiles
              .filter(
                (f) =>
                  f.basename.toLowerCase().includes(q) ||
                  f.path.toLowerCase().includes(q)
              )
              .slice(0, 30);

      if (filtered.length === 0) {
        listEl.createDiv({
          cls: "seiton-empty",
          text: "一致するノートがありません。",
        });
        return;
      }

      for (const file of filtered) {
        const row = listEl.createEl("button", {
          attr: { type: "button" },
          cls: "seiton-session-row seiton-context-picker-row",
        });
        const head = row.createDiv({ cls: "seiton-session-row-head" });
        head.createSpan({
          cls: "seiton-session-row-title",
          text: file.basename,
        });
        row.createDiv({ cls: "seiton-session-row-meta", text: file.path });
        row.addEventListener("click", () => {
          void this.chooseItem(file);
        });
      }
    };

    searchInput.addEventListener("input", () => {
      renderList(searchInput.value);
    });

    renderList("");
    window.setTimeout(() => searchInput.focus(), 50);

    new ButtonComponent(footer)
      .setButtonText("キャンセル")
      .onClick(() => this.close());
  }

  private async chooseItem(item: TFile): Promise<void> {
    try {
      await this.memoService.appendMemoToNote(this.item.entry, item);
      showToast(`「${item.basename}」に追記しました。`);
      this.close();
      this.onAppended();
    } catch (error) {
      showToast(userMessageOf(error));
    }
  }
}
