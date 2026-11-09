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
 * B/S（資産残高）サマリーカードを描画する。
 */
export function renderBsCards(
  container: HTMLElement,
  bs: AssetBsSummary
): void {
  const grid = container.createDiv({ cls: "seiton-asset-bs-grid" });

  const addCard = (
    label: string,
    value: number,
    desc: string,
    isHero = false,
    colorClass = ""
  ) => {
    const card = grid.createDiv({
      cls: isHero
        ? "seiton-asset-stat-card is-hero"
        : `seiton-asset-stat-card ${colorClass}`,
    });
    card.createDiv({ cls: "seiton-asset-stat-label", text: label });
    const valEl = card.createDiv({ cls: "seiton-asset-stat-value" });
    valEl.createSpan({ text: `¥${value.toLocaleString()}` });
    card.createDiv({ cls: "seiton-asset-stat-desc", text: desc });
  };

  addCard(
    "実質総資産",
    bs.totalNetWorth,
    "金融純資産 ＋ ストック資産価値",
    true
  );
  addCard(
    "生活資金（日常）",
    bs.livingBalance,
    "財布・メイン口座・PayPay・クレカ残高",
    false,
    "is-living"
  );
  addCard(
    "特別資金（奨学金）",
    bs.specialBalance,
    "自己投資・融資プール口座残高",
    false,
    "is-special"
  );
  addCard(
    "ストック資産価値",
    bs.unreturnedStockValue,
    "PC・家電等の未償却残存価値",
    false,
    "is-stock"
  );
}

/**
 * P/L（当期収支）サマリーカードを描画する。
 */
export function renderPlCard(
  container: HTMLElement,
  pl: MonthlyPlSummary
): void {
  const card = container.createDiv({ cls: "seiton-asset-pl-card" });

  const head = card.createDiv({ cls: "seiton-asset-pl-head" });
  head.createEl("h3", { text: `${pl.yearMonth} の生活コスト状況` });

  const sub = head.createSpan({ cls: "seiton-asset-pl-sub" });
  const cashChangeText =
    pl.cashNetChange >= 0
      ? `+¥${pl.cashNetChange.toLocaleString()}`
      : `-¥${Math.abs(pl.cashNetChange).toLocaleString()}`;
  sub.setText(`手持ち現金増減: ${cashChangeText}`);

  const grid = card.createDiv({ cls: "seiton-asset-pl-grid" });

  const addStat = (
    label: string,
    val: number,
    desc?: string,
    isHighlight = false
  ) => {
    const item = grid.createDiv({
      cls: isHighlight
        ? "seiton-asset-pl-stat is-highlight"
        : "seiton-asset-pl-stat",
    });
    item.createSpan({ cls: "seiton-asset-pl-label", text: label });
    item.createSpan({
      cls: "seiton-asset-pl-value",
      text: `¥${val.toLocaleString()}`,
    });
    if (desc) {
      item.createSpan({ cls: "seiton-asset-pl-desc", text: desc });
    }
  };

  addStat("収入合計", pl.totalIncome, "バイト代・お小遣い等");
  addStat("日常生活費", pl.livingCost, "残高差分から自動逆算");
  addStat("当期減価償却費", pl.depreciation, "大型支出の月割按分");
  addStat("実質生活コスト", pl.realLivingCost, "生活費 ＋ 減価償却費", true);
}

/**
 * ストック支出＆返済カードを描画する。
 */
export function renderStockCard(
  container: HTMLElement,
  status: StockExpenseStatus,
  onRepayClick: () => void
): void {
  const card = container.createDiv({ cls: "seiton-asset-stock-card" });

  const head = card.createDiv({ cls: "seiton-asset-stock-head" });
  const titleWrap = head.createDiv({ cls: "seiton-asset-stock-title-wrap" });
  titleWrap.createEl("h4", {
    cls: "seiton-asset-stock-title",
    text: status.stock.title,
  });

  const badges = titleWrap.createDiv({ cls: "seiton-asset-stock-badges" });
  if (status.stock.isRepaymentRequired) {
    badges.createSpan({
      cls: status.isRepaymentCompleted
        ? "seiton-asset-badge is-completed"
        : "seiton-asset-badge is-repay",
      text: status.isRepaymentCompleted ? "完済" : "奨学金へ要返済",
    });
  } else {
    badges.createSpan({
      cls: "seiton-asset-badge is-special",
      text: "自己投資（返済不要）",
    });
  }

  // 返済ボタン（要返済かつ未完済の場合）
  if (status.stock.isRepaymentRequired && !status.isRepaymentCompleted) {
    const repayBtn = button(head, {
      label: "返済する",
      onClick: onRepayClick,
      tone: "secondary",
    });
    repayBtn.addClass("seiton-asset-repay-btn");
  }

  // メタ情報グリッド
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
