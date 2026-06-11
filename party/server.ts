// PartyKit room: relay + stroke log + sync.
//
// Brush-agnostic: stores and forwards stroke payloads without interpreting
// them. The full stroke log is kept for late-join sync; identity is the
// client-persisted `id` in messages, never the socket connection id.

import type * as Party from "partykit/server";
import type { FullStroke, Msg, Player } from "../lib/protocol";
import { PROMPT_COUNT } from "../lib/prompts";

export default class PaperRoom implements Party.Server {
  options: Party.ServerOptions = { hibernate: false };

  strokes: FullStroke[] = [];
  players = new Map<string, Player>(); // clientId -> player
  conns = new Map<string, string>(); // connection id -> clientId
  prompt = Math.floor(Math.random() * PROMPT_COUNT); // random first prompt
  round = 0; // 0-based, ROUNDS per session
  reveal = false;
  ready = new Set<string>(); // clientIds ready for reveal

  constructor(readonly room: Party.Room) {}

  onConnect(conn: Party.Connection) {
    conn.send(JSON.stringify(this.syncMsg()));
  }

  onClose(conn: Party.Connection) {
    this.conns.delete(conn.id);
  }

  onMessage(raw: string, sender: Party.Connection) {
    let msg: Msg;
    try {
      msg = JSON.parse(raw) as Msg;
    } catch {
      return;
    }

    switch (msg.t) {
      case "hello": {
        // two chairs at this table: reject a third distinct person
        if (!this.players.has(msg.id) && this.players.size >= 2) {
          sender.send(JSON.stringify({ t: "full" } satisfies Msg));
          return;
        }
        this.players.set(msg.id, { id: msg.id, name: msg.name });
        this.conns.set(sender.id, msg.id);
        // keep everyone's player list fresh
        this.room.broadcast(JSON.stringify(this.syncMsg()));
        return;
      }

      case "start": {
        this.strokes.push({ ...msg.stroke, author: msg.id, pts: [] });
        this.relay(raw, sender);
        return;
      }

      case "points": {
        const s = this.findStroke(msg.sid);
        if (s) s.pts.push(...msg.pts);
        this.relay(raw, sender);
        return;
      }

      case "end": {
        this.relay(raw, sender);
        return;
      }

      case "undo": {
        // pop the author's last stroke from the log; clients rebuild via replay
        for (let i = this.strokes.length - 1; i >= 0; i--) {
          if (this.strokes[i].author === msg.id) {
            this.strokes.splice(i, 1);
            break;
          }
        }
        this.relay(raw, sender);
        return;
      }

      case "clear": {
        this.strokes = [];
        this.ready.clear();
        this.relay(raw, sender);
        return;
      }

      case "prompt": {
        this.prompt = msg.idx;
        this.round++;
        this.strokes = []; // fresh sheet per prompt (clients archive first)
        this.ready.clear();
        this.relay(raw, sender);
        return;
      }

      case "finish": {
        // session over → poster; next session starts at round 0
        this.round = 0;
        this.ready.clear();
        this.relay(raw, sender);
        return;
      }

      case "mode": {
        this.reveal = msg.reveal;
        this.ready.clear();
        this.relay(raw, sender);
        return;
      }

      case "reveal-now": {
        // client signals "I'm finished"; when both players are ready,
        // emit reveal-now to everyone
        const id = this.connClientId(sender);
        if (id) this.ready.add(id);
        if (this.ready.size >= 2 || this.ready.size >= this.players.size) {
          this.ready.clear();
          this.room.broadcast(JSON.stringify({ t: "reveal-now" } satisfies Msg));
        }
        return;
      }

      case "restore": {
        // reconnect healing: re-add strokes the server lost
        const have = new Set(this.strokes.map((s) => s.sid));
        for (const s of msg.strokes) {
          if (!have.has(s.sid)) this.strokes.push(s);
        }
        this.relay(raw, sender);
        return;
      }
    }
  }

  private findStroke(sid: string): FullStroke | undefined {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].sid === sid) return this.strokes[i];
    }
    return undefined;
  }

  private connClientId(conn: Party.Connection): string | null {
    // the latest hello from this connection sets its clientId
    return this.conns.get(conn.id) ?? null;
  }

  private relay(raw: string, sender: Party.Connection) {
    this.room.broadcast(raw, [sender.id]);
  }

  private syncMsg(): Msg {
    return {
      t: "sync",
      strokes: this.strokes,
      prompt: this.prompt,
      round: this.round,
      reveal: this.reveal,
      players: [...this.players.values()],
    };
  }
}
