// IndexedDB per-prompt archive. Written each time the prompt advances,
// storing FullStroke[] (strokes are the unit of truth — never bitmaps).
//
// Known limitation: IndexedDB is per-device. The durable shared archive
// (persisting the stroke log to room.storage in the Durable Object) is a
// stretch goal, behind the same `sync` shape.

import { get, set, keys } from "idb-keyval";
import type { FullStroke } from "./protocol";

export type ArchiveEntry = {
  room: string;
  promptIdx: number;
  strokes: FullStroke[];
  savedAt: number;
};

const keyFor = (room: string, promptIdx: number) =>
  `pbu:${room}:${promptIdx}`;

export async function archivePrompt(
  room: string,
  promptIdx: number,
  strokes: FullStroke[],
): Promise<void> {
  if (strokes.length === 0) return;
  const entry: ArchiveEntry = {
    room,
    promptIdx,
    strokes,
    savedAt: Date.now(),
  };
  try {
    await set(keyFor(room, promptIdx), entry);
  } catch {
    // archive is best-effort; never block the session on it
  }
}

export async function loadArchived(
  room: string,
  promptIdx: number,
): Promise<ArchiveEntry | undefined> {
  try {
    return await get<ArchiveEntry>(keyFor(room, promptIdx));
  } catch {
    return undefined;
  }
}

export async function listArchived(room: string): Promise<string[]> {
  try {
    const all = await keys();
    return all
      .filter((k): k is string => typeof k === "string")
      .filter((k) => k.startsWith(`pbu:${room}:`));
  } catch {
    return [];
  }
}
