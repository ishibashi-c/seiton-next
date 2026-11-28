/**
 * バーコード（EAN-13 / ISBN）デコードエンジン。
 *
 * 1. ネイティブ `BarcodeDetector`（Android WebView / Chrome / Electron 等）を優先使用し、
 *    2段バーコード（978 + 192）を同時に検出して 978/979 のみ抽出する。
 * 2. 非対応環境や難読フレーム向けに、切り抜き・90度回転・コントラスト強調を組み合わせた
 *    `@zxing/browser` の多段解析へフォールバックする。
 *
 * 画像をディスク・写真ライブラリ・Vault へ一切保存せず、メモリ上の Canvas だけで処理する。
 */

import { BarcodeFormat, BrowserMultiFormatReader } from "@zxing/browser";
import { DecodeHintType } from "@zxing/library";
import {
  type BarcodeDetectionOutcome,
  classifyDetectedBarcodes,
} from "../../domain/barcode";

interface NativeBarcodeResult {
  rawValue?: string;
}

interface NativeBarcodeDetector {
  detect(source: ImageBitmapSource): Promise<NativeBarcodeResult[]>;
}

interface NativeBarcodeDetectorConstructor {
  getSupportedFormats?: () => Promise<string[]>;
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
}

interface CropRegion {
  highContrast?: boolean;
  maxDimension: number;
  rh: number;
  rotate90?: boolean;
  rw: number;
  rx: number;
  ry: number;
}

const IMAGE_ZXING_PASSES: readonly CropRegion[] = [
  // 1. 全体（高解像度維持）
  { maxDimension: 1800, rh: 1, rw: 1, rx: 0, ry: 0 },
  // 2. 中央帯（横持ち撮影時）
  { maxDimension: 1600, rh: 0.5, rw: 0.84, rx: 0.08, ry: 0.25 },
  // 3. 上段帯（日本の2段バーコード上段の 978 を分離）
  { maxDimension: 1600, rh: 0.55, rw: 1, rx: 0, ry: 0 },
  // 4. 中段帯
  { maxDimension: 1600, rh: 0.56, rw: 1, rx: 0, ry: 0.22 },
  // 5. 下段帯（上下逆さま撮影対策）
  { maxDimension: 1600, rh: 0.55, rw: 1, rx: 0, ry: 0.45 },
  // 6. 90度回転（縦持ち・横バーコード）
  { maxDimension: 1600, rh: 1, rotate90: true, rw: 1, rx: 0, ry: 0 },
  // 7. 90度回転 + 中央帯
  { maxDimension: 1600, rh: 1, rotate90: true, rw: 0.56, rx: 0.22, ry: 0 },
  // 8. 高コントラスト・グレースケール強調（照明ムラ・低コントラスト印刷向け）
  {
    highContrast: true,
    maxDimension: 1400,
    rh: 0.6,
    rw: 0.9,
    rx: 0.05,
    ry: 0.2,
  },
];

export class BarcodeDecoder {
  private nativeDetector: NativeBarcodeDetector | null = null;
  private nativeChecked = false;
  private readonly zxingReader: BrowserMultiFormatReader;

  constructor() {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    this.zxingReader = new BrowserMultiFormatReader(hints);
  }

  /**
   * 実行環境でネイティブ `BarcodeDetector`（ean_13）が使えるか初期化して返す。
   */
  async init(): Promise<"native" | "zxing"> {
    if (this.nativeChecked) {
      return this.nativeDetector ? "native" : "zxing";
    }
    this.nativeChecked = true;
    const ctor = (
      globalThis as unknown as {
        BarcodeDetector?: NativeBarcodeDetectorConstructor;
      }
    ).BarcodeDetector;
    if (typeof ctor !== "function") {
      return "zxing";
    }
    try {
      if (typeof ctor.getSupportedFormats === "function") {
        const supported = await ctor.getSupportedFormats();
        if (!supported.includes("ean_13")) {
          return "zxing";
        }
      }
      this.nativeDetector = new ctor({ formats: ["ean_13"] });
      return "native";
    } catch {
      this.nativeDetector = null;
      return "zxing";
    }
  }

