/**
 * 口座（アセット）の管理・追加モーダル。
 */

import { type App, Modal } from "obsidian";
import type {
  AccountGroup,
  AccountKind,
  AssetAccount,
} from "../../domain/asset";
import type { AssetService } from "../../services/assetService";
import { ConfirmModal } from "../confirmModal";
import { buildSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

export interface AccountSettingsModalOptions {
  onSaved?: () => void;
}

export class AccountSettingsModal extends Modal {
  private readonly assetService: AssetService;
  private readonly options: AccountSettingsModalOptions;

  private accounts: AssetAccount[] = [];
  private listContainerEl: HTMLElement | null = null;

  constructor(
    app: App,
    assetService: AssetService,
    options: AccountSettingsModalOptions = {}
  ) {
    super(app);
    this.assetService = assetService;
    this.options = options;
  }

  override async onOpen(): Promise<void> {
    const { body, footer } = buildSeitonModal(this, {
      description:
        "残高スナップショットで管理する口座や電子マネーを整理・追加します。",
      title: "口座の管理",
      wide: true,
    });

    const dataset = await this.assetService.loadDataset();
    this.accounts = [...dataset.accounts].sort((a, b) => a.order - b.order);

    this.renderAddForm(body);
    this.listContainerEl = body.createDiv({
      cls: "seiton-asset-accounts-list-wrap",
    });
    this.renderAccountList();

    const closeBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "完了",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  private renderAddForm(container: HTMLElement): void {
    const box = container.createDiv({ cls: "seiton-asset-add-account-box" });
    box.createEl("h4", {
      cls: "seiton-asset-group-title",
      text: "＋ 新しい口座を追加",
    });

    const row = box.createDiv({ cls: "st-field-row" });

    const nameField = row.createDiv({ cls: "st-field" });
    nameField.createEl("label", { cls: "st-field-label", text: "口座名 *" });
    const nameInput = nameField.createEl("input", {
      attr: { placeholder: "例: 楽天銀行、Suicaなど", type: "text" },
      cls: "st-field-input",
    });

    const groupField = row.createDiv({ cls: "st-field" });
    groupField.createEl("label", { cls: "st-field-label", text: "区分 *" });
    const groupSelect = groupField.createEl("select", {
      cls: "st-field-select",
    });
    groupSelect.createEl("option", {
      attr: { value: "living" },
      text: "生活資金（日常）",
    });
    groupSelect.createEl("option", {
      attr: { value: "special" },
      text: "特別資金（奨学金/投資）",
    });

    const kindField = row.createDiv({ cls: "st-field" });
    kindField.createEl("label", { cls: "st-field-label", text: "種別 *" });
    const kindSelect = kindField.createEl("select", { cls: "st-field-select" });
    kindSelect.createEl("option", {
      attr: { value: "bank" },
      text: "銀行口座",
    });
    kindSelect.createEl("option", {
      attr: { value: "emoney" },
      text: "電子マネー/QR",
    });
    kindSelect.createEl("option", { attr: { value: "cash" }, text: "現金" });
    kindSelect.createEl("option", {
      attr: { value: "credit" },
      text: "クレジットカード/後払い",
    });
    kindSelect.createEl("option", { attr: { value: "other" }, text: "その他" });

    const btnField = row.createDiv({ cls: "st-field" });
    btnField.createEl("label", { cls: "st-field-label", text: "　" });
    const addBtn = btnField.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-btn-mini mod-cta",
      text: "口座を追加",
    });

    addBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        showToast("口座名を入力してください。");
        return;
      }
      const newAcc: AssetAccount = {
        createdAt: new Date().toISOString(),
        group: groupSelect.value as AccountGroup,
        id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        initialBalance: 0,
        kind: kindSelect.value as AccountKind,
        name,
        order: this.accounts.length + 1,
      };
      this.accounts.push(newAcc);
      await this.saveAccounts();
      nameInput.value = "";
      this.renderAccountList();
      showToast(`「${name}」を追加しました。`);
    });
  }

  private renderAccountList(): void {
    if (!this.listContainerEl) {
      return;
    }
    this.listContainerEl.empty();

    this.listContainerEl.createEl("h4", {
      cls: "seiton-asset-group-title",
      text: "登録済み口座一覧",
    });

    const list = this.listContainerEl.createDiv({
      cls: "seiton-asset-accounts-list",
    });

    for (const acc of this.accounts) {
      const row = list.createDiv({ cls: "seiton-asset-account-row" });

      const info = row.createDiv({ cls: "seiton-asset-account-info" });
      info.createSpan({ cls: "seiton-asset-account-name", text: acc.name });
      const badge = info.createSpan({
        cls: `seiton-asset-badge is-${acc.group}`,
        text: acc.group === "living" ? "生活資金" : "特別資金",
      });
      badge.title = acc.kind;

      const actions = row.createDiv({ cls: "seiton-asset-account-actions" });
      const delBtn = actions.createEl("button", {
        attr: { "aria-label": "削除", type: "button" },
        cls: "seiton-scanner-card-del",
        text: "✕",
      });

      delBtn.addEventListener("click", () => {
        new ConfirmModal(this.app, {
          confirmingLabel: "削除する",
          message: `口座「${acc.name}」を削除してもよろしいですか？`,
          onConfirm: async () => {
            this.accounts = this.accounts.filter((a) => a.id !== acc.id);
            await this.saveAccounts();
            this.renderAccountList();
            showToast(`「${acc.name}」を削除しました。`);
          },
          title: "口座を削除",
        }).open();
      });
    }
  }

  private async saveAccounts(): Promise<void> {
    await this.assetService.saveAccounts(this.accounts);
    this.options.onSaved?.();
  }
}
