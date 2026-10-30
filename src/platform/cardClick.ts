const INTERACTIVE =
  "button, a, input, select, textarea, [contenteditable='true'], [role='button'], [role='menu'], .seiton-card-menu";

/**
 * カード全体を開く対象にする。
 * 中のボタン・選択・メニュー・テキスト選択中は除外する。
 */
export function makeCardClickable(card: HTMLElement, onOpen: () => void): void {
  card.classList.add("is-card-clickable");
  card.addEventListener("click", (event) => {
    if (event.defaultPrevented) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (target.closest(INTERACTIVE)) {
      return;
    }
    if ((window.getSelection()?.toString() ?? "").trim() !== "") {
      return;
    }
    onOpen();
  });
}
