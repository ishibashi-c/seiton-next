/**
 * 資産データの CSV エクスポートロジック。
 * Excel で日本語が文字化けせず開けるよう、UTF-8 BOM 付きで出力する。
 */

import type { AssetDataset } from "./asset";
import {
  calculateLatestBs,
  calculateStockStatus,
  type MonthlyPlSummary,
  sortSnapshots,
} from "./assetCalc";

const UTF8_BOM = "\uFEFF";

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const str = String(value);
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(cells: unknown[]): string {
  return `${cells.map(escapeCsvCell).join(",")}\r\n`;
}

/**
 * 残高スナップショット履歴の CSV を生成する。
 */
export function generateSnapshotsCsv(dataset: AssetDataset): string {
  const accounts = [...dataset.accounts].sort((a, b) => a.order - b.order);
  const snapshots = sortSnapshots(dataset.snapshots);

  let csv = UTF8_BOM;

  // ヘッダー行
  const headers = [
    "日付",
    ...accounts.map(
      (a) => `${a.name}(${a.group === "living" ? "生活" : "特別"})`
    ),
    "生活資金合計",
    "特別資金（奨学金）",
    "金融純資産",
    "未償却ストック価値",
    "実質総資産",
    "メモ",
  ];
  csv += toCsvRow(headers);

  // データ行
  for (const snap of snapshots) {
    const bs = calculateLatestBs(dataset, snap.date);
    const row: unknown[] = [snap.date];

    for (const acc of accounts) {
      row.push(snap.balances[acc.id] ?? 0);
    }

    row.push(
      bs.livingBalance,
      bs.specialBalance,
      bs.netFinancialWorth,
      bs.unreturnedStockValue,
      bs.totalNetWorth,
      snap.note ?? ""
    );

    csv += toCsvRow(row);
  }

  return csv;
}

/**
 * 月次収支（P/L）推移の CSV を生成する。
 */
export function generateMonthlyPlCsv(summaries: MonthlyPlSummary[]): string {
  let csv = UTF8_BOM;

  const headers = [
    "年月",
    "収入合計",
    "日常生活費",
    "減価償却費",
    "実質生活コスト",
    "生活資金キャッシュ増減",
    "キャッシュ純増減",
  ];
  csv += toCsvRow(headers);

  for (const s of summaries) {
    csv += toCsvRow([
      s.yearMonth,
      s.totalIncome,
      s.livingCost,
      s.depreciation,
      s.realLivingCost,
      s.livingCashChange,
      s.cashNetChange,
    ]);
  }

  return csv;
}

/**
 * ストック支出＆返済台帳の CSV を生成する。
 */
export function generateStocksCsv(
  dataset: AssetDataset,
  asOfDate?: string
): string {
  const date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const accountMap = new Map(dataset.accounts.map((a) => [a.id, a.name]));

  let csv = UTF8_BOM;

  const headers = [
    "品名",
    "購入金額",
    "購入日",
    "支払元口座",
    "償却月数",
    "月額償却費",
    "償却累計",
    "未償却残高",
    "返済要否",
    "返済実績累計",
    "要返済差額",
    "償却状況",
    "完済状況",
    "メモ",
  ];
  csv += toCsvRow(headers);

  for (const stock of dataset.stocks) {
    const status = calculateStockStatus(stock, dataset.repayments, date);
    const sourceName =
      accountMap.get(stock.sourceAccountId) ?? stock.sourceAccountId;

    csv += toCsvRow([
      stock.title,
      stock.amount,
      stock.purchaseDate,
      sourceName,
      stock.amortizationMonths,
      status.monthlyAmortization,
      status.amortizedAmount,
      status.unreturnedValue,
      stock.isRepaymentRequired ? "要返済" : "返済不要",
      status.totalRepayments,
      status.repaymentBalance,
      status.isAmortizationCompleted
        ? "償却済"
        : `${status.elapsedMonths}/${stock.amortizationMonths}ヶ月`,
      status.isRepaymentCompleted ? "完済" : "未完済",
      stock.memo ?? "",
    ]);
  }

  return csv;
}
