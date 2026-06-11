# paper between us

A two-person, real-time drawing app for virtual date nights. Two people join
a room code from separate devices (iPads primarily), receive a shared random
prompt ("draw them as a season," "draw them as a kitchen at 7am"), and draw
portraits of each other on two square side-by-side sheets — yours sharp, your
partner's frosted behind a blur. In live mode their drawing forms as a blurry
shape that sharpens at the end; in reveal mode it stays blank until both
finish, then washes in like water spreading across paper. Rooms are capped at
two people; a third join is turned away.

A session is four random prompts. After the fourth, "make the poster" ends
the session for both people and each side can save a 2×2 grid poster of the
partner's four portraits of them, titled "sketches of {you}" in one corner
and "by {partner}" in the other.

Painting runs on a WebGL2 engine with three tools: a precise, pressure-
responsive ink pen, a watercolor with edge darkening, granulation, and
ragged wet edges, and an eraser (lifts paint back to the paper; replay-
deterministic like everything else).

## Architecture

```
Next.js app (Vercel)
 ├─ app/page.tsx                shell: join → draw → reveal → done
 ├─ components/PaintCanvas.tsx  pointer handling + engine + socket wiring
 ├─ engine/paint.ts             WebGL2 engine (framework-free class)
 ├─ engine/shaders.ts           GLSL source strings
 ├─ lib/protocol.ts             message types shared client/server
 ├─ lib/render-export.ts        offscreen replay → PNG poster
 ├─ lib/archive.ts              IndexedDB per-prompt archive
 └─ party/server.ts             PartyKit room: relay + stroke log + sync

PartyKit room (Cloudflare edge)
 └─ relays stroke events, keeps the full stroke log for late-join sync,
    syncs prompt index and reveal mode. Brush-agnostic.
```

Core principle: **strokes are the unit of truth.** Rendering is fully
deterministic from stroke data (points + brush params + seed). Undo,
late-join sync, reconnect healing, window resize, reveal, and poster export
are all implemented as replay — pixels are never the source of truth.

## Running locally

Two processes:

```bash
npm install
npx partykit dev          # the room server, ws on :1999
npm run dev               # the Next.js app on :3000
```

Open http://localhost:3000 in two browser windows, join the same room code.

## Deploying

- Next app → Vercel as usual.
- Room server → `npx partykit deploy`, then set
  `NEXT_PUBLIC_PARTYKIT_HOST=<your-project>.<your-user>.partykit.dev`
  in the Vercel environment.

## Tests

```bash
npx tsx scripts/walker-test.ts    # stroke resampler determinism
                                  # (live batches ≡ replay, batch-boundary safe)
node scripts/server-test.mjs      # room integration test
                                  # (needs `npx partykit dev` running)
```

## Known limitations

- **The per-prompt archive is per-device.** Finished sheets are written to
  IndexedDB (`idb-keyval`) as `FullStroke[]` each time the prompt advances,
  but IndexedDB lives on one device. The durable shared archive — persisting
  the stroke log to `room.storage` in the Durable Object — is a stretch
  goal, to be implemented behind the same `sync` shape.
- The room server keeps state in memory (no hibernation); a redeploy clears
  in-flight rooms. Clients heal what they can via `restore` on reconnect.
- A room remembers its two people for its in-memory lifetime: if your partner
  switches devices/browsers mid-session they'll count as a new (third) person
  and be turned away until the room idles out.
# paper-between-us
