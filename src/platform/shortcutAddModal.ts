import type { App } from "obsidian";
import { Modal } from "obsidian";

interface ShortcutAddModalOptions {
  onFolder: () => void;
  onShortcut: () => void;
}

/** 「追加」から、ショートカットかフォルダかを選ぶ。 */
export class ShortcutAddModal extends Modal {
  private readonly options: ShortcutAddModalOptions;

  constructor(app: App, options: ShortcutAddModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    this.setTitle("追加");
    const list = this.contentEl.createDiv({ cls: "seiton-add-choice" });

    const shortcut = list.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-add-choice-item",
    });
    shortcut.createDiv({
      cls: "seiton-add-choice-title",
      text: "ショートカット",
    });
    shortcut.createDiv({
      cls: "seiton-add-choice-desc",
      text: "URLまたはノートへのリンクを1つ追加します。",
    });
    shortcut.addEventListener("click", () => {
      this.close();
      this.options.onShortcut();
    });

    const folder = list.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-add-choice-item",
    });
    folder.createDiv({ cls: "seiton-add-choice-title", text: "グループ" });
    folder.createDiv({
      cls: "seiton-add-choice-desc",
      text: "ショートカットを見出しでまとめます。",
    });
    folder.addEventListener("click", () => {
      this.close();
      this.options.onFolder();
    });

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const cancel = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancel.addEventListener("click", () => this.close());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
