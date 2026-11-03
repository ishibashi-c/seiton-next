/**
 * 資産管理（Assets）のVault永続化サービス。
 * `Seiton/System/Assets/` 配下の Markdown ファイル群（Accounts.md, Snapshots.md, Stocks.md）の
 * 読み込み・書き込み・CSVエクスポートを統括する。
 */

import { ASSETS_FOLDER } from "../config";
import {
  type AssetAccount,
  type AssetDataset,
  type AssetIncome,
  type AssetSnapshot,
  DEFAULT_ACCOUNTS,
  type StockExpense,
  type StockRepayment,
} from "../domain/asset";
import { calculateMonthlyPl } from "../domain/assetCalc";
import {
  generateMonthlyPlCsv,
  generateSnapshotsCsv,
  generateStocksCsv,
} from "../domain/assetExport";
import {
  parseAccountsMarkdown,
  parseSnapshotsMarkdown,
  parseStocksMarkdown,
  serializeAccountsMarkdown,
  serializeSnapshotsMarkdown,
  serializeStocksMarkdown,
} from "../domain/assetSerializer";
import type { VaultPort } from "./vaultPort";

export class AssetService {
  private readonly vault: VaultPort;
  private readonly baseFolder: string;

  constructor(vault: VaultPort, baseFolder = ASSETS_FOLDER) {
    this.vault = vault;
    this.baseFolder = baseFolder;
  }

  get accountsPath(): string {
    return `${this.baseFolder}/Accounts.md`;
  }

  get snapshotsPath(): string {
    return `${this.baseFolder}/Snapshots.md`;
  }

  get stocksPath(): string {
    return `${this.baseFolder}/Stocks.md`;
  }

  /**
   * 必要なフォルダと初期ファイルの存在を保証する。
   */
  async ensure(): Promise<void> {
    await this.vault.ensureFolder(this.baseFolder);

    // Accounts.md が無ければ初期口座を作成
    if (!this.vault.exists(this.accountsPath)) {
      const initialAccounts: AssetAccount[] = DEFAULT_ACCOUNTS.map((acc) => ({
        ...acc,
        createdAt: new Date().toISOString(),
      }));
      await this.vault.create(
        this.accountsPath,
        serializeAccountsMarkdown(initialAccounts)
      );
    }

    if (!this.vault.exists(this.snapshotsPath)) {
      await this.vault.create(
        this.snapshotsPath,
        serializeSnapshotsMarkdown([], [])
      );
    }

    if (!this.vault.exists(this.stocksPath)) {
      await this.vault.create(this.stocksPath, serializeStocksMarkdown([], []));
    }
  }

  /**
   * 資産ドメインの全データを読み出す。
   */
  async loadDataset(): Promise<AssetDataset> {
    await this.ensure();

    const [accountsContent, snapshotsContent, stocksContent] =
      await Promise.all([
        this.vault.read(this.accountsPath),
        this.vault.read(this.snapshotsPath),
        this.vault.read(this.stocksPath),
      ]);

    const accounts = parseAccountsMarkdown(accountsContent);
    const { snapshots, incomes } = parseSnapshotsMarkdown(snapshotsContent);
    const { stocks, repayments } = parseStocksMarkdown(stocksContent);

    return {
      accounts,
      incomes,
      repayments,
      snapshots,
      stocks,
    };
  }

  /**
   * 口座リストを保存する。
   */
  async saveAccounts(accounts: AssetAccount[]): Promise<void> {
    await this.ensure();
    await this.vault.process(this.accountsPath, () =>
      serializeAccountsMarkdown(accounts)
    );
  }

  /**
   * 残高スナップショットを記録する（同日があれば更新）。
   */
  async recordSnapshot(
    input: Omit<AssetSnapshot, "createdAt" | "id">,
    incomesToAdd: Omit<AssetIncome, "createdAt" | "id">[] = []
  ): Promise<AssetSnapshot> {
    await this.ensure();

    let savedSnapshot: AssetSnapshot | null = null;

    await this.vault.process(this.snapshotsPath, (content) => {
      const data = parseSnapshotsMarkdown(content);
      const nowIso = new Date().toISOString();

      // 既存の同日スナップショットがあれば更新、なければ新規作成
      const existingIdx = data.snapshots.findIndex(
        (s) => s.date === input.date
      );
      const existing =
        existingIdx >= 0 ? data.snapshots[existingIdx] : undefined;
      if (existing) {
        savedSnapshot = {
          balances: { ...input.balances },
          createdAt: existing.createdAt,
          date: input.date,
          id: existing.id,
          note: input.note,
        };
        data.snapshots[existingIdx] = savedSnapshot;
      } else {
        const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        savedSnapshot = {
          balances: { ...input.balances },
          createdAt: nowIso,
          date: input.date,
          id,
          note: input.note,
        };
        data.snapshots.push(savedSnapshot);
      }

      // 同時入力された収入があれば追加
      for (const inc of incomesToAdd) {
        const incId = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        data.incomes.push({
          ...inc,
          createdAt: nowIso,
          id: incId,
        });
      }

      return serializeSnapshotsMarkdown(data.snapshots, data.incomes);
    });

    if (!savedSnapshot) {
      throw new Error("スナップショットの保存に失敗しました。");
    }
    return savedSnapshot;
  }

