/**
 * 収入（給与・お小遣い・お年玉等）単体記録モーダル。
 */

import { type App, Modal } from "obsidian";
import type { IncomeCategory } from "../../domain/asset";
import type { AssetService } from "../../services/assetService";
import { buildSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

export interface IncomeModalOptions {
  onSaved?: () => void;
}

export class IncomeModal extends Modal {
  private readonly assetService: AssetService;
  private readonly options: IncomeModalOptions;

  private amountInput: HTMLInputElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private categorySelect: HTMLSelectElement | null = null;
  private memoInput: HTMLInputElement | null = null;

  constructor(
    app: App,
    assetService: AssetService,
    options: IncomeModalOptions = {}
  ) {
    super(app);
    this.assetService = assetService;
    this.options = options;
  }

  override onOpen(): void {
    const todayStr = new Date().toISOString().slice(0, 10);
    const { body, footer } = buildSeitonModal(this, {
      description: "バイト給料やお小遣い、お年玉などの収入を記録します。",
      title: "収入を記録",
    });

    const form = body.createDiv({ cls: "seiton-asset-income-form" });

    const row1 = form.createDiv({ cls: "st-field-row" });
    const categoryField = row1.createDiv({ cls: "st-field" });
    categoryField.createEl("label", {
      cls: "st-field-label",
      text: "収入種別 *",
    });
    this.categorySelect = categoryField.createEl("select", {
      cls: "st-field-select",
    });
    this.categorySelect.createEl("option", {
      attr: { value: "salary" },
      text: "給料（バイト代）",
    });
    this.categorySelect.createEl("option", {
      attr: { value: "allowance" },
      text: "お小遣い",
    });
    this.categorySelect.createEl("option", {
      attr: { value: "gift" },
      text: "お年玉・お祝い",
    });
    this.categorySelect.createEl("option", {
      attr: { value: "other" },
      text: "その他臨時収入",
    });

    const amountField = row1.createDiv({ cls: "st-field" });
    amountField.createEl("label", {
      cls: "st-field-label",
      text: "金額 (円) *",
    });
    this.amountInput = amountField.createEl("input", {
      attr: { inputmode: "numeric", placeholder: "例: 85000", type: "number" },
      cls: "st-field-input",
    });

    const dateField = form.createDiv({ cls: "st-field" });
    dateField.createEl("label", { cls: "st-field-label", text: "入金日 *" });
    this.dateInput = dateField.createEl("input", {
      attr: { type: "date", value: todayStr },
      cls: "st-field-input",
    });

    const memoField = form.createDiv({ cls: "st-field" });
    memoField.createEl("label", {
      cls: "st-field-label",
      text: "メモ（任意）",
    });
    this.memoInput = memoField.createEl("input", {
      attr: { placeholder: "例: 〇〇カフェ10月分", type: "text" },
      cls: "st-field-input",
    });

    const cancelBtn = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "収入を保存",
    });
    submitBtn.addEventListener("click", () => {
      void this.submitIncome();
    });
  }

  private async submitIncome(): Promise<void> {
    const amount = Number(this.amountInput?.value) || 0;
    const category = (this.categorySelect?.value || "other") as IncomeCategory;
    const date = this.dateInput?.value || new Date().toISOString().slice(0, 10);
    const memo = this.memoInput?.value.trim() || undefined;

    if (amount <= 0) {
      showToast("金額を正しく入力してください。");
      return;
    }

    try {
      await this.assetService.addIncome({
        amount,
        category,
        date,
        memo,
      });
      showToast(`¥${amount.toLocaleString()} の収入を記録しました。`);
      this.options.onSaved?.();
      this.close();
    } catch (err) {
      showToast(
        `収入の記録に失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
