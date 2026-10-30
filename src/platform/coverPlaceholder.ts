/**
 * 表紙を取得できなかった本のための仮表紙を描く。
 *
 * 紙のような背景に枠、中央に書名と著者、下部に「表紙を取得できませんでした」。
 * 画像は既存の表紙と同じ 600x900（2:3）で、Covers/{ISBN}.jpg に保存する。
 */

const WIDTH = 600;
const HEIGHT = 900;
const BACKGROUND = "#f7f6f2";
const INK = "#262626";
const MUTED = "#7a7a7a";
const FAINT = "#9a9a9a";
const RULE = "#dad7cf";
const FONT_STACK =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';

export interface PlaceholderCoverInput {
  author: string;
  title: string;
}

function wrapLines(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const char of text) {
    if (context.measureText(line + char).width <= maxWidth) {
      line += char;
      continue;
    }
    lines.push(line);
    line = char;
    if (lines.length === maxLines) {
      return lines;
    }
  }
  if (line !== "" && lines.length < maxLines) {
    lines.push(line);
  }
  return lines;
}

/** 仮表紙をJPEGのバイト列で返す。DOMが無い環境では null。 */
export async function renderPlaceholderCover(
  input: PlaceholderCoverInput
): Promise<ArrayBuffer | null> {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = RULE;
  context.lineWidth = 2;
  context.strokeRect(28, 28, WIDTH - 56, HEIGHT - 56);

  const title = input.title.trim();
  const author = input.author.split(" / ")[0]?.trim() ?? "";

  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  context.fillStyle = INK;
  context.font = `600 40px ${FONT_STACK}`;
  const lines = wrapLines(context, title, WIDTH - 140, 4);
  const lineHeight = 60;
  const blockHeight = lineHeight * lines.length + (author === "" ? 0 : 40);
  let y = (HEIGHT - blockHeight) / 2 - 10;
  for (const line of lines) {
    context.fillText(line, WIDTH / 2, y);
    y += lineHeight;
  }

  if (author !== "") {
    context.fillStyle = MUTED;
    context.font = `22px ${FONT_STACK}`;
    context.fillText(author, WIDTH / 2, y + 16);
  }

  context.strokeStyle = RULE;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(80, HEIGHT - 120);
  context.lineTo(WIDTH - 80, HEIGHT - 120);
  context.stroke();

  context.fillStyle = FAINT;
  context.font = `17px ${FONT_STACK}`;
  context.fillText("表紙を取得できませんでした", WIDTH / 2, HEIGHT - 92);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/jpeg", 0.88);
  });
  return blob === null ? null : await blob.arrayBuffer();
}
