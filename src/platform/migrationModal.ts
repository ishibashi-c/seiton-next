import { showToast } from "./ui/toast";
/**
 * 旧Seitonデータの移行モーダル。
 *
 * - 候補一覧、読み取り専用プレビュー、選択、変換、結果とログパスを表示する。
 * - 変換はコピーのみ。元ファイルの削除・移動・書換えは行わない。
 * - CSSは styles.css を変更せず、`seiton-migration-*` クラスだけを付ける。
 */

import type { App } from "obsidian";
import { Modal } from "obsidian";
import { userMessageOf } from "../domain/errors";
import type {
  MigrationCategory,
  MigrationResultStatus,
} from "../domain/migration";
import type {
  MigrationCandidate,
  MigrationPort,
  MigrationReport,
  MigrationScanResult,
  MigrationService,
} from "../services/migrationService";
import { ObsidianVaultPort } from "./obsidianVaultPort";
import { markSeitonModal } from "./ui/modal";
import { ButtonComponent } from "./ui/setting";

const STATUS_LABELS: Record<MigrationResultStatus, string> = {
  converted: "変換済み",
  failed: "失敗",
  skipped: "スキップ",
};

const CATEGORY_GROUPS: Array<{ category: MigrationCategory; label: string }> = [
  { category: "legacy-note", label: "旧形式のノート" },
  { category: "legacy-memo", label: "月次メモ" },
];

/**
 * ObsidianのVault APIを移行サービス用のポートへ合わせる。
 * `MigrationService` にはこのポートだけを渡す。
 */
export function createObsidianMigrationPort(app: App): MigrationPort {
  const vault = new ObsidianVaultPort(app);
  return {
    create: (path, data) => vault.create(path, data),
    ensureFolder: (path) => vault.ensureFolder(path),
    exists: (path) => vault.exists(path),
    listMarkdown: async () =>
      app.vault.getMarkdownFiles().map((file) => file.path),
    process: (path, transform) => vault.process(path, transform),
    read: (path) => vault.read(path),
  };
}

export interface MigrationModalOptions {
  onConverted?: (report: MigrationReport) => void;
}

export class MigrationModal extends Modal {
  private readonly options: MigrationModalOptions;
  private readonly service: MigrationService;
  private scanResult: MigrationScanResult | null = null;
  private readonly selected = new Set<string>();
  private readonly reviewSelected = new Set<string>();
  private reconvert = false;
  private scanning = false;
  private converting = false;
  private openState = false;
  private statusEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private problemsEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private resultEl: HTMLElement | null = null;
  private convertButton: ButtonComponent | null = null;
  private scanButton: ButtonComponent | null = null;

  constructor(
    app: App,
    service: MigrationService,
    options: MigrationModalOptions = {}
  ) {
    super(app);
    this.service = service;
    this.options = options;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.openState = true;
    this.modalEl.addClass("seiton-migration-modal");
    this.setTitle("旧Seitonデータの移行");
    this.renderChrome();
    void this.runScan();
  }

  override onClose(): void {
    this.openState = false;
    this.statusEl = null;
    this.summaryEl = null;
    this.listEl = null;
    this.problemsEl = null;
    this.previewEl = null;
    this.resultEl = null;
    this.convertButton = null;
    this.scanButton = null;
  }

