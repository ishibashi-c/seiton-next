/**
 * 資産（Assets）ビュー。
 * 口座残高スナップショット、減価償却、奨学金返済、収支推移を一元管理する第7のタブ。
 */

import { ItemView, type WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_ASSETS } from "../config";
import type { AssetDataset } from "../domain/asset";
import {
  calculateLatestBs,
  calculateMonthlyPl,
  calculateStockStatus,
} from "../domain/assetCalc";
import type { AssetService } from "../services/assetService";
import { AccountSettingsModal } from "./assets/accountSettingsModal";
import {
  renderAssetIndex,
  renderSnapshotsHistory,
  renderStockCard,
} from "./assets/cards";
import { renderMonthlyPlChart, renderNetWorthChart } from "./assets/charts";
import { IncomeModal } from "./assets/incomeModal";
import { RepayModal } from "./assets/repayModal";
import { SnapshotModal } from "./assets/snapshotModal";
import { StockModal } from "./assets/stockModal";
import { closeTabShell, finishTabShell, mountTabShell } from "./tabs/shell";
import { showToast } from "./ui/toast";

export class AssetsView extends ItemView {
  private readonly assetService: AssetService;
  private dataset: AssetDataset | null = null;
  private activeSubTab: "charts" | "history" | "summary" = "summary";
  private asOfEl: HTMLElement | null = null;
  private mainAreaEl: HTMLElement | null = null;
  private subTabButtons = new Map<
    "charts" | "history" | "summary",
    HTMLButtonElement
  >();

  constructor(leaf: WorkspaceLeaf, assetService: AssetService) {
    super(leaf);
    this.assetService = assetService;
  }

  override getViewType(): string {
    return VIEW_TYPE_ASSETS;
  }

  override getDisplayText(): string {
    return "資産";
  }

  override getIcon(): string {
    return "wallet";
  }

