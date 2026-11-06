/**
 * 自前のセレクト。ネイティブの `<select>` を置き換える。
 * 一覧は body 直下に fixed で出すので、モーダルのスクロールで切れない。
 * 狭い画面やスマートフォンでは画面中央を軸にスマートなダイアログとして即座に表示する。
 */

import { setIcon } from "obsidian";

export interface SelectChoice {
  label: string;
  value: string;
}

export interface SelectOptions {
  choices: SelectChoice[];
  onChange: (value: string) => void;
  title?: string;
  value: string;
}

export interface SelectControl {
  element: HTMLElement;
  setChoices(choices: SelectChoice[]): void;
  setValue(value: string): void;
  value(): string;
}

const DIALOG_MAX_WIDTH = 640;

export function createSelect(options: SelectOptions): SelectControl {
  let choices = [...options.choices];
  let value = options.value;
  let open = false;
  let pop: HTMLElement | null = null;
  let backdrop: HTMLElement | null = null;
  let active = -1;

  const root = document.createElement("div");
  root.className = "st-select";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "st-select-trigger";
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-haspopup", "listbox");

  const valueEl = document.createElement("span");
  valueEl.className = "st-select-value";
  const caret = document.createElement("span");
  caret.className = "st-select-caret";
  setIcon(caret, "chevron-down");
  trigger.append(valueEl, caret);
  root.append(trigger);

  const labelOf = (input: string): string =>
    choices.find((choice) => choice.value === input)?.label ?? "";

  const paint = (): void => {
    const label = labelOf(value);
    valueEl.setText(label);
    valueEl.toggleClass("is-empty", label === "");
  };

  const close = (focus = true): void => {
    if (!open) {
      return;
    }
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    backdrop?.remove();
    backdrop = null;
    pop?.remove();
    pop = null;
    active = -1;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onDocumentKey, true);
    window.removeEventListener("resize", onReposition);
    document.removeEventListener("scroll", onScroll, true);
    if (focus) {
      trigger.focus();
    }
  };

  const onOutside = (event: PointerEvent): void => {
    const target = event.target;
    if (
      target instanceof Node &&
      (root.contains(target) || pop?.contains(target))
    ) {
      return;
    }
    close(false);
  };

  const onDocumentKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const onReposition = (): void => {
    if (pop && !pop.hasClass("is-dialog") && !pop.hasClass("is-sheet")) {
      place();
    }
  };

  const onScroll = (event: Event): void => {
    if (pop && event.target instanceof Node && pop.contains(event.target)) {
      return;
    }
    close(false);
  };

  const place = (): void => {
    if (!pop) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    pop.style.left = `${rect.left}px`;
    pop.style.width = `${rect.width}px`;
    const height = pop.offsetHeight;
    const below = rect.bottom + 6;
    const above = rect.top - height - 6;
    pop.style.top = `${below + height > window.innerHeight - 8 && above > 8 ? above : below}px`;
  };

  const select = (next: string): void => {
    value = next;
    paint();
    close();
    options.onChange(next);
  };

  const highlight = (index: number): void => {
    if (!pop) {
      return;
    }
    const items = Array.from(
      pop.querySelectorAll<HTMLElement>(".st-select-item")
    );
    if (items.length === 0) {
      return;
    }
    const clamped = (index + items.length) % items.length;
    active = clamped;
    for (const [position, item] of items.entries()) {
      item.toggleClass("is-active", position === clamped);
    }
    items[clamped]?.scrollIntoView({ block: "nearest" });
  };

  const build = (): HTMLElement => {
    const list = document.createElement("div");
    list.className = "st-select-pop";
    list.setAttribute("role", "listbox");
    const isMobile =
      window.innerWidth <= DIALOG_MAX_WIDTH ||
      document.body.hasClass("is-phone");
    if (isMobile) {
      list.addClass("is-dialog");

      const header = document.createElement("div");
      header.className = "st-select-dialog-header";

      const titleEl = document.createElement("span");
      titleEl.className = "st-select-dialog-title";
      titleEl.setText(options.title ?? "選択");

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "st-select-dialog-close";
      closeBtn.setAttribute("aria-label", "閉じる");
      setIcon(closeBtn, "x");
      closeBtn.addEventListener("click", () => close(true));

      header.append(titleEl, closeBtn);
      list.append(header);
    }

    const itemsWrap = document.createElement("div");
    itemsWrap.className = "st-select-items-wrap";
    for (const choice of choices) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "st-select-item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(choice.value === value));
      item.createSpan({ cls: "st-select-item-text", text: choice.label });
      if (choice.value === value) {
        const check = document.createElement("span");
        check.className = "st-select-item-check";
        setIcon(check, "check");
        item.append(check);
      }
      item.addEventListener("click", () => select(choice.value));
      itemsWrap.append(item);
    }
    list.append(itemsWrap);
    return list;
  };

  const openPop = (): void => {
    if (open) {
      return;
    }
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    pop = build();
    const isMobileDialog = pop.hasClass("is-dialog");
    if (isMobileDialog) {
      backdrop = document.createElement("div");
      backdrop.className = "st-select-backdrop";
      backdrop.addEventListener("pointerdown", () => close(false));
      document.body.append(backdrop);
    }
    document.body.append(pop);
    if (!isMobileDialog) {
      place();
    }
    const current = choices.findIndex((choice) => choice.value === value);
    highlight(current >= 0 ? current : 0);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onDocumentKey, true);
    window.addEventListener("resize", onReposition);
    document.addEventListener("scroll", onScroll, true);
  };

  trigger.addEventListener("click", () => {
    if (open) {
      close();
      return;
    }
    openPop();
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openPop();
        return;
      }
      highlight(active + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (!open) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const choice = choices[active];
      if (choice) {
        select(choice.value);
      }
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      highlight(event.key === "Home" ? 0 : choices.length - 1);
      return;
    }
    if (event.key.length === 1) {
      const typed = event.key.toLowerCase();
      const index = choices.findIndex((choice) =>
        choice.label.toLowerCase().startsWith(typed)
      );
      if (index >= 0) {
        highlight(index);
      }
    }
  });

  paint();

  return {
    element: root,
    setChoices(next) {
      choices = [...next];
      if (open) {
        pop?.remove();
        backdrop?.remove();
        backdrop = null;
        pop = build();
        if (pop) {
          const isMobileDialog = pop.hasClass("is-dialog");
          if (isMobileDialog) {
            backdrop = document.createElement("div");
            backdrop.className = "st-select-backdrop";
            backdrop.addEventListener("pointerdown", () => close(false));
            document.body.append(backdrop);
          }
          document.body.append(pop);
          if (!isMobileDialog) {
            place();
          }
        }
      }
      paint();
    },
    setValue(next) {
      value = next;
      paint();
    },
    value: () => value,
  };
}
