// Offscreen replay → PNG posters. Each sheet renders through the same WebGL
// engine the screen uses, so exports pixel-match the live rendering.
//
// Two posters:
//  - renderPosterPNG: the current sheet pair, side by side (mid-session save)
//  - renderSketchesPosterPNG: end of session — a 2×2 grid of the partner's
//    four portraits of you, titled "sketches of {you}" / "by {partner}"

import { PaintEngine } from "@/engine/paint";
import type { FullStroke } from "./protocol";

const PANEL = 1280; // square sheets
const MARGIN = 64;
const GAP = 56;
const DUSK = "#232036";
const PAPER = "#F7F2E7";

async function renderPanel(
  strokes: FullStroke[],
  localAuthor: string,
  size = PANEL,
): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  // PaintEngine sizes itself from clientWidth/Height * dpr (capped at 2);
  // park the canvas offscreen at the export size so the math holds
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.position = "fixed";
  canvas.style.left = "-10000px";
  canvas.style.width = `${size / dpr}px`;
  canvas.style.height = `${size / dpr}px`;
  document.body.appendChild(canvas);
  const engine = new PaintEngine(canvas);
  try {
    engine.localAuthor = localAuthor;
    engine.setReveal(1); // everything visible in the poster
    engine.load(strokes);
    const blob = await engine.exportPNG();
    return await createImageBitmap(blob);
  } finally {
    engine.destroy();
    canvas.remove();
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/png",
    ),
  );
}

/** The current sheet pair, side by side (mid-session save). */
export async function renderPosterPNG(
  strokes: FullStroke[],
  localAuthor: string,
): Promise<Blob> {
  const mine = strokes.filter((s) => s.author === localAuthor);
  const theirs = strokes.filter((s) => s.author !== localAuthor);
  const a = await renderPanel(mine, localAuthor);
  const b = await renderPanel(theirs, localAuthor);

  const w = MARGIN * 2 + GAP + PANEL * 2;
  const h = MARGIN * 2 + PANEL;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = DUSK;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(a, MARGIN, MARGIN, PANEL, PANEL);
  ctx.drawImage(b, MARGIN + PANEL + GAP, MARGIN, PANEL, PANEL);
  a.close();
  b.close();

  return toBlob(out);
}

// -- the session poster -------------------------------------------------------

const GRID_PANEL = 1000;
const GRID_GAP = 48;
const GRID_MARGIN = 96;
const TITLE_BAND = 150; // room above/below the grid for the corner text

export type PosterRound = { idx: number; strokes: FullStroke[] };

/**
 * 2×2 grid of the partner's four portraits of you.
 * "sketches of {subject}" sits in the top-left corner, "by {artist}" in the
 * bottom-right. Missing rounds render as blank paper.
 */
export async function renderSketchesPosterPNG({
  rounds,
  localAuthor,
  subject,
  artist,
}: {
  rounds: PosterRound[];
  localAuthor: string;
  subject: string;
  artist: string;
}): Promise<Blob> {
  // the poster shows what the partner drew of you
  const panels: ImageBitmap[] = [];
  for (let i = 0; i < 4; i++) {
    const strokes = (rounds[i]?.strokes ?? []).filter(
      (s) => s.author !== localAuthor,
    );
    panels.push(await renderPanel(strokes, localAuthor, GRID_PANEL));
  }

  const gridW = GRID_PANEL * 2 + GRID_GAP;
  const w = GRID_MARGIN * 2 + gridW;
  const h = TITLE_BAND * 2 + gridW;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = DUSK;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(
      panels[i],
      GRID_MARGIN + col * (GRID_PANEL + GRID_GAP),
      TITLE_BAND + row * (GRID_PANEL + GRID_GAP),
      GRID_PANEL,
      GRID_PANEL,
    );
    ctx.restore();
    panels[i].close();
  }

  // corner text — Fraunces if it's loaded, Georgia otherwise
  try {
    await document.fonts.load('600 64px "Fraunces"');
  } catch {
    /* fall through to the fallback stack */
  }
  const family = '"Fraunces", Georgia, serif';
  ctx.fillStyle = PAPER;

  ctx.font = `600 64px ${family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(`sketches of ${subject}`, GRID_MARGIN, TITLE_BAND / 2);

  ctx.font = `italic 500 52px ${family}`;
  ctx.textAlign = "right";
  ctx.globalAlpha = 0.85;
  ctx.fillText(`by ${artist}`, w - GRID_MARGIN, h - TITLE_BAND / 2);
  ctx.globalAlpha = 1;

  return toBlob(out);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
