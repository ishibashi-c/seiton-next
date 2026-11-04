/**
 * ストック支出（減価償却対象の大型支出）登録モーダル。
 */

import { type App, Modal } from "obsidian";
import type { AssetDataset } from "../../domain/asset";
import type { AssetService } from "../../services/assetService";
import { button, checkboxField, selectField, textField } from "../ui/field";
import { buildSeitonModal } from "../ui/modal";
import type { SelectControl } from "../ui/select";
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
  private sourceControl: SelectControl | null = null;
  private monthsInput: HTMLInputElement | null = null;
  private isRepaymentRequired = true;
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
    this.titleInput = textField(container, {
      label: "品名・内容 *",
      placeholder: "例: MacBook Pro M4、冷蔵庫など",
    });

    // 金額 & 購入日
    const row1 = container.createDiv({ cls: "st-field-row" });
    this.amountInput = textField(row1, {
      label: "購入金額 (円) *",
      onChange: () => this.updatePreview(),
      placeholder: "例: 240000",
      type: "number",
    });

    this.dateInput = textField(row1, {
      label: "購入日 *",
      type: "date",
      value: todayStr,
    });

    // 支払元口座 & 償却月数
    const row2 = container.createDiv({ cls: "st-field-row" });
    const accounts = [...this.dataset.accounts].sort(
      (a, b) => a.order - b.order
    );
    const initialSpecial = accounts.find((a) => a.group === "special");
    const choices = accounts.map((acc) => ({
      label: `${acc.name} (${acc.group === "living" ? "生活資金" : "特別資金"})`,
      value: acc.id,
    }));

    this.sourceControl = selectField(row2, {
      choices,
      label: "支払元口座 *",
      onChange: () => undefined,
      value: initialSpecial?.id ?? accounts[0]?.id ?? "",
    });

    this.monthsInput = textField(row2, {
      label: "償却期間 (月数) *",
      onChange: () => this.updatePreview(),
      placeholder: "例: 24",
      type: "number",
      value: "24",
    });

    // 償却プレビュー
    this.previewEl = container.createDiv({
      cls: "seiton-asset-amortization-preview",
    });
    this.updatePreview();

    // 返済要否チェックボックス
    const repayField = container.createDiv({
      cls: "seiton-asset-checkbox-field",
    });
    checkboxField(repayField, {
      checked: true,
      label: "奨学金口座への返済が必要（生活費から返済していく内部融資）",
      onChange: (checked) => {
        this.isRepaymentRequired = checked;
      },
    });
    repayField.createEl("p", {
      cls: "st-field-desc",
      text: "※TOEIC受験料などの純粋な自己投資の場合はチェックを外してください。",
    });

    // メモ
    this.memoInput = textField(container, {
      label: "メモ（任意）",
      placeholder: "購入理由やスペックなど",
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
    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });

    button(footer, {
      label: "ストック支出を登録",
      onClick: () => {
        void this.saveStock();
      },
      tone: "primary",
    });
  }

  private async saveStock(): Promise<void> {
    const title = this.titleInput?.value.trim() || "";
    const amount = Number(this.amountInput?.value) || 0;
    const purchaseDate =
      this.dateInput?.value || new Date().toISOString().slice(0, 10);
    const sourceAccountId = this.sourceControl?.value() || "";
    const amortizationMonths = Number(this.monthsInput?.value) || 1;
    const isRepaymentRequired = this.isRepaymentRequired;
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
