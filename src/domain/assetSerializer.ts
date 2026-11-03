/**
 * 資産データの Markdown ファイル シリアライズ＆パース純粋ロジック。
 * 人間可読な Markdown フロントマター ＋ JSON ブロック形式で安全に永続化する。
 */

import type {
  AssetAccount,
  AssetIncome,
  AssetSnapshot,
  StockExpense,
  StockRepayment,
} from "./asset";

/** JSON ブロックを抽出してパースするヘルパー */
function extractJsonBlock<T>(content: string, fallback: T): T {
  const match = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(content);
  if (!match?.[1]) {
    return fallback;
  }
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return fallback;
  }
}

/** Accounts.md のシリアライズ */
export function serializeAccountsMarkdown(accounts: AssetAccount[]): string {
  const sorted = [...accounts].sort((a, b) => a.order - b.order);
  const jsonStr = JSON.stringify(sorted, null, 2);

  return `---
kind: asset-accounts
updated: "${new Date().toISOString()}"
---

# 資産口座設定

Seiton 資産管理の口座定義です。

\`\`\`json
${jsonStr}
\`\`\`
`;
}

/** Accounts.md のパース */
export function parseAccountsMarkdown(content: string): AssetAccount[] {
  return extractJsonBlock<AssetAccount[]>(content, []);
}

/** Snapshots.md のデータ構造 */
export interface SnapshotsFileData {
  incomes: AssetIncome[];
  snapshots: AssetSnapshot[];
}

/** Snapshots.md のシリアライズ */
export function serializeSnapshotsMarkdown(
  snapshots: AssetSnapshot[],
  incomes: AssetIncome[]
): string {
  const data: SnapshotsFileData = {
    incomes: [...incomes].sort((a, b) => a.date.localeCompare(b.date)),
    snapshots: [...snapshots].sort((a, b) => a.date.localeCompare(b.date)),
  };
  const jsonStr = JSON.stringify(data, null, 2);

  return `---
kind: asset-snapshots
updated: "${new Date().toISOString()}"
---

# 資産スナップショット＆収入記録

定期的な残高スナップショットと収入の台帳です。

\`\`\`json
${jsonStr}
\`\`\`
`;
}

/** Snapshots.md のパース */
export function parseSnapshotsMarkdown(content: string): SnapshotsFileData {
  return extractJsonBlock<SnapshotsFileData>(content, {
    incomes: [],
    snapshots: [],
  });
}

/** Stocks.md のデータ構造 */
export interface StocksFileData {
  repayments: StockRepayment[];
  stocks: StockExpense[];
}

/** Stocks.md のシリアライズ */
export function serializeStocksMarkdown(
  stocks: StockExpense[],
  repayments: StockRepayment[]
): string {
  const data: StocksFileData = {
    repayments: [...repayments].sort((a, b) => a.date.localeCompare(b.date)),
    stocks: [...stocks].sort((a, b) =>
      a.purchaseDate.localeCompare(b.purchaseDate)
    ),
  };
  const jsonStr = JSON.stringify(data, null, 2);

  return `---
kind: asset-stocks
updated: "${new Date().toISOString()}"
---

# ストック支出＆返済台帳

減価償却対象の大型支出と、奨学金口座への返済履歴です。

\`\`\`json
${jsonStr}
\`\`\`
`;
}

/** Stocks.md のパース */
export function parseStocksMarkdown(content: string): StocksFileData {
  return extractJsonBlock<StocksFileData>(content, {
    repayments: [],
    stocks: [],
  });
}
