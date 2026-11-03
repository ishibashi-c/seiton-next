/**
 * 本のバーコード（ISBN）スキャナーモーダル。
 * OS標準のカメラアプリ呼び出し（capture="environment"）または画像選択・ドラッグ＆ドロップ・
 * クリップボード貼り付けからバーコードを自動検知し、連続スキャン＆一括追加を行う。
 * キーボードやUSBバーコードリーダーによるISBN直接入力にも対応。
 */

import { BarcodeFormat, BrowserMultiFormatReader } from "@zxing/browser";
import { DecodeHintType } from "@zxing/library";
import { type App, Modal, setIcon } from "obsidian";
import {
  extractIsbnFromBarcode,
  formatScanErrorMessage,
  isScanCooldown,
  playScanSound,
  triggerScanHaptic,
} from "../../domain/barcode";
import type { BookCandidate } from "../../domain/book";
import { userMessageOf } from "../../domain/errors";
import type { BookService } from "../../services/bookService";
import { markSeitonModal } from "../ui/modal";
import { showToast } from "../ui/toast";

export interface ScannedBookItem {
  authors: string;
  candidate: BookCandidate | null;
  coverUrl: string;
  error?: string;
  id: string;
  isbn: string;
  loading: boolean;
  publisher: string;
  title: string;
}

export interface BarcodeScannerModalOptions {
  onSaved?: (count: number) => void;
  onScanSingle?: (isbn: string) => void;
  /** 1冊だけスキャンして即時完了するモード */
  single?: boolean;
}

export class BarcodeScannerModal extends Modal {
  private readonly bookService: BookService;
  private readonly options: BarcodeScannerModalOptions;

  private captureBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private statusTimer: number | null = null;

  private queueListEl: HTMLElement | null = null;
  private countBadgeEl: HTMLElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;

  private items: ScannedBookItem[] = [];
  private lastScannedIsbn: string | null = null;
  private lastScannedAt = 0;
  private isAnalyzing = false;
  private saving = false;

  private pasteHandler: ((e: ClipboardEvent) => void) | null = null;

  constructor(
    app: App,
    bookService: BookService,
    options: BarcodeScannerModalOptions = {}
  ) {
    super(app);
    this.bookService = bookService;
    this.options = options;
  }

  override onOpen(): void {
    markSeitonModal(this);
    this.modalEl.addClass("seiton-scanner-modal");
    this.setTitle(
      this.options.single ? "バーコードをスキャン" : "バーコードで本を追加"
    );

    this.renderUI();
    this.registerGlobalPaste();
  }

  override onClose(): void {
    if (this.pasteHandler) {
      window.removeEventListener("paste", this.pasteHandler);
      this.pasteHandler = null;
    }
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.contentEl.empty();
    this.items = [];
    this.captureBtn = null;
    this.statusEl = null;
    this.queueListEl = null;
    this.countBadgeEl = null;
    this.submitBtn = null;
  }

  private renderUI(): void {
    const content = this.contentEl;
    content.empty();

    // 1. カメラ撮影・画像選択エリア（Hero Card）
    this.renderCaptureHero(content);

    // 2. 手動ISBN入力フォーム
    this.renderManualInput(content);

    // 3. 単体スキャンモードの場合はキュー一覧は不要
    if (this.options.single) {
      return;
    }

    // 4. 連続スキャン用キュー一覧
    const queueSection = content.createDiv({ cls: "seiton-scanner-queue" });

    const queueHead = queueSection.createDiv({
      cls: "seiton-scanner-queue-head",
    });
    const headTitle = queueHead.createEl("h3", { text: "スキャンした本" });
    this.countBadgeEl = headTitle.createSpan({
      cls: "seiton-scanner-count-badge",
      text: "0冊",
    });

    this.queueListEl = queueSection.createDiv({
      cls: "seiton-scanner-queue-list",
    });
    this.renderQueueItems();

    // 5. フッター（保存・キャンセル）
    const footer = content.createDiv({ cls: "seiton-modal-footer" });
    const cancelBtn = footer.createEl("button", {
      attr: { type: "button" },
      text: "キャンセル",
    });
    cancelBtn.addEventListener("click", () => this.close());

    this.submitBtn = footer.createEl("button", {
      attr: { type: "button" },
      cls: "mod-cta",
      text: "本棚に追加 (0冊)",
    });
    this.submitBtn.disabled = true;
    this.submitBtn.addEventListener("click", () => {
      void this.saveAll();
    });
  }

