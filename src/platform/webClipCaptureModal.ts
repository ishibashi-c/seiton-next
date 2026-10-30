import type { App } from "obsidian";
import { Modal, TFile } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { domainOf, normalizeSourceUrl } from "../domain/network";
import type {
  WebClipCapture,
  WebClipDuplicate,
  WebClipService,
} from "../services/webClipService";
import { markSeitonModal } from "./ui/modal";
import {
  Setting,
  type TextAreaComponent,
  type TextComponent,
} from "./ui/setting";

import { showToast } from "./ui/toast";
export interface WebClipCaptureInput {
  capture?: string;
  note?: string;
  title?: string;
  url: string;
}

/** 共有・ブックマークレットから開く、公式Clipper風の確認画面。 */
export class WebClipCaptureModal extends Modal {
  private readonly service: WebClipService;
  private readonly input: WebClipCaptureInput;
  private readonly onSaved: (path: string) => void;
  private titleValue: string;
  private noteValue: string;
  private titleText: TextComponent | null = null;
  private noteText: TextAreaComponent | null = null;
  private bodyToggle: {
    setValue(value: boolean): void;
    setDisabled(value: boolean): void;
  } | null = null;
  private statusEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;
  private duplicate: WebClipDuplicate | null = null;
  private capture: WebClipCapture | null = null;
  private bodyText = "";
  private includeBody = true;
  private busy = false;
  private closed = false;

