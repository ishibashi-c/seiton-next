import { userMessageOf } from "../../domain/errors";
import type {
  PromptService,
  PromptSessionSummary,
} from "../../services/promptService";

export type PromptStatusKind = "error" | "idle" | "success";

export interface PromptComposerStatus {
  kind: PromptStatusKind;
  message: string;
}

export interface PromptComposerOptions {
  copyToClipboard: (text: string) => Promise<boolean>;
  getSession: () => PromptSessionSummary | null;
  isOpen: () => boolean;
  onCopied: (path: string, status: PromptComposerStatus) => Promise<void>;
  promptService: PromptService;
}

export class PromptComposer {
  private readonly options: PromptComposerOptions;
  private input: HTMLTextAreaElement | null = null;
  private statusEl: HTMLElement | null = null;
  private copyButton: HTMLButtonElement | null = null;
  private draftButton: HTMLButtonElement | null = null;
  private draft = "";
  private draftDirty = false;
  private saveTimer: number | null = null;
  private saving = false;
  private copying = false;

  constructor(options: PromptComposerOptions) {
    this.options = options;
  }

  render(host: HTMLElement): void {
    host.createDiv({
      cls: "seiton-prompt-pane-label",
      text: "次の指示",
    });
    const input = host.createEl("textarea", {
      attr: {
        "aria-label": "次のプロンプト指示",
        placeholder: "指示を書く。コピーはするが、AIへは送信しません。",
        rows: "6",
      },
      cls: "seiton-prompt-composer-input",
    });
    this.input = input;
    input.spellcheck = false;
    input.addEventListener("input", () => {
      this.draft = input.value;
      this.draftDirty = true;
      this.setStatus("未保存", "idle");
      this.updateDraftButton();
      this.scheduleDraftSave();
    });
    input.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void this.copy();
      }
    });

    const footer = host.createDiv({ cls: "seiton-prompt-composer-footer" });
    this.statusEl = footer.createSpan({
      cls: "seiton-prompt-status",
    });
    footer.createSpan({
      cls: "seiton-keyhint",
      text: "⌘/Ctrl + Enter でコピー",
    });
    this.draftButton = footer.createEl("button", {
      cls: "seiton-prompt-secondary",
      text: "今すぐ保存",
    });
    this.draftButton.type = "button";
    this.draftButton.addEventListener("click", () => {
      void this.saveDraftNow(true);
    });
    this.updateDraftButton();
    this.copyButton = footer.createEl("button", {
      cls: "seiton-prompt-copy mod-cta",
      text: "コピーして履歴に残す",
    });
    this.copyButton.type = "button";
    this.copyButton.addEventListener("click", () => {
      void this.copy();
    });
  }

  setValue(value: string): void {
    this.draft = value;
    this.draftDirty = false;
    if (this.input) {
      this.input.value = value;
    }
    this.updateDraftButton();
  }

  setEnabled(enabled: boolean): void {
    if (this.input) {
      this.input.disabled = !enabled;
      this.input.toggleClass("is-disabled", !enabled);
    }
    if (this.copyButton) {
      this.copyButton.disabled = !enabled;
    }
    this.updateDraftButton();
  }

  private updateDraftButton(): void {
    if (!this.draftButton) {
      return;
    }
    const enabled = this.input ? !this.input.disabled : true;
    this.draftButton.disabled = !enabled || !this.draftDirty || this.saving;
    this.draftButton.setText(this.draftDirty ? "今すぐ保存" : "保存済み");
  }

  setStatus(message: string, kind: PromptStatusKind): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", kind === "error");
    this.statusEl.toggleClass("is-success", kind === "success");
  }

  focus(): void {
    this.input?.focus();
  }

  quote(body: string): void {
    if (!this.options.isOpen()) {
      this.setStatus("終了したセッションでは引用できません。", "error");
      return;
    }
    this.draft = body;
    this.draftDirty = true;
    if (this.input) {
      this.input.value = body;
      this.input.focus();
    }
    this.setStatus(
      "引用しました。編集してコピーすると、新しい履歴になります。",
      "idle"
    );
    this.updateDraftButton();
    this.scheduleDraftSave();
  }

  /** ビューを閉じる前に、未保存の下書きを書き出す。 */
  async flush(): Promise<void> {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const session = this.options.getSession();
    if (!(session && this.options.isOpen() && this.draftDirty)) {
      return;
    }
    try {
      await this.options.promptService.saveDraft(
        session.path,
        this.input?.value ?? this.draft
      );
    } catch {
      // 画面を閉じる処理は止めない。下書きは次回も編集できる。
    }
  }

  private scheduleDraftSave(): void {
    if (!this.options.isOpen()) {
      return;
    }
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveDraftNow(false);
    }, 700);
  }

  private async saveDraftNow(userInitiated: boolean): Promise<void> {
    const session = this.options.getSession();
    if (!session || this.saving || this.copying || !this.options.isOpen()) {
      return;
    }
    if (!this.draftDirty && !userInitiated) {
      return;
    }
    this.saving = true;
    this.updateDraftButton();
    try {
      await this.options.promptService.saveDraft(session.path, this.draft);
      this.draftDirty = false;
      const time = savedAtLabel();
      this.setStatus(
        userInitiated ? `保存しました ${time}` : `自動保存済み ${time}`,
        "success"
      );
      this.updateDraftButton();
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
    } finally {
      this.saving = false;
      this.updateDraftButton();
    }
  }

  private async copy(): Promise<void> {
    const session = this.options.getSession();
    if (!(session && this.options.isOpen())) {
      return;
    }
    const text = this.draft;
    if (text.trim() === "") {
      this.setStatus("指示を入力してください。", "error");
      return;
    }

    const copied = await this.options.copyToClipboard(text);
    if (!copied) {
      this.setStatus(
        "コピーに失敗しました。履歴にも保存していません。",
        "error"
      );
      return;
    }

    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.copying = true;
    this.draftDirty = false;

    try {
      const result = await this.options.promptService.appendCopiedPrompt(
        session.path,
        text
      );
      this.draft = "";
      this.draftDirty = false;
      if (this.input) {
        this.input.value = "";
      }
      try {
        await this.options.promptService.saveDraft(session.path, "");
      } catch {
        // 下書きが残っても、コピーと履歴保存は成功している。
      }
      await this.options.onCopied(session.path, {
        kind: "success",
        message: result.duplicate
          ? "コピーしました。同じ内容なので履歴は増やしていません。"
          : "コピーしました。履歴に保存しました。",
      });
    } catch (error) {
      this.draftDirty = true;
      this.setStatus(
        `コピーは成功しましたが、履歴保存に失敗しました。下書きは残っています。${userMessageOf(error)}`,
        "error"
      );
    } finally {
      this.copying = false;
    }
  }
}

function savedAtLabel(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}
