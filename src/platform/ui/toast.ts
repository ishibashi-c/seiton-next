/**
 * 自前のトースト。`Notice` の代わりに使う。
 * 画面の左下に積み、3秒で消える。ポインタを乗せている間は止まる。
 */

const LIFETIME_MS = 3200;
const MAX_VISIBLE = 3;

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container?.isConnected) {
    return container;
  }
  const element = document.createElement("div");
  element.className = "st-toasts";
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "false");
  document.body.append(element);
  container = element;
  return element;
}

export function showToast(message: string): void {
  const host = ensureContainer();
  const toast = document.createElement("div");
  toast.className = "st-toast is-entering";
  toast.setText(message);
  host.append(toast);

  while (host.children.length > MAX_VISIBLE) {
    host.firstElementChild?.remove();
  }

  let timer = window.setTimeout(dismiss, LIFETIME_MS);
  toast.addEventListener("pointerenter", () => {
    window.clearTimeout(timer);
  });
  toast.addEventListener("pointerleave", () => {
    timer = window.setTimeout(dismiss, 1200);
  });

  function dismiss(): void {
    window.clearTimeout(timer);
    toast.removeClass("is-entering");
    toast.addClass("is-leaving");
    window.setTimeout(() => toast.remove(), 160);
  }
}