  private renderCaptureHero(container: HTMLElement): void {
    const hero = container.createDiv({ cls: "seiton-scanner-hero" });

    // 非表示のファイル入力（capture="environment" でスマホの標準カメラアプリを起動）
    const fileInput = hero.createEl("input", {
      attr: {
        accept: "image/*",
        capture: "environment",
        style: "display: none;",
        type: "file",
      },
      cls: "seiton-scanner-file-input",
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (file) {
        void this.scanImageFile(file);
      }
      // 同じファイルを再選択できるようにリセット
      fileInput.value = "";
    });

    // ドラッグ＆ドロップ対応
    hero.addEventListener("dragover", (e) => {
      e.preventDefault();
      hero.addClass("is-dragover");
    });
    hero.addEventListener("dragleave", () => {
      hero.removeClass("is-dragover");
    });
    hero.addEventListener("drop", (e) => {
      e.preventDefault();
      hero.removeClass("is-dragover");
      const file = e.dataTransfer?.files?.[0];
      if (file?.type.startsWith("image/")) {
        void this.scanImageFile(file);
      }
    });

    // 撮影ボタン
    const captureBtn = hero.createEl("button", {
      attr: { type: "button" },
      cls: "seiton-scanner-capture-btn mod-cta",
    });
    this.captureBtn = captureBtn;
    this.updateCaptureButtonText();

    captureBtn.addEventListener("click", () => {
      if (!this.isAnalyzing) {
        fileInput.click();
      }
    });

    // サブ説明
    hero.createEl("p", {
      cls: "seiton-scanner-hero-sub",
      text: "本の裏表紙のバーコードを撮影、または画像をドロップ / 貼り付け",
    });

    // ステータス・結果通知領域
    this.statusEl = hero.createDiv({ cls: "seiton-scanner-status" });
  }

  private updateCaptureButtonText(): void {
    if (!this.captureBtn) {
      return;
    }
    this.captureBtn.empty();

    if (this.isAnalyzing) {
      const spinner = this.captureBtn.createSpan({
        cls: "seiton-scanner-btn-icon is-spinning",
      });
      setIcon(spinner, "loader-2");
      this.captureBtn.createSpan({ text: "画像を解析中…" });
      this.captureBtn.disabled = true;
    } else {
      const iconSpan = this.captureBtn.createSpan({
        cls: "seiton-scanner-btn-icon",
      });
      setIcon(iconSpan, "camera");
      const btnText =
        this.items.length > 0
          ? "続けて次の本を撮影"
          : "カメラでバーコードを撮影";
      this.captureBtn.createSpan({ text: btnText });
      this.captureBtn.disabled = false;
    }
  }

