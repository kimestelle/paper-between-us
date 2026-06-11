// Wire protocol — shared between client and PartyKit server.
// The server is brush-agnostic: it stores and forwards stroke payloads
// without interpreting them.

export type Pt = { x: number; y: number; p: number }; // normalized 0..1, p = pressure 0..1

export type Brush = "pen" | "water" | "erase";

export type StrokeMeta = {
  sid: string; // stroke id (author-generated, e.g. `${clientId}-${n}`)
  brush: Brush;
  color: string; // hex from the fixed pigment palette
  sizeFrac: number; // brush radius as fraction of min(canvasW, canvasH)
  seed: number; // float 0..1, random per stroke — drives shader noise
};

export type FullStroke = StrokeMeta & { author: string; pts: Pt[] };

export type Player = { id: string; name: string };

export type Msg =
  | { t: "hello"; id: string; name: string }
  | { t: "start"; id: string; stroke: StrokeMeta }
  | { t: "points"; id: string; sid: string; pts: Pt[] } // batched per rAF
  | { t: "end"; id: string; sid: string }
  | { t: "undo"; id: string } // undoes author's last stroke
  | { t: "clear" }
  | { t: "prompt"; idx: number }
  | { t: "mode"; reveal: boolean }
  | { t: "reveal-now" } // both-ready trigger
  | { t: "finish" } // session over after the last round → poster
  | { t: "full" } // room already has two people; sender is rejected
  | { t: "restore"; id: string; strokes: FullStroke[] } // reconnect healing
  | {
      t: "sync";
      strokes: FullStroke[];
      prompt: number;
      round: number; // 0-based round within the session (4 rounds total)
      reveal: boolean;
      players: Player[];
    };

// A session is four prompts, then the poster.
export const ROUNDS = 4;

// Fixed pigment palette (no color picker).
export const PALETTE = [
  { name: "vermilion", hex: "#C84B31" },
  { name: "indigo", hex: "#3D5A80" },
  { name: "moss", hex: "#6A7F5A" },
  { name: "plum", hex: "#7C4B66" },
  { name: "ochre", hex: "#C99846" },
  { name: "ink", hex: "#2A2B33" },
] as const;

// Two brush sizes only (small/large), as fraction of min(canvasW, canvasH).
export const SIZES: Record<Brush, { small: number; large: number }> = {
  pen: { small: 0.004, large: 0.009 },
  water: { small: 0.022, large: 0.045 },
  erase: { small: 0.018, large: 0.042 },
};
