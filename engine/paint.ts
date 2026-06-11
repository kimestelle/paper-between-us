// WebGL2 paint engine — framework-free.
//
// Rendering model: stamp, then glaze.
//  1. While a stroke is live, stamps are splatted into a per-author
//     single-channel coverage FBO with blendEquation(MAX) — coverage
//     saturates instead of accumulating, so a stroke never darkens itself.
//  2. On stroke end, the coverage is composited into the author's dry layer
//     with multiplicative blending. Dry layers store transmittance starting
//     at white; overlapping strokes glaze (darken), overlapping stamps
//     within a stroke do not.
//
// Strokes are the unit of truth: undo, sync, resize, reveal, and export are
// all replay (rebuild from the stroke log). Never snapshot pixels.

import type { Brush, FullStroke, Pt, StrokeMeta } from "@/lib/protocol";
import {
  DRY_FS,
  GLAZE_FS,
  PAPER_FS,
  QUAD_VS,
  STAMP_PEN_FS,
  STAMP_VS,
  STAMP_WATER_FS,
} from "./shaders";

const MAX_DPR = 2;
const SPACING_K: Record<Brush, number> = { pen: 0.25, water: 0.35, erase: 0.3 };
const OPACITY: Record<Brush, number> = { pen: 0.92, water: 1.0, erase: 1.0 };
const FLOATS_PER_STAMP = 5; // cx, cy, radius, alpha, dist

type StampSink = (
  x: number,
  y: number,
  r: number,
  a: number,
  d: number,
) => void;

/**
 * Path → stamps. Smooths raw points with midpoint-to-midpoint quadratics and
 * resamples to fixed stamp spacing, carrying leftover distance across
 * segments AND across `points` batches (otherwise remote strokes stitch at
 * batch boundaries). Used identically for live input and replay, so both
 * paths emit the exact same stamps.
 */
export class StrokeWalker {
  private a: Pt | null = null; // p_{n-2}
  private b: Pt | null = null; // p_{n-1}
  private count = 0;
  private pendingGap = 0; // distance to travel before the next stamp
  private walked = 0; // total along-stroke distance, px

  constructor(
    private brush: Brush,
    private sizeFrac: number,
    private w: number,
    private h: number,
    private emit: StampSink,
  ) {}

  private get minWH() {
    return Math.min(this.w, this.h);
  }
  private radiusAt(p: number) {
    return this.sizeFrac * this.minWH * (0.3 + 0.7 * p);
  }
  private alphaAt(p: number) {
    return this.brush === "pen" ? 0.35 + 0.65 * p : 0.75 + 0.25 * p;
  }
  private spacingAt(p: number) {
    return Math.max(this.radiusAt(p) * SPACING_K[this.brush], 0.6);
  }

  /** March a straight sub-segment (device px), emitting spaced stamps. */
  private seg(ax: number, ay: number, ap: number, bx: number, by: number, bp: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-6) return;
    let traveled = 0;
    while (this.pendingGap <= len - traveled) {
      traveled += this.pendingGap;
      this.walked += this.pendingGap;
      const t = traveled / len;
      const p = ap + (bp - ap) * t;
      this.emit(
        ax + dx * t,
        ay + dy * t,
        this.radiusAt(p),
        this.alphaAt(p),
        this.walked / this.minWH,
      );
      this.pendingGap = this.spacingAt(p);
    }
    const rest = len - traveled;
    this.pendingGap -= rest;
    this.walked += rest;
  }

  /** Flatten a quadratic (m0 → m1, control c) into linear pieces. */
  private quad(
    m0x: number, m0y: number, m0p: number,
    cx: number, cy: number,
    m1x: number, m1y: number, m1p: number,
  ) {
    const poly =
      Math.hypot(cx - m0x, cy - m0y) + Math.hypot(m1x - cx, m1y - cy);
    const steps = Math.min(48, Math.max(1, Math.ceil(poly / 3)));
    let px = m0x;
    let py = m0y;
    let pp = m0p;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * m0x + 2 * u * t * cx + t * t * m1x;
      const y = u * u * m0y + 2 * u * t * cy + t * t * m1y;
      const p = m0p + (m1p - m0p) * t;
      this.seg(px, py, pp, x, y, p);
      px = x;
      py = y;
      pp = p;
    }
  }

  /** Feed one raw point (normalized 0..1). */
  feed(pt: Pt) {
    const x = pt.x * this.w;
    const y = pt.y * this.h;
    const p = pt.p;
    this.count++;
    if (this.count === 1) {
      // dot tap: stamp immediately
      this.emit(x, y, this.radiusAt(p), this.alphaAt(p), 0);
      this.pendingGap = this.spacingAt(p);
      this.b = { x, y, p };
      return;
    }
    const b = this.b!;
    if (this.count === 2) {
      // line from p0 to mid(p0, p1)
      const mx = (b.x + x) / 2;
      const my = (b.y + y) / 2;
      const mp = (b.p + p) / 2;
      this.seg(b.x, b.y, b.p, mx, my, mp);
    } else {
      const a = this.a!;
      const m0x = (a.x + b.x) / 2;
      const m0y = (a.y + b.y) / 2;
      const m0p = (a.p + b.p) / 2;
      const m1x = (b.x + x) / 2;
      const m1y = (b.y + y) / 2;
      const m1p = (b.p + p) / 2;
      this.quad(m0x, m0y, m0p, b.x, b.y, m1x, m1y, m1p);
    }
    this.a = b;
    this.b = { x, y, p };
  }

  /** Final segment: last midpoint → last raw point. */
  finish() {
    if (this.count >= 2) {
      const a = this.a!;
      const b = this.b!;
      if (this.count === 2) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const mp = (a.p + b.p) / 2;
        this.seg(mx, my, mp, b.x, b.y, b.p);
      } else {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const mp = (a.p + b.p) / 2;
        this.seg(mx, my, mp, b.x, b.y, b.p);
      }
    }
  }
}

