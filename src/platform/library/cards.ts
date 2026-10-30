import { makeCardClickable } from "../cardClick";
import { showCardMenu } from "../cardMenu";

export interface ItemAction {
  danger?: boolean;
  label: string;
  run: () => void;
}

export interface ItemCardOptions {
  actions: ItemAction[];
  date: string;
  kind: string;
  kindLabel: string;
  media?: HTMLElement | null;
  meta?: string;
  onOpen: () => void;
  onSelect?: (button: HTMLElement) => void;
  selectable?: boolean;
  selected?: boolean;
  state?: string;
  title: string;
}

/** The one card skeleton: kind + date, title, one meta line, state, actions. */
export function renderItemCard(options: ItemCardOptions): HTMLElement {
  const article = document.createElement("article");
  article.className = "seiton-item";
  article.dataset.kind = options.kind;

  const head = article.createDiv({ cls: "seiton-item-head" });
  if (options.selectable) {
    const select = document.createElement("button");
    select.type = "button";
    select.className = `seiton-select${options.selected ? " is-selected" : ""}`;
    select.setAttribute("aria-pressed", String(Boolean(options.selected)));
    select.setAttribute("aria-label", `${options.title} を選択`);
    select.addEventListener("click", (event) => {
      event.stopPropagation();
      options.onSelect?.(select);
    });
    head.appendChild(select);
  }
  if (options.media) {
    head.appendChild(options.media);
  }
  head.createSpan({ cls: "seiton-item-type", text: options.kindLabel });
  const headRight = head.createDiv({ cls: "seiton-item-head-right" });
  headRight.createSpan({ cls: "seiton-item-updated", text: options.date });
  addItemMenu(headRight, options.actions, options.title);

  const content = article.createDiv({ cls: "seiton-item-content" });
  const title = content.createEl("button", {
    cls: "seiton-item-title",
    text: options.title,
  });
  title.type = "button";
  title.addEventListener("click", options.onOpen);
  if (options.meta) {
    content.createDiv({ cls: "seiton-item-source", text: options.meta });
  }

  const side = article.createDiv({ cls: "seiton-item-side" });
  if (options.state) {
    side.createSpan({ cls: "seiton-item-state", text: options.state });
  }
  makeCardClickable(article, options.onOpen);
  return article;
}

export function addCardAction(
  parent: HTMLElement,
  label: string,
  action: () => void
): void {
  const button = parent.createEl("button", {
    cls: "seiton-item-action",
    text: label,
  });
  button.type = "button";
  button.addEventListener("click", action);
}

function addItemMenu(
  parent: HTMLElement,
  actions: ItemAction[],
  title: string
): void {
  if (actions.length === 0) {
    return;
  }
  const more = parent.createEl("button", {
    attr: {
      "aria-haspopup": "menu",
      "aria-label": `${title} の操作`,
    },
    cls: "seiton-item-more",
    text: "⋯",
  });
  more.type = "button";
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    showCardMenu(more, actions);
  });
}
