// Film recipes, written with the same settings as Fujifilm in-camera recipes
// and compiled into shader parameters.

const BASE = { nostalgic: 0, classic: 1, mono: 2 };
const STRENGTH = { off: 0, weak: 1, strong: 2 };
const GRAIN = {
  off: [0, 1],
  'weak-small': [0.045, 1], 'weak-large': [0.05, 1.7],
  'strong-small': [0.08, 1], 'strong-large': [0.09, 1.7],
};
const DR = { 100: 0.32, 200: 0.4, 400: 0.5 };

// Kelvin (relative to daylight) plus Fujifilm red/blue shift → RGB gains.
function whiteBalance({ kelvin = 5500, red = 0, blue = 0 }) {
  const t = (kelvin - 5500) / 1000;
  return [
    (1 + 0.035 * t) * (1 + 0.012 * red),
    1,
    (1 - 0.05 * t) * (1 + 0.016 * blue),
  ];
}

function compile(r) {
  return {
    base: BASE[r.sim],
    wb: r.wbGains || whiteBalance(r.wb || {}),
    tone: [r.highlight ?? 0, r.shadow ?? 0],
    color: r.color ?? 0,
    chrome: [STRENGTH[r.cce ?? 'off'], STRENGTH[r.ccfxBlue ?? 'off']],
    grain: GRAIN[r.grain ?? 'off'],
    exp: r.exposure ?? 0,
    dr: DR[r.dr ?? 100],
    clarity: r.clarity ?? 0,
    halation: r.halation ?? 0.04,
    vignette: r.vignette ?? 0.18,
  };
}

export const RECIPES = [
  {
    id: 'nn',
    name: 'Nostalgic Neg.',
    swatch: 'linear-gradient(135deg, #f6c77d 0%, #d67d4c 50%, #2f4f52 100%)',
    // Original Feeltr look: warm amber highlights, rich shadows.
    sim: 'nostalgic', wbGains: [1.045, 1, 0.915], cce: 'strong', grain: 'weak-small',
    halation: 0.09, vignette: 0.22,
  },
  {
    id: 'classic',
    name: 'Classic Negative',
    swatch: 'linear-gradient(135deg, #f0d9a8 0%, #c2614f 48%, #1f4a55 100%)',
    // Fuji X Weekly, "[Not] My X100V Classic Negative".
    sim: 'classic', dr: 200, highlight: 1, shadow: 0, color: 3,
    grain: 'weak-large', cce: 'weak', ccfxBlue: 'weak',
    wb: { red: 4, blue: -4 }, clarity: 2, exposure: 0.33,
  },
  {
    id: 'copenhagen',
    name: 'Copenhagen Neg.',
    swatch: 'linear-gradient(135deg, #f4e3c3 0%, #d98a5f 45%, #35596a 100%)',
    // Fuji X Weekly, "Copenhagen Negative" (2026).
    sim: 'classic', dr: 400, highlight: 2.5, shadow: -2, color: 4,
    grain: 'strong-small', cce: 'weak', ccfxBlue: 'strong',
    wb: { kelvin: 5700, red: 1, blue: 1 }, clarity: -3, exposure: -0.33,
  },
  {
    id: 'retro',
    name: 'Classic Retro',
    swatch: 'linear-gradient(135deg, #e9c98f 0%, #b1543f 50%, #1b3550 100%)',
    // Fuji X Weekly, "Classic Retro" (2026). Exact values are not public in our sources:
    // tuned from its description — strong small grain, strong Color Chrome and FX Blue,
    // daylight WB with a shift, DR400, lower sharpness, a little clarity, underexposed.
    sim: 'classic', dr: 400, highlight: -1, shadow: 1, color: 2,
    grain: 'strong-small', cce: 'strong', ccfxBlue: 'strong',
    wb: { kelvin: 5500, red: 2, blue: -3 }, clarity: 1, exposure: -0.67,
  },
  {
    id: 'agfa',
    name: 'Agfa Ultra 100',
    swatch: 'linear-gradient(135deg, #ffd98a 0%, #e0503a 45%, #1d5a8a 100%)',
    // Fuji X Weekly, "Agfa Ultra 100 v2" (X-Trans V).
    sim: 'nostalgic', dr: 400, highlight: 1.5, shadow: 1, color: 3,
    grain: 'weak-large', cce: 'weak', ccfxBlue: 'weak',
    wb: { kelvin: 5800, red: -3, blue: -3 }, clarity: -2, exposure: 0.33,
    halation: 0.06,
  },
  {
    id: 'mono',
    name: 'Mono +R',
    swatch: 'linear-gradient(135deg, #f4f1ec 0%, #8b8b8b 50%, #151515 100%)',
    sim: 'mono', grain: 'strong-small', halation: 0, vignette: 0.3,
  },
].map((r) => ({ ...r, look: compile(r) }));

export const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((r) => [r.id, r]));
