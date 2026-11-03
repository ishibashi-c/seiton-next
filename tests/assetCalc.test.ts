import { describe, expect, it } from "vitest";
import type { AssetDataset } from "../src/domain/asset";
import {
  calculateElapsedMonths,
  calculateLatestBs,
  calculateMonthlyPl,
  calculateStockStatus,
} from "../src/domain/assetCalc";

describe("calculateElapsedMonths", () => {
  it("同月内の日付は1ヶ月目としてカウントする", () => {
    expect(calculateElapsedMonths("2026-11-01", "2026-11-15")).toBe(1);
  });

  it("翌月の同日以降は2ヶ月目としてカウントする", () => {
    expect(calculateElapsedMonths("2026-11-01", "2026-12-01")).toBe(2);
    expect(calculateElapsedMonths("2026-11-01", "2027-11-01")).toBe(13);
  });
});

describe("calculateStockStatus", () => {
  it("ストック支出の減価償却と要返済額を正しく計算する", () => {
    const stock = {
      amortizationMonths: 24,
      amount: 240_000,
      createdAt: "2026-11-01",
      id: "stock_pc",
      isRepaymentRequired: true,
      purchaseDate: "2026-11-01",
      sourceAccountId: "acc_scholarship",
      title: "MacBook Pro",
    };

    // 1ヶ月目（2026-11-15）: 返済なし
    const status1 = calculateStockStatus(stock, [], "2026-11-15");
    expect(status1.monthlyAmortization).toBe(10_000);
    expect(status1.amortizedAmount).toBe(10_000);
    expect(status1.unreturnedValue).toBe(230_000);
    expect(status1.totalRepayments).toBe(0);
    expect(status1.repaymentBalance).toBe(10_000); // 1万円要返済
    expect(status1.isRepaymentCompleted).toBe(false);

    // 3ヶ月目（2027-01-15）: 2万円返済済み
    const repayments = [
      {
        amount: 20_000,
        createdAt: "2027-01-10",
        date: "2027-01-10",
        id: "rep_1",
        stockExpenseId: "stock_pc",
      },
    ];
    const status3 = calculateStockStatus(stock, repayments, "2027-01-15");
    expect(status3.elapsedMonths).toBe(3);
    expect(status3.amortizedAmount).toBe(30_000);
    expect(status3.unreturnedValue).toBe(210_000);
    expect(status3.totalRepayments).toBe(20_000);
    expect(status3.repaymentBalance).toBe(10_000); // 3万償却 - 2万返済 = 残り1万目安

    // 前倒し返済（4万円返済）
    const repaymentsOver = [
      {
        amount: 40_000,
        createdAt: "2027-01-10",
        date: "2027-01-10",
        id: "rep_2",
        stockExpenseId: "stock_pc",
      },
    ];
    const statusOver = calculateStockStatus(
      stock,
      repaymentsOver,
      "2027-01-15"
    );
    expect(statusOver.repaymentBalance).toBe(-10_000); // 前倒し1万円
  });

  it("返済不要（自己投資）のストック支出は要返済額が0になる", () => {
    const stock = {
      amortizationMonths: 6,
      amount: 60_000,
      createdAt: "2026-11-01",
      id: "stock_toeic",
      isRepaymentRequired: false,
      purchaseDate: "2026-11-01",
      sourceAccountId: "acc_scholarship",
      title: "TOEIC集中コース",
    };
    const status = calculateStockStatus(stock, [], "2026-11-15");
    expect(status.monthlyAmortization).toBe(10_000);
    expect(status.amortizedAmount).toBe(10_000);
    expect(status.repaymentBalance).toBe(0);
    expect(status.isRepaymentCompleted).toBe(true);
  });
});

describe("calculateLatestBs", () => {
  it("生活資金・特別資金・未償却ストック価値を合算してB/Sを計算する", () => {
    const dataset: AssetDataset = {
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
          group: "living",
          id: "acc_bank",
          initialBalance: 0,
          kind: "bank",
          name: "銀行",
          order: 2,
        },
        {
          createdAt: "2026-11-01",
          group: "special",
          id: "acc_scholarship",
          initialBalance: 0,
          kind: "bank",
          name: "奨学金",
          order: 3,
        },
      ],
      incomes: [],
      repayments: [],
      snapshots: [
        {
          balances: {
            acc_bank: 100_000,
            acc_scholarship: 300_000,
            acc_wallet: 15_000,
          },
          createdAt: "2026-11-15",
          date: "2026-11-15",
          id: "snap_1",
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
          sourceAccountId: "acc_scholarship",
          title: "MacBook",
        },
      ],
    };

    const bs = calculateLatestBs(dataset, "2026-11-15");
    expect(bs.livingBalance).toBe(115_000);
    expect(bs.specialBalance).toBe(300_000);
    expect(bs.netFinancialWorth).toBe(415_000);
    expect(bs.unreturnedStockValue).toBe(230_000); // 240,000 - 10,000
    expect(bs.totalNetWorth).toBe(645_000);
  });
});

describe("calculateMonthlyPl", () => {
  it("スナップショット差分と収入から生活費と実質生活コストを自動逆算する", () => {
    const dataset: AssetDataset = {
      accounts: [
        {
          createdAt: "2026-10-01",
          group: "living",
          id: "acc_bank",
          initialBalance: 0,
          kind: "bank",
          name: "メイン銀行",
          order: 1,
        },
        {
          createdAt: "2026-10-01",
          group: "special",
          id: "acc_scholarship",
          initialBalance: 0,
          kind: "bank",
          name: "奨学金",
          order: 2,
        },
      ],
      incomes: [
        {
          amount: 85_000,
          category: "salary",
          createdAt: "2026-11-25",
          date: "2026-11-25",
          id: "inc_1",
          memo: "バイト代",
        },
        {
          amount: 20_000,
          category: "allowance",
          createdAt: "2026-11-01",
          date: "2026-11-01",
          id: "inc_2",
          memo: "お小遣い",
        },
      ],
      repayments: [],
      snapshots: [
        {
          // 10月末: 100,000円
          balances: { acc_bank: 100_000 },
          createdAt: "2026-10-31",
          date: "2026-10-31",
          id: "snap_oct",
        },
        {
          // 11月末: 115,000円 (生活資金 +15,000円増)
          balances: { acc_bank: 115_000 },
          createdAt: "2026-11-30",
          date: "2026-11-30",
          id: "snap_nov",
        },
      ],
      stocks: [
        {
          amortizationMonths: 12, // 月1万円償却
          amount: 120_000,
          createdAt: "2026-11-01",
          id: "stock_1",
          isRepaymentRequired: false,
          purchaseDate: "2026-11-01",
          sourceAccountId: "acc_scholarship",
          title: "家電",
        },
      ],
    };

    const pl = calculateMonthlyPl("2026-11", dataset);
    expect(pl.totalIncome).toBe(105_000); // 85,000 + 20,000
    expect(pl.livingCashChange).toBe(15_000); // 115,000 - 100,000
    // 生活費 = 収入 105,000 - 残高増 15,000 = 90,000
    expect(pl.livingCost).toBe(90_000);
    // 当月償却費 = 10,000
    expect(pl.depreciation).toBe(10_000);
    // 実質生活コスト = 生活費 90,000 + 償却 10,000 = 100,000
    expect(pl.realLivingCost).toBe(100_000);
  });
});
