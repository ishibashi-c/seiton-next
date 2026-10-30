/**
 * ショートカットのドラッグ並べ替え。
 *
 * HTML5のドラッグ&ドロップはタッチで発火しないため、Pointer Events で組む。
 * マウスは少し動かしたら掴み、指は長押しで掴む。掴む前に指が動いたら
 * スクロールを優先して諦める。
 */

export interface ShortcutDragCallbacks {
  onGroup: (source: string, group: string) => void;
  onItem: (source: string, target: string, before: boolean) => void;
}

const LONG_PRESS_MS = 350;
const SCROLL_CANCEL_PX = 8;
const MOUSE_ARM_PX = 4;
const GHOST_OFFSET_Y = -40;

type DropTarget =
  | { before: boolean; kind: "item"; target: string }
  | { group: string; kind: "group" };

export class ShortcutDrag {
  private readonly callbacks: ShortcutDragCallbacks;
  private readonly host: HTMLElement;
  private armed = false;
  private drop: DropTarget | null = null;
  private ghost: HTMLElement | null = null;
  private hovered: HTMLElement | null = null;
  private pointerId: number | null = null;
  private source: string | null = null;
  private startX = 0;
  private startY = 0;
  private tile: HTMLElement | null = null;
  private timer: number | null = null;

  private readonly onMove = (event: PointerEvent): void => {
    this.handleMove(event);
  };

  private readonly onUp = (event: PointerEvent): void => {
    this.handleUp(event);
  };

  private readonly blockScroll = (event: Event): void => {
    event.preventDefault();
  };

  /** 長押しではタイル側のメニューを開かせない。 */
  private readonly blockMenu = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  constructor(host: HTMLElement, callbacks: ShortcutDragCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    host.addEventListener("pointerdown", this.handleDown);
  }

  destroy(): void {
    this.finish();
    this.host.removeEventListener("pointerdown", this.handleDown);
  }

  private readonly handleDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const element = event.target as Element | null;
    if (element?.closest(".seiton-shortcut-more")) {
      return;
    }
    const tile = element?.closest<HTMLElement>(
      ".seiton-shortcut[data-link-target]"
    );
    const source = tile?.dataset.linkTarget;
    if (!(tile && source)) {
      return;
    }
    this.finish();
    this.tile = tile;
    this.source = source;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.pointerId = event.pointerId;
    document.addEventListener("pointermove", this.onMove, { passive: false });
    document.addEventListener("pointerup", this.onUp);
    document.addEventListener("pointercancel", this.onUp);
    if (event.pointerType !== "mouse") {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.arm(this.startX, this.startY);
      }, LONG_PRESS_MS);
    }
  };

  private handleMove(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId || this.source === null) {
      return;
    }
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    const distance = Math.hypot(dx, dy);
    if (!this.armed) {
      if (this.timer !== null) {
        if (distance > SCROLL_CANCEL_PX) {
          this.finish();
        }
        return;
      }
      if (distance < MOUSE_ARM_PX) {
        return;
      }
      this.arm(event.clientX, event.clientY);
    }
    event.preventDefault();
    this.moveGhost(event.clientX, event.clientY);
    this.updateTarget(event.clientX, event.clientY);
  }

  private handleUp(event: PointerEvent): void {
    if (event.pointerId !== this.pointerId) {
      return;
    }
    const armed = this.armed;
    const drop = this.drop;
    const source = this.source;
    this.finish();
    if (!(armed && source)) {
      return;
    }
    this.swallowClick();
    if (!drop) {
      return;
    }
    if (drop.kind === "group") {
      this.callbacks.onGroup(source, drop.group);
      return;
    }
    this.callbacks.onItem(source, drop.target, drop.before);
  }

  private arm(x: number, y: number): void {
    this.clearTimer();
    this.armed = true;
    this.tile?.addClass("is-dragging");
    this.ghost = this.createGhost();
    document.body.appendChild(this.ghost);
    this.moveGhost(x, y);
    document.addEventListener("touchmove", this.blockScroll, {
      passive: false,
    });
    document.addEventListener("contextmenu", this.blockMenu, true);
    document.documentElement.addClass("seiton-dragging");
  }

  private updateTarget(x: number, y: number): void {
    this.clearMarks();
    this.drop = null;
    const element = document.elementFromPoint(x, y);
    if (!(element instanceof Element)) {
      return;
    }
    const groupTile = element.closest<HTMLElement>(
      ".seiton-shortcut[data-group-name]"
    );
    const group = groupTile?.dataset.groupName;
    if (groupTile && group) {
      groupTile.addClass("is-drop-target");
      this.hovered = groupTile;
      this.drop = { group, kind: "group" };
      return;
    }
    const itemTile = element.closest<HTMLElement>(
      ".seiton-shortcut[data-link-target]"
    );
    const target = itemTile?.dataset.linkTarget;
    if (!(itemTile && target) || target === this.source) {
      return;
    }
    const rect = itemTile.getBoundingClientRect();
    const before = x < rect.left + rect.width / 2;
    itemTile.addClass(before ? "is-drop-before" : "is-drop-after");
    this.hovered = itemTile;
    this.drop = { before, kind: "item", target };
  }

  private createGhost(): HTMLElement {
    const ghost = document.createElement("div");
    ghost.className = "seiton-shortcut seiton-shortcut-ghost";
    const icon = this.tile?.querySelector(".seiton-shortcut-icon");
    if (icon) {
      ghost.appendChild(icon.cloneNode(true));
    }
    const label = this.tile?.querySelector(".seiton-shortcut-label");
    if (label instanceof HTMLElement) {
      const span = document.createElement("span");
      span.className = "seiton-shortcut-label";
      span.textContent = label.textContent;
      ghost.appendChild(span);
    }
    return ghost;
  }

  private moveGhost(x: number, y: number): void {
    if (!this.ghost) {
      return;
    }
    this.ghost.style.left = `${x}px`;
    this.ghost.style.top = `${y + GHOST_OFFSET_Y}px`;
  }

  private clearMarks(): void {
    this.hovered?.removeClass("is-drop-target");
    this.hovered?.removeClass("is-drop-before");
    this.hovered?.removeClass("is-drop-after");
    this.hovered = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private finish(): void {
    this.clearTimer();
    this.clearMarks();
    this.tile?.removeClass("is-dragging");
    this.ghost?.remove();
    this.ghost = null;
    this.tile = null;
    this.source = null;
    this.armed = false;
    this.drop = null;
    this.pointerId = null;
    document.removeEventListener("pointermove", this.onMove);
    document.removeEventListener("pointerup", this.onUp);
    document.removeEventListener("pointercancel", this.onUp);
    document.removeEventListener("touchmove", this.blockScroll, false);
    document.removeEventListener("contextmenu", this.blockMenu, true);
    document.documentElement.removeClass("seiton-dragging");
  }

  /** ドラッグの直後に来るクリックでURLを開かないようにする。 */
  private swallowClick(): void {
    const swallow = (event: Event): void => {
      event.stopPropagation();
      event.preventDefault();
    };
    document.addEventListener("click", swallow, true);
    window.setTimeout(() => {
      document.removeEventListener("click", swallow, true);
    }, 400);
  }
}
