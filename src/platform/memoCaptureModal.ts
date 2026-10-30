/**
 * 一言メモ入力モーダル。ホーム・コマンド・モバイルクイックアクションの共通入口。
 * 保存に失敗した場合は入力を保持し、その場で再試行できる。
 */

import type { App } from "obsidian";
import { ButtonComponent, Modal, Notice, TextAreaComponent } from "obsidian";
import { userMessageOf } from "../domain/errors";
import type { AddMemoResult, MemoService } from "../services/memoService";

const DEFAULT_DRAFT_KEY = "seiton-next:memo-draft";

export interface MemoCaptureModalOptions {
  /** 下書きを端末に保存するキー。 */
  draftKey?: string;
  initialValue?: string;
  onClosed?: () => void;
  onDraftChange?: (value: string) => void;
  onSaved?: (result: AddMemoResult) => void;
}

export class MemoCaptureModal extends Modal {
  private readonly memoService: MemoService;
  private readonly options: MemoCaptureModalOptions;
  private readonly draftKey: string;
  private value: string;
  private textareaEl: HTMLTextAreaElement | null = null;
  private saveButton: ButtonComponent | null = null;
  private statusEl: HTMLElement | null = null;
  private saving = false;
  private openState = false;

  constructor(
    app: App,
    memoService: MemoService,
    options: MemoCaptureModalOptions = {}
  ) {
    super(app);
    this.memoService = memoService;
    this.options = options;
    this.draftKey = options.draftKey ?? DEFAULT_DRAFT_KEY;
    const initial = options.initialValue ?? "";
    this.value = initial === "" ? readDraft(this.draftKey) : initial;
  }

  override onOpen(): void {
    this.openState = true;
    this.modalEl.addClass("seiton-capture-modal");
    this.setTitle("メモ");

    this.contentEl.createEl("p", {
      cls: "seiton-capture-hint",
      text: "タイトル・タグ・保存先は不要です。保存はこの端末のVaultへ行います。",
    });

    const textarea = new TextAreaComponent(this.contentEl);
    textarea.inputEl.addClass("seiton-capture-textarea");
    textarea.inputEl.rows = 7;
    textarea.inputEl.spellcheck = false;
    textarea.setPlaceholder("思いついたことをそのまま書く");
    textarea.setValue(this.value);
    textarea.onChange((next) => {
      this.value = next;
      writeDraft(this.draftKey, next);
      this.options.onDraftChange?.(next);
      this.setStatus("", "idle");
    });
    this.textareaEl = textarea.inputEl;

    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-modal-status",
    });

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    footer.createSpan({
      cls: "seiton-keyhint",
      text: "⌘/Ctrl + Enter で保存",
    });
    this.saveButton = new ButtonComponent(footer)
      .setButtonText("保存")
      .setCta()
      .onClick(() => {
        void this.submit();
      });

    this.scope.register(["Mod"], "Enter", (event) => {
      event.preventDefault();
      void this.submit();
      return false;
    });

    window.setTimeout(() => {
      if (!this.openState) {
        return;
      }
      this.textareaEl?.focus();
      const length = this.value.length;
      this.textareaEl?.setSelectionRange(length, length);
    }, 60);
  }

  override onClose(): void {
    this.openState = false;
    this.textareaEl = null;
    this.saveButton = null;
    this.statusEl = null;
    this.options.onClosed?.();
  }

  private setStatus(message: string, kind: "idle" | "error"): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", kind === "error");
  }

  private async submit(): Promise<void> {
    if (this.saving) {
      return;
    }
    if (this.value.trim() === "") {
      this.setStatus("何か入力してください。", "error");
      this.textareaEl?.focus();
      return;
    }

    this.saving = true;
    this.saveButton?.setDisabled(true);
    this.setStatus("保存中…", "idle");

    const savedValue = this.value;
    let result: AddMemoResult;
    try {
      result = await this.memoService.addMemo(savedValue);
    } catch (error) {
      this.saving = false;
      this.saveButton?.setDisabled(false);
      this.setStatus(userMessageOf(error), "error");
      if (this.openState) {
        this.textareaEl?.focus();
      }
      return;
    }

    // 保存は完了している。保存後のUI更新が失敗しても「保存失敗」と表示しない。
    this.saving = false;
    try {
      // 保存中に追記されていたら、その分は下書きとして残す。
      if (this.value === savedValue) {
        writeDraft(this.draftKey, "");
      } else {
        writeDraft(this.draftKey, this.value);
      }
      this.options.onDraftChange?.(this.value === savedValue ? "" : this.value);
    } catch (error) {
      console.error("[Seiton] draft callback failed", error);
    }
    try {
      this.options.onSaved?.(result);
    } catch (error) {
      console.error("[Seiton] onSaved callback failed", error);
    }
    new Notice("メモを保存しました（この端末）");
    if (this.openState) {
      this.close();
    }
  }
}

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value === "") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // 保存できない環境でも入力自体は続けられる。
  }
}
