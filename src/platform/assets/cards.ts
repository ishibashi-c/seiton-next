/**
 * 資産（Assets）ビューのカード・リスト表示コンポーネント。
 */

import type { AssetDataset } from "../../domain/asset";
import {
  type AssetBsSummary,
  type MonthlyPlSummary,
  type StockExpenseStatus,
  sortSnapshots,
} from "../../domain/assetCalc";
import { button } from "../ui/field";
import { renderStockProgressBar } from "./charts";

/**
 * 資産インデックス（Ledger Index: 無彩色台帳）を描画する。
 */
export function renderAssetIndex(
  container: HTMLElement,
  bs: AssetBsSummary,
  pl: MonthlyPlSummary,
  dataset: AssetDataset
): void {
  const index = container.createDiv({ cls: "seiton-asset-index" });

  // 1. 上段（.seiton-asset-index-top）
  const top = index.createDiv({ cls: "seiton-asset-index-top" });

  // 左: 純資産の金額 1つだけ
  const heroWrap = top.createDiv({ cls: "seiton-asset-hero-wrap" });
  heroWrap.createDiv({
    cls: "seiton-asset-hero-number",
    text: `¥${bs.totalNetWorth.toLocaleString()}`,
  });
  heroWrap.createDiv({
    cls: "seiton-asset-hero-label",
    text: `純資産（${bs.asOfDate}）`,
  });

  // 右: 1本の積み上げ比率バー（生活資金 vs 特別資金）
  const positiveLiving = Math.max(0, bs.livingBalance);
  const positiveSpecial = Math.max(0, bs.specialBalance);
  const totalFunds = positiveLiving + positiveSpecial;
  const livingPct =
    totalFunds > 0 ? Math.round((positiveLiving / totalFunds) * 100) : 50;
  const specialPct = totalFunds > 0 ? 100 - livingPct : 50;

  const barWrap = top.createDiv({
    cls: "seiton-asset-bar-wrap",
  });
  const bar = barWrap.createDiv({
    attr: {
      title: `生活資金 ${livingPct}% / 特別資金 ${specialPct}%`,
    },
    cls: "seiton-asset-bar",
  });
  const livingSeg = bar.createDiv({
    cls: "seiton-asset-bar-segment is-living",
  });
  livingSeg.style.width = `${livingPct}%`;
  const specialSeg = bar.createDiv({
    cls: "seiton-asset-bar-segment is-special",
  });
  specialSeg.style.width = `${specialPct}%`;

  // 2. 中段・B/S内訳行（.seiton-asset-breakdown）
  const breakdown = index.createDiv({ cls: "seiton-asset-breakdown" });

  const livingCount = dataset.accounts.filter(
    (a) => a.group === "living"
  ).length;
  const specialCount = dataset.accounts.filter(
    (a) => a.group === "special"
  ).length;

  const addBreakdownItem = (
    label: string,
    valText: string,
    subText?: string
  ) => {
    const item = breakdown.createSpan({ cls: "seiton-asset-breakdown-item" });
    item.createSpan({ cls: "seiton-asset-item-label", text: label });
    item.createSpan({ cls: "seiton-asset-item-val", text: valText });
    if (subText) {
      item.createSpan({ cls: "seiton-asset-item-sub", text: subText });
    }
  };

  addBreakdownItem(
    "生活資金",
    `¥${bs.livingBalance.toLocaleString()}`,
    `（${livingCount}口座）`
  );
  breakdown.createSpan({ cls: "seiton-asset-dot", text: "·" });
  addBreakdownItem(
    "特別資金",
    `¥${bs.specialBalance.toLocaleString()}`,
    `（${specialCount}口座）`
  );
  breakdown.createSpan({ cls: "seiton-asset-dot", text: "·" });
  addBreakdownItem(
    "ストック未償却残高",
    `¥${bs.unreturnedStockValue.toLocaleString()}`
  );

  // 3. 下段・当月P/L台帳行（.seiton-asset-pl-row）
  const plRow = index.createDiv({ cls: "seiton-asset-pl-row" });

  const [yStr, mStr] = pl.yearMonth.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  const daysInMonth = year && month ? new Date(year, month, 0).getDate() : 30;
  const dailyCost =
    daysInMonth > 0 ? Math.round(pl.realLivingCost / daysInMonth) : 0;

  const plMain = plRow.createDiv({ cls: "seiton-asset-pl-main" });
  plMain.createSpan({
    cls: "seiton-asset-pl-title",
    text: `当月（${pl.yearMonth}）の実質生活コスト:`,
  });
  plMain.createSpan({
    cls: "seiton-asset-pl-cost",
    text: `¥${pl.realLivingCost.toLocaleString()}`,
  });
  plMain.createSpan({
    cls: "seiton-asset-pl-daily",
    text: `（日割 ¥${dailyCost.toLocaleString()}/日）`,
  });

  // 内訳: 収入 · キャッシュ減少 · 特別支出控除 · ストック月償却
  let directLivingStockAmount = 0;
  for (const stock of dataset.stocks) {
    if (stock.purchaseDate.startsWith(pl.yearMonth)) {
      const acc = dataset.accounts.find((a) => a.id === stock.sourceAccountId);
      if (acc?.group === "living") {
        directLivingStockAmount += stock.amount;
      }
    }
  }

  const cashDecrease = -pl.livingCashChange;
  const cashDecreaseText =
    cashDecrease >= 0
      ? `¥${cashDecrease.toLocaleString()}`
      : `-¥${Math.abs(cashDecrease).toLocaleString()}`;
  const specialStockText = `-¥${directLivingStockAmount.toLocaleString()}`;

  const plDetails = plRow.createDiv({ cls: "seiton-asset-pl-details" });
  const addPlDetail = (label: string, val: string) => {
    const item = plDetails.createSpan({ cls: "seiton-asset-pl-detail-item" });
    item.createSpan({ cls: "seiton-asset-item-label", text: label });
    item.createSpan({ cls: "seiton-asset-item-val", text: val });
  };

  addPlDetail("収入", `¥${pl.totalIncome.toLocaleString()}`);
  plDetails.createSpan({ cls: "seiton-asset-dot", text: "·" });
  addPlDetail("キャッシュ減少", cashDecreaseText);
  plDetails.createSpan({ cls: "seiton-asset-dot", text: "·" });
  addPlDetail("特別支出控除", specialStockText);
  plDetails.createSpan({ cls: "seiton-asset-dot", text: "·" });
  addPlDetail("ストック月償却", `+¥${pl.depreciation.toLocaleString()}`);
}

