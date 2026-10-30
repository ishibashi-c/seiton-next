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
 * カードの⋯に紐づく小さなメニュー。
 * ObsidianのMenuに依存せず、位置・外側クリック・Escをここで面倒みる。
 */
export function showCardMenu(
  anchor: HTMLElement,
  actions: CardMenuAction[]
): void {
  closeCardMenu();
  if (actions.length === 0) {
    return;
  }
  const menu = document.createElement("div");
  menu.className = "seiton-card-menu";
  menu.setAttribute("role", "menu");
  // プラグインCSSが古い/未適用でも読めるよう、位置と見た目はインラインで持つ。
  menu.style.cssText = [
    "position:fixed",
    "z-index:1000",
    "min-width:150px",
    "padding:4px",
    "display:flex",
    "flex-direction:column",
    "box-sizing:border-box",
    "background:var(--background-primary,#fff)",
    "border:1px solid var(--background-modifier-border,#d9d9d9)",
    "border-radius:10px",
    "font-family:var(--font-interface,sans-serif)",
  ].join(";");
  menu.style.visibility = "hidden";
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `seiton-card-menu-item${
      action.danger ? " is-danger" : ""
    }`;
    button.setAttribute("role", "menuitem");
    button.textContent = action.label;
    button.style.cssText = [
      "background:transparent",
      "border:0",
      "border-radius:6px",
      "box-shadow:none",
      "color:var(--text-normal,#222)",
      "font-family:inherit",
      "font-size:12px",
      "padding:7px 10px",
      "text-align:left",
      "width:100%",
    ].join(";");
    button.addEventListener("click", () => {
      closeCardMenu();
      action.run();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);

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
    menu.remove();
    activeCleanup = null;
  };
  activeCleanup = cleanup;
  window.setTimeout(() => {
    document.addEventListener("pointerdown", onPointerDown);
  }, 0);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", cleanup);
  window.addEventListener("scroll", cleanup, true);
  menu.querySelector<HTMLButtonElement>("button")?.focus();
}
