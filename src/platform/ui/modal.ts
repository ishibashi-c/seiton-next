/**
 * Seiton のモーダル枠。Obsidian の `Modal` は背景・Esc・フォーカスの閉じ込めにだけ使い、
 * 見出し・本文・フッターは自前で組む。
 */

import type { Modal } from "obsidian";

/** Obsidian のモーダルには、Seiton の見た目を当てる目印を付ける。 */
export function markSeitonModal(modal: Modal): void {
  modal.modalEl.addClass("st-modal");
}

export interface SeitonModalOptions {
  description?: string;
  title: string;
  wide?: boolean;
}

export interface SeitonModalFrame {
  body: HTMLElement;
  footer: HTMLElement;
}

/** モーダルの中身を組み立てる。`onOpen` の先頭で1回だけ呼ぶ。 */
export function buildSeitonModal(
  modal: Modal,
  options: SeitonModalOptions
): SeitonModalFrame {
  modal.modalEl.addClass("st-modal");
  modal.modalEl.addClass("st-modal-shell");
  if (options.wide) {
    modal.modalEl.addClass("is-wide");
  }
  modal.contentEl.empty();
  modal.titleEl.empty();
  modal.titleEl.hide();

  const body = modal.contentEl.createDiv({ cls: "st-modal-body" });
  if (options.title !== "" || options.description) {
    const head = body.createDiv({ cls: "st-modal-head" });
    if (options.title !== "") {
      head.createDiv({ cls: "st-modal-title", text: options.title });
    }
    if (options.description) {
      head.createDiv({ cls: "st-modal-desc", text: options.description });
    }
  }

  const footer = modal.modalEl.createDiv({ cls: "st-modal-foot" });
  return { body, footer };
}

/** フォームの中の見出し。長いモーダルを区切る。 */
export function modalSection(body: HTMLElement, label: string): void {
  body.createDiv({ cls: "st-section", text: label });
}
