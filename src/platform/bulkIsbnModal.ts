import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import type { BookCandidate } from "../domain/book";
import { mapWithConcurrency, sleep } from "../domain/concurrency";
import { parseIsbnList } from "../domain/isbnBatch";
import type { BookService } from "../services/bookService";

type RowStatus = "duplicate" | "error" | "loading" | "new";

interface BulkRow {
  candidate: BookCandidate | null;
  isbn: string;
  message: string;
  selected: boolean;
  status: RowStatus;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 複数ISBNをまとめて書誌確認し、選択した本を追加する。 */
export class BulkIsbnModal extends Modal {
  private readonly books: BookService;
  private readonly onDone?: () => void;
  private rows: BulkRow[] = [];
  private input = "";
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private addButton: HTMLButtonElement | null = null;
  private loadButton: HTMLButtonElement | null = null;
  private busy = false;
  private closed = false;
  private invalidCount = 0;

  constructor(app: App, books: BookService, onDone?: () => void) {
    super(app);
    this.books = books;
    this.onDone = onDone;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-bulk-modal");
    this.setTitle("ISBNをまとめて追加");
    this.contentEl.createEl("p", {
      cls: "seiton-bulk-hint",
      text: "ISBNを1行に1つ、またはカンマ区切りで入力します。ハイフン付きでも構いません。登録済みのISBNは除外されます。",
    });

    const field = this.contentEl.createDiv({ cls: "seiton-bulk-field" });
    field.createEl("label", {
      attr: { for: "seiton-bulk-input" },
      cls: "seiton-bulk-label",
      text: "ISBN",
    });
    const textarea = field.createEl("textarea", {
      attr: {
        id: "seiton-bulk-input",
        placeholder: "9784873119243\n9784101010014",
        rows: "5",
      },
      cls: "seiton-bulk-input",
    });
    textarea.addEventListener("input", () => {
      this.input = textarea.value;
    });
    window.setTimeout(() => textarea.focus(), 50);

    const actions = this.contentEl.createDiv({ cls: "seiton-bulk-actions" });
    this.loadButton = actions.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "書誌を確認",
    });
    this.loadButton.addEventListener("click", () => {
      void this.load();
    });