  /**
   * 収入を1件記録する。
   */
  async addIncome(
    input: Omit<AssetIncome, "createdAt" | "id">
  ): Promise<AssetIncome> {
    await this.ensure();

    let created: AssetIncome | null = null;

    await this.vault.process(this.snapshotsPath, (content) => {
      const data = parseSnapshotsMarkdown(content);
      const id = `inc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      created = {
        ...input,
        createdAt: new Date().toISOString(),
        id,
      };
      data.incomes.push(created);
      return serializeSnapshotsMarkdown(data.snapshots, data.incomes);
    });

    if (!created) {
      throw new Error("収入の保存に失敗しました。");
    }
    return created;
  }

  /**
   * ストック支出を1件登録する。
   */
  async addStockExpense(
    input: Omit<StockExpense, "createdAt" | "id">
  ): Promise<StockExpense> {
    await this.ensure();

    let created: StockExpense | null = null;

    await this.vault.process(this.stocksPath, (content) => {
      const data = parseStocksMarkdown(content);
      const id = `stock_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      created = {
        ...input,
        createdAt: new Date().toISOString(),
        id,
      };
      data.stocks.push(created);
      return serializeStocksMarkdown(data.stocks, data.repayments);
    });

    if (!created) {
      throw new Error("ストック支出の保存に失敗しました。");
    }
    return created;
  }

  /**
   * ストック支出に対する返済を1件記録する。
   */
  async addStockRepayment(
    input: Omit<StockRepayment, "createdAt" | "id">
  ): Promise<StockRepayment> {
    await this.ensure();

    let created: StockRepayment | null = null;

    await this.vault.process(this.stocksPath, (content) => {
      const data = parseStocksMarkdown(content);
      const id = `rep_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      created = {
        ...input,
        createdAt: new Date().toISOString(),
        id,
      };
      data.repayments.push(created);
      return serializeStocksMarkdown(data.stocks, data.repayments);
    });

    if (!created) {
      throw new Error("返済の保存に失敗しました。");
    }
    return created;
  }

  /**
   * CSVファイルを Vault 内の `Seiton/Exports/Assets-YYYYMMDD/` に出力する。
   */
  async exportCsvFiles(
    targetFolder?: string
  ): Promise<{ filename: string; path: string }[]> {
    const dataset = await this.loadDataset();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const folder = targetFolder ?? `Seiton/Exports/Assets-${today}`;
    await this.vault.ensureFolder(folder);

    // 1. スナップショット履歴 CSV
    const snapshotsCsv = generateSnapshotsCsv(dataset);
    const snapshotsPath = `${folder}/Snapshots.csv`;
    if (this.vault.exists(snapshotsPath)) {
      await this.vault.process(snapshotsPath, () => snapshotsCsv);
    } else {
      await this.vault.create(snapshotsPath, snapshotsCsv);
    }

    // 2. 月次P/L CSV（過去スナップショットや収入のある全月分）
    const monthsSet = new Set<string>();
    for (const s of dataset.snapshots) {
      monthsSet.add(s.date.slice(0, 7));
    }
    for (const inc of dataset.incomes) {
      monthsSet.add(inc.date.slice(0, 7));
    }
    const months = Array.from(monthsSet).sort();
    const monthlySummaries = months.map((m) => calculateMonthlyPl(m, dataset));
    const plCsv = generateMonthlyPlCsv(monthlySummaries);
    const plPath = `${folder}/MonthlyPl.csv`;
    if (this.vault.exists(plPath)) {
      await this.vault.process(plPath, () => plCsv);
    } else {
      await this.vault.create(plPath, plCsv);
    }

    // 3. ストック台帳 CSV
    const stocksCsv = generateStocksCsv(dataset);
    const stocksPath = `${folder}/Stocks.csv`;
    if (this.vault.exists(stocksPath)) {
      await this.vault.process(stocksPath, () => stocksCsv);
    } else {
      await this.vault.create(stocksPath, stocksCsv);
    }

    return [
      { filename: "Snapshots.csv", path: snapshotsPath },
      { filename: "MonthlyPl.csv", path: plPath },
      { filename: "Stocks.csv", path: stocksPath },
    ];
  }
}
