import { describe, expect, it } from "vitest";
import type { AssetDataset } from "../src/domain/asset";
import {
  generateMonthlyPlCsv,
  generateSnapshotsCsv,
  generateStocksCsv,
} from "../src/domain/assetExport";

describe("assetExport", () => {
  const dummyDataset: AssetDataset = {
    accounts: [
      {
        createdAt: "2026-11-01",
        group: "living",
        id: "acc_wallet",
        initialBalance: 0,
        kind: "cash",
        name: "財布",
        order: 1,
      },
      {
        createdAt: "2026-11-01",
        group: "special",
        id: "acc_scholar",
        initialBalance: 0,
        kind: "bank",
        name: "奨学金",
        order: 2,
      },
    ],
    incomes: [],
    repayments: [
      {
        amount: 20_000,
        createdAt: "2026-11-10",
        date: "2026-11-10",
        id: "rep_1",
        stockExpenseId: "stock_pc",
      },
    ],
    snapshots: [
      {
        balances: { acc_scholar: 300_000, acc_wallet: 15_000 },
        createdAt: "2026-11-15",
        date: "2026-11-15",
        id: "snap_1",
        note: "給料日直後",
      },
    ],
    stocks: [
      {
        amortizationMonths: 24,
        amount: 240_000,
        createdAt: "2026-11-01",
        id: "stock_pc",
        isRepaymentRequired: true,
        purchaseDate: "2026-11-01",
        sourceAccountId: "acc_scholar",
        title: "MacBook Pro",
      },
    ],
  };

  it("スナップショットCSVがBOM付きで正しく出力される", () => {
    const csv = generateSnapshotsCsv(dummyDataset);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("日付,財布(生活),奨学金(特別),生活資金合計");
    expect(csv).toContain("2026-11-15,15000,300000,15000,300000,315000");
  });

  it("月次P/L CSVが出力される", () => {
    const csv = generateMonthlyPlCsv([
      {
        cashNetChange: 15_000,
        depreciation: 10_000,
        livingCashChange: 15_000,
        livingCost: 90_000,
        realLivingCost: 100_000,
        totalIncome: 105_000,
        yearMonth: "2026-11",
      },
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("年月,収入合計,日常生活費,減価償却費");
    expect(csv).toContain("2026-11,105000,90000,10000,100000,15000,15000");
  });

  it("ストック台帳CSVが出力される", () => {
    const csv = generateStocksCsv(dummyDataset, "2026-11-15");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("品名,購入金額,購入日,支払元口座,償却月数");
    expect(csv).toContain(
      "MacBook Pro,240000,2026-11-01,奨学金,24,10000,10000,230000,要返済,20000,-10000"
    );
  });
});
