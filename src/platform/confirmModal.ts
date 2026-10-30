import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { userMessageOf } from "../domain/errors";

interface ConfirmModalOptions {
  confirmingLabel?: string;
  message: string;
  onConfirm: () => Promise<void> | void;
  title: string;
}

/** 破壊的操作の前に出す共通の確認ダイアログ。 */
export class ConfirmModal extends Modal {
  private readonly options: ConfirmModalOptions;
  private busy = false;

  constructor(app: App, options: ConfirmModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-confirm-modal");
    this.setTitle(this.options.title);
    this.contentEl.createEl("p", {
      cls: "seiton-confirm-message",
      text: this.options.message,
    });

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const cancel = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancel.addEventListener("click", () => this.close());
    const confirm = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-warning",
      text: this.options.confirmingLabel ?? "実行",
    });
    confirm.addEventListener("click", () => {
      void this.submit(confirm);
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async submit(button: HTMLButtonElement): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    button.disabled = true;
    try {
      await this.options.onConfirm();
      this.close();
    } catch (error) {
      new Notice(userMessageOf(error));
      button.disabled = false;
      this.busy = false;
    }
  }
}
