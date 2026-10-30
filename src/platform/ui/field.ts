/**
 * フォームの部品。`Setting` の代わりに使う。
 * 見出しは入力の上、説明はその下。トグルとチェックは横並び。
 */

import { setIcon } from "obsidian";
import { createSelect, type SelectChoice, type SelectControl } from "./select";

export interface FieldOptions {
  description?: string;
  inline?: boolean;
  label?: string;
}

export interface TextFieldOptions extends FieldOptions {
  onChange?: (value: string) => void;
  placeholder?: string;
  type?: string;
  value?: string;
}

export interface TextAreaFieldOptions extends TextFieldOptions {
  rows?: number;
}

export interface SelectFieldOptions extends FieldOptions {
  choices: SelectChoice[];
  onChange: (value: string) => void;
  value: string;
}

export interface ToggleFieldOptions extends FieldOptions {
  onChange?: (value: boolean) => void;
  value?: boolean;
}

export interface CheckFieldOptions extends FieldOptions {
  checked?: boolean;
  onChange?: (value: boolean) => void;
}

export function fieldRow(
  parent: HTMLElement,
  options: FieldOptions = {}
): HTMLElement {
  const row = parent.createDiv({
    cls: options.inline ? "st-field is-inline" : "st-field",
  });
  if (options.label || options.description) {
    const head = row.createDiv({ cls: "st-field-head" });
    if (options.label) {
      head.createSpan({ cls: "st-field-label", text: options.label });
    }
    if (options.description) {
      head.createSpan({ cls: "st-field-desc", text: options.description });
    }
  }
  return row;
}

export function textField(
  parent: HTMLElement,
  options: TextFieldOptions = {}
): HTMLInputElement {
  const row = fieldRow(parent, options);
  const input = row.createEl("input", { cls: "st-input", type: "text" });
  if (options.type) {
    input.type = options.type;
  }
  input.value = options.value ?? "";
  if (options.placeholder) {
    input.placeholder = options.placeholder;
  }
  if (options.onChange) {
    input.addEventListener("input", () => options.onChange?.(input.value));
  }
  return input;
}

export function textAreaField(
  parent: HTMLElement,
  options: TextAreaFieldOptions = {}
): HTMLTextAreaElement {
  const row = fieldRow(parent, options);
  const area = row.createEl("textarea", { cls: "st-textarea" });
  area.value = options.value ?? "";
  area.rows = options.rows ?? 3;
  if (options.placeholder) {
    area.placeholder = options.placeholder;
  }
  if (options.onChange) {
    area.addEventListener("input", () => options.onChange?.(area.value));
  }
  return area;
}

export function selectField(
  parent: HTMLElement,
  options: SelectFieldOptions
): SelectControl {
  const row = fieldRow(parent, options);
  const select = createSelect({
    choices: options.choices,
    onChange: options.onChange,
    value: options.value,
  });
  row.append(select.element);
  return select;
}

export function toggleField(
  parent: HTMLElement,
  options: ToggleFieldOptions = {}
): HTMLButtonElement {
  const row = fieldRow(parent, { ...options, inline: true });
  const button = row.createEl("button", {
    attr: { role: "switch" },
    cls: "st-switch",
    type: "button",
  });
  const set = (value: boolean): void => {
    button.setAttribute("aria-checked", String(value));
  };
  set(Boolean(options.value));
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    set(next);
    options.onChange?.(next);
  });
  return button;
}

const CHECK_ICON = "check";

export function checkboxField(
  parent: HTMLElement,
  options: CheckFieldOptions = {}
): HTMLButtonElement {
  const button = parent.createEl("button", {
    attr: { role: "checkbox" },
    cls: "st-check",
    type: "button",
  });
  const box = button.createSpan({ cls: "st-check-box" });
  setIcon(box, CHECK_ICON);
  button.createSpan({ text: options.label ?? "" });
  const set = (value: boolean): void => {
    button.setAttribute("aria-checked", String(value));
  };
  set(Boolean(options.checked));
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    set(next);
    options.onChange?.(next);
  });
  return button;
}

export interface ButtonOptions {
  label: string;
  onClick: () => void;
  start?: boolean;
  tone?: "danger" | "danger-solid" | "ghost" | "primary" | "secondary";
}

export function button(
  parent: HTMLElement,
  options: ButtonOptions
): HTMLButtonElement {
  const element = parent.createEl("button", {
    cls: `st-btn is-${options.tone ?? "primary"}`,
    text: options.label,
    type: "button",
  });
  if (options.start) {
    element.addClass("is-start");
  }
  element.addEventListener("click", options.onClick);
  return element;
}
