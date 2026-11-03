import { describe, expect, it } from "vitest";
import type {
  AssetAccount,
  AssetIncome,
  AssetSnapshot,
  StockExpense,
  StockRepayment,
} from "../src/domain/asset";
import {
  parseAccountsMarkdown,
  parseSnapshotsMarkdown,
  parseStocksMarkdown,
  serializeAccountsMarkdown,
  serializeSnapshotsMarkdown,
  serializeStocksMarkdown,
} from "../src/domain/assetSerializer";

describe("assetSerializer", () => {
  it("Accounts.md をシリアライズしてパースで元に戻せる", () => {
    const accounts: AssetAccount[] = [
      {
        createdAt: "2026-11-01",
        group: "living",
        id: "acc_1",
        initialBalance: 1000,
        kind: "bank",
        name: "みずほ",
        order: 1,
      },
      {
        createdAt: "2026-11-01",
        group: "special",
        id: "acc_2",
        initialBalance: 50_000,
        kind: "bank",
        name: "奨学金",
        order: 2,
      },
    ];

    const md = serializeAccountsMarkdown(accounts);
    expect(md).toContain("kind: asset-accounts");
    expect(md).toContain('"id": "acc_1"');

    const parsed = parseAccountsMarkdown(md);
    expect(parsed).toEqual(accounts);
  });

  it("Snapshots.md をシリアライズしてパースで元に戻せる", () => {
    const snapshots: AssetSnapshot[] = [
      {
        balances: { acc_1: 15_000 },
        createdAt: "2026-11-15T09:00:00Z",
        date: "2026-11-15",
        id: "snap_1",
        note: "給料日",
      },
    ];
    const incomes: AssetIncome[] = [
      {
        amount: 85_000,
        category: "salary",
        createdAt: "2026-11-25T10:00:00Z",
        date: "2026-11-25",
        id: "inc_1",
        memo: "バイト代",
      },
    ];

    const md = serializeSnapshotsMarkdown(snapshots, incomes);
    expect(md).toContain("kind: asset-snapshots");

    const parsed = parseSnapshotsMarkdown(md);
    expect(parsed.snapshots).toEqual(snapshots);
    expect(parsed.incomes).toEqual(incomes);
  });

  it("Stocks.md をシリアライズしてパースで元に戻せる", () => {
    const stocks: StockExpense[] = [
      {
        amortizationMonths: 24,
        amount: 240_000,
        createdAt: "2026-11-01",
        id: "stock_1",
        isRepaymentRequired: true,
        memo: "仕事用",
        purchaseDate: "2026-11-01",
        sourceAccountId: "acc_2",
        title: "MacBook",
      },
    ];
    const repayments: StockRepayment[] = [
      {
        amount: 10_000,
        createdAt: "2026-11-20",
        date: "2026-11-20",
        id: "rep_1",
        stockExpenseId: "stock_1",
      },
    ];

    const md = serializeStocksMarkdown(stocks, repayments);
    expect(md).toContain("kind: asset-stocks");

    const parsed = parseStocksMarkdown(md);
    expect(parsed.stocks).toEqual(stocks);
    expect(parsed.repayments).toEqual(repayments);
  });
});