  constructor(
    app: App,
    service: WebClipService,
    input: WebClipCaptureInput,
    onSaved: (path: string) => void
  ) {
    super(app);
    this.service = service;
    this.input = input;
    this.onSaved = onSaved;
    this.titleValue = (input.title ?? "").trim();
    this.noteValue = (input.note ?? "").trim();
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-webclip-capture-modal");
    this.setTitle("Webクリップ");
    const url = normalizeSourceUrl(this.input.url);
    if (!url) {
      this.contentEl.createEl("p", {
        cls: "seiton-webclip-error",
        text: "http/httpsのURLだけを保存できます。",
      });
      this.renderFooter(false);
      return;
    }

    this.contentEl.createEl("p", {
      cls: "seiton-bulk-hint",
      text: "ページを取得して、タイトル・説明・本文をMarkdownで保存します。取得できない場合はURLだけで保存できます。",
    });
    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-webclip-status",
      text: "ページを確認中…",
    });
    this.statusEl.setAttribute("aria-live", "polite");

    new Setting(this.contentEl).setName("タイトル").addText((text) => {
      this.titleText = text;
      text.setValue(this.titleValue).onChange((value) => {
        this.titleValue = value;
      });
    });
    new Setting(this.contentEl)
      .setName("選択テキスト・メモ")
      .setDesc("ブックマークレットで選択した範囲、または共有時のメモ。")
      .addTextArea((text) => {
        this.noteText = text;
        text.inputEl.rows = 3;
        text.setValue(this.noteValue).onChange((value) => {
          this.noteValue = value;
        });
      });
    new Setting(this.contentEl)
      .setName("本文を保存")
      .setDesc(
        "ページ本文をMarkdownにして保存します。取得できない場合はオフになります。"
      )
      .addToggle((toggle) => {
        this.bodyToggle = toggle;
        toggle.setValue(true).onChange((value) => {
          this.includeBody = value;
        });
        toggle.setDisabled(true);
      });
    this.previewEl = this.contentEl.createDiv({
      cls: "seiton-webclip-preview",
    });
    this.renderFooter(true);
    this.setBusy(true);
    void this.load();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.titleText = null;
    this.noteText = null;
    this.bodyToggle = null;
    this.statusEl = null;
    this.previewEl = null;
    this.saveButton = null;
  }

  private renderFooter(canSave: boolean): void {
    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const cancel = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancel.addEventListener("click", () => this.close());
    this.saveButton = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "保存",
    });
    this.saveButton.disabled = !canSave;
    this.saveButton.addEventListener("click", () => {
      void this.save();
    });
  }

  private async load(): Promise<void> {
    const url = normalizeSourceUrl(this.input.url);
    if (!url) {
      return;
    }
    try {
      this.duplicate = await this.service.findDuplicate(url);
      if (this.closed) {
        return;
      }
      if (this.duplicate) {
        this.setStatus(`既にクリップがあります: ${this.duplicate.title}`);
        this.renderDuplicate();
        this.bodyToggle?.setValue(false);
        this.bodyToggle?.setDisabled(true);
        this.setBusy(false);
        return;
      }
      this.capture = await this.service.capturePage(url);
      if (this.closed) {
        return;
      }
      this.bodyText = this.capture.body;
      if (!this.titleValue && this.capture.title) {
        this.titleValue = this.capture.title;
        this.titleText?.setValue(this.titleValue);
      }
      this.setStatus(
        this.capture.body
          ? `本文 ${this.capture.body.length.toLocaleString()}文字を取得しました。`
          : "本文を抽出できませんでした。URLとタイトルだけで保存できます。"
      );
      this.bodyToggle?.setDisabled(this.capture.body === "");
      if (!this.capture.body) {
        this.bodyToggle?.setValue(false);
      }
      this.renderPreview();
      this.setBusy(false);
      if (this.duplicate) {
        this.saveButton?.setAttribute("disabled", "true");
      }
    } catch (error) {
      if (this.closed) {
        return;
      }
      this.setStatus(
        `${userMessageOf(error)} URLとタイトルだけで保存できます。`
      );
      this.bodyToggle?.setValue(false);
      this.bodyToggle?.setDisabled(true);
      this.setBusy(false);
    }
  }

  private renderDuplicate(): void {
    if (!this.duplicate || !this.previewEl) {
      return;
    }
    this.previewEl.empty();
    const box = this.previewEl.createDiv({ cls: "seiton-webclip-duplicate" });
    box.createSpan({ text: "同じURLのクリップがあります。" });
    const open = box.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "開く",
    });
    open.addEventListener("click", () => {
      const file = this.app.vault.getAbstractFileByPath(
        this.duplicate?.path ?? ""
      );
      if (file instanceof TFile) {
        this.close();
        void this.app.workspace.getLeaf(false).openFile(file);
      }
    });
  }

  private renderPreview(): void {
    const host = this.previewEl;
    if (!host || this.duplicate) {
      return;
    }
    host.empty();
    if (this.capture?.description) {
      host.createDiv({
        cls: "seiton-webclip-description",
        text: this.capture.description,
      });
    }
    const meta = [
      this.capture?.author,
      this.capture?.published,
      domainOf(this.capture?.url ?? this.input.url),
    ]
      .filter(Boolean)
      .join(" · ");
    if (meta) {
      host.createDiv({ cls: "seiton-webclip-meta", text: meta });
    }
  }

  private setBusy(value: boolean): void {
    this.busy = value;
    if (this.saveButton) {
      this.saveButton.disabled =
        value ||
        this.duplicate !== null ||
        normalizeSourceUrl(this.input.url) === null;
    }
    this.titleText?.setDisabled(value);
    this.noteText?.setDisabled(value);
  }

  private async save(): Promise<void> {
    if (this.busy || this.duplicate) {
      return;
    }
    const url = normalizeSourceUrl(this.input.url);
    if (!url) {
      return;
    }
    this.setBusy(true);
    this.setStatus("保存中…");
    try {
      const path = await this.service.createCaptureNote({
        author: this.capture?.author,
        body: this.includeBody ? this.bodyText : "",
        description: this.capture?.description,
        image: this.capture?.image,
        note: this.noteValue,
        published: this.capture?.published,
        source: url,
        tags: ["webクリップ", domainOf(url)],
        title: this.titleValue || this.capture?.title || domainOf(url),
      });
      showToast("Webクリップを保存しました。");
      this.onSaved(path);
      this.close();
    } catch (error) {
      showToast(userMessageOf(error));
      this.setStatus("保存できませんでした。");
      this.setBusy(false);
    }
  }

  private setStatus(message: string): void {
    this.statusEl?.setText(message);
  }
}
