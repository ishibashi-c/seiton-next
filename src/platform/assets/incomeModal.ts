/**
 * 収入（給与・お小遣い・お年玉等）単体記録モーダル。
 */

import { type App, Modal } from "obsidian";
import type { IncomeCategory } from "../../domain/asset";
import type { AssetService } from "../../services/assetService";
import { button, selectField, textField } from "../ui/field";
import { buildSeitonModal } from "../ui/modal";
import type { SelectControl } from "../ui/select";
import { showToast } from "../ui/toast";

export interface IncomeModalOptions {
  onSaved?: () => void;
}

export class IncomeModal extends Modal {
  private readonly assetService: AssetService;
  private readonly options: IncomeModalOptions;

  private amountInput: HTMLInputElement | null = null;
  private dateInput: HTMLInputElement | null = null;
  private categoryControl: SelectControl | null = null;
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
    this.categoryControl = selectField(row1, {
      choices: [
        { label: "給料（バイト代）", value: "salary" },
        { label: "お小遣い", value: "allowance" },
        { label: "お年玉・お祝い", value: "gift" },
        { label: "その他臨時収入", value: "other" },
      ],
      label: "収入種別 *",
      onChange: () => undefined,
      value: "salary",
    });

    this.amountInput = textField(row1, {
      label: "金額 (円) *",
      placeholder: "例: 85000",
      type: "number",
    });

    this.dateInput = textField(form, {
      label: "入金日 *",
      type: "date",
      value: todayStr,
    });

    this.memoInput = textField(form, {
      label: "メモ（任意）",
      placeholder: "例: 〇〇カフェ10月分",
    });

    button(footer, {
      label: "キャンセル",
      onClick: () => this.close(),
      tone: "ghost",
    });

    button(footer, {
      label: "収入を保存",
      onClick: () => {
        void this.submitIncome();
      },
      tone: "primary",
    });
  }

  private async submitIncome(): Promise<void> {
    const amount = Number(this.amountInput?.value) || 0;
    const category = (this.categoryControl?.value() ||
      "other") as IncomeCategory;
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
