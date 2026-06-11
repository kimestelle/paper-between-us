// Integration test for the PartyKit room (run against `npx partykit dev`):
//   node scripts/server-test.mjs
// Verifies: sync on connect, relay, stroke log accumulation, per-author
// undo, both-ready reveal-now, restore healing, prompt reset.

const HOST = "ws://127.0.0.1:1999/parties/main/TEST" + Date.now();

function client(id) {
  const ws = new WebSocket(HOST);
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const w = waiters.findIndex((f) => f.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else inbox.push(m);
  });
  return {
    id,
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    open: () => new Promise((r) => ws.addEventListener("open", () => r(), { once: true })),
    next: (pred, ms = 4000) =>
      new Promise((resolve, reject) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        const w = { pred, resolve: (m) => (clearTimeout(t), resolve(m)) };
        const t = setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) waiters.splice(j, 1); // don't swallow later messages
          reject(new Error(`timeout waiting (client ${id})`));
        }, ms);
        waiters.push(w);
      }),
  };
}

const ok = (cond, label) => {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok ${label}`);
};

const a = client("aaa");
await a.open();
const sync0 = await a.next((m) => m.t === "sync");
ok(
  sync0.strokes.length === 0 &&
    typeof sync0.prompt === "number" &&
    sync0.round === 0,
  "initial sync empty (random prompt, round 0)",
);

a.send({ t: "hello", id: "aaa", name: "Ana" });
await a.next((m) => m.t === "sync" && m.players.length === 1);

const b = client("bbb");
await b.open();
await b.next((m) => m.t === "sync");
b.send({ t: "hello", id: "bbb", name: "Ben" });
const syncB = await a.next((m) => m.t === "sync" && m.players.length === 2);
ok(syncB.players.map((p) => p.id).sort().join() === "aaa,bbb", "both players registered");

// stroke relay + log
const meta = { sid: "aaa-1", brush: "water", color: "#3D5A80", sizeFrac: 0.04, seed: 0.5 };
a.send({ t: "start", id: "aaa", stroke: meta });
a.send({ t: "points", id: "aaa", sid: "aaa-1", pts: [{ x: 0.1, y: 0.1, p: 0.5 }, { x: 0.2, y: 0.2, p: 0.6 }] });
a.send({ t: "end", id: "aaa", sid: "aaa-1" });
ok((await b.next((m) => m.t === "start")).stroke.sid === "aaa-1", "start relayed");
ok((await b.next((m) => m.t === "points")).pts.length === 2, "points relayed");
await b.next((m) => m.t === "end");

// late-join sync carries the stroke with accumulated points
const c = client("ccc");
await c.open();
const syncC = await c.next((m) => m.t === "sync");
ok(syncC.strokes.length === 1 && syncC.strokes[0].pts.length === 2, "late-join sync has full stroke");
c.ws.close();

// per-author undo
b.send({ t: "start", id: "bbb", stroke: { ...meta, sid: "bbb-1" } });
b.send({ t: "end", id: "bbb", sid: "bbb-1" });
await a.next((m) => m.t === "end");
a.send({ t: "undo", id: "aaa" });
await b.next((m) => m.t === "undo" && m.id === "aaa");
const d1 = client("ddd");
await d1.open();
const syncD = await d1.next((m) => m.t === "sync");
ok(syncD.strokes.length === 1 && syncD.strokes[0].author === "bbb", "undo popped only aaa's stroke");
d1.ws.close();

// restore healing
a.send({ t: "restore", id: "aaa", strokes: [{ ...meta, sid: "aaa-1", author: "aaa", pts: [{ x: 0.1, y: 0.1, p: 0.5 }] }] });
ok((await b.next((m) => m.t === "restore")).strokes[0].sid === "aaa-1", "restore relayed");

// both-ready reveal handshake
a.send({ t: "mode", reveal: true });
await b.next((m) => m.t === "mode" && m.reveal === true);
a.send({ t: "reveal-now" });
let early = false;
await a.next((m) => m.t === "reveal-now", 800).then(() => (early = true)).catch(() => {});
ok(!early, "reveal-now waits for second player");
b.send({ t: "reveal-now" });
await a.next((m) => m.t === "reveal-now");
await b.next((m) => m.t === "reveal-now");
ok(true, "reveal-now fires when both ready");

// prompt advance clears the log and bumps the round
a.send({ t: "prompt", idx: 1 });
await b.next((m) => m.t === "prompt" && m.idx === 1);
const e = client("eee");
await e.open();
const syncE = await e.next((m) => m.t === "sync");
ok(syncE.prompt === 1 && syncE.strokes.length === 0, "prompt advance resets sheet");
ok(syncE.round === 1, "prompt advance bumps round");
e.ws.close();

// finish relays and resets the round
a.send({ t: "finish" });
await b.next((m) => m.t === "finish");
const g = client("ggg");
await g.open();
const syncG = await g.next((m) => m.t === "sync");
ok(syncG.round === 0, "finish resets round");
g.ws.close();

// two-player cap: a third distinct id is rejected with "full"
const f = client("fff");
await f.open();
await f.next((m) => m.t === "sync");
f.send({ t: "hello", id: "fff", name: "Fay" });
ok((await f.next((m) => m.t === "full")).t === "full", "third player rejected");
// rejoining with a known id still works
const a2 = client("aaa");
await a2.open();
await a2.next((m) => m.t === "sync");
a2.send({ t: "hello", id: "aaa", name: "Ana" });
const syncA2 = await a2.next((m) => m.t === "sync" && m.players.length === 2);
ok(syncA2.players.some((p) => p.id === "aaa"), "existing player can rejoin");
f.ws.close();
a2.ws.close();

console.log("all server checks passed");
process.exit(0);
