/**
 * 残高スナップショット入力モーダル。
 * 前回の残高を引き継ぎ、変動した口座だけ数値を打ち替えて素早く記録できる。
 * 期間中の収入の同時記録にも対応。
 */

import { type App, Modal } from "obsidian";
import type {
  AssetDataset,
  AssetIncome,
  IncomeCategory,
} from "../../domain/asset";
import { sortSnapshots } from "../../domain/assetCalc";
import type { AssetService } from "../../services/assetService";
import { buildSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

export interface SnapshotModalOptions {
  onSaved?: () => void;
}

export class SnapshotModal extends Modal {
  private readonly assetService: AssetService;
  private readonly options: SnapshotModalOptions;
  private dataset: AssetDataset | null = null;

  private balanceInputs = new Map<string, HTMLInputElement>();
  private dateInput: HTMLInputElement | null = null;
  private noteInput: HTMLInputElement | null = null;

  // 同時入力する収入リスト
  private pendingIncomes: Omit<AssetIncome, "createdAt" | "id">[] = [];
  private incomesContainerEl: HTMLElement | null = null;

  constructor(
    app: App,
    assetService: AssetService,
    options: SnapshotModalOptions = {}
  ) {
    super(app);
    this.assetService = assetService;
    this.options = options;
  }

  override async onOpen(): Promise<void> {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "各口座の現在残高を入力してください。変動のない口座は前回の残高が維持されます。",
      title: "残高スナップショットを記録",
      wide: true,
    });

    this.dataset = await this.assetService.loadDataset();
    this.renderForm(body);
    this.renderFooter(footer);
  }

  private renderForm(container: HTMLElement): void {
    if (!this.dataset) {
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const sorted = sortSnapshots(this.dataset.snapshots);
    const latestSnapshot = sorted.at(-1);

    // 1. 日付 & メモ
    const metaRow = container.createDiv({ cls: "st-field-row" });
    const dateField = metaRow.createDiv({ cls: "st-field" });
    dateField.createEl("label", { cls: "st-field-label", text: "記録日" });
    this.dateInput = dateField.createEl("input", {
      attr: { type: "date", value: todayStr },
      cls: "st-field-input",
    });

    const noteField = metaRow.createDiv({ cls: "st-field" });
    noteField.createEl("label", {
      cls: "st-field-label",
      text: "メモ（任意）",
    });
    this.noteInput = noteField.createEl("input", {
      attr: { placeholder: "例: 給料日、月末締めなど", type: "text" },
      cls: "st-field-input",
    });

    // 2. 口座一覧（生活資金 vs 特別資金）
    const accounts = [...this.dataset.accounts].sort(
      (a, b) => a.order - b.order
    );
    const livingAccounts = accounts.filter((a) => a.group === "living");
    const specialAccounts = accounts.filter((a) => a.group === "special");

    const renderGroup = (title: string, groupAccounts: typeof accounts) => {
      const section = container.createDiv({
        cls: "seiton-asset-group-section",
      });
      section.createEl("h4", { cls: "seiton-asset-group-title", text: title });

      const grid = section.createDiv({ cls: "seiton-asset-input-grid" });
      for (const acc of groupAccounts) {
        const prevBalance =
          latestSnapshot?.balances[acc.id] ?? acc.initialBalance ?? 0;
        const row = grid.createDiv({ cls: "seiton-asset-input-row" });

        const labelWrap = row.createDiv({
          cls: "seiton-asset-input-label-wrap",
        });
        labelWrap.createSpan({
          cls: "seiton-asset-input-name",
          text: acc.name,
        });
        labelWrap.createSpan({
          cls: "seiton-asset-input-prev",
          text: `前回: ¥${prevBalance.toLocaleString()}`,
        });

        const input = row.createEl("input", {
          attr: {
            inputmode: "numeric",
            type: "number",
            value: String(prevBalance),
          },
          cls: "st-field-input seiton-asset-number-input",
        });
        this.balanceInputs.set(acc.id, input);
      }
    };

    renderGroup("生活資金（日常口座・電子マネー・クレカ）", livingAccounts);
    renderGroup("特別資金（奨学金口座など）", specialAccounts);

    // 3. この期間の収入（任意）
    const incomeSection = container.createDiv({
      cls: "seiton-asset-group-section",
    });
    const incomeHeader = incomeSection.createDiv({
      cls: "seiton-asset-group-header",
    });
    incomeHeader.createEl("h4", {
      cls: "seiton-asset-group-title",
      text: "期間中の収入（任意）",
    });

    const addIncomeBtn = incomeHeader.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-btn-mini",
      text: "+ 収入を追加",
    });
    addIncomeBtn.addEventListener("click", () => this.addPendingIncomeRow());

    this.incomesContainerEl = incomeSection.createDiv({
      cls: "seiton-asset-pending-incomes",
    });
  }

  private addPendingIncomeRow(): void {
    if (!this.incomesContainerEl) {
      return;
    }

    const row = this.incomesContainerEl.createDiv({
      cls: "seiton-asset-income-inline-row",
    });
    const todayStr =
      this.dateInput?.value || new Date().toISOString().slice(0, 10);

    const categorySelect = row.createEl("select", { cls: "st-field-select" });
    categorySelect.createEl("option", {
      attr: { value: "salary" },
      text: "給料（バイト代）",
    });
    categorySelect.createEl("option", {
      attr: { value: "allowance" },
      text: "お小遣い",
    });
    categorySelect.createEl("option", {
      attr: { value: "gift" },
      text: "お年玉・お祝い",
    });
    categorySelect.createEl("option", {
      attr: { value: "other" },
      text: "その他臨時収入",
    });

    const amountInput = row.createEl("input", {
      attr: { inputmode: "numeric", placeholder: "金額 (円)", type: "number" },
      cls: "st-field-input seiton-asset-income-amount",
    });

    const memoInput = row.createEl("input", {
      attr: { placeholder: "メモ", type: "text" },
      cls: "st-field-input seiton-asset-income-memo",
    });

    const removeBtn = row.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-card-del",
      text: "✕",
    });

    const item: Omit<AssetIncome, "createdAt" | "id"> = {
      amount: 0,
      category: "salary",
      date: todayStr,
      memo: "",
    };
    this.pendingIncomes.push(item);

    categorySelect.addEventListener("change", () => {
      item.category = categorySelect.value as IncomeCategory;
    });
    amountInput.addEventListener("input", () => {
      item.amount = Number(amountInput.value) || 0;
    });
    memoInput.addEventListener("input", () => {
      item.memo = memoInput.value.trim();
    });
    removeBtn.addEventListener("click", () => {
      row.remove();
      this.pendingIncomes = this.pendingIncomes.filter((i) => i !== item);
    });
  }

  private renderFooter(footer: HTMLElement): void {
    const cancelBtn = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "スナップショットを保存",
    });
    submitBtn.addEventListener("click", () => {
      void this.saveSnapshot();
    });
  }

  private async saveSnapshot(): Promise<void> {
    const date = this.dateInput?.value || new Date().toISOString().slice(0, 10);
    const note = this.noteInput?.value.trim() || undefined;

    const balances: Record<string, number> = {};
    for (const [accId, input] of this.balanceInputs.entries()) {
      balances[accId] = Number(input.value) || 0;
    }

    // 収入データの日付を記録日に同期
    const validIncomes = this.pendingIncomes
      .filter((inc) => inc.amount > 0)
      .map((inc) => ({ ...inc, date }));

    try {
      await this.assetService.recordSnapshot(
        { balances, date, note },
        validIncomes
      );
      showToast(`${date} のスナップショットを保存しました。`);
      this.options.onSaved?.();
      this.close();
    } catch (err) {
      showToast(
        `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