  private renderChrome(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("seiton-migration-content");

    const safety = content.createDiv({ cls: "seiton-migration-safety" });
    safety.createEl("strong", {
      cls: "seiton-migration-safety-title",
      text: "元ファイルは変更しません。",
    });
    safety.createEl("p", {
      cls: "seiton-migration-safety-text",
      text: "変換は新しいファイルの作成、または週次メモへの追記だけです。旧ファイルの削除・移動・書換えは行いません。",
    });
    safety.createEl("p", {
      cls: "seiton-migration-safety-text",
      text: "実行前にVault全体のバックアップを確認してください。移行後は、同じ内容を旧プラグインで編集しないでください。",
    });

    const toolbar = content.createDiv({ cls: "seiton-migration-toolbar" });
    const reconvertLabel = toolbar.createEl("label", {
      cls: "seiton-migration-reconvert",
    });
    const reconvertInput = reconvertLabel.createEl("input", {
      type: "checkbox",
    });
    reconvertInput.checked = this.reconvert;
    reconvertInput.addEventListener("change", () => {
      this.reconvert = reconvertInput.checked;
      this.renderList();
      this.updateSelectionState();
    });
    reconvertLabel.createSpan({
      text: "変換済みの項目も再変換する（明示確認）",
    });

    this.scanButton = new ButtonComponent(toolbar)
      .setButtonText("再スキャン")
      .onClick(() => {
        void this.runScan();
      });
    new ButtonComponent(toolbar).setButtonText("すべて選択").onClick(() => {
      this.selectAll(true);
    });
    new ButtonComponent(toolbar).setButtonText("選択解除").onClick(() => {
      this.selectAll(false);
    });

    this.summaryEl = toolbar.createSpan({
      cls: "seiton-migration-summary",
      text: "スキャンしていません。",
    });

    this.statusEl = content.createDiv({ cls: "seiton-migration-status" });

    const layout = content.createDiv({ cls: "seiton-migration-layout" });
    const listPanel = layout.createDiv({
      cls: "seiton-migration-list-panel",
    });
    listPanel.createEl("h3", {
      cls: "seiton-migration-heading",
      text: "移行候補",
    });
    this.problemsEl = listPanel.createDiv({
      cls: "seiton-migration-problems",
    });
    this.listEl = listPanel.createDiv({ cls: "seiton-migration-list" });

    const previewPanel = layout.createDiv({
      cls: "seiton-migration-preview",
    });
    previewPanel.createEl("h3", {
      cls: "seiton-migration-heading",
      text: "プレビュー（読み取り専用）",
    });
    this.previewEl = previewPanel.createDiv({
      cls: "seiton-migration-preview-body",
    });
    this.showPreviewPlaceholder();

    this.resultEl = content.createDiv({ cls: "seiton-migration-result" });

    const footer = content.createDiv({ cls: "seiton-migration-footer" });
    new ButtonComponent(footer).setButtonText("閉じる").onClick(() => {
      this.close();
    });
    this.convertButton = new ButtonComponent(footer)
      .setButtonText("選択した項目を変換")
      .setCta()
      .onClick(() => {
        void this.runConvert();
      });
    this.convertButton.setDisabled(true);
  }

  private async runScan(options: { quiet?: boolean } = {}): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    this.scanButton?.setDisabled(true);
    this.convertButton?.setDisabled(true);
    if (!options.quiet) {
      this.setStatus("Vaultを読み取り専用でスキャンしています…");
    }

