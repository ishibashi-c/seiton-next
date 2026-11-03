/**
 * 奨学金口座への返済入力モーダル。
 * 減価償却で蓄積された要返済額に対して、余裕のあるタイミングで任意の金額を返済する。
 */

import { type App, Modal } from "obsidian";
import type { StockExpense, StockRepayment } from "../../domain/asset";
import { calculateStockStatus } from "../../domain/assetCalc";
import type { AssetService } from "../../services/assetService";
import { buildSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

export interface RepayModalOptions {
  allRepayments: StockRepayment[];
  onSaved?: () => void;
  stock: StockExpense;
}

export class RepayModal extends Modal {
  private readonly assetService: AssetService;
  private readonly options: RepayModalOptions;

  private amountInput: HTMLInputElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private memoInput: HTMLInputElement | null = null;

  constructor(
    app: App,
    assetService: AssetService,
    options: RepayModalOptions
  ) {
    super(app);
    this.assetService = assetService;
    this.options = options;
  }

  override onOpen(): void {
    const { stock, allRepayments } = this.options;
    const todayStr = new Date().toISOString().slice(0, 10);
    const status = calculateStockStatus(stock, allRepayments, todayStr);

    const { body, footer } = buildSeitonModal(this, {
      description: `「${stock.title}」の購入資金を、生活資金から奨学金口座へ返済します。固定額ではなく任意の金額を返済できます。`,
      title: "奨学金口座へ返済",
    });

    // 1. 現状サマリーカード
    const summaryCard = body.createDiv({
      cls: "seiton-asset-repay-summary-card",
    });
    summaryCard.createDiv({
      cls: "seiton-asset-repay-summary-title",
      text: `${stock.title} (購入額: ¥${stock.amount.toLocaleString()})`,
    });

    const metaGrid = summaryCard.createDiv({ cls: "seiton-asset-repay-grid" });
    const addMeta = (label: string, val: string, isHighlight = false) => {
      const item = metaGrid.createDiv({ cls: "seiton-asset-repay-grid-item" });
      item.createSpan({ cls: "seiton-asset-repay-label", text: label });
      item.createSpan({
        cls: isHighlight
          ? "seiton-asset-repay-val is-accent"
          : "seiton-asset-repay-val",
        text: val,
      });
    };

    addMeta("月額償却費", `¥${status.monthlyAmortization.toLocaleString()}/月`);
    addMeta(
      "償却累計 (時間経過)",
      `¥${status.amortizedAmount.toLocaleString()}`
    );
    addMeta("現在の返済実績", `¥${status.totalRepayments.toLocaleString()}`);

    const balanceText =
      status.repaymentBalance > 0
        ? `¥${status.repaymentBalance.toLocaleString()} (返済目安)`
        : status.repaymentBalance < 0
          ? `¥${Math.abs(status.repaymentBalance).toLocaleString()} (前倒し返済済)`
          : "適正ペース (差額なし)";
    addMeta("要返済目安額", balanceText, status.repaymentBalance > 0);

    // 2. 返済フォーム
    const form = body.createDiv({ cls: "seiton-asset-repay-form" });

    const row = form.createDiv({ cls: "st-field-row" });
    const dateField = row.createDiv({ cls: "st-field" });
    dateField.createEl("label", { cls: "st-field-label", text: "返済日 *" });
    this.dateInput = dateField.createEl("input", {
      attr: { type: "date", value: todayStr },
      cls: "st-field-input",
    });

    const defaultRepayAmount = Math.max(
      0,
      status.repaymentBalance > 0
        ? status.repaymentBalance
        : status.monthlyAmortization
    );
    const amountField = row.createDiv({ cls: "st-field" });
    amountField.createEl("label", {
      cls: "st-field-label",
      text: "今回返済する金額 (円) *",
    });
    this.amountInput = amountField.createEl("input", {
      attr: {
        inputmode: "numeric",
        placeholder: "例: 20000",
        type: "number",
        value: defaultRepayAmount > 0 ? String(defaultRepayAmount) : "",
      },
      cls: "st-field-input",
    });

    const memoField = form.createDiv({ cls: "st-field" });
    memoField.createEl("label", {
      cls: "st-field-label",
      text: "メモ（任意）",
    });
    this.memoInput = memoField.createEl("input", {
      attr: {
        placeholder: "例: 11月バイト代から、お年玉からなど",
        type: "text",
      },
      cls: "st-field-input",
    });

    // 3. フッター
    const cancelBtn = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "返済を記録する",
    });
    submitBtn.addEventListener("click", () => {
      void this.submitRepayment();
    });
  }

  private async submitRepayment(): Promise<void> {
    const amount = Number(this.amountInput?.value) || 0;
    const date = this.dateInput?.value || new Date().toISOString().slice(0, 10);
    const memo = this.memoInput?.value.trim() || undefined;

    if (amount <= 0) {
      showToast("返済金額を正しく入力してください。");
      return;
    }

    try {
      await this.assetService.addStockRepayment({
        amount,
        date,
        memo,
        stockExpenseId: this.options.stock.id,
      });
      showToast(`¥${amount.toLocaleString()} の返済を記録しました。`);
      this.options.onSaved?.();
      this.close();
    } catch (err) {
      showToast(
        `返済の記録に失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
