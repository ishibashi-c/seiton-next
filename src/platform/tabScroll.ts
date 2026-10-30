/**
 * タブごとのスクロール位置。単一リーフでビューを作り直しても戻れるようにする。
 * 位置は端末のlocalStorageにも残し、Obsidianを開き直した後も使える。
 */

const STORAGE_KEY = "seiton-next.tab-scroll";

let positions: Map<string, number> | null = null;

function store(): Map<string, number> {
  if (positions) {
    return positions;
  }
  positions = new Map<string, number>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "number" && Number.isFinite(value)) {
            positions.set(key, value);
          }
        }
      }
    }
  } catch {
    // 保存できない環境でも位置はメモリ上だけ保持する。
  }
  return positions;
}

function persist(): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(store()))
    );
  } catch {
    // 保存できない環境でも画面は動かす。
  }
}

export function saveTabScroll(type: string, element: HTMLElement): void {
  store().set(type, element.scrollTop);
  persist();
}

/** ビューを閉じるとき用。DOMが外れた後の0で、保存済みの位置を上書きしない。 */
export function saveTabScrollOnClose(type: string, element: HTMLElement): void {
  if (!element.isConnected || element.scrollTop <= 0) {
    return;
  }
  saveTabScroll(type, element);
}

export function restoreTabScroll(type: string, element: HTMLElement): void {
  const top = store().get(type);
  if (top === undefined || top <= 0) {
    return;
  }
  const apply = (): void => {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll"));
  };
  window.requestAnimationFrame(() => {
    apply();
    window.setTimeout(apply, 60);
    window.setTimeout(apply, 180);
  });
}
