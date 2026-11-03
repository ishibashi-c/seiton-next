import { beforeEach, describe, expect, it } from "vitest";
import { AssetService } from "../src/services/assetService";
import { MemoryVault } from "./helpers/memoryVault";

describe("AssetService", () => {
  let vault: MemoryVault;
  let service: AssetService;

  beforeEach(() => {
    vault = new MemoryVault();
    service = new AssetService(vault);
  });

  it("初回ロード時に初期口座セットが自動生成される", async () => {
    const dataset = await service.loadDataset();
    expect(dataset.accounts.length).toBeGreaterThan(0);
    expect(dataset.accounts.some((a) => a.id === "acc_wallet")).toBe(true);
    expect(dataset.accounts.some((a) => a.id === "acc_scholarship")).toBe(true);
    expect(dataset.snapshots).toHaveLength(0);
    expect(dataset.stocks).toHaveLength(0);
  });

  it("スナップショットと収入を同時に安全に記録できる", async () => {
    await service.recordSnapshot(
      {
        balances: { acc_main_bank: 150_000, acc_wallet: 8000 },
        date: "2026-11-25",
        note: "給料日スナップショット",
      },
      [
        {
          amount: 85_000,
          category: "salary",
          date: "2026-11-25",
          memo: "11月バイト代",
        },
      ]
    );

    const dataset = await service.loadDataset();
    expect(dataset.snapshots).toHaveLength(1);
    expect(dataset.snapshots[0]?.date).toBe("2026-11-25");
    expect(dataset.snapshots[0]?.balances.acc_main_bank).toBe(150_000);
    expect(dataset.incomes).toHaveLength(1);
    expect(dataset.incomes[0]?.amount).toBe(85_000);
  });

  it("ストック支出の登録と奨学金への返済を記録できる", async () => {
    const stock = await service.addStockExpense({
      amortizationMonths: 24,
      amount: 240_000,
      isRepaymentRequired: true,
      memo: "M4 Mac mini",
      purchaseDate: "2026-11-01",
      sourceAccountId: "acc_scholarship",
      title: "Mac mini",
    });

    await service.addStockRepayment({
      amount: 20_000,
      date: "2026-11-28",
      memo: "バイト代から返済",
      stockExpenseId: stock.id,
    });

    const dataset = await service.loadDataset();
    expect(dataset.stocks).toHaveLength(1);
    expect(dataset.stocks[0]?.title).toBe("Mac mini");
    expect(dataset.repayments).toHaveLength(1);
    expect(dataset.repayments[0]?.amount).toBe(20_000);
  });

  it("CSVエクスポートが実行され3ファイルが生成される", async () => {
    await service.recordSnapshot({
      balances: { acc_main_bank: 100_000 },
      date: "2026-11-01",
    });
    const exported = await service.exportCsvFiles("Seiton/Exports/Test");
    expect(exported).toHaveLength(3);
    expect(vault.exists("Seiton/Exports/Test/Snapshots.csv")).toBe(true);
    expect(vault.exists("Seiton/Exports/Test/MonthlyPl.csv")).toBe(true);
    expect(vault.exists("Seiton/Exports/Test/Stocks.csv")).toBe(true);
  });
});
