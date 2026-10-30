import { Notice } from "obsidian";
import type { PropertyService } from "../../services/propertyService";

export class LibrarySelection {
  mode = false;
  readonly selected = new Set<string>();
  private bar: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private toggleButton: HTMLButtonElement | null = null;
  private readonly properties: PropertyService;
  private readonly refresh: () => void;

  constructor(properties: PropertyService, refresh: () => void) {
    this.properties = properties;
    this.refresh = refresh;
  }

  mount(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "seiton-selection-bar" });
    this.bar = bar;
    this.countEl = bar.createSpan({ cls: "seiton-selection-count" });
    const pin = bar.createEl("button", {
      attr: { "data-bulk": "true", type: "button" },
      cls: "seiton-text-action",
      text: "ピン",
    });
    pin.addEventListener("click", () => {
      void this.apply({ pinned: true });
    });
    const archive = bar.createEl("button", {
      attr: { "data-bulk": "true", type: "button" },
      cls: "seiton-text-action",
      text: "アーカイブ",
    });
    archive.addEventListener("click", () => {
      void this.apply({ archived: true });
    });
    const clear = bar.createEl("button", {
      attr: { "data-bulk": "true", type: "button" },
      cls: "seiton-text-action",
      text: "選択を解除",
    });
    clear.addEventListener("click", () => this.clear());
    this.update();
  }

  bindToggle(button: HTMLButtonElement): void {
    this.toggleButton = button;
    button.addEventListener("click", () => {
      this.mode = !this.mode;
      this.selected.clear();
      button.setText(this.mode ? "選択を終了" : "選択");
      button.classList.toggle("is-active", this.mode);
      this.update();
      this.refresh();
    });
  }

  toggle(path: string, button: HTMLElement): void {
    const active = !this.selected.has(path);
    if (active) {
      this.selected.add(path);
    } else {
      this.selected.delete(path);
    }
    button.classList.toggle("is-selected", active);
    button.setAttribute("aria-pressed", String(active));
    this.update();
  }

  clear(): void {
    this.selected.clear();
    this.update();
    this.refresh();
  }

  reset(): void {
    this.mode = false;
    this.selected.clear();
    this.toggleButton = null;
    this.bar = null;
    this.countEl = null;
  }

  update(): void {
    if (!this.bar) {
      return;
    }
    this.bar.classList.toggle("is-visible", this.mode);
    this.countEl?.setText(`${this.selected.size}件選択`);
    for (const button of Array.from(
      this.bar.querySelectorAll<HTMLButtonElement>("[data-bulk]")
    )) {
      button.disabled = this.selected.size === 0;
    }
  }

  private async apply(patch: {
    pinned?: boolean;
    archived?: boolean;
  }): Promise<void> {
    if (this.selected.size === 0) {
      return;
    }
    let updated = 0;
    let failed = 0;
    for (const path of Array.from(this.selected)) {
      try {
        await this.properties.update(path, patch);
        updated += 1;
      } catch {
        failed += 1;
      }
    }
    this.selected.clear();
    this.mode = false;
    this.toggleButton?.setText("選択");
    this.toggleButton?.removeClass("is-active");
    this.update();
    this.refresh();
    if (failed > 0) {
      new Notice(`${updated}件を更新、${failed}件は更新できませんでした。`);
    } else {
      new Notice(`${updated}件を更新しました。`);
    }
  }
}