  private registerGlobalPaste(): void {
    this.pasteHandler = (e: ClipboardEvent) => {
      // テキスト入力中は除外
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            void this.scanImageFile(file);
            break;
          }
        }
      }
    };
    window.addEventListener("paste", this.pasteHandler);
  }

  private renderManualInput(container: HTMLElement): void {
    const manualSection = container.createDiv({
      cls: "seiton-scanner-manual",
    });
    const form = manualSection.createEl("form", {
      cls: "seiton-scanner-manual-form",
    });
    const input = form.createEl("input", {
      attr: {
        autocomplete: "off",
        inputmode: "numeric",
        placeholder: "ISBN（13桁）を入力、またはリーダーでスキャン…",
        type: "text",
      },
      cls: "seiton-scanner-manual-input",
    });

    form.createEl("button", {
      attr: { type: "submit" },
      cls: "seiton-scanner-manual-btn",
      text: this.options.single ? "確定" : "追加",
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) {
        return;
      }
      const isbn = extractIsbnFromBarcode(raw);
      if (!isbn) {
        showToast("有効なISBN（13桁）を入力してください。");
        return;
      }
      input.value = "";
      this.handleDetectedBarcode(isbn);
      input.focus();
    });
  }

  private async scanImageFile(file: File | Blob): Promise<void> {
    if (!file.type.startsWith("image/")) {
      this.showStatus("画像ファイルを選択してください。", "error");
      return;
    }

    this.isAnalyzing = true;
    this.updateCaptureButtonText();
    this.showStatus("バーコードを解析中…", "loading");

    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await this.loadImage(objectUrl);
      const isbn = await this.detectIsbnFromImage(img);

      if (!isbn) {
        this.showStatus(
          "バーコードが見つかりませんでした。ピントを合わせてバーコード全体が写るように撮影してください。",
          "error"
        );
        return;
      }

      this.showStatus(`ISBN: ${isbn} を読み取りました`, "success");
      this.handleDetectedBarcode(isbn);
    } catch (error) {
      this.showStatus(formatScanErrorMessage(error), "error");
    } finally {
      URL.revokeObjectURL(objectUrl);
      this.isAnalyzing = false;
      this.updateCaptureButtonText();
    }
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました。"));
      img.src = src;
    });
  }

  /**
   * 画像から多段探索でISBNを検出する。
   * 1. 画像全体からデコード
   * 2. 上半分（日本の本の2段バーコードの上段ISBN）からデコード
   * 3. 下半分（逆さま撮影対策）からデコード
   */
  private async detectIsbnFromImage(
    img: HTMLImageElement
  ): Promise<string | null> {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new BrowserMultiFormatReader(hints);

    // 1. 全体スキャン（最大幅1200px）
    try {
      const canvas = this.createScaledCanvas(img, 1200);
      const result = reader.decodeFromCanvas(canvas);
      const isbn = extractIsbnFromBarcode(result.getText());
      if (isbn) {
        return isbn;
      }
    } catch {
      // not found, continue to crops
    }

    // 2. 上半分（高さ0〜65%）を切り抜いてスキャン（上段のISBNバーコードを抽出）
    try {
      const topCanvas = this.createCroppedCanvas(img, 0, 0, 1, 0.65, 1200);
      const result = reader.decodeFromCanvas(topCanvas);
      const isbn = extractIsbnFromBarcode(result.getText());
      if (isbn) {
        return isbn;
      }
    } catch {
      // not found
    }

    // 3. 下半分（高さ35〜100%）を切り抜いてスキャン（上下逆さま対策）
    try {
      const bottomCanvas = this.createCroppedCanvas(
        img,
        0,
        0.35,
        1,
        0.65,
        1200
      );
      const result = reader.decodeFromCanvas(bottomCanvas);
      const isbn = extractIsbnFromBarcode(result.getText());
      if (isbn) {
        return isbn;
      }
    } catch {
      // not found
    }

    return null;
  }

  private createScaledCanvas(
    img: HTMLImageElement,
    maxDimension: number
  ): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    let { width, height } = img;
    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }
    canvas.width = Math.max(width, 1);
    canvas.height = Math.max(height, 1);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }

  private createCroppedCanvas(
    img: HTMLImageElement,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    maxDimension: number
  ): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    const sx = img.width * rx;
    const sy = img.height * ry;
    const sw = img.width * rw;
    const sh = img.height * rh;

    let dw = sw;
    let dh = sh;
    if (dw > maxDimension || dh > maxDimension) {
      if (dw > dh) {
        dh = Math.round((dh * maxDimension) / dw);
        dw = maxDimension;
      } else {
        dw = Math.round((dw * maxDimension) / dh);
        dh = maxDimension;
      }
    }
    canvas.width = Math.max(Math.round(dw), 1);
    canvas.height = Math.max(Math.round(dh), 1);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }

  private showStatus(
    message: string,
    type: "error" | "loading" | "success"
  ): void {
    if (!this.statusEl) {
      return;
    }
    if (this.statusTimer !== null) {
      window.clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    this.statusEl.empty();
    this.statusEl.className = `seiton-scanner-status is-${type}`;
    this.statusEl.setText(message);

    if (type !== "loading") {
      this.statusTimer = window.setTimeout(() => {
        this.statusTimer = null;
        if (this.statusEl) {
          this.statusEl.empty();
          this.statusEl.className = "seiton-scanner-status";
        }
      }, 3500);
    }
  }

  private renderQueueItems(): void {
    const list = this.queueListEl;
    if (!list) {
      return;
    }
    list.empty();

    if (this.items.length === 0) {
      list.createDiv({
        cls: "seiton-scanner-empty",
        text: "バーコードを撮影するかISBNを入力すると、ここに本が自動で追加されます。",
      });
      this.updateSubmitButton();
      return;
    }

    for (const item of this.items) {
      const card = list.createDiv({ cls: "seiton-scanner-card" });

      // 表紙サムネイル
      const coverEl = card.createDiv({ cls: "seiton-scanner-card-cover" });
      if (item.coverUrl) {
        coverEl.createEl("img", {
          attr: { alt: item.title, src: item.coverUrl },
        });
      } else {
        const placeholder = coverEl.createDiv({
          cls: "seiton-scanner-cover-placeholder",
        });
        setIcon(placeholder, "book");
      }

      // 書誌情報
      const metaEl = card.createDiv({ cls: "seiton-scanner-card-meta" });
      if (item.loading) {
        metaEl.createDiv({
          cls: "seiton-scanner-card-title is-loading",
          text: `照会中… (${item.isbn})`,
        });
      } else {
        metaEl.createDiv({
          cls: "seiton-scanner-card-title",
          text: item.title || item.isbn,
        });
        const sub: string[] = [];
        if (item.authors) {
          sub.push(item.authors);
        }
        if (item.publisher) {
          sub.push(item.publisher);
        }
        if (sub.length > 0) {
          metaEl.createDiv({
            cls: "seiton-scanner-card-sub",
            text: sub.join(" · "),
          });
        }
        metaEl.createDiv({
          cls: "seiton-scanner-card-isbn",
          text: `ISBN: ${item.isbn}`,
        });
      }

      // 削除ボタン
      const deleteBtn = card.createEl("button", {
        attr: { "aria-label": "スキャンから削除", type: "button" },
        cls: "seiton-scanner-card-del",
      });
      setIcon(deleteBtn, "x");
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.removeItem(item.id);
      });
    }

    this.updateSubmitButton();
  }

  private updateSubmitButton(): void {
    const count = this.items.length;
    if (this.countBadgeEl) {
      this.countBadgeEl.setText(`${count}冊`);
    }
    if (this.submitBtn) {
      this.submitBtn.setText(`本棚に追加 (${count}冊)`);
      this.submitBtn.disabled = count === 0 || this.saving;
    }
  }

  private removeItem(id: string): void {
    this.items = this.items.filter((item) => item.id !== id);
    this.renderQueueItems();
    this.updateCaptureButtonText();
  }

  private handleDetectedBarcode(isbn: string): void {
    const now = Date.now();
    if (isScanCooldown(isbn, this.lastScannedIsbn, this.lastScannedAt, now)) {
      return;
    }

    this.lastScannedIsbn = isbn;
    this.lastScannedAt = now;

    // 単体スキャンモードの場合
    if (this.options.single) {
      playScanSound();
      triggerScanHaptic();
      this.options.onScanSingle?.(isbn);
      this.close();
      return;
    }

    // すでにスキャンリストにあるか確認
    if (this.items.some((item) => item.isbn === isbn)) {
      this.showStatus("すでに追加されています", "error");
      return;
    }

    // 読み取り成功
    playScanSound();
    triggerScanHaptic();

    // キューに追加
    const id = `scan_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newItem: ScannedBookItem = {
      authors: "",
      candidate: null,
      coverUrl: "",
      id,
      isbn,
      loading: true,
      publisher: "",
      title: "",
    };
    this.items.unshift(newItem); // 最新を先頭へ
    this.renderQueueItems();
    this.updateCaptureButtonText();

    // バックグラウンドで書誌照会
    void this.lookupItem(id, isbn);
  }

  private async lookupItem(id: string, isbn: string): Promise<void> {
    try {
      const result = await this.bookService.lookupIsbn(isbn);
      const candidate = result.candidate;
      const target = this.items.find((item) => item.id === id);
      if (!target) {
        return;
      }
      target.loading = false;
      if (candidate) {
        target.candidate = candidate;
        target.title = candidate.title;
        target.authors = candidate.authors.join(", ");
        target.publisher = candidate.publisher;
        target.coverUrl = candidate.coverUrl ?? "";
      } else {
        target.title = `ISBN: ${isbn}`;
      }
      this.renderQueueItems();
    } catch {
      const target = this.items.find((item) => item.id === id);
      if (target) {
        target.loading = false;
        target.title = `ISBN: ${isbn}`;
        this.renderQueueItems();
      }
    }
  }

  private async saveAll(): Promise<void> {
    if (this.items.length === 0 || this.saving) {
      return;
    }
    this.saving = true;
    this.updateSubmitButton();

    let successCount = 0;
    try {
      for (const item of this.items) {
        const candidate = item.candidate;
        await this.bookService.createBook({
          authors: item.authors,
          category: "",
          coverUrl: item.coverUrl,
          isbn: item.isbn,
          publisher: item.publisher,
          readingStatus: "tbr",
          title: item.title || candidate?.title || item.isbn,
        });
        successCount += 1;
      }

      showToast(`${successCount}冊の本を本棚に追加しました。`);
      this.options.onSaved?.(successCount);
      this.close();
    } catch (error) {
      showToast(`追加中にエラーが発生しました: ${userMessageOf(error)}`);
      this.saving = false;
      this.updateSubmitButton();
    }
  }
}