type Target = { fbo: WebGLFramebuffer; tex: WebGLTexture };

type Layer = {
  dry: Target; // transmittance, starts white
  cov: Target; // single-channel coverage for the active stroke
};

type Active = {
  meta: StrokeMeta;
  walker: StrokeWalker;
  pts: Pt[]; // raw points, kept for the stroke log
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class PaintEngine {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private w = 0;
  private h = 0;

  private progStampPen!: WebGLProgram;
  private progStampWater!: WebGLProgram;
  private progGlaze!: WebGLProgram;
  private progPaper!: WebGLProgram;
  private progDry!: WebGLProgram;
  private uni = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  private quadVAO!: WebGLVertexArrayObject;
  private stampVAO!: WebGLVertexArrayObject;
  private instanceBuf!: WebGLBuffer;
  private cornerBuf!: WebGLBuffer;
  private stampData = new Float32Array(4096 * FLOATS_PER_STAMP);
  private stampCount = 0;

  private layers = new Map<string, Layer>();
  private active = new Map<string, Active>();
  private strokes: FullStroke[] = [];

  /** the locally-drawing author; other authors are "the partner" */
  localAuthor = "";

  private revealT = 1;
  private showPartnerLive = true;
  private reducedMotion = false;
  private dirty = true;
  private raf = 0;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true, // needed for export
    });
    if (!gl) {
      throw new Error(
        "WebGL2 is not available in this browser — paper between us needs it to paint.",
      );
    }
    this.gl = gl;
    this.reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.buildPrograms();
    this.buildGeometry();
    this.resize();

    const tick = () => {
      if (this.destroyed) return;
      if (this.dirty) {
        this.dirty = false;
        this.composite();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // -- public API -----------------------------------------------------------

  beginStroke(author: string, meta: StrokeMeta) {
    if (this.active.has(author)) this.endStroke(author); // safety
    const layer = this.layer(author);
    this.clearTarget(layer.cov, 0, 0, 0, 0);
    const sink = this.makeSink();
    this.active.set(author, {
      meta,
      pts: [],
      walker: new StrokeWalker(meta.brush, meta.sizeFrac, this.w, this.h, sink),
    });
  }

  addPoints(author: string, pts: Pt[]) {
    const act = this.active.get(author);
    if (!act || pts.length === 0) return;
    this.stampCount = 0;
    for (const p of pts) {
      act.pts.push(p);
      act.walker.feed(p);
    }
    this.flushStamps(this.layer(author).cov, act.meta);
    this.dirty = true;
  }

  endStroke(author: string) {
    const act = this.active.get(author);
    if (!act) return;
    this.stampCount = 0;
    act.walker.finish();
    this.flushStamps(this.layer(author).cov, act.meta);
    const layer = this.layer(author);
    this.glaze(layer.cov, layer.dry, act.meta, 0);
    this.clearTarget(layer.cov, 0, 0, 0, 0);
    this.active.delete(author);
    this.strokes.push({ ...act.meta, author, pts: act.pts });
    this.dirty = true;
  }

  undo(author: string) {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      if (this.strokes[i].author === author) {
        this.strokes.splice(i, 1);
        this.rebuild(this.strokes);
        return;
      }
    }
  }

  clear() {
    this.strokes = [];
    this.active.clear();
    for (const l of this.layers.values()) {
      this.clearTarget(l.dry, 1, 1, 1, 1);
      this.clearTarget(l.cov, 0, 0, 0, 0);
    }
    this.dirty = true;
  }

  /** sync / restore / undo / resize all converge here: deterministic replay */
  load(strokes: FullStroke[]) {
    this.rebuild(strokes);
  }

  getStrokes(): FullStroke[] {
    return this.strokes.slice();
  }

  setReveal(t: number) {
    this.revealT = Math.min(1, Math.max(0, t));
    this.dirty = true;
  }

  setShowPartnerLive(b: boolean) {
    this.showPartnerLive = b;
    this.dirty = true;
  }

  resize() {
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    // re-allocate all layer textures, then replay (points are normalized)
    const authors = [...this.layers.keys()];
    for (const a of authors) {
      const l = this.layers.get(a)!;
      this.deleteTarget(l.dry);
      this.deleteTarget(l.cov);
    }
    this.layers.clear();
    for (const a of authors) this.layer(a);
    this.rebuild(this.strokes);
  }

  async exportPNG(): Promise<Blob> {
    this.composite();
    return new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("export failed"))),
        "image/png",
      );
    });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    const gl = this.gl;
    for (const l of this.layers.values()) {
      this.deleteTarget(l.dry);
      this.deleteTarget(l.cov);
    }
    this.layers.clear();
    // Free resources but do NOT loseContext(): a canvas keeps handing back
    // the same WebGL context, so killing it here would brick the canvas for
    // any future engine (React Strict Mode remounts hit this immediately —
    // the second mount would see only "shader compile: null").
    gl.deleteBuffer(this.instanceBuf);
    gl.deleteBuffer(this.cornerBuf);
    gl.deleteVertexArray(this.quadVAO);
    gl.deleteVertexArray(this.stampVAO);
    for (const p of [
      this.progStampPen,
      this.progStampWater,
      this.progGlaze,
      this.progPaper,
      this.progDry,
    ]) {
      gl.deleteProgram(p);
    }
    this.uni.clear();
  }

  // -- replay ---------------------------------------------------------------

  private rebuild(strokes: FullStroke[]) {
    this.strokes = strokes.slice();
    this.active.clear();
    for (const s of this.strokes) this.layer(s.author); // ensure layers exist
    for (const l of this.layers.values()) {
      this.clearTarget(l.dry, 1, 1, 1, 1);
      this.clearTarget(l.cov, 0, 0, 0, 0);
    }
    for (const s of this.strokes) {
      const layer = this.layer(s.author);
      this.stampCount = 0;
      const walker = new StrokeWalker(
        s.brush,
        s.sizeFrac,
        this.w,
        this.h,
        this.makeSink(),
      );
      for (const p of s.pts) walker.feed(p);
      walker.finish();
      this.flushStamps(layer.cov, s);
      this.glaze(layer.cov, layer.dry, s, 0);
      this.clearTarget(layer.cov, 0, 0, 0, 0);
    }
    this.dirty = true;
  }

  // -- stamping -------------------------------------------------------------

  private makeSink(): StampSink {
    return (x, y, r, a, d) => {
      const need = (this.stampCount + 1) * FLOATS_PER_STAMP;
      if (need > this.stampData.length) {
        const grown = new Float32Array(this.stampData.length * 2);
        grown.set(this.stampData);
        this.stampData = grown;
      }
      const o = this.stampCount * FLOATS_PER_STAMP;
      this.stampData[o] = x;
      this.stampData[o + 1] = y;
      this.stampData[o + 2] = r;
      this.stampData[o + 3] = a;
      this.stampData[o + 4] = d;
      this.stampCount++;
    };
  }

  /** Draw pending stamps into a coverage target. One buffer, one draw call. */
  private flushStamps(cov: Target, meta: StrokeMeta) {
    if (this.stampCount === 0) return;
    const gl = this.gl;
    // erase uses the pen's soft round stamp shape
    const prog =
      meta.brush === "water" ? this.progStampWater : this.progStampPen;
    gl.bindFramebuffer(gl.FRAMEBUFFER, cov.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog);
    gl.uniform2f(this.loc(prog, "uRes"), this.w, this.h);
    if (meta.brush === "water") {
      gl.uniform1f(this.loc(prog, "uSeed"), meta.seed);
      gl.uniform1f(this.loc(prog, "uAspect"), this.w / this.h);
    }
    gl.bindVertexArray(this.stampVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.stampData.subarray(0, this.stampCount * FLOATS_PER_STAMP),
      gl.DYNAMIC_DRAW,
    );
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.stampCount);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(null);
    this.stampCount = 0;
  }

  /** Composite a coverage texture into a target (dry layer or screen). */
  private glaze(cov: Target, into: Target | null, meta: StrokeMeta, wet: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
    gl.viewport(0, 0, this.w, this.h);
    const prog = this.progGlaze;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cov.tex);
    gl.uniform1i(this.loc(prog, "uCov"), 0);
    const [r, g, b] = hexToRgb(meta.color);
    gl.uniform3f(this.loc(prog, "uColor"), r, g, b);
    gl.uniform1f(this.loc(prog, "uOpacity"), OPACITY[meta.brush]);
    gl.uniform1i(
      this.loc(prog, "uBrush"),
      meta.brush === "pen" ? 0 : meta.brush === "water" ? 1 : 2,
    );
    gl.uniform1f(this.loc(prog, "uSeed"), meta.seed);
    gl.uniform1f(this.loc(prog, "uWet"), wet);
    gl.uniform1f(this.loc(prog, "uAspect"), this.w / this.h);
    gl.uniform1f(this.loc(prog, "uFlipY"), into ? 0 : 1);
    gl.enable(gl.BLEND);
    if (meta.brush === "erase") {
      // lerp the destination back toward white (dry) / paper tint (live)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.ZERO, gl.SRC_COLOR); // multiply
    }
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // -- frame composite ------------------------------------------------------

  private composite() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.bindVertexArray(this.quadVAO);

    // 1. paper (no blend)
    gl.disable(gl.BLEND);
    gl.useProgram(this.progPaper);
    gl.uniform1f(this.loc(this.progPaper, "uFlipY"), 1);
    gl.uniform1f(this.loc(this.progPaper, "uAspect"), this.w / this.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2 + 3. dry layers (mine plain; partner's through the wash mask)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
    gl.useProgram(this.progDry);
    for (const [author, layer] of this.layers) {
      const mine = author === this.localAuthor;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layer.dry.tex);
      gl.uniform1i(this.loc(this.progDry, "uDry"), 0);
      gl.uniform1f(this.loc(this.progDry, "uFlipY"), 1);
      gl.uniform1f(this.loc(this.progDry, "uReveal"), mine ? 1 : this.revealT);
      gl.uniform1i(
        this.loc(this.progDry, "uWashMode"),
        mine ? 0 : this.reducedMotion ? 2 : 1,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // 4. live coverage through the glaze shader (mine always; partner's
    //    only in live mode), with the wet sheen lift
    for (const [author, act] of this.active) {
      const mine = author === this.localAuthor;
      if (!mine && !this.showPartnerLive) continue;
      this.glaze(this.layer(author).cov, null, act.meta, 1);
    }
    gl.bindVertexArray(null);
  }

  // -- GL plumbing ----------------------------------------------------------

  private layer(author: string): Layer {
    let l = this.layers.get(author);
    if (!l) {
      l = { dry: this.makeTarget(true), cov: this.makeTarget(false) };
      this.clearTarget(l.dry, 1, 1, 1, 1);
      this.clearTarget(l.cov, 0, 0, 0, 0);
      this.layers.set(author, l);
    }
    return l;
  }

  private makeTarget(rgba: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, rgba ? gl.RGBA8 : gl.R8, this.w, this.h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  private deleteTarget(t: Target) {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  private clearTarget(t: Target, r: number, g: number, b: number, a: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private buildPrograms() {
    this.progStampPen = this.link(STAMP_VS, STAMP_PEN_FS);
    this.progStampWater = this.link(STAMP_VS, STAMP_WATER_FS);
    this.progGlaze = this.link(QUAD_VS, GLAZE_FS);
    this.progPaper = this.link(QUAD_VS, PAPER_FS);
    this.progDry = this.link(QUAD_VS, DRY_FS);
  }

  private buildGeometry() {
    const gl = this.gl;
    const corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const cornerBuf = gl.createBuffer()!;
    this.cornerBuf = cornerBuf;
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    // fullscreen quad VAO (attrib 0 only)
    this.quadVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // instanced stamp VAO
    this.stampVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instanceBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuf);
    const stride = FLOATS_PER_STAMP * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  private link(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error(
          gl.isContextLost()
            ? "WebGL context was lost — reload the page."
            : `shader compile: ${gl.getShaderInfoLog(sh)}`,
        );
      }
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`program link: ${gl.getProgramInfoLog(prog)}`);
    }
    this.uni.set(prog, new Map());
    return prog;
  }

  private loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    const cache = this.uni.get(prog)!;
    if (!cache.has(name)) {
      cache.set(name, this.gl.getUniformLocation(prog, name));
    }
    return cache.get(name)!;
  }
}
