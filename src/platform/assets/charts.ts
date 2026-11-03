/**
 * 資産（Assets）ビュー用の軽量インライン SVG チャート。
 * 外部ライブラリを使わず、テーマ変数（CSSカスタムプロパティ）に連動して美しく描画される。
 */

import type { AssetDataset } from "../../domain/asset";
import {
  calculateLatestBs,
  type calculateStockStatus,
  type MonthlyPlSummary,
  sortSnapshots,
} from "../../domain/assetCalc";

/**
 * 総資産の推移（積層エリア／折れ線）チャートを描画する。
 */
export function renderNetWorthChart(
  container: HTMLElement,
  dataset: AssetDataset,
  width = 600,
  height = 200
): void {
  const snapshots = sortSnapshots(dataset.snapshots);
  if (snapshots.length === 0) {
    container.createDiv({
      cls: "seiton-asset-chart-empty",
      text: "スナップショットが記録されると、ここに資産推移グラフが表示されます。",
    });
    return;
  }

  // 各スナップショット時点の数値を算出
  const points = snapshots.map((s) => {
    const bs = calculateLatestBs(dataset, s.date);
    return {
      date: s.date,
      living: bs.livingBalance,
      special: bs.specialBalance,
      stock: bs.unreturnedStockValue,
      total: bs.totalNetWorth,
    };
  });

  const maxVal = Math.max(1, ...points.map((p) => p.total));
  const minVal = Math.min(0, ...points.map((p) => Math.min(p.living, p.total)));
  const range = maxVal - minVal || 1;

  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const getX = (idx: number) =>
    padLeft +
    (points.length <= 1 ? plotW / 2 : (idx / (points.length - 1)) * plotW);
  const getY = (val: number) =>
    padTop + plotH - ((val - minVal) / range) * plotH;

  // SVG 要素の構築
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "seiton-asset-svg-chart");

  // 背景ガイドライン（横線）
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const val = minVal + (range / steps) * i;
    const y = getY(val);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(padLeft));
    line.setAttribute("x2", String(width - padRight));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "seiton-chart-grid-line");
    svg.appendChild(line);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(padLeft - 8));
    text.setAttribute("y", String(y + 4));
    text.setAttribute("text-anchor", "end");
    text.setAttribute("class", "seiton-chart-label");
    text.textContent = `¥${Math.round(val).toLocaleString()}`;
    svg.appendChild(text);
  }

  // 総資産（Total）の折れ線
  const polyPoints = points
    .map((p, idx) => `${getX(idx)},${getY(p.total)}`)
    .join(" ");
  const polyline = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  polyline.setAttribute("points", polyPoints);
  polyline.setAttribute("class", "seiton-chart-line-total");
  svg.appendChild(polyline);

  // 生活資金（Living）の折れ線
  const livingPolyPoints = points
    .map((p, idx) => `${getX(idx)},${getY(p.living)}`)
    .join(" ");
  const livingPolyline = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "polyline"
  );
  livingPolyline.setAttribute("points", livingPolyPoints);
  livingPolyline.setAttribute("class", "seiton-chart-line-living");
  svg.appendChild(livingPolyline);

  // ドット & X軸ラベル
  points.forEach((p, idx) => {
    const x = getX(idx);
    const y = getY(p.total);

    const circle = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "circle"
    );
    circle.setAttribute("cx", String(x));
    circle.setAttribute("cy", String(y));
    circle.setAttribute("r", "4");
    circle.setAttribute("class", "seiton-chart-dot");
    svg.appendChild(circle);

    // 日付ラベル
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(x));
    text.setAttribute("y", String(height - 8));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "seiton-chart-label");
    text.textContent = p.date.slice(5); // MM-DD
    svg.appendChild(text);
  });

  container.appendChild(svg);
}

/**
 * 月次収支（収入 vs 生活費 vs 償却費）バーチャートを描画する。
 */
export function renderMonthlyPlChart(
  container: HTMLElement,
  summaries: MonthlyPlSummary[],
  width = 600,
  height = 200
): void {
  if (summaries.length === 0) {
    container.createDiv({
      cls: "seiton-asset-chart-empty",
      text: "月次収支データがまだありません。",
    });
    return;
  }

  const maxVal = Math.max(
    1,
    ...summaries.map((s) => Math.max(s.totalIncome, s.realLivingCost))
  );

  const padLeft = 60;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "seiton-asset-svg-chart");

  const barGroupWidth = plotW / summaries.length;
  const barWidth = Math.min(24, barGroupWidth * 0.35);

  summaries.forEach((s, idx) => {
    const groupX =
      padLeft + idx * barGroupWidth + (barGroupWidth - barWidth * 2 - 4) / 2;

    // 1. 収入バー（緑）
    const incomeH = (s.totalIncome / maxVal) * plotH;
    const incomeY = padTop + plotH - incomeH;
    const incomeBar = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect"
    );
    incomeBar.setAttribute("x", String(groupX));
    incomeBar.setAttribute("y", String(incomeY));
    incomeBar.setAttribute("width", String(barWidth));
    incomeBar.setAttribute("height", String(incomeH));
    incomeBar.setAttribute("class", "seiton-chart-bar-income");
    svg.appendChild(incomeBar);

    // 2. 実質生活コストバー（生活費 ＋ 償却費）
    const costH = (s.realLivingCost / maxVal) * plotH;
    const costY = padTop + plotH - costH;
    const costBar = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "rect"
    );
    costBar.setAttribute("x", String(groupX + barWidth + 4));
    costBar.setAttribute("y", String(costY));
    costBar.setAttribute("width", String(barWidth));
    costBar.setAttribute("height", String(costH));
    costBar.setAttribute("class", "seiton-chart-bar-cost");
    svg.appendChild(costBar);

    // X軸ラベル（年月）
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(groupX + barWidth + 2));
    text.setAttribute("y", String(height - 8));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "seiton-chart-label");
    text.textContent = s.yearMonth;
    svg.appendChild(text);
  });

  container.appendChild(svg);
}

/**
 * 各ストック支出の返済・償却プログレスゲージを描画する。
 */
export function renderStockProgressBar(
  container: HTMLElement,
  stockStatus: ReturnType<typeof calculateStockStatus>
): void {
  const wrap = container.createDiv({ cls: "seiton-asset-stock-progress-wrap" });

  const amount = stockStatus.stock.amount;
  const amortizedPct = Math.min(
    100,
    Math.round((stockStatus.amortizedAmount / amount) * 100)
  );
  const repaidPct = Math.min(
    100,
    Math.round((stockStatus.totalRepayments / amount) * 100)
  );

  const track = wrap.createDiv({ cls: "seiton-asset-progress-track" });

  // 償却進捗（背景の淡いバー）
  const amortBar = track.createDiv({ cls: "seiton-asset-progress-amort" });
  amortBar.style.width = `${amortizedPct}%`;

  // 返済進捗（手前のアクセントバー）
  const repayBar = track.createDiv({ cls: "seiton-asset-progress-repay" });
  repayBar.style.width = `${repaidPct}%`;

  const legend = wrap.createDiv({ cls: "seiton-asset-progress-legend" });
  legend.createSpan({
    cls: "seiton-asset-legend-item is-amort",
    text: `償却: ${amortizedPct}% (${stockStatus.elapsedMonths}/${stockStatus.stock.amortizationMonths}ヶ月)`,
  });
  if (stockStatus.stock.isRepaymentRequired) {
    legend.createSpan({
      cls: "seiton-asset-legend-item is-repay",
      text: `返済: ${repaidPct}% (¥${stockStatus.totalRepayments.toLocaleString()})`,
    });
  }
}
