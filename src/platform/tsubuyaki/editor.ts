import { userMessageOf } from "../../domain/errors";
import { clockOf } from "../../domain/time";
import type { MemoListItem, MemoService } from "../../services/memoService";

export interface TsubuyakiEditorOptions {
  memoService: MemoService;
  onChanged: () => void;
}

export class TsubuyakiEditor {
  private readonly memoService: MemoService;
  private readonly onChanged: () => void;
  private editingId: string | null = null;

  constructor(options: TsubuyakiEditorOptions) {
    this.memoService = options.memoService;
    this.onChanged = options.onChanged;
  }

  begin(id: string): boolean {
    if (this.editingId !== null && this.editingId !== id) {
      return false;
    }
    this.editingId = id;
    return true;
  }

  isEditing(id: string): boolean {
    return this.editingId === id;
  }

  reset(): void {
    this.editingId = null;
  }

  focus(): void {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      "[data-editing='true'] textarea"
    );
    textarea?.focus();
    const length = textarea?.value.length ?? 0;
    textarea?.setSelectionRange(length, length);
  }

  render(parent: HTMLElement, item: MemoListItem): void {
    const row = parent.createDiv({ cls: "seiton-tsubuyaki-row is-editing" });
    row.dataset.id = item.entry.id;
    row.dataset.editing = "true";

    row.createEl("time", {
      cls: "seiton-tsubuyaki-time",
      text: clockOf(item.entry.at) || "--:--",
    });

    const main = row.createDiv({ cls: "seiton-tsubuyaki-main" });
    const textarea = main.createEl("textarea", {
      attr: { "aria-label": "つぶやきを編集", rows: "4" },
      cls: "seiton-tsubuyaki-edit",
    });
    textarea.value = item.entry.body;
    const footer = main.createDiv({ cls: "seiton-tsubuyaki-edit-foot" });
    const status = footer.createSpan({ cls: "seiton-tsubuyaki-status" });
    status.setAttribute("aria-live", "polite");
    const cancel = footer.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "キャンセル",
    });
    const save = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "保存",
    });

    let busy = false;
    const finish = (): void => {
      this.editingId = null;
      this.onChanged();
    };
    const submit = async (): Promise<void> => {
      if (busy) {
        return;
      }
      const text = textarea.value;
      if (text.trim() === "") {
        status.setText("本文を入力してください。");
        status.addClass("is-error");
        textarea.focus();
        return;
      }
      busy = true;
      save.disabled = true;
      cancel.disabled = true;
      status.removeClass("is-error");
      status.setText("保存中…");
      try {
        const updated = await this.memoService.updateMemoBody(
          item.week,
          item.entry.id,
          text
        );
        item.entry = updated;
        finish();
      } catch (error) {
        busy = false;
        save.disabled = false;
        cancel.disabled = false;
        status.setText(userMessageOf(error));
        status.addClass("is-error");
        textarea.focus();
      }
    };

    cancel.addEventListener("click", finish);
    save.addEventListener("click", () => {
      void submit();
    });
    textarea.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    });
    window.setTimeout(() => {
      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
    }, 0);
  }
}
