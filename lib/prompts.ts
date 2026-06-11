// Shared prompt pool. Both clients index into this list with the synced
// prompt index, so order matters — append only.

export const PROMPTS = [
  "draw them as a season",
  "draw them as a kitchen at 7am",
  "draw them as the weather right now",
  "draw them as a houseplant",
  "draw them as a sunday morning",
  "draw them as a city at night",
  "draw them as a cup of something warm",
  "draw them as a door you'd like to open",
  "draw them as the sea in winter",
  "draw them as a lamp left on in a window",
  "draw them as breakfast",
  "draw them as a thunderstorm passing",
  "draw them as a book you'd reread",
  "draw them as the last ten minutes of a train ride",
  "draw them as a garden in march",
  "draw them as home",
] as const;

export const PROMPT_COUNT = PROMPTS.length;

export function promptAt(idx: number): string {
  return PROMPTS[((idx % PROMPTS.length) + PROMPTS.length) % PROMPTS.length];
}

/** Random prompt index avoiding any already used this session. */
export function pickPrompt(used: number[]): number {
  const avail: number[] = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    if (!used.includes(i)) avail.push(i);
  }
  if (avail.length === 0) return Math.floor(Math.random() * PROMPTS.length);
  return avail[Math.floor(Math.random() * avail.length)];
}
