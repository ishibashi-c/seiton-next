/**
 * 資産・家計管理（Assets）のコアデータ型定義。
 */

/** 口座グループ（生活用か、奨学金などの特別資金か） */
export type AccountGroup = "living" | "special";

/** 口座種別 */
export type AccountKind = "bank" | "cash" | "credit" | "emoney" | "other";

/** 口座（アセット） */
export interface AssetAccount {
  archived?: boolean;
  createdAt: string;
  group: AccountGroup;
  id: string;
  initialBalance: number;
  kind: AccountKind;
  name: string;
  order: number;
}

/** 残高スナップショット */
export interface AssetSnapshot {
  /** 口座ID -> 残高（円） */
  balances: Record<string, number>;
  createdAt: string;
  date: string; // YYYY-MM-DD
  id: string;
  note?: string;
}

/** 収入種別 */
export type IncomeCategory = "allowance" | "gift" | "other" | "salary";

/** 収入レコード */
export interface AssetIncome {
  amount: number;
  category: IncomeCategory;
  createdAt: string;
  date: string; // YYYY-MM-DD
  id: string;
  memo?: string;
  targetAccountId?: string;
}

/** ストック支出（減価償却対象の大型支出） */
export interface StockExpense {
  amortizationMonths: number;
  amount: number;
  createdAt: string;
  id: string;
  isRepaymentRequired: boolean;
  memo?: string;
  purchaseDate: string; // YYYY-MM-DD
  sourceAccountId: string;
  title: string;
}

/** ストック支出への返済レコード */
export interface StockRepayment {
  amount: number;
  createdAt: string;
  date: string; // YYYY-MM-DD
  id: string;
  memo?: string;
  sourceAccountId?: string;
  stockExpenseId: string;
  targetAccountId?: string;
}

/** 資産ドメインの全データ集約 */
export interface AssetDataset {
  accounts: AssetAccount[];
  incomes: AssetIncome[];
  repayments: StockRepayment[];
  snapshots: AssetSnapshot[];
  stocks: StockExpense[];
}

/** 初期デフォルト口座セット（初回セットアップ用） */
export const DEFAULT_ACCOUNTS: Omit<AssetAccount, "createdAt">[] = [
  {
    group: "living",
    id: "acc_wallet",
    initialBalance: 0,
    kind: "cash",
    name: "財布（現金）",
    order: 1,
  },
  {
    group: "living",
    id: "acc_main_bank",
    initialBalance: 0,
    kind: "bank",
    name: "メイン銀行",
    order: 2,
  },
  {
    group: "living",
    id: "acc_paypay",
    initialBalance: 0,
    kind: "emoney",
    name: "PayPay",
    order: 3,
  },
  {
    group: "living",
    id: "acc_credit",
    initialBalance: 0,
    kind: "credit",
    name: "クレジットカード",
    order: 4,
  },
  {
    group: "special",
    id: "acc_scholarship",
    initialBalance: 0,
    kind: "bank",
    name: "奨学金口座（自己投資）",
    order: 5,
  },
];
