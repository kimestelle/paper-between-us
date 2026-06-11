// GLSL source strings for the paint engine.
//
// Determinism rule: all noise is hash-based value noise seeded only from the
// per-stroke seed and position. No time, no randomness outside the seed —
// both clients must converge on identical dried pixels.

const NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// 3-octave fbm
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.13, 9.57);
    a *= 0.5;
  }
  return v;
}
`;

// ---------------------------------------------------------------------------
// Stamp pass — instanced quads splatted into a single-channel coverage FBO
// with blendEquation(MAX). Per-instance: center(px), radius(px), alpha,
// along-stroke distance (normalized by min(w,h)).
// ---------------------------------------------------------------------------

export const STAMP_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;   // unit quad corner, -1..1
layout(location = 1) in vec2 iCenter;   // device px
layout(location = 2) in float iRadius;  // device px
layout(location = 3) in float iAlpha;
layout(location = 4) in float iDist;    // along-stroke distance / min(w,h)
uniform vec2 uRes;
out vec2 vLocal;
out vec2 vWorld;   // canvas uv 0..1 (x/w, y/h)
out float vAlpha;
out float vDist;
void main() {
  vec2 px = iCenter + aCorner * iRadius;
  vLocal = aCorner;
  vWorld = px / uRes;
  vAlpha = iAlpha;
  vDist = iDist;
  // FBO space: uv == clip*0.5+0.5, no flip (consistent for all FBO passes)
  gl_Position = vec4(vWorld * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const STAMP_PEN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
in float vAlpha;
in float vDist;
out vec4 outColor;
void main() {
  float r = length(vLocal);
  float c = (1.0 - smoothstep(0.7, 1.0, r)) * vAlpha;
  outColor = vec4(c, 0.0, 0.0, 1.0);
}
`;

export const STAMP_WATER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
in float vAlpha;
in float vDist;
uniform float uSeed;     // 0..1 per stroke
uniform float uAspect;   // w/h, to keep noise isotropic in uv space
out vec4 outColor;
${NOISE}
void main() {
  float r = length(vLocal);
  // soft falloff
  float c = 1.0 - smoothstep(0.25, 1.0, r);
  // body texture: 3-octave fbm in canvas space, offset by the stroke seed
  vec2 np = vec2(vWorld.x * uAspect, vWorld.y) * 22.0 + uSeed * 113.7;
  float n = fbm(np + vDist * 1.7);
  c *= 0.72 + 0.56 * n;
  // ragged rim
  float rimNoise = fbm(np * 1.9 + 31.4 + uSeed * 57.3);
  c *= smoothstep(0.0, 0.08, (1.0 - r) + (rimNoise - 0.5) * 0.35);
  outColor = vec4(clamp(c, 0.0, 1.0) * vAlpha, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Fullscreen quad VS shared by glaze / composite / paper / wash passes.
// uFlipY = 1 when rendering to the default framebuffer (screen), 0 for FBOs.
// ---------------------------------------------------------------------------

export const QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
uniform float uFlipY;
out vec2 vUV;
void main() {
  vec2 uv = aPos * 0.5 + 0.5;
  vUV = vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlipY));
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Glaze — coverage → transmittance color. Multiplied into the destination
// (dry layer or screen) with blendFunc(ZERO, SRC_COLOR). Zero coverage must
// output white so the destination is left untouched.
// uBrush: 0 = pen, 1 = water, 2 = erase. uWet adds the +4% live lift.
// Erase is drawn with normal alpha blending instead (lerps the dry layer
// back toward white = untouched paper).
// ---------------------------------------------------------------------------

export const GLAZE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uCov;
uniform vec3 uColor;     // pigment, sRGB 0..1
uniform float uOpacity;
uniform int uBrush;      // 0 pen, 1 water, 2 erase
uniform float uSeed;
uniform float uWet;      // 0 dry, 1 live
uniform float uAspect;
out vec4 outColor;
${NOISE}
void main() {
  float c = texture(uCov, vUV).r;
  if (uBrush == 2) {
    // eraser: alpha-blended toward white (dry layer) / paper tint (live)
    float a = smoothstep(0.05, 0.55, c) * uOpacity;
    vec3 tint = mix(vec3(1.0), vec3(0.969, 0.949, 0.906), uWet);
    outColor = vec4(tint, a);
    return;
  }
  vec3 glaze;
  if (uBrush == 0) {
    float a = smoothstep(0.25, 0.6, c) * uOpacity;
    glaze = mix(vec3(1.0), uColor, a);
  } else {
    // coverage falls off at edges, so mid-coverage IS the edge zone
    float body = smoothstep(0.03, 0.55, c);
    float rim = smoothstep(0.03, 0.22, c) * (1.0 - smoothstep(0.18, 0.5, c));
    float density = clamp(body * 0.62 + rim * 0.30, 0.0, 0.95) * uOpacity;
    // granulation: paper-anchored noise, +-15%
    vec2 gp = vec2(vUV.x * uAspect, vUV.y) * 90.0 + uSeed * 41.9;
    float gran = vnoise(gp) * 0.55 + vnoise(gp * 2.7 + 13.1) * 0.45;
    density *= 0.85 + 0.30 * gran;
    // rim gets darker AND more saturated
    vec3 pigment = pow(uColor, vec3(1.0 + rim * 0.8));
    glaze = mix(vec3(1.0), pigment, clamp(density, 0.0, 1.0));
  }
  // wet sheen: paint visibly settles when it dries
  glaze += (vec3(1.0) - glaze) * (0.04 * uWet);
  outColor = vec4(glaze, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Paper — procedural warm paper, drawn with blending disabled.
// ---------------------------------------------------------------------------

export const PAPER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform float uAspect;
out vec4 outColor;
${NOISE}
void main() {
  vec2 p = vec2(vUV.x * uAspect, vUV.y);
  vec3 tint = vec3(0.969, 0.949, 0.906); // #F7F2E7
  // fbm grain
  float grain = fbm(p * 140.0);
  // faint directional fiber noise (stretched horizontally)
  float fiber = vnoise(vec2(p.x * 260.0, p.y * 26.0));
  float tone = 1.0 - 0.045 * (grain - 0.5) - 0.025 * (fiber - 0.5);
  // very subtle vignette
  vec2 d = vUV - 0.5;
  tone *= 1.0 - 0.06 * smoothstep(0.25, 0.75, dot(d, d) * 2.0);
  outColor = vec4(tint * tone, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Dry layer composite — multiplies a dry (transmittance) texture onto the
// screen. uWash applies the reveal mask to the partner's layer:
//   uWashMode 0: hard cut (always fully shown / hidden by uReveal=1/0 — used
//                for my own layer with uReveal=1)
//   uWashMode 1: noise-edged wash sweep driven by uReveal
//   uWashMode 2: uniform crossfade (prefers-reduced-motion)
// ---------------------------------------------------------------------------

export const DRY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uDry;
uniform float uReveal;    // 0 hidden .. 1 shown
uniform int uWashMode;
out vec4 outColor;
${NOISE}
void main() {
  vec3 dry = texture(uDry, vUV).rgb;
  float show;
  if (uWashMode == 1) {
    float n = fbm(vUV * 2.5);
    // mask=1 means still hidden; water spreads across the paper as t rises
    float mask = smoothstep(uReveal - 0.12, uReveal + 0.12, n);
    show = 1.0 - mask;
  } else if (uWashMode == 2) {
    show = uReveal;
  } else {
    show = step(0.5, uReveal);
  }
  vec3 glaze = mix(vec3(1.0), dry, show);
  outColor = vec4(glaze, 1.0);
}
`;
