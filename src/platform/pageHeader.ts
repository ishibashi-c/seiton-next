/**
 * 各タブで共通のページヘッダー。
 * タイトル、補足行、右側の操作を同じ順序・同じ高さで並べる。
 */

import { setIcon } from "obsidian";

export type PageHeaderActionKind = "icon" | "primary" | "text";

export interface PageHeaderAction {
  ariaLabel?: string;
  icon?: string;
  kind?: PageHeaderActionKind;
  label: string;
  onClick: (button: HTMLButtonElement) => void;
}

export interface PageHeaderHandle {
  actionsEl: HTMLElement;
  addAction: (action: PageHeaderAction) => HTMLButtonElement;
  header: HTMLElement;
  heading: HTMLElement;
  sublineEl: HTMLElement | null;
  titleEl: HTMLElement;
}

export interface PageHeaderOptions {
  actions?: PageHeaderAction[];
  /** 空文字を渡すと、後から更新できる空の補足行を作る。 */
  subline?: string;
  title: string;
}

export function renderPageHeader(
  parent: HTMLElement,
  options: PageHeaderOptions
): PageHeaderHandle {
  const header = parent.createDiv({ cls: "seiton-page-head" });
  const heading = header.createDiv({ cls: "seiton-page-heading" });
  const titleEl = heading.createEl("h1", {
    cls: "seiton-page-title",
    text: options.title,
  });
  const sublineEl =
    options.subline === undefined
      ? null
      : heading.createDiv({
          cls: "seiton-page-subline",
          text: options.subline,
        });
  const actionsEl = header.createDiv({ cls: "seiton-page-actions" });

  const addAction = (action: PageHeaderAction): HTMLButtonElement => {
    const kind = action.kind ?? (action.icon ? "icon" : "text");
    const button = actionsEl.createEl("button", {
      attr: {
        type: "button",
        ...(action.ariaLabel ? { "aria-label": action.ariaLabel } : {}),
      },
      cls:
        kind === "primary"
          ? "seiton-primary-text"
          : kind === "icon"
            ? "clickable-icon"
            : "seiton-text-action",
    });
    if (kind === "icon") {
      if (action.icon) {
        setIcon(button, action.icon);
      }
      button.title = action.ariaLabel ?? action.label;
    } else {
      button.setText(action.label);
    }
    button.addEventListener("click", () => action.onClick(button));
    return button;
  };

  for (const action of options.actions ?? []) {
    addAction(action);
  }

  return { actionsEl, addAction, header, heading, sublineEl, titleEl };
}