/**
 * 後方互換用：B/S サマリー
 */
export function renderBsCards(
  container: HTMLElement,
  bs: AssetBsSummary
): void {
  const row = container.createDiv({ cls: "seiton-asset-index" });
  const top = row.createDiv({ cls: "seiton-asset-index-top" });
  const heroWrap = top.createDiv({ cls: "seiton-asset-hero-wrap" });
  heroWrap.createDiv({
    cls: "seiton-asset-hero-number",
    text: `¥${bs.totalNetWorth.toLocaleString()}`,
  });
  heroWrap.createDiv({
    cls: "seiton-asset-hero-label",
    text: `純資産（${bs.asOfDate}）`,
  });
}

/**
 * 後方互換用：P/L サマリー
 */
export function renderPlCard(
  container: HTMLElement,
  pl: MonthlyPlSummary
): void {
  const row = container.createDiv({ cls: "seiton-asset-pl-row" });
  const plMain = row.createDiv({ cls: "seiton-asset-pl-main" });
  plMain.createSpan({
    cls: "seiton-asset-pl-title",
    text: `当月（${pl.yearMonth}）の実質生活コスト:`,
  });
  plMain.createSpan({
    cls: "seiton-asset-pl-cost",
    text: `¥${pl.realLivingCost.toLocaleString()}`,
  });
}

/**
 * ストック支出＆返済行を描画する（台帳行デザイン）。
 */
