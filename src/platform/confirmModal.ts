import type { App } from "obsidian";
import { Modal } from "obsidian";
import { userMessageOf } from "../domain/errors";
import { button } from "./ui/field";
import { buildSeitonModal } from "./ui/modal";

import { showToast } from "./ui/toast";

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
  private confirmEl: HTMLButtonElement | null = null;

  constructor(app: App, options: ConfirmModalOptions) {
    super(app);
    this.options = options;
  }

  override onOpen(): void {
    const { footer } = buildSeitonModal(this, {
      description: this.options.message,
      title: this.options.title,
    });
    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });
    this.confirmEl = button(footer, {
      label: this.options.confirmingLabel ?? "実行",
      onClick: () => {
        void this.submit();
      },
      tone: "danger-solid",
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.confirmEl = null;
  }

  private async submit(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    if (this.confirmEl) {
      this.confirmEl.disabled = true;
    }
    try {
      await this.options.onConfirm();
      this.close();
    } catch (error) {
      showToast(userMessageOf(error));
      if (this.confirmEl) {
        this.confirmEl.disabled = false;
      }
      this.busy = false;
    }
  }
}
