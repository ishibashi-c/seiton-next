import type { App } from "obsidian";
import { Modal, Setting, type TextComponent } from "obsidian";

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
    this.setTitle(
      this.options.initial ? "ショートカットを編集" : "ショートカットを追加"
    );
    this.contentEl.createEl("p", {
      cls: "seiton-shortcut-hint",
      text: "URLは既定のブラウザで、ノートはObsidianで開きます。保存先は Seiton/System/Links.md です。",
    });

    if (this.options.groups.length > 0) {
      new Setting(this.contentEl)
        .setName("グループ")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "なし");
          for (const group of this.options.groups) {
            dropdown.addOption(group, group);
          }
          dropdown.setValue(this.group ?? "").onChange((value) => {
            this.group = value === "" ? null : value;
          });
        });
    }

    new Setting(this.contentEl).setName("ラベル").addText((text) => {
      text.setValue(this.label).onChange((value) => {
        this.label = value;
      });
      window.setTimeout(() => text.inputEl.focus(), 50);
    });

    new Setting(this.contentEl)
      .setName("リンク")
      .setDesc("https://… または [[ノート]] / Vault内のパス")
      .addText((text: TextComponent) => {
        text
          .setPlaceholder("https://example.com または [[ノート]]")
          .setValue(this.target)
          .onChange((value) => {
            this.target = value;
          });
      });

    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-shortcut-modal-status",
    });
    this.statusEl.setAttribute("aria-live", "polite");

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const cancel = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "保存",
    });
    save.addEventListener("click", () => this.submit());
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