    this.statusEl = this.contentEl.createDiv({ cls: "seiton-bulk-status" });
    this.statusEl.setAttribute("aria-live", "polite");
    this.listEl = this.contentEl.createDiv({ cls: "seiton-bulk-list" });

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const close = footer.createEl("button", {
      attr: { type: "button" },
      text: "閉じる",
    });
    close.addEventListener("click", () => this.close());
    this.addButton = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "選択した本を追加",
    });
    this.addButton.addEventListener("click", () => {
      void this.addSelected();
    });
    this.updateAddButton();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.listEl = null;
    this.statusEl = null;
    this.addButton = null;
    this.loadButton = null;
  }

  private async load(): Promise<void> {
    if (this.busy) {
      return;
    }
    const parsed = parseIsbnList(this.input);
    this.invalidCount = parsed.invalid.length;
    if (parsed.valid.length === 0) {
      this.setStatus(
        parsed.invalid.length > 0
          ? `有効なISBNがありません（無効: ${parsed.invalid.slice(0, 5).join(", ")}）`
          : "ISBNを入力してください。",
        true
      );
      return;
    }

    this.busy = true;
    this.loadButton?.setAttribute("disabled", "true");
    this.loadButton?.setText("確認中…");
    this.rows = parsed.valid.map((isbn) => ({
      candidate: null,
      isbn,
      message: "",
      selected: false,
      status: "loading",
    }));
    this.renderRows();
    this.setStatus(
      `確認中 0/${this.rows.length}${parsed.invalid.length > 0 ? `（無効 ${parsed.invalid.length}件を除外）` : ""}`
    );

    let done = 0;
    await mapWithConcurrency(this.rows, 1, async (row) => {
      if (this.closed) {
        return;
      }
      try {
        const duplicate = await this.books.findDuplicateByIsbn(row.isbn);
        if (duplicate) {
          row.status = "duplicate";
          row.message = `登録済み: ${duplicate.title}`;
        } else {
          const result = await this.books.lookupIsbn(row.isbn);
          row.candidate = result.candidate;
          if (result.candidate) {
            row.status = "new";
            row.selected = true;
            row.message = "新規";
          } else {
            row.status = "error";
            row.message =
              result.attempts.at(-1)?.message ?? "書誌を取得できませんでした。";
          }
        }
      } catch (error) {
        row.status = "error";
        row.message = messageOf(error);
      }
      done += 1;
      this.setStatus(`確認中 ${done}/${this.rows.length}`);
      this.renderRows();
      // 外部APIのレート制限を避けるため、1件ずつ間隔を空ける。
      await sleep(300);
    });

    this.busy = false;
    this.loadButton?.removeAttribute("disabled");
    this.loadButton?.setText("書誌を確認");
    const counts = this.countByStatus();
    this.setStatus(
      `新規 ${counts.new}件 / 登録済み ${counts.duplicate}件 / 失敗 ${counts.error}件${
        this.invalidCount > 0 ? ` / 無効 ${this.invalidCount}件` : ""
      }`
    );
    this.updateAddButton();
  }

  private countByStatus(): Record<RowStatus, number> {
    return this.rows.reduce(
      (counts, row) => {
        counts[row.status] += 1;
        return counts;
      },
      { duplicate: 0, error: 0, loading: 0, new: 0 }
    );
  }

  private renderRows(): void {
    const host = this.listEl;
    if (!host) {
      return;
    }
    host.empty();
    if (this.rows.length === 0) {
      return;
    }
    const table = host.createEl("table", { cls: "seiton-bulk-table" });
    const head = table.createEl("thead").createEl("tr");
    head.createEl("th", { text: "" });
    head.createEl("th", { text: "ISBN" });
    head.createEl("th", { text: "書名・著者" });
    head.createEl("th", { text: "状態" });
    const body = table.createEl("tbody");
    for (const row of this.rows) {
      const tr = body.createEl("tr");
      const checkCell = tr.createEl("td");
      const checkbox = checkCell.createEl("input", {
        attr: { "aria-label": `${row.isbn} を選択`, type: "checkbox" },
      });
      checkbox.checked = row.selected;
      checkbox.disabled = row.status !== "new";
      checkbox.addEventListener("change", () => {
        row.selected = checkbox.checked;
        this.updateAddButton();
      });
      tr.createEl("td", { cls: "seiton-bulk-isbn", text: row.isbn });
      const titleCell = tr.createEl("td");
      if (row.candidate) {
        titleCell.createDiv({
          cls: "seiton-bulk-title",
          text: row.candidate.title || "（書名なし）",
        });
        const meta = [
          row.candidate.authors.join(" / "),
          row.candidate.publisher,
        ]
          .filter(Boolean)
          .join(" · ");
        if (meta) {
          titleCell.createDiv({ cls: "seiton-bulk-author", text: meta });
        }
      } else {
        titleCell.createDiv({ cls: "seiton-bulk-title", text: "—" });
      }
      const statusCell = tr.createEl("td", {
        cls: `seiton-bulk-row-status is-${row.status}`,
        text:
          row.status === "loading"
            ? "確認中…"
            : row.status === "new"
              ? "新規"
              : row.message,
      });
      statusCell.setAttribute("title", row.message);
    }
    this.updateAddButton();
  }

  private async addSelected(): Promise<void> {
    if (this.busy) {
      return;
    }
    const selected = this.rows.filter(
      (row) => row.selected && row.status === "new" && row.candidate
    );
    if (selected.length === 0) {
      this.setStatus("追加する本を選択してください。", true);
      return;
    }
    this.busy = true;
    this.addButton?.setAttribute("disabled", "true");
    this.addButton?.setText("追加中…");
    let added = 0;
    let failed = 0;
    for (const row of selected) {
      const candidate = row.candidate;
      if (!candidate) {
        continue;
      }
      try {
        await this.books.createBook({
          authors: candidate.authors,
          category: candidate.category || null,
          coverUrl: candidate.coverUrl || null,
          isbn: row.isbn,
          published: candidate.published || null,
          publisher: candidate.publisher || null,
          readingStatus: "tbr",
          series: candidate.series || null,
          title: candidate.title,
        });
        added += 1;
        this.rows = this.rows.filter((entry) => entry !== row);
      } catch (error) {
        failed += 1;
        row.status = "error";
        row.message = messageOf(error);
      }
    }
    this.busy = false;
    this.addButton?.removeAttribute("disabled");
    this.addButton?.setText("選択した本を追加");
    this.renderRows();
    this.setStatus(
      `${added}冊を追加しました${failed > 0 ? `（${failed}冊は失敗）` : ""}。`,
      failed > 0
    );
    if (added > 0) {
      new Notice(`${added}冊を追加しました。`);
      this.onDone?.();
    }
    this.updateAddButton();
  }

  private updateAddButton(): void {
    const count = this.rows.filter(
      (row) => row.selected && row.status === "new"
    ).length;
    if (!this.addButton) {
      return;
    }
    this.addButton.setText(
      count > 0 ? `選択した本を追加（${count}）` : "選択した本を追加"
    );
    this.addButton.disabled = this.busy || count === 0;
  }

  private setStatus(message: string, isError = false): void {
    this.statusEl?.setText(message);
    this.statusEl?.toggleClass("is-error", isError);
  }
}
