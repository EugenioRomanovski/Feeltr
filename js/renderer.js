// WebGL renderer: blends up to two exposures and develops them with a film look.

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 v_uv;
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform vec4 u_rectA;     // xy offset, zw scale (negative z = mirrored)
uniform vec4 u_rectB;
uniform float u_hasB;
uniform int u_mode;       // 0 film (additive), 1 screen, 2 lighten
uniform float u_mix;      // weight of the second exposure
uniform float u_seed;
uniform vec2 u_res;
uniform float u_grain;    // grain cell size in px

// Recipe (see recipes.js)
uniform int u_base;       // 0 Nostalgic Neg., 1 Classic Neg., 2 Monochrome +R
uniform vec3 u_wb;        // white balance gains
uniform vec2 u_tone;      // highlight, shadow (Fujifilm units)
uniform float u_color;    // colour (Fujifilm units)
uniform vec2 u_chrome;    // Color Chrome Effect, Color Chrome FX Blue (0 off, 1 weak, 2 strong)
uniform vec2 u_grainFx;   // grain amount, grain size
uniform float u_exp;      // exposure compensation, EV
uniform float u_dr;       // highlight roll-off strength (DR100..DR400)
uniform float u_clarity;  // Fujifilm clarity units
uniform float u_halation;
uniform float u_vignette;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toGamma(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

vec3 softClip(vec3 s) {
  vec3 k = max(s - 0.8, 0.0);
  return min(s, vec3(0.8)) + 0.2 * (1.0 - exp(-k / 0.2));
}

// Linear-light combination of both exposures, like two exposures on one negative.
vec3 exposure(vec2 uv) {
  vec3 a = toLin(texture2D(u_texA, u_rectA.xy + uv * u_rectA.zw).rgb);
  if (u_hasB < 0.5) return a;
  vec3 b = toLin(texture2D(u_texB, u_rectB.xy + uv * u_rectB.zw).rgb);
  float wa = 1.0 - u_mix;
  float wb = u_mix;
  if (u_mode == 1) {
    vec3 ga = toGamma(a) * min(1.0, 2.0 * wa);
    vec3 gb = toGamma(b) * min(1.0, 2.0 * wb);
    return toLin(1.0 - (1.0 - ga) * (1.0 - gb));
  }
  if (u_mode == 2) {
    return max(a * min(1.0, 2.0 * wa), b * min(1.0, 2.0 * wb));
  }
  return softClip((a * wa + b * wb) * 1.3);
}

float shoulderF(float x) {
  float p = 0.68;
  float u = clamp((x - p) / (1.0 - p), 0.0, 1.0);
  return x < p ? x : p + (x - p) * (1.0 - u_dr * u);
}
vec3 shoulder(vec3 c) { return vec3(shoulderF(c.r), shoulderF(c.g), shoulderF(c.b)); }
vec3 saturate3(vec3 c, float s) { return mix(vec3(dot(c, LUMA)), c, s); }

// Fujifilm Highlight / Shadow tone: positive = harder, negative = softer.
vec3 toneHS(vec3 c) {
  float l = dot(c, LUMA);
  float hi = smoothstep(0.4, 1.0, l) * (1.0 - l) * 4.0;
  float lo = (1.0 - smoothstep(0.0, 0.5, l)) * l * 4.0;
  return c + c / max(l, 1e-3) * (u_tone.x * 0.022 * hi - u_tone.y * 0.03 * lo);
}

// Nostalgic Neg.: soft highlight roll-off, amber highlights, rich shadows.
vec3 nostalgicNeg(vec3 c) {
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, 0.22);
  c = shoulder(c);
  c = mix(vec3(0.045, 0.035, 0.035), vec3(1.0), c);

  float l = dot(c, LUMA);
  float hi = smoothstep(0.42, 0.95, l);
  float lo = 1.0 - smoothstep(0.05, 0.5, l);
  c = mix(c, c * vec3(1.07, 0.985, 0.80) + vec3(0.02, 0.008, 0.0), hi * 0.85);
  c = saturate3(c, 1.0 + 0.28 * lo - 0.12 * hi);

  float gd = clamp(c.g - max(c.r, c.b), 0.0, 1.0);
  c.r += gd * 0.25;
  c.b -= gd * 0.10;
  return c;
}

// Classic Neg.: hard contrast, cyan-leaning shadows, warm highlights,
// olive greens and teal blues — the Superia-like snapshot look.
vec3 classicNeg(vec3 c) {
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, 0.42);
  c = shoulder(c);
  c = mix(vec3(0.03, 0.04, 0.045), vec3(1.0, 0.985, 0.96), c);

  float l = dot(c, LUMA);
  float hi = smoothstep(0.5, 0.95, l);
  float lo = 1.0 - smoothstep(0.02, 0.45, l);
  c += vec3(-0.025, 0.004, 0.02) * lo;
  c += vec3(0.024, -0.002, -0.012) * hi;

  float gd = clamp(c.g - max(c.r, c.b), 0.0, 1.0);
  c.r += gd * 0.18;
  c.g -= gd * 0.12;
  float bd = clamp(c.b - max(c.r, c.g), 0.0, 1.0);
  c.g += bd * 0.22;
  float rd = clamp(c.r - max(c.g, c.b), 0.0, 1.0);
  c.b += rd * 0.06;
  return saturate3(c, 0.88);
}