export function renderStockCard(
  container: HTMLElement,
  status: StockExpenseStatus,
  onRepayClick: () => void,
  dataset?: AssetDataset
): void {
  const card = container.createDiv({ cls: "seiton-asset-stock-card" });

  const head = card.createDiv({ cls: "seiton-asset-stock-head" });
  const titleWrap = head.createDiv({ cls: "seiton-asset-stock-title-wrap" });
  titleWrap.createEl("h4", {
    cls: "seiton-asset-stock-title",
    text: status.stock.title,
  });

  const statusTexts: string[] = [];
  if (dataset) {
    const acc = dataset.accounts.find(
      (a) => a.id === status.stock.sourceAccountId
    );
    if (acc) {
      statusTexts.push(acc.group === "living" ? "生活資金" : "特別資金");
    }
  }
  if (status.stock.isRepaymentRequired) {
    statusTexts.push(status.isRepaymentCompleted ? "完了" : "返済中");
  } else {
    statusTexts.push("返済不要");
  }

  titleWrap.createSpan({
    cls: "seiton-asset-stock-status",
    text: statusTexts.join(" · "),
  });

  // 返済ボタン（要返済かつ未完済の場合）
  if (status.stock.isRepaymentRequired && !status.isRepaymentCompleted) {
    const repayBtn = button(head, {
      label: "返済",
      onClick: onRepayClick,
      tone: "secondary",
    });
    repayBtn.addClass("seiton-asset-repay-btn");
  }

  // メタ情報インライン行
  const meta = card.createDiv({ cls: "seiton-asset-stock-meta" });
  meta.createSpan({
    text: `購入: ¥${status.stock.amount.toLocaleString()} (${status.stock.purchaseDate})`,
  });
  const months =
    (status.stock as unknown as { usefulLifeMonths?: number })
      .usefulLifeMonths ?? status.stock.amortizationMonths;
  const dailyCost =
    months > 0 ? Math.round(status.stock.amount / (months * 30.4375)) : 0;
  meta.createSpan({
    text: `月額償却: ¥${status.monthlyAmortization.toLocaleString()} / 月`,
  });
  meta.createSpan({
    text: `日割償却: ¥${dailyCost.toLocaleString()} / 日`,
  });
  meta.createSpan({
    text: `未償却残高: ¥${status.unreturnedValue.toLocaleString()}`,
  });

  if (status.stock.isRepaymentRequired) {
    const balanceText =
      status.repaymentBalance > 0
        ? `要返済目安: ¥${status.repaymentBalance.toLocaleString()} (返済遅れ)`
        : status.repaymentBalance < 0
          ? `前倒し返済: +¥${Math.abs(status.repaymentBalance).toLocaleString()}`
          : "適正ペース (差額なし)";
    meta.createSpan({
      cls: status.repaymentBalance > 0 ? "seiton-asset-stock-repay-alert" : "",
      text: balanceText,
    });
  }

  // プログレスバー
  renderStockProgressBar(card, status);
}

/**
 * 過去のスナップショット履歴一覧テーブルを描画する。
 */
export function renderSnapshotsHistory(
  container: HTMLElement,
  dataset: AssetDataset
): void {
  const snapshots = sortSnapshots(dataset.snapshots).reverse(); // 新しい順
  if (snapshots.length === 0) {
    container.createDiv({
      cls: "seiton-scanner-empty",
      text: "スナップショットの履歴がまだありません。",
    });
    return;
  }

  const table = container.createEl("table", {
    cls: "seiton-asset-history-table",
  });
  const thead = table.createEl("thead");
  const headRow = thead.createEl("tr");
  headRow.createEl("th", { text: "日付" });
  headRow.createEl("th", { text: "生活資金" });
  headRow.createEl("th", { text: "特別資金" });
  headRow.createEl("th", { text: "金融純資産" });
  headRow.createEl("th", { text: "総資産" });
  headRow.createEl("th", { text: "メモ" });

  const tbody = table.createEl("tbody");
  for (const snap of snapshots) {
    const b = Object.entries(snap.balances);
    let living = 0;
    let special = 0;
    for (const [accId, val] of b) {
      const acc = dataset.accounts.find((a) => a.id === accId);
      if (acc?.group === "special") {
        special += val;
      } else {
        living += val;
      }
    }
    const net = living + special;

    const row = tbody.createEl("tr");
    row.createEl("td", { cls: "seiton-asset-col-date", text: snap.date });
    row.createEl("td", { text: `¥${living.toLocaleString()}` });
    row.createEl("td", { text: `¥${special.toLocaleString()}` });
    row.createEl("td", {
      cls: "seiton-asset-col-net",
      text: `¥${net.toLocaleString()}`,
    });
    row.createEl("td", { text: `¥${net.toLocaleString()}` });
    row.createEl("td", { cls: "seiton-asset-col-note", text: snap.note ?? "" });
  }
}
