import type { App } from "obsidian";
import { Modal } from "obsidian";
import { button, selectField, textField } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";

export interface ShortcutInput {
  group: string | null;
  label: string;
  target: string;
}

interface ShortcutModalOptions {
  groups: string[];
  initial?: ShortcutInput;
  initialGroup: string | null;
  onSubmit: (input: ShortcutInput) => void;
}

/** ショートカット（リンク集の1行）を追加・編集する。 */
export class ShortcutModal extends Modal {
  private readonly options: ShortcutModalOptions;
  private group: string | null;
  private label: string;
  private target: string;
  private statusEl: HTMLElement | null = null;

  constructor(app: App, options: ShortcutModalOptions) {
    super(app);
    this.options = options;
    this.group = options.initial?.group ?? options.initialGroup ?? null;
    this.label = options.initial?.label ?? "";
    this.target = options.initial?.target ?? "";
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "URLは既定のブラウザで、ノートはObsidianで開きます。保存先は Seiton/System/Links.md です。",
      title: this.options.initial
        ? "ショートカットを編集"
        : "ショートカットを追加",
    });

    if (this.options.groups.length > 0) {
      selectField(body, {
        choices: [
          { label: "なし", value: "" },
          ...this.options.groups.map((group) => ({
            label: group,
            value: group,
          })),
        ],
        label: "グループ",
        onChange: (value) => {
          this.group = value === "" ? null : value;
        },
        value: this.group ?? "",
      });
    }

    const labelInput = textField(body, {
      label: "ラベル",
      onChange: (value) => {
        this.label = value;
      },
      value: this.label,
    });
    textField(body, {
      description: "https://… または [[ノート]] / Vault内のパス",
      label: "リンク",
      onChange: (value) => {
        this.target = value;
      },
      placeholder: "https://example.com または [[ノート]]",
      value: this.target,
    });
    window.setTimeout(() => labelInput.focus(), 50);

    this.statusEl = body.createDiv({ cls: "st-status" });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });
    button(footer, {
      label: "保存",
      onClick: () => this.submit(),
      tone: "primary",
    });

    this.scope.register([], "Enter", (event) => {
      event.preventDefault();
      this.submit();
      return false;
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.statusEl = null;
  }

  private submit(): void {
    const label = this.label.trim();
    const target = this.target.trim();
    if (label === "" || target === "") {
      this.setStatus("ラベルとリンクを入力してください。");
      return;
    }
    if (
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(target) &&
      !/^https?:\/\//iu.test(target)
    ) {
      this.setStatus("http/httpsのURLだけを登録できます。");
      return;
    }
    this.options.onSubmit({ group: this.group, label, target });
    this.close();
  }

  private setStatus(message: string): void {
    this.statusEl?.setText(message);
  }
}