  /**
   * ライブカメラの1フレームからISBN-13を検出する。
   * 呼び出し元のオフスクリーン Canvas を再利用し、GC負荷とメモリ消費を抑える。
   */
  async detectFromVideoFrame(
    video: HTMLVideoElement,
    scratchCanvas: HTMLCanvasElement,
    frameIndex: number
  ): Promise<BarcodeDetectionOutcome> {
    if (
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return { isbn: null, sawPriceBarcode: false };
    }
    await this.init();

    let sawPriceBarcode = false;

    if (this.nativeDetector) {
      // ネイティブ実装は1フレーム内の複数バーコードを同時に返せる
      const fullOutcome = await this.detectNative(video);
      if (fullOutcome.isbn) {
        return fullOutcome;
      }
      sawPriceBarcode ||= fullOutcome.sawPriceBarcode;

      // ガイド枠周辺を拡大切り出しして再チェック
      this.renderVideoRegion(video, scratchCanvas, {
        maxDimension: 1280,
        rh: 0.44,
        rw: 0.9,
        rx: 0.05,
        ry: 0.28,
      });
      const cropOutcome = await this.detectNative(scratchCanvas);
      if (cropOutcome.isbn) {
        return cropOutcome;
      }
      return {
        isbn: null,
        sawPriceBarcode: sawPriceBarcode || cropOutcome.sawPriceBarcode,
      };
    }

    // ZXing フォールバック（ガイド枠の狭い帯と広い帯を交互に走査）
    const region: CropRegion =
      frameIndex % 2 === 0
        ? { maxDimension: 1080, rh: 0.36, rw: 0.9, rx: 0.05, ry: 0.32 }
        : { maxDimension: 1080, rh: 0.6, rw: 0.92, rx: 0.04, ry: 0.2 };
    this.renderVideoRegion(video, scratchCanvas, region);
    return this.decodeZxingCanvas(scratchCanvas);
  }

  /**
   * 静止画像（ファイル選択・D&D・貼り付け）からISBN-13を検出する。
   */
  async detectFromImage(
    img: HTMLImageElement
  ): Promise<BarcodeDetectionOutcome> {
    await this.init();
    let sawPriceBarcode = false;

    if (this.nativeDetector) {
      const nativeOutcome = await this.detectNative(img);
      if (nativeOutcome.isbn) {
        return nativeOutcome;
      }
      sawPriceBarcode ||= nativeOutcome.sawPriceBarcode;
    }

    const scratch = document.createElement("canvas");
    for (const region of IMAGE_ZXING_PASSES) {
      this.renderImageRegion(img, scratch, region);
      const outcome = this.decodeZxingCanvas(scratch);
      if (outcome.isbn) {
        return outcome;
      }
      sawPriceBarcode ||= outcome.sawPriceBarcode;
    }

    return { isbn: null, sawPriceBarcode };
  }

  private async detectNative(
    source: ImageBitmapSource
  ): Promise<BarcodeDetectionOutcome> {
    if (!this.nativeDetector) {
      return { isbn: null, sawPriceBarcode: false };
    }
    try {
      const barcodes = await this.nativeDetector.detect(source);
      const values = barcodes
        .map((item) => item.rawValue ?? "")
        .filter((v) => v !== "");
      return classifyDetectedBarcodes(values);
    } catch {
      return { isbn: null, sawPriceBarcode: false };
    }
  }

  private decodeZxingCanvas(
    canvas: HTMLCanvasElement
  ): BarcodeDetectionOutcome {
    try {
      const result = this.zxingReader.decodeFromCanvas(canvas);
      return classifyDetectedBarcodes([result.getText()]);
    } catch {
      return { isbn: null, sawPriceBarcode: false };
    }
  }

  private renderVideoRegion(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    region: CropRegion
  ): void {
    this.drawCroppedSource(
      video,
      video.videoWidth,
      video.videoHeight,
      canvas,
      region
    );
  }

  private renderImageRegion(
    img: HTMLImageElement,
    canvas: HTMLCanvasElement,
    region: CropRegion
  ): void {
    this.drawCroppedSource(
      img,
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      canvas,
      region
    );
  }

  private drawCroppedSource(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    canvas: HTMLCanvasElement,
    region: CropRegion
  ): void {
    const sx = Math.round(sourceWidth * region.rx);
    const sy = Math.round(sourceHeight * region.ry);
    const sw = Math.max(1, Math.round(sourceWidth * region.rw));
    const sh = Math.max(1, Math.round(sourceHeight * region.rh));

    let dw = sw;
    let dh = sh;
    if (dw > region.maxDimension || dh > region.maxDimension) {
      if (dw > dh) {
        dh = Math.round((dh * region.maxDimension) / dw);
        dw = region.maxDimension;
      } else {
        dw = Math.round((dw * region.maxDimension) / dh);
        dh = region.maxDimension;
      }
    }
    dw = Math.max(1, dw);
    dh = Math.max(1, dh);

    canvas.width = region.rotate90 ? dh : dw;
    canvas.height = region.rotate90 ? dw : dh;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.save();
    ctx.filter = region.highContrast
      ? "grayscale(100%) contrast(175%)"
      : "none";
    if (region.rotate90) {
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(source, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    } else {
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
    }
    ctx.restore();
  }
}
