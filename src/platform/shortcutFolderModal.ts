import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";

interface ShortcutFolderModalOptions {
  initialName?: string;
  onSubmit: (name: string) => void;
}

/** ショートカットのグループを作成・改名する。 */
export class ShortcutFolderModal extends Modal {
  private readonly options: ShortcutFolderModalOptions;
  private name: string;
  private statusEl: HTMLElement | null = null;

  constructor(app: App, options: ShortcutFolderModalOptions) {
    super(app);
    this.options = options;
    this.name = options.initialName ?? "";
  }

  override onOpen(): void {
    this.setTitle(
      this.options.initialName ? "グループの名前を変更" : "グループを作成"
    );
    this.contentEl.createEl("p", {
      cls: "seiton-shortcut-hint",
      text: "グループはノートの見出し1つです。削除すると中のショートカットはグループなしに戻ります。",
    });

    new Setting(this.contentEl).setName("名前").addText((text) => {
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      });
      window.setTimeout(() => text.inputEl.focus(), 50);
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
    const name = this.name.trim();
    if (name === "") {
      this.statusEl?.setText("名前を入力してください。");
      return;
    }
    this.options.onSubmit(name);
    this.close();
  }
}
