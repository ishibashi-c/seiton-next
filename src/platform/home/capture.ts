import type { App } from "obsidian";
import { VIEW_TYPE_LIBRARY } from "../../config";
import { userMessageOf } from "../../domain/errors";
import type { MemoService } from "../../services/memoService";
import { SeitonLibraryView } from "../libraryView";
import { openSeitonView } from "../seitonNav";

const CAPTURE_DRAFT_KEY = "seiton-next.capture-draft";

export interface HomeCaptureOptions {
  app: App;
  memoService: MemoService;
  onCleared: () => void;
  onRefresh: () => Promise<void> | void;
}

interface LastSaved {
  id: string;
  text: string;
  week: string;
}

export class HomeCapture {
  private readonly app: App;
  private readonly memoService: MemoService;
  private readonly onCleared: () => void;
  private readonly onRefresh: () => Promise<void> | void;
  private buttonEl: HTMLButtonElement | null = null;
  private draft = "";
  private lastSaved: LastSaved | null = null;
  private saving = false;
  private statusEl: HTMLElement | null = null;
  private textareaEl: HTMLTextAreaElement | null = null;

  constructor(options: HomeCaptureOptions) {
    this.app = options.app;
    this.memoService = options.memoService;
    this.onCleared = options.onCleared;
    this.onRefresh = options.onRefresh;
  }

  render(parent: HTMLElement): void {
    this.draft = window.localStorage.getItem(CAPTURE_DRAFT_KEY) ?? this.draft;

    const capture = parent.createDiv({
      cls: "seiton-capture seiton-capture-card",
    });
    capture.createEl("label", {
      attr: { for: "seiton-capture-input" },
      cls: "seiton-capture-label",
      text: "メモ",
    });
    capture.createSpan({
      cls: "seiton-capture-destination",
      text: "保存先: つぶやき（週次メモ）",
    });

    const row = capture.createDiv({ cls: "seiton-capture-row" });
    const textarea = row.createEl("textarea", {
      attr: {
        id: "seiton-capture-input",
        placeholder: "思いついたことを、そのまま。",
        rows: "1",
      },
      cls: "seiton-capture-textarea",
    });
    textarea.spellcheck = false;
    textarea.value = this.draft;
    this.textareaEl = textarea;

    textarea.addEventListener("input", () => {
      this.draft = textarea.value;
      window.localStorage.setItem(CAPTURE_DRAFT_KEY, textarea.value);
      this.setStatus("", "idle");
    });
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void this.save();
      }
    });

    const button = row.createEl("button", {
      cls: "seiton-save-button mod-cta",
      text: "保存",
    });
    button.type = "button";
    button.addEventListener("click", () => {
      void this.save();
    });
    this.buttonEl = button;

    const footer = capture.createDiv({ cls: "seiton-capture-footer" });
    this.statusEl = footer.createSpan({
      cls: "seiton-capture-status",
    });
    this.statusEl.setAttribute("aria-live", "polite");

    const library = footer.createEl("button", {
      cls: "seiton-text-action",
      text: "ライブラリで探す",
      type: "button",
    });
    library.addEventListener("click", () => {
      void this.openLibrarySearch(this.draft.split("\n")[0]?.trim() ?? "");
    });
    footer.createSpan({
      cls: "seiton-keyhint",
      text: "⌘/Ctrl + Enter",
    });
  }

  focus(): void {
    this.textareaEl?.focus();
  }

  reset(): void {
    this.textareaEl = null;
    this.buttonEl = null;
    this.statusEl = null;
    this.lastSaved = null;
  }

  private setStatus(message: string, kind: "idle" | "success" | "error"): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-success", kind === "success");
    this.statusEl.toggleClass("is-error", kind === "error");
  }

  private async undo(): Promise<void> {
    const saved = this.lastSaved;
    if (!saved) {
      this.setStatus("取り消せる保存がありません", "idle");
      return;
    }
    try {
      const { entry } = await this.memoService.readEntry(saved.week, saved.id);
      if (entry.state === "deleted") {
        this.lastSaved = null;
        this.onCleared();
        this.setStatus("すでに取り消されています", "idle");
        return;
      }
      if (entry.state === "promoted") {
        this.setStatus("ノート化済みのため取り消せません", "error");
        return;
      }
      await this.memoService.setMemoDeleted(saved.week, saved.id, true);
      this.lastSaved = null;
      this.onCleared();
      this.draft = saved.text;
      window.localStorage.setItem(CAPTURE_DRAFT_KEY, saved.text);
      if (this.textareaEl) {
        this.textareaEl.value = saved.text;
      }
      this.setStatus("取り消しました。入力を戻しました", "idle");
      await this.onRefresh();
      this.textareaEl?.focus();
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
    }
  }

  private async save(): Promise<void> {
    if (this.saving) {
      return;
    }
    const text = this.draft;
    if (text.trim() === "") {
      this.setStatus("何か入力してください。", "error");
      this.textareaEl?.focus();
      return;
    }

    this.saving = true;
    if (this.buttonEl) {
      this.buttonEl.disabled = true;
    }
    this.setStatus("保存中…", "idle");

    try {
      const result = await this.memoService.addMemo(text);
      this.lastSaved = { id: result.id, text, week: result.week };
      // Only clear what was actually saved; text typed during the write stays.
      if (this.draft === text) {
        this.draft = "";
        window.localStorage.removeItem(CAPTURE_DRAFT_KEY);
        if (this.textareaEl) {
          this.textareaEl.value = "";
        }
      }
      this.setStatus(`保存しました（端末内） · ${result.week}`, "success");
      const undo = this.statusEl?.createEl("button", {
        cls: "seiton-status-undo",
        text: "取り消す",
      });
      undo?.addEventListener("click", () => {
        void this.undo();
      });
      const savedRef = this.lastSaved;
      window.setTimeout(() => {
        if (this.lastSaved === savedRef) {
          this.lastSaved = null;
          this.setStatus("", "idle");
        }
      }, 15_000);
      await this.onRefresh();
      this.textareaEl?.focus();
    } catch (error) {
      this.setStatus(userMessageOf(error), "error");
      this.textareaEl?.focus();
    } finally {
      this.saving = false;
      if (this.buttonEl) {
        this.buttonEl.disabled = false;
      }
    }
  }

  private async openLibrarySearch(query: string): Promise<void> {
    await openSeitonView(this.app, VIEW_TYPE_LIBRARY);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LIBRARY)[0];
    const view = leaf?.view;
    if (view instanceof SeitonLibraryView) {
      await view.setSearch(query);
    }
  }
}
