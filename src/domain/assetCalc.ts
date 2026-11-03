/**
 * 資産・家計管理（Assets）の計算純粋ロジック。
 * B/S（残高バランスシート）、P/L（期間損益・生活費）、減価償却、返済進捗を算出する。
 */

import type {
  AssetAccount,
  AssetDataset,
  AssetSnapshot,
  StockExpense,
  StockRepayment,
} from "./asset";

/** 最新のB/S（残高状況）サマリー */
export interface AssetBsSummary {
  asOfDate: string;
  livingBalance: number;
  netFinancialWorth: number;
  specialBalance: number;
  totalNetWorth: number;
  unreturnedStockValue: number;
}

/** ストック支出のステータス詳細 */
export interface StockExpenseStatus {
  amortizedAmount: number; // 償却累計額
  elapsedMonths: number; // 経過月数
  isAmortizationCompleted: boolean; // 償却完了フラグ
  isRepaymentCompleted: boolean; // 完済フラグ
  monthlyAmortization: number; // 月額償却費
  repaymentBalance: number; // 返済進捗差額（プラスなら返済遅れ・目安額、マイナスなら前倒し）
  stock: StockExpense;
  totalRepayments: number; // 返済実績累計
  unreturnedValue: number; // 未償却残高（資産価値）
}

/** 月次P/L（収支）サマリー */
export interface MonthlyPlSummary {
  cashNetChange: number; // キャッシュ純増減
  depreciation: number; // 当期減価償却費
  livingCashChange: number; // 生活資金キャッシュ増減
  livingCost: number; // 日常生活費（逆算）
  realLivingCost: number; // 実質生活コスト（生活費 ＋ 減価償却費）
  totalIncome: number; // 収入合計
  yearMonth: string; // YYYY-MM
}

/** 2つの日付間の経過月数を算出する（YYYY-MM-DD） */
export function calculateElapsedMonths(
  startDate: string,
  endDate: string
): number {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 0;
  }
  const yearDiff = end.getFullYear() - start.getFullYear();
  const monthDiff = end.getMonth() - start.getMonth();
  const months = yearDiff * 12 + monthDiff;
  // 日付が開始日以上であれば +1 ヶ月目としてカウント
  const dayAdjustment = end.getDate() >= start.getDate() ? 1 : 0;
  return Math.max(0, months + dayAdjustment);
}

/** ストック支出の償却・返済状況を計算する */
export function calculateStockStatus(
  stock: StockExpense,
  allRepayments: StockRepayment[],
  asOfDate: string
): StockExpenseStatus {
  const elapsedMonths = calculateElapsedMonths(stock.purchaseDate, asOfDate);
  const effectiveMonths = Math.min(elapsedMonths, stock.amortizationMonths);

  const monthlyAmortization =
    stock.amortizationMonths > 0
      ? Math.round(stock.amount / stock.amortizationMonths)
      : stock.amount;

  const amortizedAmount =
    effectiveMonths >= stock.amortizationMonths
      ? stock.amount
      : Math.min(stock.amount, monthlyAmortization * effectiveMonths);

  const unreturnedValue = Math.max(0, stock.amount - amortizedAmount);

  // 当該ストックに対する返済実績
  const repayments = allRepayments.filter(
    (r) => r.stockExpenseId === stock.id && r.date <= asOfDate
  );
  const totalRepayments = repayments.reduce((sum, r) => sum + r.amount, 0);

  // 要返済額（償却ペース基準）
  const requiredRepaymentByAmortization = stock.isRepaymentRequired
    ? amortizedAmount
    : 0;

  // 返済進捗差額（プラス: 償却ペースに対して要返済、マイナス: 前倒し返済）
  const repaymentBalance = requiredRepaymentByAmortization - totalRepayments;

  const isAmortizationCompleted = amortizedAmount >= stock.amount;
  const isRepaymentCompleted =
    !stock.isRepaymentRequired || totalRepayments >= stock.amount;

  return {
    amortizedAmount,
    elapsedMonths,
    isAmortizationCompleted,
    isRepaymentCompleted,
    monthlyAmortization,
    repaymentBalance,
    stock,
    totalRepayments,
    unreturnedValue,
  };
}

/** 口座リストから口座種別（生活/特別）のマップを作成する */
function createAccountGroupMap(
  accounts: AssetAccount[]
): Map<string, "living" | "special"> {
  const map = new Map<string, "living" | "special">();
  for (const acc of accounts) {
    map.set(acc.id, acc.group);
  }
  return map;
}

