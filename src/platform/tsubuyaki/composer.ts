import type { App } from "obsidian";
import { userMessageOf } from "../../domain/errors";
import { clockOf } from "../../domain/time";
import type { MemoService } from "../../services/memoService";

const DRAFT_KEY = "seiton-next.capture-draft";

export type ComposerStatusKind = "error" | "idle" | "success";

export interface TsubuyakiComposerOptions {
  app: App;
  memoService: MemoService;
  onSaved: () => Promise<void>;
}

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(value: string): void {
  try {
    if (value === "") {
      window.localStorage.removeItem(DRAFT_KEY);
    } else {
      window.localStorage.setItem(DRAFT_KEY, value);
    }
  } catch {
    // 保存できない環境でも入力は続けられる。
  }
}

/** つぶやきページの入力欄。下書き、保存、状態表示だけを持つ。 */
export class TsubuyakiComposer {
  private readonly memoService: MemoService;
  private readonly onSaved: () => Promise<void>;
  private value = "";
  private saving = false;
  private inputEl: HTMLTextAreaElement | null = null;
  private saveButtonEl: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(options: TsubuyakiComposerOptions) {
    // app は呼び出し側の画面コンテキストを表す。入力欄自身は使わない。
    void options.app;
    this.memoService = options.memoService;
    this.onSaved = options.onSaved;
    this.value = readDraft();
  }

  render(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "seiton-tsubuyaki-compose" });
    const textarea = card.createEl("textarea", {
      attr: {
        "aria-label": "つぶやきを書く",
        placeholder: "思いついたことを、そのまま。",
        rows: "1",
      },
      cls: "seiton-tsubuyaki-input",
    });
    textarea.spellcheck = false;
    textarea.value = this.value;
    this.inputEl = textarea;

    const footer = card.createDiv({ cls: "seiton-tsubuyaki-compose-foot" });
    footer.createSpan({ cls: "seiton-keyhint", text: "⌘/Ctrl + Enter" });
    const save = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta seiton-tsubuyaki-save",
      text: "保存",
    });
    save.disabled = this.value.trim() === "";
    save.addEventListener("click", () => {
      void this.submit();
    });
    this.saveButtonEl = save;

    this.statusEl = card.createDiv({ cls: "seiton-tsubuyaki-status" });
    this.statusEl.setAttribute("aria-live", "polite");

    const resize = (): void => {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    };
    textarea.addEventListener("input", () => {
      this.value = textarea.value;
      writeDraft(this.value);
      save.disabled = this.value.trim() === "";
      this.setStatus("", "idle");
      resize();
    });
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void this.submit();
      }
    });
    window.setTimeout(resize, 0);
  }

  setStatus(message: string, kind: ComposerStatusKind): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-success", kind === "success");
    this.statusEl.toggleClass("is-error", kind === "error");
  }

  focus(): void {
    this.inputEl?.focus();
  }

  private async submit(): Promise<void> {
    if (this.saving) {
      return;
    }
    const text = this.value;
    if (text.trim() === "") {
      this.setStatus("何か入力してください。", "error");
      this.inputEl?.focus();
      return;
    }
    this.saving = true;
    if (this.saveButtonEl) {
      this.saveButtonEl.disabled = true;
    }
    this.setStatus("保存中…", "idle");
    try {
      const result = await this.memoService.addMemo(text);
      if (this.value === text) {
        this.value = "";
        writeDraft("");
        if (this.inputEl) {
          this.inputEl.value = "";
          this.inputEl.style.height = "auto";
        }
      }
      this.setStatus(`保存しました ${clockOf(result.at)}`, "success");
      await this.onSaved();
      this.inputEl?.focus();
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
      this.inputEl?.focus();
    } finally {
      this.saving = false;
      if (this.saveButtonEl) {
        this.saveButtonEl.disabled = this.value.trim() === "";
      }
    }
  }
}
