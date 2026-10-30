import type { App } from "obsidian";
import { Modal } from "obsidian";
import {
  type CalilBranch,
  calilAvailableCount,
  calilBestBranch,
  calilBookUrl,
  calilHoldingCount,
  calilLibraryPageUrl,
  calilMapUrl,
} from "../domain/calil";
import { mapWithConcurrency } from "../domain/concurrency";
import { isAllowedRemoteUrl } from "../domain/network";
import type { BookService, CalilSearchResult } from "../services/bookService";
import type { CalilLastResult, SeitonSettings } from "../services/settings";
import type { NoteRecord } from "../services/vaultIndex";
import { markSeitonModal } from "./ui/modal";
import { createSelect, type SelectControl } from "./ui/select";

import { showToast } from "./ui/toast";

type RowStatus = "cached" | "done" | "error" | "idle" | "running";
type Filter = "all" | "available" | "error" | "held" | "idle" | "unavailable";
type Sort = "available" | "configured" | "title";

interface CalilRow {
  expanded: boolean;
  isbn: string;
  message: string;
  record: NoteRecord;
  result?: CalilSearchResult;
  selected: boolean;
  status: RowStatus;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

/** 選択した本をカーリルで一括検索し、館ごとの結果を確認する。 */
export class CalilBulkModal extends Modal {
  private readonly books: BookService;
  private filter: Filter = "all";
  private filterEl: HTMLElement | null = null;
  private readonly getSettings: () => SeitonSettings;
  private readonly rows: CalilRow[];
  private listEl: HTMLElement | null = null;
  private runButton: HTMLButtonElement | null = null;
  private readonly saveSettings: (
    patch: Partial<SeitonSettings>
  ) => Promise<void>;
  private sort: Sort = "configured";
  private sortEl: SelectControl | null = null;
  private statusEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private busy = false;
  private closed = false;

