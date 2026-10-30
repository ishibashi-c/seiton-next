import type { App } from "obsidian";
import { Modal } from "obsidian";
import { button, textField } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";

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
    const { body, footer } = buildSeitonModal(this, {
      description:
        "グループはノートの見出し1つです。削除すると中のショートカットはグループなしに戻ります。",
      title: this.options.initialName
        ? "グループの名前を変更"
        : "グループを作成",
    });

    const input = textField(body, {
      label: "名前",
      onChange: (value) => {
        this.name = value;
      },
      value: this.name,
    });
    window.setTimeout(() => input.focus(), 50);

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
    const name = this.name.trim();
    if (name === "") {
      this.statusEl?.setText("名前を入力してください。");
      return;
    }
    this.options.onSubmit(name);
    this.close();
  }
}