  override async onOpen(): Promise<void> {
    const { body } = mountTabShell(this, {
      actions: [
        {
          kind: "primary",
          label: "残高を記録",
          onClick: () => {
            new SnapshotModal(this.app, this.assetService, {
              onSaved: () => void this.reloadData(),
            }).open();
          },
        },
        {
          label: "＋ ストック支出",
          onClick: () => {
            new StockModal(this.app, this.assetService, {
              onSaved: () => void this.reloadData(),
            }).open();
          },
        },
        {
          label: "＋ 収入",
          onClick: () => {
            new IncomeModal(this.app, this.assetService, {
              onSaved: () => void this.reloadData(),
            }).open();
          },
        },
        {
          label: "口座管理",
          onClick: () => {
            new AccountSettingsModal(this.app, this.assetService, {
              onSaved: () => void this.reloadData(),
            }).open();
          },
        },
        {
          label: "CSV出力",
          onClick: async () => {
            try {
              const files = await this.assetService.exportCsvFiles();
              showToast(
                `${files.length}件のCSVファイルを出力しました（Seiton/Exports/）。`
              );
            } catch (err) {
              showToast(
                `CSV出力に失敗しました: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          },
        },
      ],
      rootClasses: ["seiton-home", "seiton-assets"],
      subline: "残高スナップショットと減価償却による資産・家計台帳",
      tab: "assets",
      title: "資産",
    });

    this.mountToolbarAndContainers(body);
    finishTabShell(this, VIEW_TYPE_ASSETS);
    void this.reloadData();
  }

  override async onClose(): Promise<void> {
    closeTabShell(this, VIEW_TYPE_ASSETS);
    this.asOfEl = null;
    this.mainAreaEl = null;
    this.subTabButtons.clear();
    this.dataset = null;
    this.contentEl.empty();
  }

  async renderView(): Promise<void> {
    await this.reloadData();
  }

  async reloadData(): Promise<void> {
    this.dataset = await this.assetService.loadDataset();
    if (!this.mainAreaEl) {
      return;
    }
    if (this.asOfEl) {
      if (this.dataset.snapshots.length === 0) {
        this.asOfEl.setText("スナップショット未登録");
      } else {
        const bs = calculateLatestBs(this.dataset);
        this.asOfEl.setText(
          `最終記録 ${bs.asOfDate} · ${this.dataset.snapshots.length}件`
        );
      }
    }
    this.renderActiveSubTab();
  }

  private mountToolbarAndContainers(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "seiton-asset-toolbar" });
    const termRow = toolbar.createDiv({ cls: "seiton-asset-term-row" });

    const subNav = termRow.createDiv({
      attr: { "aria-label": "資産表示", role: "tablist" },
      cls: "seiton-asset-subnav",
    });
    const tabs: Array<{ id: "charts" | "history" | "summary"; label: string }> =
      [
        { id: "summary", label: "台帳サマリー" },
        { id: "charts", label: "推移グラフ" },
        { id: "history", label: "残高履歴" },
      ];

    this.subTabButtons.clear();
    for (const t of tabs) {
      const active = this.activeSubTab === t.id;
      const btn = subNav.createEl("button", {
        attr: {
          "aria-selected": active ? "true" : "false",
          role: "tab",
          type: "button",
        },
        cls: `seiton-asset-subtab${active ? " is-active" : ""}`,
        text: t.label,
      });
      btn.addEventListener("click", () => {
        this.switchSubTab(t.id);
      });
      this.subTabButtons.set(t.id, btn);
    }

    this.asOfEl = termRow.createDiv({ cls: "seiton-asset-asof" });
    this.mainAreaEl = container.createDiv({ cls: "seiton-asset-main-area" });
  }

  private switchSubTab(tab: "charts" | "history" | "summary"): void {
    if (this.activeSubTab === tab) {
      return;
    }
    this.activeSubTab = tab;
    for (const [id, btn] of this.subTabButtons.entries()) {
      const active = id === tab;
      btn.toggleClass("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    this.renderActiveSubTab();
  }

  private renderActiveSubTab(): void {
    const mainArea = this.mainAreaEl;
    if (!mainArea || !this.dataset) {
      return;
    }
    mainArea.empty();

    if (this.activeSubTab === "summary") {
      this.renderSummaryTab(mainArea);
    } else if (this.activeSubTab === "charts") {
      this.renderChartsTab(mainArea);
    } else {
      this.renderHistoryTab(mainArea);
    }
  }

  private renderSummaryTab(container: HTMLElement): void {
    if (!this.dataset) {
      return;
    }

    const bs = calculateLatestBs(this.dataset);
    const today = new Date();
    const currentMonth = today.toISOString().slice(0, 7);
    const pl = calculateMonthlyPl(currentMonth, this.dataset);

    // 資産インデックス（Ledger Index: B/S・P/L統合サマリー）
    renderAssetIndex(container, bs, pl, this.dataset);

    // ストック支出＆返済トラッカーセクション
    const stockSection = container.createDiv({ cls: "seiton-asset-section" });
    const stockHead = stockSection.createDiv({
      cls: "seiton-asset-section-head",
    });
    stockHead.createEl("h3", { text: "ストック支出・返済台帳" });

    const activeStocks = this.dataset.stocks.filter(
      (s) => s.purchaseDate <= bs.asOfDate
    );
    if (activeStocks.length === 0) {
      stockSection.createDiv({
        cls: "seiton-scanner-empty",
        text: "登録されているストック支出（大型支出）はありません。「＋ ストック支出」から登録できます。",
      });
    } else {
      const stockList = stockSection.createDiv({
        cls: "seiton-asset-stock-list",
      });
      for (const stock of activeStocks) {
        const status = calculateStockStatus(
          stock,
          this.dataset.repayments,
          bs.asOfDate
        );
        renderStockCard(
          stockList,
          status,
          () => {
            if (!this.dataset) {
              return;
            }
            new RepayModal(this.app, this.assetService, {
              allRepayments: this.dataset.repayments,
              onSaved: () => void this.reloadData(),
              stock,
            }).open();
          },
          this.dataset
        );
      }
    }
  }

  private renderChartsTab(container: HTMLElement): void {
    const dataset = this.dataset;
    if (!dataset) {
      return;
    }

    const netWorthSection = container.createDiv({
      cls: "seiton-asset-section",
    });
    netWorthSection.createEl("h3", { text: "総資産の推移" });
    renderNetWorthChart(netWorthSection, dataset);

    const plSection = container.createDiv({ cls: "seiton-asset-section" });
    plSection.createEl("h3", { text: "月次収支（収入 vs 実質生活コスト）" });

    // 過去スナップショットや収入のある全月
    const monthsSet = new Set<string>();
    for (const s of dataset.snapshots) {
      monthsSet.add(s.date.slice(0, 7));
    }
    for (const inc of dataset.incomes) {
      monthsSet.add(inc.date.slice(0, 7));
    }
    const months = Array.from(monthsSet).sort();
    const monthlySummaries = months.map((m) => calculateMonthlyPl(m, dataset));
    renderMonthlyPlChart(plSection, monthlySummaries);
  }

  private renderHistoryTab(container: HTMLElement): void {
    if (!this.dataset) {
      return;
    }
    const section = container.createDiv({ cls: "seiton-asset-section" });
    section.createEl("h3", { text: "スナップショット履歴一覧" });
    renderSnapshotsHistory(section, this.dataset);
  }
}
