/**
 * ストック支出（減価償却対象の大型支出）登録モーダル。
 */

import { type App, Modal } from "obsidian";
import type { AssetDataset } from "../../domain/asset";
import type { AssetService } from "../../services/assetService";
import { buildSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

export interface StockModalOptions {
  onSaved?: () => void;
}

export class StockModal extends Modal {
  private readonly assetService: AssetService;
  private readonly options: StockModalOptions;
  private dataset: AssetDataset | null = null;

  private titleInput: HTMLInputElement | null = null;
  private amountInput: HTMLInputElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private sourceSelect: HTMLSelectElement | null = null;
  private monthsInput: HTMLInputElement | null = null;
  private repaymentCheckbox: HTMLInputElement | null = null;
  private memoInput: HTMLInputElement | null = null;
  private previewEl: HTMLElement | null = null;

  constructor(
    app: App,
    assetService: AssetService,
    options: StockModalOptions = {}
  ) {
    super(app);
    this.assetService = assetService;
    this.options = options;
  }

  override async onOpen(): Promise<void> {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "PCや家電など、長期間使用する大型支出を登録して月々の生活費に減価償却として按分します。",
      title: "ストック支出（大型支出）を登録",
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

    // 品名
    const titleField = container.createDiv({ cls: "st-field" });
    titleField.createEl("label", {
      cls: "st-field-label",
      text: "品名・内容 *",
    });
    this.titleInput = titleField.createEl("input", {
      attr: { placeholder: "例: MacBook Pro M4、冷蔵庫など", type: "text" },
      cls: "st-field-input",
    });

    // 金額 & 購入日
    const row1 = container.createDiv({ cls: "st-field-row" });
    const amountField = row1.createDiv({ cls: "st-field" });
    amountField.createEl("label", {
      cls: "st-field-label",
      text: "購入金額 (円) *",
    });
    this.amountInput = amountField.createEl("input", {
      attr: { inputmode: "numeric", placeholder: "例: 240000", type: "number" },
      cls: "st-field-input",
    });
    this.amountInput.addEventListener("input", () => this.updatePreview());

    const dateField = row1.createDiv({ cls: "st-field" });
    dateField.createEl("label", { cls: "st-field-label", text: "購入日 *" });
    this.dateInput = dateField.createEl("input", {
      attr: { type: "date", value: todayStr },
      cls: "st-field-input",
    });

    // 支払元口座 & 償却月数
    const row2 = container.createDiv({ cls: "st-field-row" });
    const sourceField = row2.createDiv({ cls: "st-field" });
    sourceField.createEl("label", {
      cls: "st-field-label",
      text: "支払元口座 *",
    });
    this.sourceSelect = sourceField.createEl("select", {
      cls: "st-field-select",
    });

    // 奨学金口座を優先選択
    const accounts = [...this.dataset.accounts].sort(
      (a, b) => a.order - b.order
    );
    for (const acc of accounts) {
      const opt = this.sourceSelect.createEl("option", {
        attr: { value: acc.id },
        text: `${acc.name} (${acc.group === "living" ? "生活資金" : "特別資金"})`,
      });
      if (acc.group === "special") {
        opt.selected = true;
      }
    }

    const monthsField = row2.createDiv({ cls: "st-field" });
    monthsField.createEl("label", {
      cls: "st-field-label",
      text: "償却期間 (月数) *",
    });
    this.monthsInput = monthsField.createEl("input", {
      attr: {
        inputmode: "numeric",
        placeholder: "例: 24",
        type: "number",
        value: "24",
      },
      cls: "st-field-input",
    });
    this.monthsInput.addEventListener("input", () => this.updatePreview());

    // 償却プレビュー
    this.previewEl = container.createDiv({
      cls: "seiton-asset-amortization-preview",
    });
    this.updatePreview();

    // 返済要否チェックボックス
    const repayField = container.createDiv({
      cls: "seiton-asset-checkbox-field",
    });
    const repayLabel = repayField.createEl("label");
    this.repaymentCheckbox = repayLabel.createEl("input", {
      attr: { checked: "true", type: "checkbox" },
    });
    repayLabel.createSpan({
      text: " 奨学金口座への返済が必要（生活費から返済していく内部融資）",
    });
    repayField.createEl("p", {
      cls: "st-field-desc",
      text: "※TOEIC受験料などの純粋な自己投資の場合はチェックを外してください。",
    });

    // メモ
    const memoField = container.createDiv({ cls: "st-field" });
    memoField.createEl("label", {
      cls: "st-field-label",
      text: "メモ（任意）",
    });
    this.memoInput = memoField.createEl("input", {
      attr: { placeholder: "購入理由やスペックなど", type: "text" },
      cls: "st-field-input",
    });
  }

  private updatePreview(): void {
    if (!this.previewEl) {
      return;
    }
    const amount = Number(this.amountInput?.value) || 0;
    const months = Number(this.monthsInput?.value) || 1;
    if (amount <= 0 || months <= 0) {
      this.previewEl.setText("");
      return;
    }
    const monthly = Math.round(amount / months);
    this.previewEl.setText(
      `💡 月額償却費: 約 ¥${monthly.toLocaleString()} / 月 （${months}ヶ月かけて生活コストに均等計上）`
    );
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
      text: "ストック支出を登録",
    });
    submitBtn.addEventListener("click", () => {
      void this.saveStock();
    });
  }

  private async saveStock(): Promise<void> {
    const title = this.titleInput?.value.trim() || "";
    const amount = Number(this.amountInput?.value) || 0;
    const purchaseDate =
      this.dateInput?.value || new Date().toISOString().slice(0, 10);
    const sourceAccountId = this.sourceSelect?.value || "";
    const amortizationMonths = Number(this.monthsInput?.value) || 1;
    const isRepaymentRequired = this.repaymentCheckbox?.checked ?? true;
    const memo = this.memoInput?.value.trim() || undefined;

    if (!title) {
      showToast("品名を入力してください。");
      return;
    }
    if (amount <= 0) {
      showToast("購入金額を正しく入力してください。");
      return;
    }
    if (amortizationMonths <= 0) {
      showToast("償却月数は1以上を入力してください。");
      return;
    }

    try {
      await this.assetService.addStockExpense({
        amortizationMonths,
        amount,
        isRepaymentRequired,
        memo,
        purchaseDate,
        sourceAccountId,
        title,
      });
      showToast(`「${title}」（¥${amount.toLocaleString()}）を登録しました。`);
      this.options.onSaved?.();
      this.close();
    } catch (err) {
      showToast(
        `登録に失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
