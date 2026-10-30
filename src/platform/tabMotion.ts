/**
 * タブ切り替えの入場アニメーション。
 * どのタブからどのタブへ動いたかだけを一時的に覚え、新しい画面の本文に適用する。
 */

export type TabDirection = 1 | -1;

interface PendingTabMotion {
  direction: TabDirection;
  fromType: string;
  toType: string;
}

let pending: PendingTabMotion | null = null;
let expiryTimer: number | null = null;

function clearExpiry(): void {
  if (expiryTimer !== null) {
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

export function beginTabMotion(
  fromType: string,
  toType: string,
  fromIndex: number,
  toIndex: number
): void {
  if (fromType === toType) {
    pending = null;
    clearExpiry();
    return;
  }
  pending = {
    direction: toIndex >= fromIndex ? 1 : -1,
    fromType,
    toType,
  };
  clearExpiry();
  expiryTimer = window.setTimeout(() => {
    pending = null;
    expiryTimer = null;
  }, 2000);
}

export function clearTabMotion(): void {
  pending = null;
  clearExpiry();
}

/**
 * 新しいビューの本文にだけ入場アニメーションを付ける。
 * ヘッダーとナビは動かさない。
 */
export function applyTabEnter(container: HTMLElement, type: string): void {
  if (!pending || pending.toType !== type) {
    return;
  }
  const motion = pending;
  pending = null;
  clearExpiry();

  const body = container.querySelector<HTMLElement>(".seiton-tab-body");
  if (!body) {
    return;
  }
  const nav = container.querySelector<HTMLElement>(".seiton-top-nav");
  nav
    ?.querySelector<HTMLElement>(".seiton-top-tab.is-active")
    ?.focus({ preventScroll: true });
  body.style.setProperty("--seiton-enter-x", `${motion.direction * 8}px`);
  body.classList.add("is-tab-entering");
  nav?.classList.add("is-tab-transitioning");

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    body.classList.remove("is-tab-entering");
    body.style.removeProperty("--seiton-enter-x");
    nav?.classList.remove("is-tab-transitioning");
  };
  body.addEventListener("animationend", cleanup, { once: true });
  window.setTimeout(cleanup, 400);
}
