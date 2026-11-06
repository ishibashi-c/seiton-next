import { setIcon } from "obsidian";

export interface CardMenuAction {
  danger?: boolean;
  label: string;
  run: () => void;
}

let activeCleanup: (() => void) | null = null;

export function closeCardMenu(): void {
  activeCleanup?.();
}

/**
 * カードの⋯に紐づくメニュー。
 * デスクトップではアンカー付近のポップオーバー、モバイル幅（<=640px）では画面中央軸のスマートダイアログとして即時表示する。
 */
export function showCardMenu(
  anchor: HTMLElement,
  actions: CardMenuAction[]
): void {
  closeCardMenu();
  if (actions.length === 0) {
    return;
  }

  const isDialog = window.innerWidth <= 640;
  let backdropEl: HTMLElement | null = null;

  if (isDialog) {
    backdropEl = document.createElement("div");
    backdropEl.className = "st-select-backdrop";
    backdropEl.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeCardMenu();
    });
    document.body.appendChild(backdropEl);
  }

  const menu = document.createElement("div");
  menu.className = `seiton-card-menu${isDialog ? " is-dialog" : ""}`;
  menu.setAttribute("role", "menu");

  if (isDialog) {
    const header = document.createElement("div");
    header.className = "st-select-dialog-header";
    const titleEl = document.createElement("span");
    titleEl.className = "st-select-dialog-title";
    titleEl.textContent = "操作を選択";
    header.appendChild(titleEl);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "st-select-dialog-close";
    closeBtn.setAttribute("aria-label", "閉じる");
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeCardMenu();
    });
    header.appendChild(closeBtn);
    menu.appendChild(header);
  }

  const listWrap = document.createElement("div");
  listWrap.className = "seiton-card-menu-list";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `seiton-card-menu-item${
      action.danger ? " is-danger" : ""
    }`;
    button.setAttribute("role", "menuitem");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      closeCardMenu();
      action.run();
    });
    listWrap.appendChild(button);
  }
  menu.appendChild(listWrap);

  if (!isDialog) {
    menu.style.visibility = "hidden";
  }
  document.body.appendChild(menu);

  if (!isDialog) {
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(
      window.innerWidth - width - 8,
      Math.max(8, rect.right - width)
    );
    const below = rect.bottom + 4;
    const top =
      below + height > window.innerHeight - 8
        ? Math.max(8, rect.top - height - 4)
        : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && !menu.contains(event.target)) {
      closeCardMenu();
    }
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCardMenu();
      anchor.focus();
    }
  };
  const cleanup = (): void => {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", cleanup);
    window.removeEventListener("scroll", cleanup, true);
    backdropEl?.remove();
    backdropEl = null;
    menu.remove();
    activeCleanup = null;
  };
  activeCleanup = cleanup;
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown);
  }, 0);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", cleanup);
  if (!isDialog) {
    window.addEventListener("scroll", cleanup, true);
  }
  listWrap.querySelector<HTMLButtonElement>("button")?.focus();
}