/** 日付で昇順ソートされたスナップショットを取得する */
export function sortSnapshots(snapshots: AssetSnapshot[]): AssetSnapshot[] {
  return [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
}

/** 最新のB/S状況を計算する */
export function calculateLatestBs(
  dataset: AssetDataset,
  asOfDate?: string
): AssetBsSummary {
  const sortedSnapshots = sortSnapshots(dataset.snapshots);
  const filteredSnapshots = asOfDate
    ? sortedSnapshots.filter((s) => s.date <= asOfDate)
    : sortedSnapshots;

  const latestSnapshot = filteredSnapshots.at(-1);
  const date =
    asOfDate ?? latestSnapshot?.date ?? new Date().toISOString().slice(0, 10);

  const groupMap = createAccountGroupMap(dataset.accounts);

  let livingBalance = 0;
  let specialBalance = 0;

  if (latestSnapshot) {
    for (const [accId, balance] of Object.entries(latestSnapshot.balances)) {
      const group = groupMap.get(accId) ?? "living";
      if (group === "living") {
        livingBalance += balance;
      } else {
        specialBalance += balance;
      }
    }
  }

  // 全ストック支出の未償却資産価値を合計
  let unreturnedStockValue = 0;
  for (const stock of dataset.stocks) {
    if (stock.purchaseDate <= date) {
      const status = calculateStockStatus(stock, dataset.repayments, date);
      unreturnedStockValue += status.unreturnedValue;
    }
  }

  const netFinancialWorth = livingBalance + specialBalance;
  const totalNetWorth = netFinancialWorth + unreturnedStockValue;

  return {
    asOfDate: date,
    livingBalance,
    netFinancialWorth,
    specialBalance,
    totalNetWorth,
    unreturnedStockValue,
  };
}

/**
 * 指定した月（YYYY-MM）の月次P/L（収支）サマリーを計算する。
 */
export function calculateMonthlyPl(
  yearMonth: string,
  dataset: AssetDataset
): MonthlyPlSummary {
  const monthStart = `${yearMonth}-01`;
  const nextMonthObj = new Date(`${yearMonth}-01`);
  nextMonthObj.setMonth(nextMonthObj.getMonth() + 1);
  const nextMonthStart = `${nextMonthObj.toISOString().slice(0, 7)}-01`;

  // 1. 当月の収入合計
  const monthIncomes = dataset.incomes.filter((inc) =>
    inc.date.startsWith(yearMonth)
  );
  const totalIncome = monthIncomes.reduce((sum, inc) => sum + inc.amount, 0);

  // 2. 当月の減価償却費合計
  let depreciation = 0;
  for (const stock of dataset.stocks) {
    if (stock.purchaseDate < nextMonthStart) {
      const statusAtMonth = calculateStockStatus(
        stock,
        dataset.repayments,
        `${yearMonth}-28`
      );
      if (
        statusAtMonth.elapsedMonths > 0 &&
        statusAtMonth.elapsedMonths <= stock.amortizationMonths
      ) {
        depreciation += statusAtMonth.monthlyAmortization;
      }
    }
  }

  // 3. スナップショットから生活資金のキャッシュ増減を算出
  const sorted = sortSnapshots(dataset.snapshots);
  const groupMap = createAccountGroupMap(dataset.accounts);

  // 当月の開始時点に最も近い（前月末以前の最後の）スナップショット
  const prevSnapshots = sorted.filter((s) => s.date < monthStart);
  const startSnapshot = prevSnapshots.at(-1);

  // 当月内の最後のスナップショット
  const monthSnapshots = sorted.filter((s) => s.date.startsWith(yearMonth));
  const endSnapshot = monthSnapshots.at(-1);

  let livingCashChange = 0;
  let cashNetChange = 0;

  if (startSnapshot && endSnapshot) {
    let startLiving = 0;
    let endLiving = 0;
    let startTotal = 0;
    let endTotal = 0;

    for (const [accId, val] of Object.entries(startSnapshot.balances)) {
      const g = groupMap.get(accId) ?? "living";
      if (g === "living") {
        startLiving += val;
      }
      startTotal += val;
    }
    for (const [accId, val] of Object.entries(endSnapshot.balances)) {
      const g = groupMap.get(accId) ?? "living";
      if (g === "living") {
        endLiving += val;
      }
      endTotal += val;
    }

    livingCashChange = endLiving - startLiving;
    cashNetChange = endTotal - startTotal;
  }

  // 4. 当月、生活口座から直接支払ったストック支出（もしあれば控除）
  let directLivingStockAmount = 0;
  for (const stock of dataset.stocks) {
    if (stock.purchaseDate.startsWith(yearMonth)) {
      const group = groupMap.get(stock.sourceAccountId);
      if (group === "living") {
        directLivingStockAmount += stock.amount;
      }
    }
  }

  // 5. 日常生活費の逆算
  // 生活費 = 収入 - 生活資金増減 - 生活口座直接ストック支出
  // ※生活資金が増えていれば支出は少なくなり、減っていれば支出は多くなる
  const livingCost = Math.max(
    0,
    totalIncome - livingCashChange - directLivingStockAmount
  );

  // 6. 実質生活コスト = 日常生活費 + 当期減価償却費
  const realLivingCost = livingCost + depreciation;

  return {
    cashNetChange,
    depreciation,
    livingCashChange,
    livingCost,
    realLivingCost,
    totalIncome,
    yearMonth,
  };
}
