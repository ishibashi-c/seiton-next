/**
 * 画面右下に出す、現在のタブの主操作。
 * スクロール位置を動かさずに、入力や検索を開くために使う。
 */

import type { ItemView } from "obsidian";
import { setIcon } from "obsidian";

export interface FloatingActionOptions {
  icon: string;
  label: string;
  onClick: () => void;
}

const SHOW_AFTER = 480;

export function addFloatingAction(
  view: ItemView,
  options: FloatingActionOptions
): HTMLButtonElement {
  const button = view.contentEl.createEl("button", {
    attr: {
      "aria-label": options.label,
      type: "button",
    },
    cls: "seiton-fab",
  });
  button.title = options.label;
  setIcon(button, options.icon);
  button.addEventListener("click", () => options.onClick());

  const place = (): void => {
    const rect = view.containerEl.getBoundingClientRect();
    const mobile = window.innerWidth <= 640;
    const right = Math.max(
      12,
      window.innerWidth - rect.right + (mobile ? 16 : 24)
    );
    const bottom = Math.max(
      12,
      window.innerHeight - rect.bottom + (mobile ? 72 : 24)
    );
    button.style.right = `${right}px`;
    button.style.bottom = `${bottom}px`;
  };

  const update = (): void => {
    const visible = view.contentEl.scrollTop > SHOW_AFTER;
    button.classList.toggle("is-visible", visible);
    button.tabIndex = visible ? 0 : -1;
  };

  view.registerDomEvent(view.contentEl, "scroll", update);
  view.registerDomEvent(window, "resize", place);
  place();
  update();
  window.setTimeout(() => {
    place();
    update();
  }, 60);
  return button;
}
