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
  onAttachNote?: () => Promise<void> | void;
  onCopied: (path: string, status: PromptComposerStatus) => Promise<void>;
  promptService: PromptService;
}

export const PROMPT_TEMPLATES: Array<{ label: string; template: string }> = [
  {
    label: "要約・構造化",
    template:
      "以下の内容を要約し、要点を箇条書きで構造化して整理してください。\n\n# 前提 / 目的\n\n\n# 対象テキスト\n\n\n# 出力フォーマット\n- 要約（3行以内）\n- 主要な論点・決定事項\n- ネクストアクション",
  },
  {
    label: "文章推敲",
    template:
      "以下の文章を推敲し、より読みやすく論理的な構成に改善してください。誤字脱字の修正、冗長な表現の簡潔化、敬体/常体の統一も行ってください。\n\n# 対象テキスト\n\n\n# 改善の方針 / トーン\n",
  },
  {
    label: "アイデア壁打ち",
    template:
      "以下のテーマ・課題について壁打ち相手になってください。多角的な視点からアイデアを出し、懸念点や前提の問い直しも提示してください。\n\n# テーマ / 課題\n\n\n# 現在の思考\n\n\n# 欲しいフィードバック\n",
  },
  {
    label: "コード・論理検証",
    template:
      "以下のコードまたはロジックを検証してください。エッジケース、パフォーマンス、セキュリティ、型安全性の観点から問題点があれば指摘し、改善コード例を提示してください。\n\n# コンテキスト / 目的\n\n\n# 対象コード / 仕様\n```\n\n```\n\n# 検証観点\n",
  },
];

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

    const toolbar = host.createDiv({ cls: "seiton-prompt-composer-toolbar" });
    const pills = toolbar.createDiv({ cls: "seiton-prompt-template-pills" });
    for (const tpl of PROMPT_TEMPLATES) {
      const pill = pills.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-pill seiton-prompt-template-pill",
        text: tpl.label,
      });
      pill.addEventListener("click", () => {
        this.insertText(tpl.template);
      });
    }

    if (this.options.onAttachNote) {
      const attachBtn = toolbar.createEl("button", {
        attr: { type: "button" },
        cls: "seiton-text-action seiton-prompt-attach-btn",
        text: "ノート引用",
      });
      attachBtn.addEventListener("click", () => {
        void this.options.onAttachNote?.();
      });
    }

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

  insertText(text: string): void {
    if (!this.options.isOpen()) {
      this.setStatus("終了したセッションでは編集できません。", "error");
      return;
    }
    if (!this.input) {
      return;
    }
    const current = this.input.value;
    const start = this.input.selectionStart ?? current.length;
    const end = this.input.selectionEnd ?? current.length;

    let newValue: string;
    if (current.trim() === "") {
      newValue = text;
    } else if (start !== end || (start > 0 && start < current.length)) {
      newValue = `${current.slice(0, start)}${text}${current.slice(end)}`;
    } else {
      newValue = `${current.trimEnd()}\n\n${text}`;
    }

    this.input.value = newValue;
    this.draft = newValue;
    this.draftDirty = true;
    this.setStatus("未保存", "idle");
    this.updateDraftButton();
    this.scheduleDraftSave();
    this.input.focus();
  }

  attachContext(title: string, body: string): void {
    const formatted = `\n<context title="${title}">\n${body.trim()}\n</context>\n`;
    this.insertText(formatted);
    this.setStatus(`「${title}」をコンテキスト引用しました。`, "success");
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