  constructor(
    app: App,
    books: BookService,
    records: NoteRecord[],
    getSettings: () => SeitonSettings,
    saveSettings: (patch: Partial<SeitonSettings>) => Promise<void>
  ) {
    super(app);
    this.books = books;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.rows = records
      .filter((record) => (record.book.book_isbn ?? "").trim() !== "")
      .map((record) => ({
        expanded: false,
        isbn: (record.book.book_isbn ?? "").trim(),
        message: "",
        record,
        selected: true,
        status: "idle" as const,
      }));
    const cached = getSettings().calilLastResults;
    for (const row of this.rows) {
      const last = cached[row.isbn];
      if (last) {
        row.status = "cached";
        row.message = formatLastResult(last);
      }
    }
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-calil-modal");
    this.setTitle("カーリルで一括検索");
    this.contentEl.createEl("p", {
      cls: "seiton-bulk-hint",
      text: "選択した本のISBNで、設定した図書館の蔵書を検索します。結果は時間で変わるため、取得日時とあわせて確認してください。",
    });
    if (this.rows.some((row) => row.status === "cached")) {
      this.contentEl.createEl("p", {
        cls: "seiton-calil-cached-note",
        text: "前回の結果を表示しています。「検索を開始」で更新します。",
      });
    }

    const settings = this.getSettings();
    if ((settings.calilApiKey ?? "").trim() === "") {
      this.renderWarning(
        "カーリルのAPIキーが未設定です。設定画面で入力してください。"
      );
    } else if ((settings.calilLibrary ?? "").trim() === "") {
      this.renderWarning(
        "カーリルの図書館ID（systemid）が未設定です。設定画面で入力してください。"
      );
    }

    if (this.rows.length === 0) {
      this.contentEl.createEl("p", {
        cls: "seiton-empty",
        text: "ISBNのある本がありません。",
      });
      this.renderFooter();
      return;
    }

    const toolbar = this.contentEl.createDiv({ cls: "seiton-calil-toolbar" });
    const all = toolbar.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "すべて選択",
    });
    all.addEventListener("click", () => {
      for (const row of this.rows) {
        row.selected = true;
      }
      this.renderRows();
      this.updateRunButton();
    });
    const none = toolbar.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "選択を解除",
    });
    none.addEventListener("click", () => {
      for (const row of this.rows) {
        row.selected = false;
      }
      this.renderRows();
      this.updateRunButton();
    });
    this.runButton = toolbar.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "検索を開始",
    });
    this.runButton.addEventListener("click", () => {
      void this.run();
    });
    this.statusEl = toolbar.createDiv({ cls: "seiton-calil-progress" });
    this.statusEl.setAttribute("aria-live", "polite");

    this.summaryEl = this.contentEl.createDiv({
      cls: "seiton-calil-summary",
    });
    this.filterEl = this.contentEl.createDiv({ cls: "seiton-calil-filters" });
    this.renderFilters();

    const sortRow = this.contentEl.createDiv({ cls: "seiton-calil-sort" });
    sortRow.createSpan({ cls: "seiton-calil-sort-label", text: "並び順" });
    this.sortEl = createSelect({
      choices: [
        { label: "設定した図書館順", value: "configured" },
        { label: "貸出可が多い順", value: "available" },
        { label: "書名順", value: "title" },
      ],
      onChange: (value) => {
        this.sort =
          value === "title"
            ? "title"
            : value === "available"
              ? "available"
              : "configured";
        this.renderRows();
      },
      value: this.sort,
    });
    this.sortEl.element.addClass("seiton-calil-sort-select");
    this.sortEl.element.addClass("is-quiet");
    sortRow.append(this.sortEl.element);

    this.listEl = this.contentEl.createDiv({ cls: "seiton-calil-list" });
    this.renderRows();
    this.updateRunButton();
    this.renderFooter();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.filterEl = null;
    this.listEl = null;
    this.sortEl = null;
    this.statusEl = null;
    this.summaryEl = null;
    this.runButton = null;
  }

  private renderFooter(): void {
    const footer = this.contentEl.createDiv({ cls: "seiton-modal-footer" });
    const close = footer.createEl("button", {
      attr: { type: "button" },
      text: "閉じる",
    });
    close.addEventListener("click", () => this.close());
  }

  private renderWarning(message: string): void {
    const warning = this.contentEl.createDiv({ cls: "seiton-calil-warning" });
    warning.createSpan({ text: message });
    const open = warning.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-text-action",
      text: "設定を開く",
    });
    open.addEventListener("click", () => this.openSettings());
  }

  private renderFilters(): void {
    const host = this.filterEl;
    if (!host) {
      return;
    }
    host.empty();
    const choices: Array<{ id: Filter; label: string }> = [
      { id: "all", label: "すべて" },
      { id: "available", label: "貸出可" },
      { id: "held", label: "蔵書あり" },
      { id: "unavailable", label: "見つからない" },
      { id: "error", label: "失敗" },
      { id: "idle", label: "未検索" },
    ];
    for (const choice of choices) {
      const count = this.rows.filter((row) =>
        this.matchesFilter(row, choice.id)
      ).length;
      const button = host.createEl("button", {
        attr: {
          "aria-pressed": this.filter === choice.id ? "true" : "false",
          type: "button",
        },
        cls: `seiton-calil-chip${this.filter === choice.id ? " is-active" : ""}`,
        text: `${choice.label} ${count}`,
      });
      button.addEventListener("click", () => {
        this.filter = choice.id;
        this.renderFilters();
        this.renderRows();
      });
    }
  }

  private matchesFilter(row: CalilRow, filter: Filter): boolean {
    if (filter === "all") {
      return true;
    }
    if (filter === "available") {
      return Boolean(
        row.result && calilAvailableCount(row.result.branches) > 0
      );
    }
    if (filter === "unavailable") {
      return Boolean(
        row.result && calilAvailableCount(row.result.branches) === 0
      );
    }
    if (filter === "error") {
      return row.status === "error";
    }
    return row.status === "idle";
  }

  private visibleRows(): CalilRow[] {
    const rows = this.rows.filter((row) =>
      this.matchesFilter(row, this.filter)
    );
    return rows.sort((left, right) => {
      if (this.sort === "title") {
        return left.record.title.localeCompare(right.record.title, "ja");
      }
      if (this.sort === "available") {
        const diff =
          calilAvailableCount(right.result?.branches ?? []) -
          calilAvailableCount(left.result?.branches ?? []);
        if (diff !== 0) {
          return diff;
        }
      }
      return left.record.title.localeCompare(right.record.title, "ja");
    });
  }

  private renderRows(): void {
    const host = this.listEl;
    if (!host) {
      return;
    }
    host.empty();
    this.renderSummary();
    this.renderFilters();
    const rows = this.visibleRows();
    if (rows.length === 0) {
      host.createDiv({
        cls: "seiton-calil-empty",
        text: "この条件に合う本はありません。",
      });
      return;
    }
    for (const row of rows) {
      const entry = host.createDiv({ cls: "seiton-calil-entry" });
      const item = entry.createDiv({ cls: "seiton-calil-row" });
      const checkbox = item.createEl("input", {
        attr: {
          "aria-label": `${row.record.title} を検索`,
          type: "checkbox",
        },
      });
      checkbox.checked = row.selected;
      checkbox.addEventListener("change", () => {
        row.selected = checkbox.checked;
        this.updateRunButton();
      });

      const body = item.createDiv({ cls: "seiton-calil-row-body" });
      body.createDiv({ cls: "seiton-calil-title", text: row.record.title });
      body.createDiv({ cls: "seiton-calil-meta", text: row.isbn });
      this.renderRowSummary(body, row);

      const badge = item.createDiv({
        cls: `seiton-calil-badge is-${this.rowCategory(row)}`,
        text: this.rowBadge(row),
      });
      badge.setAttribute("title", row.message);

      const expand = item.createEl("button", {
        attr: {
          "aria-expanded": String(row.expanded),
          type: "button",
        },
        cls: "seiton-calil-expand",
        text: row.expanded ? "閉じる" : "詳細",
      });
      expand.disabled = !row.result;
      expand.addEventListener("click", () => {
        row.expanded = !row.expanded;
        this.renderRows();
      });

      if (row.expanded && row.result) {
        this.renderDetails(entry, row.result);
      }
    }
  }

  private renderRowSummary(parent: HTMLElement, row: CalilRow): void {
    if (!row.result) {
      parent.createDiv({
        cls: "seiton-calil-location",
        text: row.message || "未検索",
      });
      return;
    }
    const best = calilBestBranch(row.result.branches);
    if (!best) {
      parent.createDiv({
        cls: "seiton-calil-location",
        text: "蔵書情報を取得できませんでした",
      });
      return;
    }
    const more = row.result.branches.length - 1;
    parent.createDiv({
      cls: "seiton-calil-location",
      text: `${best.formal || best.libkey} · ${best.state}${
        more > 0 ? ` · ほか${more}館` : ""
      }`,
    });
    if (best.address !== "") {
      parent.createDiv({
        cls: "seiton-calil-address",
        text: best.address,
      });
    }
  }

  private renderDetails(parent: HTMLElement, result: CalilSearchResult): void {
    const details = parent.createDiv({ cls: "seiton-calil-details" });
    const head = details.createDiv({ cls: "seiton-calil-details-head" });
    head.createSpan({
      cls: "seiton-calil-details-title",
      text: "館ごとの蔵書",
    });
    this.appendLink(head, calilBookUrl(result.isbn), "カーリルで見る");

    if (result.branches.length === 0) {
      details.createDiv({
        cls: "seiton-calil-empty",
        text: "蔵書情報が見つかりませんでした。",
      });
      return;
    }
    for (const branch of result.branches) {
      this.renderBranch(details, branch);
    }
  }

  private renderBranch(parent: HTMLElement, branch: CalilBranch): void {
    const item = parent.createDiv({ cls: "seiton-calil-branch" });
    const head = item.createDiv({ cls: "seiton-calil-branch-head" });
    head.createSpan({
      cls: "seiton-calil-system",
      text: branch.systemname,
    });
    if (branch.configured) {
      head.createSpan({
        cls: "seiton-calil-configured",
        text: "設定した図書館",
      });
    }
    head.createSpan({
      cls: `seiton-calil-state is-${this.stateClass(branch.state)}`,
      text: branch.libkey ? `${branch.libkey}: ${branch.state}` : branch.state,
    });
    if (branch.formal !== "" && branch.formal !== branch.libkey) {
      item.createDiv({ cls: "seiton-calil-formal", text: branch.formal });
    }
    if (branch.address !== "") {
      item.createDiv({ cls: "seiton-calil-address", text: branch.address });
    }
    const actions = item.createDiv({ cls: "seiton-calil-links" });
    this.appendLink(actions, calilLibraryPageUrl(branch), "カーリル");
    this.appendLink(actions, calilMapUrl(branch), "地図");
    if (branch.reserveUrl !== "") {
      this.appendLink(actions, branch.reserveUrl, "予約");
    }
  }

  private appendLink(parent: HTMLElement, href: string, label: string): void {
    if (!isAllowedRemoteUrl(href)) {
      return;
    }
    const link = parent.createEl("a", {
      cls: "seiton-calil-link",
      href,
      text: label,
    });
    link.setAttr("rel", "noopener noreferrer");
    link.setAttr("target", "_blank");
  }

  private renderSummary(): void {
    if (!this.summaryEl) {
      return;
    }
    const done = this.rows.filter((row) => row.result).length;
    const available = this.rows.filter(
      (row) => row.result && calilAvailableCount(row.result.branches) > 0
    ).length;
    const held = this.rows.filter((row) => {
      if (!row.result) {
        return false;
      }
      return (
        calilAvailableCount(row.result.branches) === 0 &&
        calilHoldingCount(row.result.branches) > 0
      );
    }).length;
    this.summaryEl.setText(
      done === 0
        ? `${this.rows.length}冊を検索できます`
        : `全体: 検索済み ${done}/${this.rows.length}冊 · 貸出可 ${available}冊 · 蔵書あり ${held}冊`
    );
  }

  private rowCategory(
    row: CalilRow
  ):
    | "available"
    | "cached"
    | "error"
    | "held"
    | "idle"
    | "running"
    | "unavailable" {
    if (row.status === "error") {
      return "error";
    }
    if (row.status === "running") {
      return "running";
    }
    if (row.status === "cached") {
      return "cached";
    }
    if (!row.result) {
      return "idle";
    }
    if (calilAvailableCount(row.result.branches) > 0) {
      return "available";
    }
    return calilHoldingCount(row.result.branches) > 0 ? "held" : "unavailable";
  }

  private rowBadge(row: CalilRow): string {
    switch (this.rowCategory(row)) {
      case "available":
        return "貸出可";
      case "held":
        return "蔵書あり";
      case "unavailable":
        return "見つからない";
      case "error":
        return "失敗";
      case "running":
        return "検索中…";
      case "cached":
        return "前回";
      default:
        return "未検索";
    }
  }

  private stateClass(state: string): string {
    if (state.includes("貸出可")) {
      return "available";
    }
    if (state.includes("貸出中")) {
      return "lent";
    }
    if (state.includes("蔵書")) {
      return "held";
    }
    return "muted";
  }

  private updateRunButton(): void {
    const count = this.rows.filter((row) => row.selected).length;
    if (this.runButton) {
      this.runButton.setText(
        count > 0 ? `検索を開始（${count}）` : "検索を開始"
      );
      this.runButton.disabled =
        this.busy ||
        count === 0 ||
        (this.getSettings().calilApiKey ?? "").trim() === "";
    }
  }

  private async run(): Promise<void> {
    if (this.busy) {
      return;
    }
    if ((this.getSettings().calilApiKey ?? "").trim() === "") {
      showToast("カーリルのAPIキーが未設定です。");
      return;
    }
    const targets = this.rows.filter((row) => row.selected);
    if (targets.length === 0) {
      return;
    }
    this.busy = true;
    this.updateRunButton();
    let done = 0;
    let hits = 0;
    let failures = 0;
    const updates: Record<string, CalilLastResult> = {};
    this.setProgress(`検索中 0/${targets.length}`);
    await mapWithConcurrency(targets, 1, async (row) => {
      if (this.closed) {
        return;
      }
      row.status = "running";
      row.message = "";
      row.result = undefined;
      row.expanded = false;
      this.renderRows();
      await sleep(250);
      if (this.closed) {
        return;
      }
      try {
        const result = await this.books.searchCalil(row.isbn);
        row.result = result;
        row.status = "done";
        const available = calilAvailableCount(result.branches);
        if (available > 0) {
          hits += 1;
          row.message = `${available}館が貸出可`;
        } else {
          row.message =
            result.branches.length > 0
              ? "貸出可の館なし"
              : "蔵書情報を取得できませんでした";
        }
        updates[row.isbn] = {
          checkedAt: result.fetchedAt,
          configuredHits: result.branches.filter((branch) => branch.configured)
            .length,
          library: result.configuredLibrary,
          title: row.record.title,
          totalLibraries: result.branches.length,
        };
      } catch (error) {
        failures += 1;
        row.status = "error";
        row.message = error instanceof Error ? error.message : String(error);
      }
      done += 1;
      this.setProgress(`検索中 ${done}/${targets.length}`);
      this.renderRows();
    });
    this.busy = false;
    this.updateRunButton();
    if (Object.keys(updates).length > 0) {
      await this.saveSettings({
        calilLastResults: {
          ...this.getSettings().calilLastResults,
          ...updates,
        },
      });
    }
    const summary = `今回の検索: 対象 ${targets.length}冊 / 貸出可 ${hits}冊 / 失敗 ${failures}冊`;
    this.setProgress(summary);
    showToast(summary);
  }

  private setProgress(message: string): void {
    this.statusEl?.setText(message);
  }

  private openSettings(): void {
    const setting = (
      this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    if (!setting) {
      return;
    }
    setting.open();
    setting.openTabById("seiton-next");
  }
}

function formatLastResult(result: CalilLastResult): string {
  const date = new Date(result.checkedAt);
  const stamp = Number.isNaN(date.getTime())
    ? result.checkedAt
    : `${date.getMonth() + 1}/${date.getDate()} ${String(
        date.getHours()
      ).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const hits =
    result.configuredHits > 0 ? `${result.configuredHits}館一致` : "一致なし";
  return `前回 ${stamp} · ${hits}`;
}
