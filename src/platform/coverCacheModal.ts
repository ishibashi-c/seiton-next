import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import { mapWithConcurrency } from "../domain/concurrency";
import { type CoverCacheAnalysis, formatBytes } from "../domain/coverCache";
import type { BookService } from "../services/bookService";
import type { CoverStore } from "../services/coverStore";
import type { NoteRecord } from "../services/vaultIndex";

/** 表紙キャッシュの統計・削除・再取得。 */
export class CoverCacheModal extends Modal {
  private readonly store: CoverStore;
  private readonly books: BookService;
  private readonly records: NoteRecord[];
  private readonly onDone: () => void;
  private statsEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private removeOrphansButton: HTMLButtonElement | null = null;
  private removeAllButton: HTMLButtonElement | null = null;
  private repairButton: HTMLButtonElement | null = null;
  private busy = false;
  private closed = false;

  constructor(
    app: App,
    store: CoverStore,
    books: BookService,
    records: NoteRecord[],
    onDone: () => void
  ) {
    super(app);
    this.store = store;
    this.books = books;
    this.records = records;
    this.onDone = onDone;
  }

  override onOpen(): void {
    this.modalEl.addClass("seiton-cover-modal");
    this.setTitle("表紙キャッシュ管理");
    this.contentEl.createEl("p", {
      cls: "seiton-bulk-hint",
      text: "表紙は Seiton/System/Assets/Covers に保存されます。削除しても本の情報は残り、表紙は仮表紙に戻ります。",
    });
    this.statsEl = this.contentEl.createDiv({ cls: "seiton-cover-stats" });
    this.listEl = this.contentEl.createDiv({ cls: "seiton-cover-list" });

    const actions = this.contentEl.createDiv({ cls: "seiton-cover-actions" });
    this.removeOrphansButton = actions.createEl("button", {
      attr: { type: "button" },
      text: "未使用の表紙を削除",
    });
    this.removeOrphansButton.addEventListener("click", () => {
      this.confirm(this.removeOrphansButton, "未使用の表紙を削除", () => {
        void this.removeOrphans();
      });
    });
    this.removeAllButton = actions.createEl("button", {
      attr: { type: "button" },
      cls: "mod-warning",
      text: "すべての表紙を削除",
    });
    this.removeAllButton.addEventListener("click", () => {
      this.confirm(this.removeAllButton, "すべての表紙を削除", () => {
        void this.removeAll();
      });
    });
    this.repairButton = actions.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "表紙がない本を再取得",
    });
    this.repairButton.addEventListener("click", () => {
      void this.repair();
    });

    this.statusEl = this.contentEl.createDiv({
      cls: "seiton-cover-status",
    });
    this.statusEl.setAttribute("aria-live", "polite");

    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const close = footer.createEl("button", {
      attr: { type: "button" },
      text: "閉じる",
    });
    close.addEventListener("click", () => this.close());

    void this.load();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.statsEl = null;
    this.listEl = null;
    this.statusEl = null;
    this.removeOrphansButton = null;
    this.removeAllButton = null;
    this.repairButton = null;
  }

  private async load(): Promise<void> {
    const [analysis] = await Promise.all([this.store.analyze()]);
    const missing = this.store.missingCovers(this.records);
    this.renderStats(analysis, missing.length);
    this.renderList(analysis);
    this.updateButtons(analysis, missing.length);
  }

  private renderStats(
    analysis: CoverCacheAnalysis,
    missingCount: number
  ): void {
    const host = this.statsEl;
    if (!host) {
      return;
    }
    host.empty();
    const row = (label: string, value: string, sub = ""): void => {
      const cell = host.createDiv({ cls: "seiton-cover-stat" });
      cell.createDiv({ cls: "seiton-cover-stat-label", text: label });
      cell.createDiv({ cls: "seiton-cover-stat-value", text: value });
      if (sub) {
        cell.createDiv({ cls: "seiton-cover-stat-sub", text: sub });
      }
    };
    row(
      "保存済み",
      `${analysis.files.length}枚`,
      formatBytes(analysis.totalBytes)
    );
    row(
      "未使用",
      `${analysis.orphans.length}枚`,
      formatBytes(analysis.orphanBytes)
    );
    row("表紙なし", `${missingCount}冊`, "ISBNのある本");
  }

  private renderList(analysis: CoverCacheAnalysis): void {
    const host = this.listEl;
    if (!host) {
      return;
    }
    host.empty();
    if (analysis.orphans.length === 0) {
      return;
    }
    host.createDiv({
      cls: "seiton-cover-list-title",
      text: "未使用の表紙",
    });
    for (const file of analysis.orphans.slice(0, 8)) {
      const row = host.createDiv({ cls: "seiton-cover-file" });
      row.createSpan({
        cls: "seiton-cover-file-name",
        text: file.path.split("/").at(-1) ?? file.path,
      });
      row.createSpan({
        cls: "seiton-cover-file-size",
        text: formatBytes(file.size),
      });
    }
    if (analysis.orphans.length > 8) {
      host.createDiv({
        cls: "seiton-cover-file-more",
        text: `ほか ${analysis.orphans.length - 8}件`,
      });
    }
  }

  private updateButtons(
    analysis: CoverCacheAnalysis,
    missingCount: number
  ): void {
    if (this.removeOrphansButton) {
      this.removeOrphansButton.disabled =
        this.busy || analysis.orphans.length === 0;
    }
    if (this.removeAllButton) {
      this.removeAllButton.disabled = this.busy || analysis.files.length === 0;
    }
    if (this.repairButton) {
      this.repairButton.disabled = this.busy || missingCount === 0;
      this.repairButton.setText(
        missingCount > 0
          ? `表紙がない本を再取得（${missingCount}）`
          : "表紙がない本を再取得"
      );
    }
  }

  private async removeOrphans(): Promise<void> {
    this.busy = true;
    this.setStatus("削除中…");
    try {
      const removed = await this.store.removeOrphans();
      new Notice(`${removed}枚の未使用の表紙を削除しました。`);
      this.onDone();
      await this.load();
      this.setStatus(`${removed}枚を削除しました。`);
    } finally {
      this.busy = false;
    }
  }

  private async removeAll(): Promise<void> {
    this.busy = true;
    this.setStatus("削除中…");
    try {
      const removed = await this.store.removeAll();
      new Notice(`${removed}枚の表紙を削除しました。`);
      this.onDone();
      await this.load();
      this.setStatus(`${removed}枚を削除しました。表紙は仮表紙になります。`);
    } finally {
      this.busy = false;
    }
  }

  private async repair(): Promise<void> {
    const missing = this.store.missingCovers(this.records);
    if (missing.length === 0 || this.busy) {
      return;
    }
    this.busy = true;
    this.updateButtons(
      { files: [], orphanBytes: 0, orphans: [], totalBytes: 0 },
      missing.length
    );
    let done = 0;
    let downloaded = 0;
    this.setStatus(`再取得中 0/${missing.length}`);
    await mapWithConcurrency(missing, 2, async (record) => {
      if (this.closed) {
        return;
      }
      try {
        const result = await this.books.refreshCover(record);
        if (result.downloaded) {
          downloaded += 1;
        }
      } catch {
        // 個別の失敗は件数だけで扱う。
      }
      done += 1;
      this.setStatus(`再取得中 ${done}/${missing.length}`);
    });
    this.busy = false;
    this.onDone();
    await this.load();
    this.setStatus(
      `${downloaded}冊の表紙を再取得しました（${missing.length - downloaded}冊は取得できませんでした）。`
    );
  }

  private confirm(
    button: HTMLButtonElement | null,
    label: string,
    action: () => void
  ): void {
    if (!button) {
      return;
    }
    if (button.dataset.armed === "1") {
      button.dataset.armed = "0";
      button.setText(label);
      action();
      return;
    }
    button.dataset.armed = "1";
    button.setText("もう一度押すと実行");
    window.setTimeout(() => {
      if (button.isConnected && button.dataset.armed === "1") {
        button.dataset.armed = "0";
        button.setText(label);
      }
    }, 4000);
  }

  private setStatus(message: string): void {
    this.statusEl?.setText(message);
  }
}
