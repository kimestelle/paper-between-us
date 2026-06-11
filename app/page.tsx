"use client";

// Shell: join → draw → (reveal mode only: waiting → reveal) → next prompt | done

import { useCallback, useEffect, useRef, useState } from "react";
import PaintCanvas, { PaintCanvasHandle } from "@/components/PaintCanvas";
import type { Brush, FullStroke, Player } from "@/lib/protocol";
import { PALETTE, ROUNDS, SIZES } from "@/lib/protocol";
import { pickPrompt, promptAt } from "@/lib/prompts";
import { archivePrompt } from "@/lib/archive";
import {
  downloadBlob,
  renderPosterPNG,
  renderSketchesPosterPNG,
} from "@/lib/render-export";

type Round = { idx: number; strokes: FullStroke[] };

type Phase = "join" | "draw" | "waiting" | "revealing" | "revealed" | "done";

function randomRoomCode() {
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  return Array.from(
    { length: 4 },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join("");
}

function PenNib() {
  return (
    <svg className="nib" viewBox="0 0 40 40" width="40" height="40" aria-hidden>
      <path
        d="M20 6 L27 22 Q20 30 13 22 Z M20 22 L20 33"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="20" cy="19" r="1.6" fill="currentColor" />
    </svg>
  );
}

function EraserIcon() {
  return (
    <svg className="nib" viewBox="0 0 40 40" width="40" height="40" aria-hidden>
      <path
        d="M14 28 L7 21 a2 2 0 0 1 0-2.8 L19.2 6 a2 2 0 0 1 2.8 0 L31 15 a2 2 0 0 1 0 2.8 L20.8 28 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M13.5 13 L27 26.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M11 33 H31"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Home() {
  const canvasRef = useRef<PaintCanvasHandle>(null);

  const [phase, setPhase] = useState<Phase>("join");
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [roomInput, setRoomInput] = useState("");

  const [revealMode, setRevealMode] = useState(false);
  const [promptIdx, setPromptIdx] = useState(0);
  const [round, setRound] = useState(0); // 0-based, ROUNDS per session
  // refs mirror state for socket callbacks (archiving needs current values)
  const promptIdxRef = useRef(0);
  const roomRef = useRef("");
  const usedRef = useRef<number[]>([]); // prompt indices seen this session
  const roundsRef = useRef<Round[]>([]); // finished sheets this session
  const [posterRounds, setPosterRounds] = useState<Round[]>([]);
  useEffect(() => {
    promptIdxRef.current = promptIdx;
    if (!usedRef.current.includes(promptIdx)) usedRef.current.push(promptIdx);
  }, [promptIdx]);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const [players, setPlayers] = useState<Player[]>([]);
  const [connected, setConnected] = useState(false);
  const [canUndo, setCanUndo] = useState(false);

  const [brush, setBrush] = useState<Brush>("water");
  const [color, setColor] = useState<string>(PALETTE[1].hex); // indigo
  const [size, setSize] = useState<"small" | "large">("large");

  const [clearArming, setClearArming] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [exporting, setExporting] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // persisted identity — never the socket connection id. Read once after
  // mount (localStorage / URL are external systems unavailable during SSR).
  useEffect(() => {
    let id = localStorage.getItem("pbu-id");
    if (!id) {
      id = crypto.randomUUID().slice(0, 8);
      localStorage.setItem("pbu-id", id);
    }
    const storedName = localStorage.getItem("pbu-name") ?? "";
    const r = new URLSearchParams(window.location.search).get("room");
    queueMicrotask(() => {
      setClientId(id);
      if (storedName) setName(storedName);
      if (r) setRoomInput(r.toUpperCase());
    });
  }, []);

  // -- join -------------------------------------------------------------------

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setJoinError(null);
    localStorage.setItem("pbu-name", trimmed);
    const code = (roomInput.trim() || randomRoomCode()).toUpperCase();
    setRoom(code);
    const url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.history.replaceState(null, "", url);
    setPhase("draw");
  };

  // -- socket-driven shell events ----------------------------------------------

  /** capture the current sheet into the session record (before it clears) */
  const recordRound = useCallback(() => {
    const strokes = canvasRef.current?.getStrokes() ?? [];
    void archivePrompt(roomRef.current, promptIdxRef.current, strokes);
    roundsRef.current.push({ idx: promptIdxRef.current, strokes });
  }, []);

  /** session over (locally or partner-triggered) → poster */
  const completeSession = useCallback(() => {
    recordRound();
    setPosterRounds(roundsRef.current.slice(-ROUNDS));
    roundsRef.current = [];
    setRound(0);
    setPhase("done");
  }, [recordRound]);

  const handlePromptAdvance = useCallback(
    (idx: number) => {
      // record + archive the finished sheet before it clears
      recordRound();
      canvasRef.current?.clearLocal();
      setPromptIdx(idx);
      setRound((r) => r + 1);
      setPhase("draw");
    },
    [recordRound],
  );

  const handleMode = useCallback((reveal: boolean) => {
    setRevealMode(reveal);
    setPhase((p) => (!reveal && p === "waiting" ? "draw" : p));
  }, []);

  const handleRevealNow = useCallback(() => {
    setPhase("revealing");
    void canvasRef.current?.playReveal().then(() => setPhase("revealed"));
  }, []);

  const handleFull = useCallback(() => {
    setPlayers([]);
    setPhase("join");
    setJoinError("that room already has two people");
  }, []);

  const handleSync = useCallback(
    (s: { prompt: number; round: number; reveal: boolean; players: Player[] }) => {
      setPromptIdx(s.prompt);
      setRound(s.round);
      setRevealMode(s.reveal);
      setPlayers(s.players);
    },
    [],
  );

  const handleStrokesChanged = useCallback(() => {
    const strokes = canvasRef.current?.getStrokes() ?? [];
    setCanUndo(strokes.some((s) => s.author === clientId));
  }, [clientId]);

  // -- actions -----------------------------------------------------------------

  const nextPrompt = () => {
    recordRound();
    const idx = pickPrompt(usedRef.current);
    canvasRef.current?.sendPrompt(idx); // clears both sheets locally too
    setPromptIdx(idx);
    setRound((r) => r + 1);
    setPhase("draw");
  };

  const finishSession = () => {
    canvasRef.current?.sendFinish();
    completeSession();
  };

  const toggleMode = () => {
    const next = !revealMode;
    setRevealMode(next);
    canvasRef.current?.sendMode(next);
    setPhase((p) => (p === "waiting" ? "draw" : p));
  };

  const imFinished = () => {
    canvasRef.current?.sendReady();
    setPhase("waiting");
  };

  const onClearTap = () => {
    if (clearArming) {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      setClearArming(false);
      canvasRef.current?.clear();
    } else {
      setClearArming(true);
      clearTimerRef.current = setTimeout(() => setClearArming(false), 2000);
    }
  };

  const savePoster = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const strokes = canvasRef.current?.getStrokes() ?? [];
      const blob = await renderPosterPNG(strokes, clientId);
      downloadBlob(blob, `paper-between-us-${room}-${promptIdx + 1}.png`);
    } finally {
      setExporting(false);
    }
  };

  const saveGridPoster = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const subject = name.trim() || "you";
      const blob = await renderSketchesPosterPNG({
        rounds: posterRounds,
        localAuthor: clientId,
        subject,
        artist:
          players.find((p) => p.id !== clientId)?.name ?? "your person",
      });
      downloadBlob(
        blob,
        `sketches-of-${subject.toLowerCase().replace(/\s+/g, "-")}-${room}.png`,
      );
    } finally {
      setExporting(false);
    }
  };

  const pickPen = () => {
    if (brush === "pen") setSize((s) => (s === "small" ? "large" : "small"));
    else setBrush("pen");
  };

  const pickEraser = () => {
    if (brush === "erase") setSize((s) => (s === "small" ? "large" : "small"));
    else setBrush("erase");
  };

  const pickPan = (hex: string) => {
    if (brush === "water" && color === hex) {
      setSize((s) => (s === "small" ? "large" : "small"));
    } else {
      setBrush("water");
      setColor(hex);
    }
  };

  // -- render ------------------------------------------------------------------

  if (phase === "join") {
    return (
      <main className="stage">
        <div className="join">
          <h1>paper between us</h1>
          <p className="sub">two sheets of paper, two of you</p>
          {joinError && <p className="join-error">{joinError}</p>}
          <form onSubmit={join}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="your name"
              maxLength={24}
              autoComplete="off"
            />
            <input
              className="room-code"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value.toUpperCase())}
              placeholder="room code"
              maxLength={8}
              autoComplete="off"
            />
            <div className="mode-row">
              <button
                type="button"
                aria-pressed={!revealMode}
                onClick={() => setRevealMode(false)}
              >
                draw live
              </button>
              <button
                type="button"
                aria-pressed={revealMode}
                onClick={() => setRevealMode(true)}
              >
                reveal at the end
              </button>
            </div>
            <button type="submit">
              {roomInput.trim() ? "join room" : "make a room"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  const partner = players.find((p) => p.id !== clientId);
  const sizeFrac = SIZES[brush][size];

  return (
    <main className="stage">
      <div className="players-line">
        <span
          className={`status-dot ${connected ? "on" : ""}`}
          style={{ display: "inline-block", marginRight: 8 }}
        />
        room {room}
        {partner ? (
          <>
            {" — drawing with "}
            <span className="them">{partner.name}</span>
          </>
        ) : (
          " — waiting for your person"
        )}
        {" — round "}
        {Math.min(round + 1, ROUNDS)} of {ROUNDS}
      </div>

      <div className="slip-track">
        <div key={promptIdx} className="slip slide-in">
          {promptAt(promptIdx)}
        </div>
      </div>

      <div className="sheets-area">
        {clientId && (
          <PaintCanvas
            ref={canvasRef}
            room={room}
            clientId={clientId}
            name={name.trim()}
            partnerName={partner?.name ?? null}
            brush={brush}
            color={
              brush === "erase"
                ? "#FFFFFF"
                : brush === "pen"
                  ? PALETTE[5].hex
                  : color
            }
            sizeFrac={sizeFrac}
            canDraw={phase === "draw"}
            partnerHidden={
              revealMode && (phase === "draw" || phase === "waiting")
            }
            partnerBlurred={phase === "draw" || phase === "waiting"}
            onPrompt={handlePromptAdvance}
            onMode={handleMode}
            onRevealNow={handleRevealNow}
            onFinish={completeSession}
            onFull={handleFull}
            onSync={handleSync}
            onConnection={setConnected}
            onStrokesChanged={handleStrokesChanged}
          />
        )}

        {phase === "waiting" && (
          <div className="veil">
            <h2>finished</h2>
            <p>
              waiting for {partner ? partner.name : "your person"} to finish
              their portrait of you
            </p>
          </div>
        )}

        {phase === "done" && (
          <div className="veil">
            <h2>that&apos;s a date</h2>
            <p>
              sketches of {name.trim() || "you"}, by{" "}
              {partner?.name ?? "your person"}
            </p>
            <div className="quiet-row">
              <button
                className="quiet primary"
                onClick={saveGridPoster}
                disabled={exporting}
              >
                {exporting ? "saving…" : "save the poster"}
              </button>
              <button
                className="quiet"
                onClick={() => setPhase(revealMode ? "revealed" : "draw")}
              >
                keep drawing
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rail">
        <div className="tools">
          <button
            className="tool"
            aria-pressed={brush === "pen"}
            aria-label="pen"
            onClick={pickPen}
          >
            <PenNib />
            {brush === "pen" && (
              <span className={`size-dot ${size === "large" ? "large" : ""}`} />
            )}
          </button>
          <button
            className="tool"
            aria-pressed={brush === "erase"}
            aria-label="eraser"
            onClick={pickEraser}
          >
            <EraserIcon />
            {brush === "erase" && (
              <span className={`size-dot ${size === "large" ? "large" : ""}`} />
            )}
          </button>
          {PALETTE.map((p) => (
            <button
              key={p.hex}
              className="tool"
              aria-pressed={brush === "water" && color === p.hex}
              aria-label={p.name}
              onClick={() => pickPan(p.hex)}
            >
              <span className="pan" style={{ background: p.hex }} />
              {brush === "water" && color === p.hex && (
                <span
                  className={`size-dot ${size === "large" ? "large" : ""}`}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="quiet-row">
        <button
          className="quiet"
          onClick={() => canvasRef.current?.undo()}
          disabled={!canUndo || phase !== "draw"}
        >
          undo
        </button>
        <button
          className={`quiet ${clearArming ? "arming" : ""}`}
          onClick={onClearTap}
          disabled={phase !== "draw"}
        >
          {clearArming ? "tap again to clear" : "clear"}
        </button>
        {revealMode && phase === "draw" && (
          <button className="quiet primary" onClick={imFinished}>
            i&apos;m finished
          </button>
        )}
        {(phase === "revealed" || (!revealMode && phase === "draw")) &&
          (round >= ROUNDS - 1 ? (
            <button className="quiet primary" onClick={finishSession}>
              make the poster
            </button>
          ) : (
            <button className="quiet primary" onClick={nextPrompt}>
              next prompt
            </button>
          ))}
        <button
          className="quiet"
          onClick={savePoster}
          disabled={exporting || phase === "revealing"}
        >
          {exporting ? "saving…" : "save"}
        </button>
        <button
          className="quiet"
          onClick={toggleMode}
          disabled={phase !== "draw"}
        >
          {revealMode ? "mode: reveal" : "mode: live"}
        </button>
      </div>
    </main>
  );
}
