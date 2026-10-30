import type { App } from "obsidian";
import { Modal } from "obsidian";
import { button } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";

interface ShortcutAddModalOptions {
  onFolder: () => void;
  onShortcut: () => void;
}

/** 「追加」から、ショートカットかグループかを選ぶ。 */
export class ShortcutAddModal extends Modal {
  private readonly options: ShortcutAddModalOptions;

  constructor(app: App, options: ShortcutAddModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    const { body, footer } = buildSeitonModal(this, {
      description: "リンクを1つ足すか、見出しでまとめるかを選びます。",
      title: "追加",
    });

    const shortcut = body.createEl("button", {
      cls: "st-choice",
      type: "button",
    });
    shortcut.createDiv({ cls: "st-choice-title", text: "ショートカット" });
    shortcut.createDiv({
      cls: "st-choice-desc",
      text: "URLまたはノートへのリンクを1つ追加します。",
    });
    shortcut.addEventListener("click", () => {
      this.close();
      this.options.onShortcut();
    });

    const folder = body.createEl("button", {
      cls: "st-choice",
      type: "button",
    });
    folder.createDiv({ cls: "st-choice-title", text: "グループ" });
    folder.createDiv({
      cls: "st-choice-desc",
      text: "ショートカットを見出しでまとめます。",
    });
    folder.addEventListener("click", () => {
      this.close();
      this.options.onFolder();
    });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
