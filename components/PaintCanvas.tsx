"use client";

// Pointer handling + engines + socket wiring.
//
// Two sheets side by side: yours (interactive) and your partner's (read-only,
// frosted with a blur until reveal). Each sheet has its own engine; strokes
// route by author. Local ink renders with zero round-trip; points are
// buffered and flushed once per animation frame (never per pointermove).
// Identity is the persisted clientId — on every sync the client reconciles:
// re-pushes its own strokes the server lost (restore), re-adds anything it's
// missing locally.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import PartySocket from "partysocket";
import { PaintEngine } from "@/engine/paint";
import type {
  Brush,
  FullStroke,
  Msg,
  Player,
  Pt,
  StrokeMeta,
} from "@/lib/protocol";

const PARTYKIT_HOST =
  process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "127.0.0.1:1999";

export type PaintCanvasHandle = {
  undo(): void;
  clear(): void;
  clearLocal(): void;
  sendPrompt(idx: number): void;
  sendMode(reveal: boolean): void;
  sendReady(): void;
  sendFinish(): void;
  playReveal(): Promise<void>;
  getStrokes(): FullStroke[];
};

type Props = {
  room: string;
  clientId: string;
  name: string;
  partnerName: string | null;
  brush: Brush;
  color: string;
  sizeFrac: number;
  canDraw: boolean;
  /** reveal mode AND the partner's sheet is still hidden (blank paper) */
  partnerHidden: boolean;
  /** the partner's sheet is frosted (blurred) — pre-reveal */
  partnerBlurred: boolean;
  /** the prompt advanced (archive + fresh sheet) */
  onPrompt(idx: number): void;
  onMode(reveal: boolean): void;
  onRevealNow(): void;
  /** the partner ended the session → poster */
  onFinish(): void;
  /** the room already has two people; this client was rejected */
  onFull(): void;
  /** authoritative room state from a sync (no archiving side effects) */
  onSync(state: {
    prompt: number;
    round: number;
    reveal: boolean;
    players: Player[];
  }): void;
  onConnection(open: boolean): void;
  onStrokesChanged(): void;
};

