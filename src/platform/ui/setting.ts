/**
 * Obsidian の `Setting` と `ButtonComponent` の置き換え。
 * 呼び出し側の書き方を変えずに、Seiton の見た目で描く。
 */

import { setIcon } from "obsidian";
import { createSelect, type SelectControl } from "./select";

abstract class BaseComponent<T> {
  protected readonly handlers: Array<(value: T) => void> = [];
  protected disabled = false;

  onChange(callback: (value: T) => void): this {
    this.handlers.push(callback);
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  emit(value: T): void {
    if (this.disabled) {
      return;
    }
    for (const handler of this.handlers) {
      handler(value);
    }
  }
}

export class TextComponent extends BaseComponent<string> {
  readonly inputEl: HTMLInputElement;

  constructor(parent: HTMLElement) {
    super();
    this.inputEl = parent.createEl("input", { cls: "st-input", type: "text" });
    this.inputEl.addEventListener("input", () => this.emit(this.inputEl.value));
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  override setDisabled(value: boolean): this {
    super.setDisabled(value);
    this.inputEl.disabled = value;
    return this;
  }
}

export class TextAreaComponent extends BaseComponent<string> {
  readonly inputEl: HTMLTextAreaElement;

  constructor(parent: HTMLElement) {
    super();
    this.inputEl = parent.createEl("textarea", { cls: "st-textarea" });
    this.inputEl.addEventListener("input", () => this.emit(this.inputEl.value));
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  override setDisabled(value: boolean): this {
    super.setDisabled(value);
    this.inputEl.disabled = value;
    return this;
  }
}

export class ToggleComponent extends BaseComponent<boolean> {
  readonly toggleEl: HTMLButtonElement;
  private checked: boolean;

  constructor(button: HTMLButtonElement, value: boolean) {
    super();
    this.toggleEl = button;
    this.checked = value;
    button.setAttribute("aria-checked", String(value));
    button.addEventListener("click", () => {
      if (this.disabled) {
        return;
      }
      this.checked = !this.checked;
      button.setAttribute("aria-checked", String(this.checked));
      this.emit(this.checked);
    });
  }

  getValue(): boolean {
    return this.checked;
  }

  setValue(value: boolean): this {
    this.checked = value;
    this.toggleEl.setAttribute("aria-checked", String(value));
    return this;
  }
}

export class DropdownComponent extends BaseComponent<string> {
  private readonly control: SelectControl;
  private readonly options: Array<{ label: string; value: string }> = [];

  constructor(control: SelectControl) {
    super();
    this.control = control;
    control.setChoices(this.options);
  }

  addOption(value: string, label: string): this {
    this.options.push({ label, value });
    this.control.setChoices(this.options);
    return this;
  }

  addOptions(record: Record<string, string>): this {
    for (const [value, label] of Object.entries(record)) {
      this.addOption(value, label);
    }
    return this;
  }

  getValue(): string {
    return this.control.value();
  }

  setValue(value: string): this {
    this.control.setValue(value);
    return this;
  }
}

export class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;

  constructor(parent: HTMLElement) {
    this.buttonEl = parent.createEl("button", {
      cls: "st-btn is-secondary",
      type: "button",
    });
  }

  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (event) => {
      if (!this.buttonEl.disabled) {
        callback(event);
      }
    });
    return this;
  }

  setButtonText(value: string): this {
    this.buttonEl.setText(value);
    return this;
  }

  setClass(value: string): this {
    this.buttonEl.addClass(value);
    return this;
  }

  setCta(): this {
    this.buttonEl.removeClass("is-secondary");
    this.buttonEl.addClass("is-primary");
    return this;
  }

  setDisabled(value: boolean): this {
    this.buttonEl.disabled = value;
    return this;
  }

  setIcon(icon: string): this {
    this.buttonEl.empty();
    setIcon(this.buttonEl, icon);
    return this;
  }

  setTooltip(value: string): this {
    this.buttonEl.setAttribute("aria-label", value);
    this.buttonEl.title = value;
    return this;
  }

  setWarning(): this {
    this.buttonEl.removeClass("is-secondary");
    this.buttonEl.addClass("is-danger");
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  private description = "";
  private title = "";

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: "st-field" });
    this.infoEl = this.settingEl.createDiv({ cls: "st-field-head" });
    this.nameEl = this.infoEl.createSpan({ cls: "st-field-label" });
    this.descEl = this.infoEl.createSpan({ cls: "st-field-desc" });
    this.controlEl = this.settingEl.createDiv({ cls: "st-field-control" });
    this.sync();
  }

  addButton(callback: (component: ButtonComponent) => void): this {
    this.settingEl.addClass("is-inline");
    callback(new ButtonComponent(this.controlEl));
    return this;
  }

  addDropdown(callback: (component: DropdownComponent) => void): this {
    let emit: (value: string) => void = () => undefined;
    const control = createSelect({
      choices: [],
      onChange: (value) => emit(value),
      value: "",
    });
    const component = new DropdownComponent(control);
    emit = (value) => component.emit(value);
    this.controlEl.append(control.element);
    callback(component);
    return this;
  }

  addText(callback: (component: TextComponent) => void): this {
    callback(new TextComponent(this.controlEl));
    return this;
  }

  addTextArea(callback: (component: TextAreaComponent) => void): this {
    callback(new TextAreaComponent(this.controlEl));
    return this;
  }

  addToggle(callback: (component: ToggleComponent) => void): this {
    this.settingEl.addClass("is-inline");
    const button = this.controlEl.createEl("button", {
      attr: { role: "switch" },
      cls: "st-switch",
      type: "button",
    });
    callback(new ToggleComponent(button, false));
    return this;
  }

  setClass(value: string): this {
    this.settingEl.addClass(value);
    return this;
  }

  setDesc(value: string): this {
    this.description = value;
    this.sync();
    return this;
  }

  setHeading(): this {
    this.settingEl.addClass("st-section");
    return this;
  }

  setName(value: string): this {
    this.title = value;
    this.sync();
    return this;
  }

  private sync(): void {
    this.nameEl.setText(this.title);
    this.descEl.setText(this.description);
    this.infoEl.style.display =
      this.title === "" && this.description === "" ? "none" : "";
  }
}