// Monochrome with a red filter: darker skies and foliage, luminous skin.
vec3 monoRed(vec3 c) {
  float m = clamp(dot(c, vec3(0.80, 0.30, -0.10)), 0.0, 1.0);
  float s = m * m * (3.0 - 2.0 * m);
  m = mix(m, s, 0.6);
  m = shoulderF(m);
  m = mix(0.018, 0.985, m);
  return vec3(m) * vec3(1.0, 0.995, 0.985);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + u_seed);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  float ev = exp2(u_exp);
  vec3 lin = exposure(v_uv) * ev;

  // A ring of nearby samples drives halation and clarity (local contrast).
  vec2 px = (u_res.y * 0.006) / u_res;
  float glow = 0.0;
  vec3 near = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float ang = float(i) * 0.785398;
    vec3 t = exposure(v_uv + vec2(cos(ang), sin(ang)) * px) * ev;
    glow += max(dot(t, LUMA) - 0.7, 0.0);
    near += t;
  }
  near /= 8.0;
  lin += vec3(1.0, 0.38, 0.16) * glow * u_halation;

  vec3 c = clamp(toGamma(lin), 0.0, 1.0);
  c = clamp(c + (c - toGamma(near)) * u_clarity * 0.12, 0.0, 1.0);

  if (u_base == 2) {
    c = monoRed(c);
  } else {
    c = clamp(c * u_wb, 0.0, 1.0);
    c = u_base == 1 ? classicNeg(c) : nostalgicNeg(c);
    c = toneHS(c);
    c = saturate3(c, 1.0 + u_color * 0.07);

    float mx = max(c.r, max(c.g, c.b));
    float chroma = mx - min(c.r, min(c.g, c.b));
    c *= 1.0 - u_chrome.x * 0.07 * smoothstep(0.15, 0.6, chroma);
    float blue = clamp((c.b - max(c.r, c.g)) * 3.0, 0.0, 1.0);
    c *= 1.0 - u_chrome.y * 0.08 * blue;
  }

  vec2 q = (v_uv - 0.5) * 2.0;
  c *= 1.0 - smoothstep(0.45, 1.45, length(q)) * u_vignette;

  vec2 p = v_uv * u_res;
  float gs = u_grain * u_grainFx.y;
  float g = vnoise(p / gs) + vnoise(p / (gs * 0.6) + 17.0) - 1.0;
  float l = dot(c, LUMA);
  c += g * u_grainFx.x * (0.35 + 0.65 * (1.0 - abs(2.0 * l - 1.0)));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// Crop rectangle (in texture UV) that covers `outAspect` from a source of srcW x srcH.
export function coverRect(srcW, srcH, outAspect, mirror = false) {
  const srcAspect = srcW / srcH;
  let w = 1, h = 1;
  if (srcAspect > outAspect) w = outAspect / srcAspect;
  else h = srcAspect / outAspect;
  const x = (1 - w) / 2, y = (1 - h) / 2;
  return mirror ? [x + w, y, -w, h] : [x, y, w, h];
}

export class Renderer {
  constructor(canvas, { preserve = false } = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, premultipliedAlpha: false,
      preserveDrawingBuffer: preserve,
    });
    if (!gl) throw new Error('WebGL недоступен');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, this._shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, this._shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of ['u_texA', 'u_texB', 'u_rectA', 'u_rectB', 'u_hasB', 'u_mode', 'u_mix',
      'u_seed', 'u_res', 'u_grain', 'u_base', 'u_wb', 'u_tone', 'u_color', 'u_chrome', 'u_grainFx',
      'u_exp', 'u_dr', 'u_clarity', 'u_halation', 'u_vignette']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    gl.uniform1i(this.u.u_texA, 0);
    gl.uniform1i(this.u.u_texB, 1);

    this.tex = { A: this._texture(0), B: this._texture(1) };
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), vp[0], vp[1]);
  }

  _shader(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  _texture(unit) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    return t;
  }

  upload(slot, source) {
    const gl = this.gl;
    gl.activeTexture(slot === 'A' ? gl.TEXTURE0 : gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
  }

  // `look` is a compiled recipe from recipes.js.
  draw({ rectA, rectB = [0, 0, 1, 1], hasB = false, mode = 0, mix = 0.5, look, seed = 0 }) {
    const gl = this.gl;
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.uniform4fv(this.u.u_rectA, rectA);
    gl.uniform4fv(this.u.u_rectB, rectB);
    gl.uniform1f(this.u.u_hasB, hasB ? 1 : 0);
    gl.uniform1i(this.u.u_mode, mode);
    gl.uniform1f(this.u.u_mix, mix);
    gl.uniform1i(this.u.u_base, look.base);
    gl.uniform3fv(this.u.u_wb, look.wb);
    gl.uniform2fv(this.u.u_tone, look.tone);
    gl.uniform1f(this.u.u_color, look.color);
    gl.uniform2fv(this.u.u_chrome, look.chrome);
    gl.uniform2fv(this.u.u_grainFx, look.grain);
    gl.uniform1f(this.u.u_exp, look.exp);
    gl.uniform1f(this.u.u_dr, look.dr);
    gl.uniform1f(this.u.u_clarity, look.clarity);
    gl.uniform1f(this.u.u_halation, look.halation);
    gl.uniform1f(this.u.u_vignette, look.vignette);
    gl.uniform1f(this.u.u_seed, seed);
    gl.uniform2f(this.u.u_res, width, height);
    gl.uniform1f(this.u.u_grain, Math.max(1, Math.min(width, height) / 1100) * 1.15);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
