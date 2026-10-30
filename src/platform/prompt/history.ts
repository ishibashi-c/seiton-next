import type { App, Component } from "obsidian";
import { MarkdownRenderer, Modal } from "obsidian";
import type { PromptSessionSummary } from "../../services/promptService";
import { markSeitonModal } from "../ui/modal";
import { ButtonComponent, Setting } from "../ui/setting";

interface PromptEntry {
  at: string;
  body: string;
  id: string;
}

export type PromptStatusKind = "error" | "idle" | "success";

export interface PromptHistoryOptions {
  app: App;
  component: Component;
  copy: (text: string, message: string) => Promise<void>;
  copyClipboard: (text: string) => Promise<boolean>;
  onNewSession: () => void;
  onQuote: (body: string) => void;
  onStatus: (message: string, kind: PromptStatusKind) => void;
}

class PromptHandoffModal extends Modal {
  private readonly heading: string;
  private readonly text: string;
  private readonly copyText: (text: string) => Promise<boolean>;
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    title: string,
    text: string,
    copyText: (text: string) => Promise<boolean>
  ) {
    super(app);
    this.heading = title;
    this.text = text;
    this.copyText = copyText;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.setTitle(`${this.heading} の引き継ぎ`);
    this.contentEl.createEl("p", {
      cls: "seiton-prompt-hint",
      text: "選択した指示を原文のまままとめています。コピー前に編集できます。",
    });
    let area: HTMLTextAreaElement | null = null;
    new Setting(this.contentEl).addTextArea((text) => {
      area = text.inputEl;
      text.setValue(this.text);
      text.inputEl.rows = 18;
      text.inputEl.addClass("seiton-handoff-text");
    });
    this.statusEl = this.contentEl.createDiv({ cls: "seiton-modal-status" });
    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    new ButtonComponent(footer)
      .setButtonText("閉じる")
      .onClick(() => this.close());
    new ButtonComponent(footer)
      .setButtonText("コピー")
      .setCta()
      .onClick(() => {
        void this.copy(area?.value ?? this.text);
      });
  }

  private async copy(text: string): Promise<void> {
    const copied = await this.copyText(text);
    this.statusEl?.setText(
      copied ? "コピーしました。送信はしていません。" : "コピーに失敗しました。"
    );
    this.statusEl?.toggleClass("is-error", !copied);
  }
}

export class PromptHistory {
  private readonly options: PromptHistoryOptions;
  private host: HTMLElement | null = null;
  private currentPrompts: PromptEntry[] = [];
  private selectedPromptIds = new Set<string>();

  constructor(options: PromptHistoryOptions) {
    this.options = options;
  }

  attach(host: HTMLElement): void {
    this.host = host;
  }

  clear(): void {
    this.currentPrompts = [];
    this.selectedPromptIds.clear();
    this.host?.empty();
  }

  renderEmpty(): void {
    if (!this.host) {
      return;
    }
    this.currentPrompts = [];
    this.host.empty();
    const empty = this.host.createDiv({ cls: "seiton-empty" });
    empty.setText("新しいセッションを作成して、指示を書いてください。");
    const button = empty.createEl("button", {
      cls: "mod-cta",
      text: "新しいセッション",
    });
    button.type = "button";
    button.addEventListener("click", () => this.options.onNewSession());
  }

  render(prompts: PromptEntry[]): void {
    const host = this.host;
    if (!host) {
      return;
    }
    this.currentPrompts = prompts;
    host.empty();
    if (prompts.length === 0) {
      host.createDiv({
        cls: "seiton-section-empty",
        text: "まだ指示の履歴がありません。入力欄からコピーしてください。",
      });
      return;
    }

    for (const prompt of prompts) {
      const card = host.createDiv({ cls: "seiton-prompt-item" });
      const meta = card.createDiv({ cls: "seiton-prompt-item-meta" });
      const select = meta.createEl("input", {
        attr: {
          "aria-label": "この指示を引き継ぎに含める",
          type: "checkbox",
        },
        cls: "seiton-prompt-select",
      });
      select.checked = this.selectedPromptIds.has(prompt.id);
      select.addEventListener("change", () => {
        if (select.checked) {
          this.selectedPromptIds.add(prompt.id);
        } else {
          this.selectedPromptIds.delete(prompt.id);
        }
      });
      meta.createSpan({ text: prompt.at.replace("T", " ").slice(0, 16) });
      const actions = meta.createDiv({
        cls: "seiton-prompt-item-actions",
      });
      const quote = actions.createEl("button", {
        cls: "seiton-prompt-item-copy",
        text: "引用して編集",
      });
      quote.type = "button";
      quote.addEventListener("click", () => {
        this.options.onQuote(prompt.body);
      });
      const copy = actions.createEl("button", {
        cls: "seiton-prompt-item-copy",
        text: "この指示をコピー",
      });
      copy.type = "button";
      copy.addEventListener("click", () => {
        void this.options.copy(
          prompt.body,
          "コピーしました（履歴は増やしません）"
        );
      });
      const body = card.createDiv({
        cls: "seiton-prompt-item-body markdown-rendered",
      });
      void MarkdownRenderer.render(
        this.options.app,
        prompt.body,
        body,
        "",
        this.options.component
      ).catch(() => {
        body.setText(prompt.body);
      });
    }
    host.scrollTop = host.scrollHeight;
  }

  openHandoff(session: PromptSessionSummary): void {
    const selected = this.currentPrompts.filter((prompt) =>
      this.selectedPromptIds.has(prompt.id)
    );
    if (selected.length === 0) {
      this.options.onStatus(
        "引き継ぎに含める指示を選択してください。",
        "error"
      );
      return;
    }
    const body = selected
      .map((prompt) => `### ${prompt.at}\n\n${prompt.body}\n`)
      .join("\n");
    const text = [
      `# ${session.title} 引き継ぎ`,
      "",
      `出典: ${session.path}`,
      session.project ? `プロジェクト: ${session.project}` : "",
      "",
      body.trim(),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n");
    new PromptHandoffModal(
      this.options.app,
      session.title,
      text,
      this.options.copyClipboard
    ).open();
  }
}
