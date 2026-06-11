# paper between us — WebGL Paint Engine Rebuild

Implementation brief for Claude Code. Read fully before writing code.

## 1. What this is

paper between us is a two-person, real-time drawing app for virtual date nights. Two people join a room code from separate devices (iPads primarily), receive a shared prompt ("draw them as a season," "draw them as a kitchen at 7am"), and draw portraits of each other — either live (watching each other's strokes appear) or in reveal mode (hidden until both finish, then shown).


A WebGL2 engine enables sketching with two media — a precise ink pen and a fast, natural watercolor — and reworks the shell into a minimal-but-physical layout with deliberate micro-interactions. The realtime architecture, protocol shape, identity model, and persistence largely carry over.

## 2. Product goals (in priority order)

1. **The paint must feel real.** Watercolor with edge darkening, granulation, and ragged wet edges; pen with crisp, pressure-responsive line. This is the signature of the app — spend the quality budget here.
2. **Fast and real-time.** 60fps drawing on iPad Safari. Local ink renders with zero round-trip; remote strokes render incrementally as batches arrive (~1 batch per animation frame).
3. **Fun merged with intimacy.** Micro-interactions that make the other person feel present (their brush as a soft glow, the wash-dissolve reveal) without gamifying it.
4. **Minimal but physical layout.** One sheet of paper, tools that read as objects (pigment pans, a pen), a small typeset prompt slip. No chrome, no panels, no settings screens.

## 3. Architecture overview

```
Next.js app (Vercel)
 ├─ app/page.tsx            shell: join → draw → reveal → done
 ├─ components/PaintCanvas.tsx   pointer handling + engine + socket wiring
 ├─ engine/paint.ts         WebGL2 engine (framework-free class)
 ├─ engine/shaders.ts       GLSL source strings
 ├─ lib/protocol.ts         message types shared client/server
 ├─ lib/render-export.ts    offscreen replay → PNG poster
 └─ party/server.ts         PartyKit room: relay + snapshot + sync

PartyKit room (Cloudflare edge)
 └─ relays stroke events, keeps full stroke log for late-join sync,
    syncs prompt index and reveal mode. Brush-agnostic: it stores and
    forwards stroke payloads without interpreting them.
```

**Core principle: strokes are the unit of truth.** Rendering is fully deterministic from stroke data (points + brush params + seed). Undo, late-join sync, reconnect healing, window resize, reveal, and poster export are all implemented as *replay*. Never snapshot pixels as the source of truth.

## 4. Wire protocol

Extend the existing protocol; keep field names where they exist.

```ts
type Pt = { x: number; y: number; p: number };   // normalized 0..1, p = pressure 0..1

type StrokeMeta = {
  sid: string;          // stroke id (author-generated, e.g. `${clientId}-${n}`)
  brush: "pen" | "water";
  color: string;        // hex from the fixed pigment palette
  sizeFrac: number;     // brush radius as fraction of min(canvasW, canvasH)
  seed: number;         // float 0..1, random per stroke — drives shader noise
};

type Msg =
  | { t: "hello"; id: string; name: string }
  | { t: "start"; id: string; stroke: StrokeMeta }
  | { t: "points"; id: string; sid: string; pts: Pt[] }   // batched per rAF
  | { t: "end"; id: string; sid: string }
  | { t: "undo"; id: string }                              // undoes author's last stroke
  | { t: "clear" }
  | { t: "prompt"; idx: number }
  | { t: "mode"; reveal: boolean }
  | { t: "reveal-now" }                                    // both-ready trigger
  | { t: "restore"; id: string; strokes: FullStroke[] }    // reconnect healing
  | { t: "sync"; strokes: FullStroke[]; prompt: number; reveal: boolean;
      players: { id: string; name: string }[] };

type FullStroke = StrokeMeta & { author: string; pts: Pt[] };
```

Rules that must hold:
- Points are buffered client-side and flushed **once per animation frame** — never per pointermove event.
- Identity is the persisted `clientId` (localStorage), never the socket connection id. On reload, the client reconciles against `sync`: re-pushes any of its own strokes the server lost via `restore`, re-adds anything it's missing locally.
- Undo is per-author: server pops the author's last stroke from the log and broadcasts `undo`; every client rebuilds via replay.
- Server sends `sync` on every connect.

## 5. The WebGL2 paint engine

`engine/paint.ts`, a framework-free class. Context options: `{ alpha: false, antialias: false, preserveDrawingBuffer: true }` (preserve needed for export). DPR capped at 2.

### 5.1 Rendering model — stamp, then glaze

Two-stage pipeline per stroke:

1. **Coverage stage (while drawing).** Each active stroke owns a single-channel coverage FBO (one per author is enough — one active stroke per person). Stamps are splatted along the smoothed path with `blendEquation(MAX)` so coverage saturates instead of accumulating — a loaded brush doesn't darken itself mid-stroke, and neither should ours.
2. **Glaze stage (on stroke end).** The coverage texture is composited into the author's *dry layer* with multiplicative blending (`blendFunc(ZERO, SRC_COLOR)`). Dry layers store transmittance starting at white; each finished stroke multiplies in like a real watercolor glaze. Overlapping **strokes** therefore darken (glazing), overlapping stamps **within** a stroke do not. This single distinction is most of what makes it read as watercolor.

Maintain **two dry layers, one per author**, so reveal mode can hide/wash the partner's layer independently.

### 5.2 Path → stamps

- Smooth with the existing quadratic midpoint scheme (midpoint-to-midpoint quadratics through raw points — port the math from v1, it's good).
- Resample the curve to fixed stamp spacing, carrying leftover distance across segments and across `points` batches: spacing ≈ `radius * 0.25` (pen), `radius * 0.35` (water).
- Stamp radius = `sizeFrac * min(w,h) * (0.3 + 0.7 * pressure)`, pressure lerped along the segment.
- Render stamps as instanced quads (4-vert TRIANGLE_STRIP, per-instance attribs: center, radius, alpha, along-stroke distance; `vertexAttribDivisor(1)`). One dynamic buffer, one draw call per flush.

### 5.3 Brush shaders

**Pen (coverage stamp):** radial SDF disc, `1 - smoothstep(0.7, 1.0, r)`, scaled by pressure alpha. Crisp.

**Watercolor (coverage stamp):** soft falloff `1 - smoothstep(0.25, 1.0, r)`, modulated by 3-octave fbm seeded from the stroke seed, with a ragged rim: multiply by `smoothstep(0.0, 0.08, (1-r) + (noise-0.5)*0.35)`. All noise = deterministic hash-based value noise; **no time, no randomness outside the seed** — both clients must converge on identical dried pixels.

**Glaze shader (coverage → color, multiplied into dry layer):**
- Pen: `a = smoothstep(0.25, 0.6, coverage) * opacity; glaze = mix(white, ink, a)` — antialiased threshold.
- Water: derive body and rim from coverage value itself (coverage falls off at edges, so mid-coverage *is* the edge zone):
  - `body = smoothstep(0.03, 0.55, c)`
  - `rim  = smoothstep(0.03, 0.22, c) * (1 - smoothstep(0.18, 0.5, c))`
  - `density = clamp(body*0.62 + rim*0.30, 0, 0.95) * opacity`, modulated ±15% by a granulation noise texture
  - Rim gets darker *and more saturated*: `pigment = pow(color, vec3(1.0 + rim*0.8))`
  - `glaze = mix(white, pigment, density)`

### 5.4 Frame composite (every rAF)

Multiplicative passes straight onto the default framebuffer:
1. Paper pass (no blend): procedural warm paper — fbm grain + faint directional fiber noise + very subtle vignette. Tint `#F7F2E7`.
2. Multiply my dry layer.
3. Multiply partner's dry layer **through the wash mask** (see reveal, 5.6).
4. Multiply each *live* coverage FBO through the glaze shader (mine always; partner's only in live mode).

Multiply blend = `blendFunc(ZERO, SRC_COLOR)`.

### 5.5 Replay (undo / resize / sync / reconnect)

`rebuild(strokes: FullStroke[])`: clear both dry layers to white; for each stroke in log order — clear scratch coverage FBO, stamp the full resampled path in one pass, glaze into the author's dry layer. This must be fast (date-night stroke counts: hundreds, not thousands — instanced stamping makes this trivially quick). Resize re-runs rebuild since points are normalized.

### 5.6 Reveal wash

`setReveal(t: 0..1)` drives the partner-dry-layer pass: `mask = smoothstep(t - 0.12, t + 0.12, fbmNoise(uv * 2.5))`, `glaze = mix(white, dryColor, 1 - mask)` — the portrait arrives as water spreading across paper, not a crossfade. Animate t over ~1.8s with ease-in-out when `reveal-now` fires. Respect `prefers-reduced-motion`: cut to a 300ms opacity fade.

### 5.7 Engine API

```ts
class PaintEngine {
  constructor(canvas: HTMLCanvasElement)
  beginStroke(author: string, meta: StrokeMeta): void
  addPoints(author: string, pts: Pt[]): void
  endStroke(author: string): void          // dries + appends to stroke log
  undo(author: string): void               // pops + rebuild
  clear(): void
  load(strokes: FullStroke[]): void        // sync/restore → rebuild
  setReveal(t: number): void
  setShowPartnerLive(b: boolean): void
  resize(): void
  exportPNG(): Promise<Blob>
  destroy(): void
}
```

## 6. Shell, layout, micro-interactions

### 6.1 Layout (minimal, physical)

- Single centered paper sheet, slight drop shadow as in v1 (`Paper` component aesthetic carries over). Dusk ground behind it: deep violet-blue `#232036`, lamplight amber accent `#E8A75D`.
- **Tool rail** along the bottom edge (thumb-reachable on iPad): a pen nib + 6 pigment pans rendered as physical objects — small rounded squares of actual pigment color with an inner depression shadow. Selected tool lifts ~2px with a spring transition; pans show a wet sheen when active.
- Fixed pigment palette (no color picker): vermilion `#C84B31`, indigo `#3D5A80`, moss `#6A7F5A`, plum `#7C4B66`, ochre `#C99846`, ink `#2A2B33`.
- Two brush sizes only (small/large), toggled by tapping the active tool again. No sliders.
- **Prompt slip**: a small Fraunces-set card above the paper; advancing slides the old slip out and the new one in like paper. Prompt pool from v1 carries over.
- Type: Fraunces (prompts, names, title — soft optical sizing), Karla (utility labels). Sentence case everywhere.
- Undo and Clear as quiet text buttons; Clear requires a second confirming tap within 2s.

### 6.2 Micro-interactions (complete list — build these, don't add more)

1. **Brush cursor**: a thin ring at the pointer sized to the live stamp radius; scales subtly with pressure.
2. **Partner presence**: while the partner has an active stroke (live mode), a soft warm glow dot follows their last received point — no name tag, no cursor arrow. Fades out 600ms after their `end`.
3. **Tool lift**: selection spring (transform translateY + tiny rotate, ~180ms, slight overshoot).
4. **Wash reveal**: the engine wash (5.6) — the only big moment in the app.
5. **Wet sheen on active stroke**: while a stroke is live, its glaze pass gets a +4% brightness lift that drops on dry — paint visibly "settles."
6. **Button press = wet ink**: pressed text buttons darken and bleed 1px (text-shadow), no scale.
7. **Prompt slip slide** (6.1).

All motion behind `prefers-reduced-motion` checks. Nothing loops, nothing bounces idle.

### 6.3 Flow

`join → draw → (reveal mode only: waiting → reveal) → next prompt | done`. Carry the v1 phase machine. In reveal mode, "I'm finished" sets a ready flag; when both are ready the server emits `reveal-now`. Poster export button on the done screen (and quietly in the corner during draw), now rendering via the WebGL replay path so the export matches the screen exactly.

## 7. Persistence (carries over from v1)

- IndexedDB per-prompt archive (`idb-keyval`), written each time the prompt advances — now storing `FullStroke[]` instead of bitmaps.
- Known limitation, keep documenting it in the README: IndexedDB is per-device; the durable shared archive (persisting the stroke log to `room.storage` in the Durable Object) is a stretch goal — implement if time allows, behind the same `sync` shape.

## 8. Acceptance criteria

- [ ] 60fps while drawing on iPad Safari and desktop Chrome; no GC hitches from per-event allocation (reuse buffers).
- [ ] Watercolor shows edge darkening, granulation, ragged edges; two overlapping strokes visibly glaze; one stroke never self-darkens.
- [ ] Pen line is crisp at DPR 2 with smooth pressure response.
- [ ] Both clients converge on visually identical dried canvases from the same stroke log (verify by exporting PNGs from both sides and diffing — allow only sub-perceptual noise differences).
- [ ] Reload mid-session heals fully: own strokes restored, partner view repaired, undo order intact.
- [ ] Undo removes exactly the author's last stroke on both clients.
- [ ] Reveal wash plays once, in sync, and respects reduced motion.
- [ ] Poster export pixel-matches the live canvas rendering.
- [ ] Works with mouse (pressure defaults 0.5), Apple Pencil, and finger.

## 9. Gotchas / hard-won notes

- `blendEquation(MAX)` is core WebGL2 — but get the context as `webgl2` explicitly and fail loudly with a fallback message if unavailable.
- Create the GL context with `alpha: false` to avoid premultiplied-alpha compositing surprises with the page background.
- `touch-action: none` on the canvas, and handle `pointercancel`/`pointerleave` as stroke end — iPadOS fires these aggressively.
- Coalesced pointer events (`getCoalescedEvents()`) on supporting browsers for smoother high-speed pen input; fall back gracefully.
- Stamp leftover-distance must persist across `points` batches or remote strokes get visible stitching at batch boundaries.
- Never key anything off wall-clock time in shaders — determinism across clients depends on it.
- PartyKit deploy flow unchanged from v1: Next app on Vercel, `npx partykit deploy` for the room, client connects via `partysocket`. Install line: `npm install partysocket idb-keyval`.

## 10. Suggested build order

1. Engine standalone (local-only page, no socket): pen → watercolor coverage → glaze → paper composite. Iterate on shader feel here; this is 60% of the project's value.
2. Replay/rebuild + undo + resize.
3. Protocol + PartyKit wiring + sync/restore healing (port v1 logic).
4. Shell, tools, prompt slips, micro-interactions.
5. Reveal wash + ready handshake.
6. Poster export via replay path.
7. Acceptance pass on iPad Safari.