    try {
      const result = await this.service.scan();
      if (!this.openState) {
        return;
      }
      this.scanResult = result;
      this.selected.clear();
      this.reviewSelected.clear();
      this.renderList();
      this.renderSummary();
      this.renderProblems(result);
      this.showPreviewPlaceholder();
      if (!options.quiet) {
        this.setStatus(
          result.candidates.length === 0
            ? "旧形式の候補は見つかりませんでした。"
            : ""
        );
      }
    } catch (error) {
      if (this.openState && !options.quiet) {
        this.setStatus(userMessageOf(error), true);
      }
    } finally {
      this.scanning = false;
      this.scanButton?.setDisabled(false);
      if (this.openState) {
        this.updateSelectionState();
      }
    }
  }

  private renderSummary(): void {
    if (!this.summaryEl || !this.scanResult) {
      return;
    }
    const summary = this.scanResult.summary;
    this.summaryEl.setText(
      `旧ノート ${summary.legacyNote}件 / 月次メモ ${summary.legacyMemo}件 / 新形式 ${summary.alreadyNew}件 / 対象外 ${summary.unsupported}件`
    );
  }

  private renderProblems(result: MigrationScanResult): void {
    const container = this.problemsEl;
    if (!container) {
      return;
    }
    container.empty();
    if (result.problems.length === 0) {
      return;
    }
    container.createDiv({
      cls: "seiton-migration-problem-head",
      text: `読み込めなかったファイル（${result.problems.length}件）`,
    });
    for (const problem of result.problems) {
      const row = container.createDiv({ cls: "seiton-migration-problem" });
      row.createSpan({ cls: "seiton-migration-path", text: problem.path });
      row.createSpan({ text: ` ${problem.message}` });
    }
  }

  private actionableCandidates(): MigrationCandidate[] {
    return this.scanResult?.candidates ?? [];
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) {
      return;
    }
    list.empty();
    const candidates = this.actionableCandidates();
    if (candidates.length === 0) {
      list.createDiv({
        cls: "seiton-migration-empty",
        text: "旧形式の候補は見つかりませんでした。",
      });
      return;
    }

    for (const group of CATEGORY_GROUPS) {
      const items = candidates.filter(
        (candidate) => candidate.category === group.category
      );
      if (items.length === 0) {
        continue;
      }
      const section = list.createDiv({ cls: "seiton-migration-group" });
      section.createDiv({
        cls: "seiton-migration-group-head",
        text: `${group.label}（${items.length}件）`,
      });
      for (const candidate of items) {
        this.renderRow(section, candidate);
      }
    }
  }

  private renderRow(
    parent: HTMLElement,
    candidate: MigrationCandidate
  ): HTMLElement {
    const row = parent.createDiv({ cls: "seiton-migration-row" });
    const disabled = this.isRowDisabled(candidate);

    const checkbox = row.createEl("input", {
      cls: "seiton-migration-checkbox",
      type: "checkbox",
    });
    checkbox.checked = this.selected.has(candidate.path);
    checkbox.disabled = disabled;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        this.selected.add(candidate.path);
      } else {
        this.selected.delete(candidate.path);
        this.reviewSelected.delete(candidate.path);
      }
      this.updateSelectionState();
    });

    const main = row.createDiv({ cls: "seiton-migration-row-main" });
    const title = main.createDiv({ cls: "seiton-migration-row-title" });
    title.createSpan({ cls: "seiton-migration-path", text: candidate.path });
    const badges = title.createDiv({ cls: "seiton-migration-badges" });
    if (candidate.alreadyConverted) {
      this.addBadge(badges, "変換済み", "done");
    }
    if (candidate.needsReview) {
      this.addBadge(badges, "要確認", "warn");
    }
    if (candidate.targetState === "blocked") {
      this.addBadge(badges, "変換不可", "error");
    } else if (candidate.targetState === "collision") {
      this.addBadge(badges, "別名へコピー", "warn");
    } else if (candidate.targetState === "append") {
      this.addBadge(badges, "週次へ追記", "info");
    }

    const detail = main.createDiv({ cls: "seiton-migration-row-detail" });
    const legacyType = candidate.type === "" ? "（type なし）" : candidate.type;
    const status =
      candidate.status === "" ? "" : ` / status: ${candidate.status}`;
    const count =
      candidate.category === "legacy-memo"
        ? ` / ${candidate.entryCount}件`
        : "";
    detail.setText(`${legacyType} → kind: ${candidate.kind}${status}${count}`);

    if (candidate.targetPaths.length > 0) {
      main.createDiv({
        cls: "seiton-migration-row-target",
        text: `新: ${candidate.targetPaths.join(", ")}`,
      });
    }
    if (candidate.reasons.length > 0) {
      main.createDiv({
        cls: "seiton-migration-row-reason",
        text: candidate.reasons[0] ?? "",
      });
    }
    if (candidate.reviewSelectable) {
      const reviewLabel = main.createEl("label", {
        cls: "seiton-migration-review",
      });
      const reviewInput = reviewLabel.createEl("input", { type: "checkbox" });
      reviewInput.checked = this.reviewSelected.has(candidate.path);
      reviewInput.disabled = disabled;
      reviewInput.addEventListener("change", () => {
        if (reviewInput.checked) {
          this.reviewSelected.add(candidate.path);
        } else {
          this.reviewSelected.delete(candidate.path);
        }
      });
      reviewLabel.createSpan({
        text: "review に入れる（inbox を明示選択）",
      });
    }

    const previewButton = main.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-migration-preview-button",
      text: "プレビュー",
    });
    previewButton.addEventListener("click", () => {
      this.showPreview(candidate);
    });

    return row;
  }

  private addBadge(
    parent: HTMLElement,
    text: string,
    kind: "done" | "error" | "info" | "warn"
  ): void {
    parent.createSpan({
      cls: `seiton-migration-badge is-${kind}`,
      text,
    });
  }

  private isRowDisabled(candidate: MigrationCandidate): boolean {
    if (candidate.targetState === "blocked") {
      return true;
    }
    return candidate.alreadyConverted && !this.reconvert;
  }

  private showPreview(candidate: MigrationCandidate): void {
    const preview = this.previewEl;
    if (!preview) {
      return;
    }
    preview.empty();
    const meta = preview.createDiv({ cls: "seiton-migration-preview-meta" });
    meta.createDiv({ cls: "seiton-migration-path", text: candidate.path });
    meta.createDiv({
      text: `元ハッシュ: ${candidate.hash} / 変換先: ${
        candidate.targetPaths.length === 0
          ? "なし"
          : candidate.targetPaths.join(", ")
      }`,
    });
    const pre = preview.createEl("pre", {
      cls: "seiton-migration-preview-text",
    });
    pre.setText(candidate.preview);
    if (candidate.warnings.length > 0) {
      const warnings = preview.createDiv({
        cls: "seiton-migration-preview-warnings",
      });
      for (const warning of candidate.warnings) {
        warnings.createDiv({ text: `警告: ${warning}` });
      }
    }
    if (candidate.reasons.length > 0) {
      const reasons = preview.createDiv({
        cls: "seiton-migration-preview-reasons",
      });
      for (const reason of candidate.reasons) {
        reasons.createDiv({ text: `要確認: ${reason}` });
      }
    }
  }

  private showPreviewPlaceholder(): void {
    const preview = this.previewEl;
    if (!preview) {
      return;
    }
    preview.empty();
    preview.createDiv({
      cls: "seiton-migration-preview-placeholder",
      text: "候補の「プレビュー」を押すと、変換後にできる内容をここへ表示します。Vaultへは書き込みません。",
    });
  }

  private selectAll(checked: boolean): void {
    this.selected.clear();
    if (!checked) {
      this.reviewSelected.clear();
    }
    if (checked) {
      for (const candidate of this.actionableCandidates()) {
        if (!this.isRowDisabled(candidate)) {
          this.selected.add(candidate.path);
        }
      }
    }
    this.renderList();
    this.updateSelectionState();
  }

  private updateSelectionState(): void {
    const count = this.selected.size;
    if (this.summaryEl && this.scanResult) {
      const summary = this.scanResult.summary;
      this.summaryEl.setText(
        `旧ノート ${summary.legacyNote}件 / 月次メモ ${summary.legacyMemo}件 / 新形式 ${summary.alreadyNew}件 / 対象外 ${summary.unsupported}件 · 選択 ${count}件`
      );
    }
    this.convertButton?.setDisabled(
      count === 0 || this.converting || this.scanning
    );
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
  }

  private async runConvert(): Promise<void> {
    if (this.converting || this.scanning) {
      return;
    }
    const paths = [...this.selected];
    if (paths.length === 0) {
      this.setStatus("変換する項目を選択してください。", true);
      return;
    }

    this.converting = true;
    this.convertButton?.setDisabled(true);
    this.setStatus("変換しています…（元ファイルは変更しません）");

    let report: MigrationReport;
    try {
      report = await this.service.convert(paths, {
        alreadyConverted: this.reconvert ? "convert" : "skip",
        reviewPaths: [...this.reviewSelected],
      });
    } catch (error) {
      this.converting = false;
      if (this.openState) {
        this.setStatus(userMessageOf(error), true);
        this.updateSelectionState();
      }
      return;
    }

    this.converting = false;
    if (!this.openState) {
      return;
    }
    this.renderReport(report);
    try {
      this.options.onConverted?.(report);
    } catch (error) {
      console.error("[Seiton] migration callback failed", error);
    }
    showToast(
      `移行: 変換 ${report.summary.converted}件 / スキップ ${report.summary.skipped}件 / 失敗 ${report.summary.failed}件`
    );

    await this.runScan({ quiet: true });
    this.setStatus(
      report.summary.failed === 0
        ? "変換が完了しました。変換ログと新しいファイルを確認してください。"
        : "一部の項目が失敗しました。結果と変換ログを確認し、修正後に再試行してください。",
      report.summary.failed > 0
    );
  }

  private renderReport(report: MigrationReport): void {
    const container = this.resultEl;
    if (!container) {
      return;
    }
    container.empty();
    container.createDiv({
      cls: "seiton-migration-result-head",
      text: `変換結果（${report.convertedAt}）`,
    });
    container.createDiv({
      cls: "seiton-migration-result-summary",
      text: `変換 ${report.summary.converted}件 / スキップ ${report.summary.skipped}件 / 失敗 ${report.summary.failed}件`,
    });

    const logRow = container.createDiv({ cls: "seiton-migration-log" });
    logRow.createSpan({ text: "変換ログ: " });
    logRow.createEl("code", { text: report.logPath });
    const openLog = logRow.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-migration-log-button",
      text: "ログを開く",
    });
    openLog.addEventListener("click", () => {
      void this.app.workspace.openLinkText(report.logPath, "", true);
    });

    if (report.logWriteError !== "") {
      container.createDiv({
        cls: "seiton-migration-error",
        text: `変換ログに記録できませんでした: ${report.logWriteError}`,
      });
    }

    for (const result of report.results) {
      const row = container.createDiv({
        cls: "seiton-migration-result-item",
      });
      row.createSpan({
        cls: `seiton-migration-result-status is-${result.status}`,
        text: STATUS_LABELS[result.status],
      });
      row.createSpan({
        cls: "seiton-migration-path",
        text: result.sourcePath,
      });
      if (result.targetPaths.length > 0) {
        row.createDiv({
          cls: "seiton-migration-result-targets",
          text: `新: ${result.targetPaths.join(", ")}`,
        });
      }
      if (result.message !== "") {
        row.createDiv({
          cls: "seiton-migration-result-message",
          text: result.message,
        });
      }
    }

    if (report.summary.failed > 0) {
      container.createDiv({
        cls: "seiton-migration-note",
        text: "失敗した項目は、原因を直してから再度変換できます。成功済みの項目は変換ログの記録により二重に取り込みません。",
      });
    }
  }
}