const PaintCanvas = forwardRef<PaintCanvasHandle, Props>(function PaintCanvas(
  {
    room,
    clientId,
    name,
    partnerName,
    brush,
    color,
    sizeFrac,
    canDraw,
    partnerHidden,
    partnerBlurred,
    onPrompt,
    onMode,
    onRevealNow,
    onFinish,
    onFull,
    onSync,
    onConnection,
    onStrokesChanged,
  },
  ref,
) {
  const mineCanvasRef = useRef<HTMLCanvasElement>(null);
  const theirsCanvasRef = useRef<HTMLCanvasElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const mineRef = useRef<PaintEngine | null>(null);
  const theirsRef = useRef<PaintEngine | null>(null);
  const sockRef = useRef<PartySocket | null>(null);
  const [glError, setGlError] = useState<string | null>(null);

  // mutable per-render props for stable handlers
  const propsRef = useRef({ brush, color, sizeFrac, canDraw });
  propsRef.current = { brush, color, sizeFrac, canDraw };
  const cbRef = useRef({
    onPrompt,
    onMode,
    onRevealNow,
    onFinish,
    onFull,
    onSync,
    onConnection,
    onStrokesChanged,
  });
  cbRef.current = {
    onPrompt,
    onMode,
    onRevealNow,
    onFinish,
    onFull,
    onSync,
    onConnection,
    onStrokesChanged,
  };

  // active local stroke state (reused buffers — no per-event allocation)
  const drawingRef = useRef<{
    pointerId: number;
    sid: string;
  } | null>(null);
  const pendingRef = useRef<Pt[]>([]);
  const strokeNRef = useRef(Date.now() % 1e7);
  const glowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealAnimRef = useRef(false);

  const send = useCallback((msg: Msg) => {
    sockRef.current?.send(JSON.stringify(msg));
  }, []);

  // -- engines + socket lifecycle ---------------------------------------------

  useEffect(() => {
    const mineCanvas = mineCanvasRef.current!;
    const theirsCanvas = theirsCanvasRef.current!;
    let mine: PaintEngine;
    let theirs: PaintEngine;
    try {
      mine = new PaintEngine(mineCanvas);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }
    try {
      theirs = new PaintEngine(theirsCanvas);
    } catch (e) {
      mine.destroy();
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }
    mine.localAuthor = clientId;
    // on the partner engine the partner's strokes land on the "partner"
    // layer, which is what setReveal / setShowPartnerLive control
    theirs.localAuthor = clientId;
    mineRef.current = mine;
    theirsRef.current = theirs;

    const ro = new ResizeObserver(() => {
      mine.resize();
      theirs.resize();
    });
    ro.observe(mineCanvas);
    ro.observe(theirsCanvas);

    const sock = new PartySocket({ host: PARTYKIT_HOST, room });
    sockRef.current = sock;

    const hello = () => {
      sock.send(JSON.stringify({ t: "hello", id: clientId, name } satisfies Msg));
      cbRef.current.onConnection(true);
    };
    const closed = () => cbRef.current.onConnection(false);

    const engFor = (author: string) =>
      author === clientId ? mineRef.current : theirsRef.current;

    const onMessage = (ev: MessageEvent) => {
      let msg: Msg;
      try {
        msg = JSON.parse(ev.data as string) as Msg;
      } catch {
        return;
      }
      if (!mineRef.current || !theirsRef.current) return;
      switch (msg.t) {
        case "start":
          engFor(msg.id)?.beginStroke(msg.id, msg.stroke);
          break;
        case "points": {
          engFor(msg.id)?.addPoints(msg.id, msg.pts);
          // partner presence: soft glow at their last received point
          const last = msg.pts[msg.pts.length - 1];
          if (last && msg.id !== clientId) moveGlow(last.x, last.y);
          break;
        }
        case "end":
          engFor(msg.id)?.endStroke(msg.id);
          if (msg.id !== clientId) fadeGlow();
          cbRef.current.onStrokesChanged();
          break;
        case "undo":
          engFor(msg.id)?.undo(msg.id);
          cbRef.current.onStrokesChanged();
          break;
        case "clear":
          mineRef.current.clear();
          theirsRef.current.clear();
          cbRef.current.onStrokesChanged();
          break;
        case "prompt":
          cbRef.current.onPrompt(msg.idx);
          break;
        case "mode":
          cbRef.current.onMode(msg.reveal);
          break;
        case "reveal-now":
          cbRef.current.onRevealNow();
          break;
        case "finish":
          cbRef.current.onFinish();
          break;
        case "full":
          cbRef.current.onFull();
          break;
        case "restore": {
          // a peer re-pushed strokes the server had lost; merge per sheet
          const addMissing = (eng: PaintEngine, strokes: FullStroke[]) => {
            if (strokes.length === 0) return false;
            const have = new Set(eng.getStrokes().map((s) => s.sid));
            const add = strokes.filter((s) => !have.has(s.sid));
            if (add.length === 0) return false;
            eng.load([...eng.getStrokes(), ...add]);
            return true;
          };
          const a = addMissing(
            mineRef.current,
            msg.strokes.filter((s) => s.author === clientId),
          );
          const b = addMissing(
            theirsRef.current,
            msg.strokes.filter((s) => s.author !== clientId),
          );
          if (a || b) cbRef.current.onStrokesChanged();
          break;
        }
        case "sync": {
          // reconcile against the server log
          const localMine = mineRef.current.getStrokes();
          const serverSids = new Set(msg.strokes.map((s) => s.sid));
          const mineLost = localMine.filter(
            (s) => s.author === clientId && !serverSids.has(s.sid),
          );
          if (mineLost.length > 0) {
            send({ t: "restore", id: clientId, strokes: mineLost });
          }
          const all = [...msg.strokes, ...mineLost];
          mineRef.current.load(all.filter((s) => s.author === clientId));
          theirsRef.current.load(all.filter((s) => s.author !== clientId));
          cbRef.current.onSync({
            prompt: msg.prompt,
            round: msg.round,
            reveal: msg.reveal,
            players: msg.players,
          });
          cbRef.current.onStrokesChanged();
          break;
        }
      }
    };

    sock.addEventListener("open", hello);
    sock.addEventListener("close", closed);
    sock.addEventListener("message", onMessage);

    // flush local point batches once per animation frame
    let raf = 0;
    const flush = () => {
      const d = drawingRef.current;
      const pending = pendingRef.current;
      if (d && pending.length > 0) {
        send({ t: "points", id: clientId, sid: d.sid, pts: pending.slice() });
        mineRef.current?.addPoints(clientId, pending);
        pending.length = 0;
      }
      raf = requestAnimationFrame(flush);
    };
    raf = requestAnimationFrame(flush);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sock.removeEventListener("open", hello);
      sock.removeEventListener("close", closed);
      sock.removeEventListener("message", onMessage);
      sock.close();
      sockRef.current = null;
      mine.destroy();
      theirs.destroy();
      mineRef.current = null;
      theirsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, clientId, name]);

  // -- partner sheet visibility -------------------------------------------------

  useEffect(() => {
    const eng = theirsRef.current;
    if (!eng || revealAnimRef.current) return;
    eng.setShowPartnerLive(!partnerHidden);
    eng.setReveal(partnerHidden ? 0 : 1);
  }, [partnerHidden, glError]);

  // -- partner presence glow ------------------------------------------------------

  function moveGlow(nx: number, ny: number) {
    const glow = glowRef.current;
    const canvas = theirsCanvasRef.current;
    if (!glow || !canvas) return;
    if (glowTimerRef.current) {
      clearTimeout(glowTimerRef.current);
      glowTimerRef.current = null;
    }
    const rect = canvas.getBoundingClientRect();
    glow.style.transform = `translate(${nx * rect.width}px, ${ny * rect.height}px)`;
    glow.style.opacity = "1";
  }

  function fadeGlow() {
    glowTimerRef.current = setTimeout(() => {
      if (glowRef.current) glowRef.current.style.opacity = "0";
    }, 600);
  }

  // -- local pointer input --------------------------------------------------------

  function norm(e: PointerEvent): Pt {
    const rect = mineCanvasRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    // mouse has no pressure: default 0.5; pen/touch report real values
    const p =
      e.pointerType === "mouse" || e.pressure === 0 ? 0.5 : e.pressure;
    return { x, y, p: Math.min(1, p) };
  }

  function updateRing(e: React.PointerEvent) {
    const ring = ringRef.current;
    const canvas = mineCanvasRef.current;
    if (!ring || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { sizeFrac: sf } = propsRef.current;
    const pt = norm(e.nativeEvent);
    const r = sf * Math.min(rect.width, rect.height) * (0.3 + 0.7 * pt.p);
    ring.style.width = `${r * 2}px`;
    ring.style.height = `${r * 2}px`;
    ring.style.transform = `translate(${pt.x * rect.width - r}px, ${pt.y * rect.height - r}px)`;
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!propsRef.current.canDraw || drawingRef.current || glError) return;
    if (!e.isPrimary) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { brush: b, color: c, sizeFrac: sf } = propsRef.current;
    const sid = `${clientId}-${strokeNRef.current++}`;
    const meta: StrokeMeta = {
      sid,
      brush: b,
      color: c,
      sizeFrac: sf,
      seed: Math.random(),
    };
    drawingRef.current = { pointerId: e.pointerId, sid };
    mineRef.current?.beginStroke(clientId, meta);
    send({ t: "start", id: clientId, stroke: meta });
    pendingRef.current.push(norm(e.nativeEvent));
    updateRing(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    updateRing(e);
    const d = drawingRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const native = e.nativeEvent;
    // coalesced events for smoother high-speed pen input
    const events =
      typeof native.getCoalescedEvents === "function"
        ? native.getCoalescedEvents()
        : [native];
    const list = events.length > 0 ? events : [native];
    for (const ev of list) pendingRef.current.push(norm(ev));
  };

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drawingRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // flush whatever is pending before ending
    if (pendingRef.current.length > 0) {
      send({
        t: "points",
        id: clientId,
        sid: d.sid,
        pts: pendingRef.current.slice(),
      });
      mineRef.current?.addPoints(clientId, pendingRef.current);
      pendingRef.current.length = 0;
    }
    mineRef.current?.endStroke(clientId);
    send({ t: "end", id: clientId, sid: d.sid });
    drawingRef.current = null;
    cbRef.current.onStrokesChanged();
  };

  // -- imperative API ----------------------------------------------------------

  useImperativeHandle(ref, () => ({
    undo() {
      mineRef.current?.undo(clientId);
      send({ t: "undo", id: clientId });
      cbRef.current.onStrokesChanged();
    },
    clear() {
      mineRef.current?.clear();
      theirsRef.current?.clear();
      send({ t: "clear" });
      cbRef.current.onStrokesChanged();
    },
    clearLocal() {
      mineRef.current?.clear();
      theirsRef.current?.clear();
      cbRef.current.onStrokesChanged();
    },
    sendPrompt(idx: number) {
      mineRef.current?.clear();
      theirsRef.current?.clear();
      send({ t: "prompt", idx });
      cbRef.current.onStrokesChanged();
    },
    sendMode(reveal: boolean) {
      send({ t: "mode", reveal });
    },
    sendReady() {
      send({ t: "reveal-now" });
    },
    sendFinish() {
      send({ t: "finish" });
    },
    async playReveal() {
      const eng = theirsRef.current;
      if (!eng) return;
      revealAnimRef.current = true;
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const dur = reduced ? 300 : 1800;
      const ease = (t: number) =>
        t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // ease-in-out
      await new Promise<void>((resolve) => {
        const t0 = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / dur);
          eng.setReveal(reduced ? t : ease(t));
          if (t < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      eng.setShowPartnerLive(true);
      revealAnimRef.current = false;
    },
    getStrokes() {
      return [
        ...(mineRef.current?.getStrokes() ?? []),
        ...(theirsRef.current?.getStrokes() ?? []),
      ];
    },
  }));

  if (glError) {
    return (
      <div className="gl-fallback" role="alert">
        <p>{glError}</p>
        <p>Try a recent Safari, Chrome, or Firefox.</p>
      </div>
    );
  }

  return (
    <div className="sheets">
      <div className="sheet-col">
        <div className="sheet">
          <div className="paint-wrap">
            <canvas
              ref={mineCanvasRef}
              className="paint-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={endStroke}
              onPointerEnter={() => {
                if (ringRef.current) ringRef.current.style.opacity = "1";
              }}
              onPointerOut={(e) => {
                if (
                  !drawingRef.current &&
                  ringRef.current &&
                  e.pointerType === "mouse"
                )
                  ringRef.current.style.opacity = "0";
              }}
            />
            <div ref={ringRef} className="brush-ring" aria-hidden />
          </div>
        </div>
        <span className="sheet-label">you</span>
      </div>

      <div className="sheet-col">
        <div className={`sheet theirs${partnerBlurred ? " frosted" : ""}`}>
          <div className="paint-wrap">
            <canvas
              ref={theirsCanvasRef}
              className="paint-canvas partner"
              aria-label={`${partnerName ?? "your person"}'s sheet`}
            />
            <div ref={glowRef} className="partner-glow" aria-hidden />
          </div>
        </div>
        <span className="sheet-label">{partnerName ?? "your person"}</span>
      </div>
    </div>
  );
});

export default PaintCanvas;
