import { Renderer, coverRect } from './renderer.js';
import { db } from './db.js';

const $ = (s) => document.querySelector(s);

const FILTERS = {
  nn: { id: 0, name: 'Nostalgic Neg.' },
  mono: { id: 1, name: 'Mono +R' },
};
const MODES = ['Плёнка', 'Экран', 'Светлее'];
const FORMATS = { '3:4': 3 / 4, '2:3': 2 / 3, '1:1': 1 };
const MAX_SIDE = 4096;
const SETTINGS_KEY = 'feeltr:settings';

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
const saved = loadSettings();

const state = {
  filter: saved.filter in FILTERS ? saved.filter : 'nn',
  format: saved.format in FORMATS ? saved.format : '3:4',
  mx: !!saved.mx,
  mode: [0, 1, 2].includes(saved.mode) ? saved.mode : 0,
  mix: typeof saved.mix === 'number' ? saved.mix : 0.5,
  facing: saved.facing === 'user' ? 'user' : 'environment',
  stream: null,
  still: null,   // imported photo used instead of the live camera
  shot1: null,   // first exposure while in multi-exposure mode
  busy: false,
  screen: 'camera',
};

function persist() {
  const { filter, format, mx, mode, mix, facing } = state;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ filter, format, mx, mode, mix, facing })); } catch {}
}

const el = {
  video: $('#video'), preview: $('#preview'), viewfinder: $('#viewfinder'), frame: $('#frame'),
  flash: $('#flash'), mxBadge: $('#mxBadge'), mxPanel: $('#mxPanel'), mxReset: $('#mxReset'),
  mixRange: $('#mixRange'), shutter: $('#shutter'), btnMx: $('#btnMx'), btnFormat: $('#btnFormat'),
  btnFlip: $('#btnFlip'), btnImport: $('#btnImport'), fileInput: $('#fileInput'), stillChip: $('#stillChip'),
  vfMessage: $('#vfMessage'), vfText: $('#vfText'), counter: $('#counter'),
  btnDiary: $('#btnDiary'), lastThumb: $('#lastThumb'), diaryIcon: $('#diaryIcon'),
  camera: $('#camera'), diary: $('#diary'), diaryList: $('#diaryList'), diaryDays: $('#diaryDays'), diaryEmpty: $('#diaryEmpty'),
  filterSeg: $('#filterSeg'), modeSeg: $('#modeSeg'),
  diaryCount: $('#diaryCount'), viewer: $('#viewer'), viewerImg: $('#viewerImg'), viewerMeta: $('#viewerMeta'),
  viewerNote: $('#viewerNote'), viewerStage: $('#viewerStage'), toast: $('#toast'),
};

/* ---------------- Rendering ---------------- */

let previewR;
let captureR;
try {
  previewR = new Renderer(el.preview);
} catch (e) {
  console.error(e);
}
const uploaded = { A: null, B: null };

// The current live source: imported still or camera video.
function live() {
  if (state.still) return state.still;
  const v = el.video;
  if (state.stream && state.stream.getVideoTracks()[0]?.enabled && v.readyState >= 2 && v.videoWidth) {
    return { el: v, w: v.videoWidth, h: v.videoHeight, mirror: state.facing === 'user', dynamic: true };
  }
  return null;
}

function frame() {
  const L = live();
  const A = state.shot1 || L;
  if (!A) return null;
  const B = state.shot1 ? L : null;
  let ratio = FORMATS[state.format];
  if (A.w > A.h) ratio = 1 / ratio;
  return { A, B, ratio };
}

function params(f, seed) {
  return {
    rectA: coverRect(f.A.w, f.A.h, f.ratio, f.A.mirror),
    rectB: f.B ? coverRect(f.B.w, f.B.h, f.ratio, f.B.mirror) : undefined,
    hasB: !!f.B,
    mode: state.mode,
    mix: state.mix,
    filter: FILTERS[state.filter].id,
    seed,
  };
}

let vfBox = { width: 0, height: 0 };
new ResizeObserver(([entry]) => { vfBox = entry.contentRect; }).observe(el.viewfinder);

function sizePreview(ratio) {
  let w = vfBox.width - 20;
  let h = w / ratio;
  if (h > vfBox.height) { h = vfBox.height; w = h * ratio; }
  if (w <= 0 || h <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  const c = el.preview;
  if (c.width !== bw || c.height !== bh) {
    c.width = bw; c.height = bh;
    c.style.width = `${Math.round(w)}px`;
    c.style.height = `${Math.round(h)}px`;
  }
}

function uploadIfNeeded(slot, src) {
  if (src.dynamic || uploaded[slot] !== src.el) {
    previewR.upload(slot, src.el);
    uploaded[slot] = src.el;
  }
}

function tick(t) {
  requestAnimationFrame(tick);
  if (!previewR || state.screen !== 'camera' || document.hidden) return;
  const f = frame();
  if (!f) return;
  sizePreview(f.ratio);
  uploadIfNeeded('A', f.A);
  if (f.B) uploadIfNeeded('B', f.B);
  previewR.draw(params(f, (t * 0.001) % 7));
}

/* ---------------- Camera ---------------- */

let camToken = 0;

function stopCamera() {
  camToken++;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.video.srcObject = null;
}

// Pausing keeps the granted stream alive: browsers (iOS in particular) may ask for
// permission again on every new getUserMedia call, so we request the camera once.
function cameraLive() {
  return state.stream?.getVideoTracks().some((t) => t.readyState === 'live');
}

function pauseCamera() {
  state.stream?.getVideoTracks().forEach((t) => { t.enabled = false; });
}

function resumeCamera() {
  if (!cameraLive()) { startCamera(); return; }
  state.stream.getVideoTracks().forEach((t) => { t.enabled = true; });
  el.video.play().catch(() => {});
  hideMessage();
}

async function startCamera() {
  stopCamera();
  const token = camToken;
  if (!navigator.mediaDevices?.getUserMedia) {
    showMessage('Камера недоступна в этом браузере. Откройте Feeltr по HTTPS или выберите фото из галереи.', false);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: state.facing }, width: { ideal: 4032 }, height: { ideal: 3024 } },
    });
    if (token !== camToken) { stream.getTracks().forEach((t) => t.stop()); return; }
    state.stream = stream;
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    hideMessage();
  } catch (e) {
    if (token !== camToken) return;
    console.warn(e);
    showMessage(e.name === 'NotAllowedError'
      ? 'Feeltr нужен доступ к камере, чтобы снимать.'
      : 'Не удалось запустить камеру.', true);
  }
}

function showMessage(text, canRetry) {
  if (state.still || state.shot1) return;
  el.vfText.textContent = text;
  $('#vfRetry').hidden = !canRetry;
  el.vfMessage.hidden = false;
  el.frame.hidden = true;
}
function hideMessage() {
  el.vfMessage.hidden = true;
  el.frame.hidden = false;
}

/* ---------------- Capture ---------------- */

function fitSize(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.round(w * k), Math.round(h * k)];
}

// Raw copy of a source frame (mirror baked in), used as the first exposure.
function snapshot(src) {
  const [w, h] = fitSize(src.w, src.h, MAX_SIDE);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  if (src.mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src.el, 0, 0, w, h);
  return { el: c, w, h, mirror: false, dynamic: false };
}

const toBlob = (canvas, q) => new Promise((res, rej) =>
  canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/jpeg', q));

async function develop(f) {
  if (!captureR) captureR = new Renderer(document.createElement('canvas'), { preserve: true });
  const p = params(f, Math.random() * 7);
  const [cw, ch] = fitSize(f.A.w * Math.abs(p.rectA[2]), f.A.h * p.rectA[3], Math.min(MAX_SIDE, captureR.maxSize));
  const canvas = captureR.canvas;
  canvas.width = cw; canvas.height = ch;
  captureR.upload('A', f.A.el);
  if (f.B) captureR.upload('B', f.B.el);
  captureR.draw(p);
  const blob = await toBlob(canvas, 0.92);

  const [tw, th] = fitSize(cw, ch, 480);
  const t = document.createElement('canvas');
  t.width = tw; t.height = th;
  t.getContext('2d').drawImage(canvas, 0, 0, tw, th);
  const thumb = await toBlob(t, 0.8);
  return { blob, thumb, width: cw, height: ch };
}

function flash() {
  el.flash.classList.remove('on');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
  navigator.vibrate?.(12);
}

async function shoot() {
  if (state.busy || !previewR) return;
  const L = live();
  if (!L) { toast('Камера ещё не готова'); return; }
  state.busy = true;
  el.shutter.classList.add('busy');
  flash();
  try {
    if (state.mx && !state.shot1) {
      state.shot1 = snapshot(L);
      if (state.still) { state.still = null; resumeCamera(); }
      updateUI();
      toast('Первая экспозиция есть. Наведите камеру на второй сюжет');
      return;
    }
    const f = frame();
    const out = await develop(f);
    const photo = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
      filter: state.filter,
      mx: !!f.B,
      mode: f.B ? state.mode : null,
      format: state.format,
      note: '',
      ...out,
    };
    await db.put(photo);
    if (state.shot1) state.shot1 = null;
    updateUI();
    setLastThumb(photo.thumb);
    refreshCounter();
    el.btnDiary.classList.remove('pop');
    void el.btnDiary.offsetWidth;
    el.btnDiary.classList.add('pop');
  } catch (e) {
    console.error(e);
    toast('Не получилось сохранить кадр');
  } finally {
    state.busy = false;
    el.shutter.classList.remove('busy');
  }
}

/* ---------------- Import ---------------- */

async function importFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const src = snapshot({ el: bmp, w: bmp.width, h: bmp.height, mirror: false });
    bmp.close?.();
    state.still = src;
    pauseCamera();
    hideMessage();
    updateUI();
  } catch (e) {
    console.error(e);
    toast('Не удалось открыть фото');
  }
}

function clearStill() {
  state.still = null;
  updateUI();
  resumeCamera();
}

/* ---------------- UI state ---------------- */

let lastThumbUrl;
function setLastThumb(blob) {
  if (lastThumbUrl) URL.revokeObjectURL(lastThumbUrl);
  lastThumbUrl = blob ? URL.createObjectURL(blob) : null;
  el.lastThumb.hidden = !blob;
  el.diaryIcon.style.display = blob ? 'none' : '';
  if (blob) el.lastThumb.src = lastThumbUrl;
}

async function refreshCounter() {
  const n = await db.count().catch(() => 0);
  el.counter.textContent = `№ ${String(n + 1).padStart(3, '0')}`;
}

function setRangeFill(input) {
  const { min, max, value } = input;
  input.style.setProperty('--p', `${((value - min) / (max - min)) * 100}%`);
}

function updateUI() {
  document.querySelectorAll('.filter-chip').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.filter === state.filter)));
  document.querySelectorAll('[data-mode]').forEach((b) =>
    b.setAttribute('aria-checked', String(Number(b.dataset.mode) === state.mode)));
  el.filterSeg.style.setProperty('--i', Object.keys(FILTERS).indexOf(state.filter));
  el.modeSeg.style.setProperty('--i', state.mode);
  el.btnFormat.textContent = state.format;
  el.btnMx.setAttribute('aria-pressed', String(state.mx));
  el.mxPanel.hidden = !state.mx;
  el.mxBadge.hidden = !state.mx;
  el.mxBadge.textContent = state.shot1 ? 'ME 2/2' : 'ME 1/2';
  el.mxReset.hidden = !state.shot1;
  el.shutter.classList.toggle('second', !!state.shot1);
  el.stillChip.hidden = !state.still;
  el.mixRange.value = Math.round(state.mix * 100);
  setRangeFill(el.mixRange);
  persist();
}

/* ---------------- Diary ---------------- */

const monthFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' });

// "25 октября" (+ year when not the current one); weekday goes on its own line.
function dayTitle(d, withYear) {
  return `${monthFmt.format(d)}${withYear ? ` ${d.getFullYear()}` : ''}`;
}
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

let diaryItems = [];
let diaryUrls = [];

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function renderDiary() {
  diaryItems = await db.all();
  diaryUrls.forEach((u) => URL.revokeObjectURL(u));
  diaryUrls = [];
  const n = diaryItems.length;
  el.diaryCount.textContent = n ? `${n} ${plural(n, 'кадр', 'кадра', 'кадров')}` : '';
  el.diaryEmpty.hidden = n > 0;
  el.diaryDays.hidden = n === 0;

  const year = new Date().getFullYear();
  const frag = document.createDocumentFragment();
  let key = null;
  let grid;
  for (const p of diaryItems) {
    const d = new Date(p.createdAt);
    const k = d.toDateString();
    if (k !== key) {
      key = k;
      const sec = document.createElement('section');
      sec.className = 'day';
      const h = document.createElement('h2');
      const num = document.createElement('span');
      num.className = 'd-num';
      num.textContent = dayTitle(d, d.getFullYear() !== year);
      const rest = document.createElement('span');
      rest.className = 'd-rest';
      rest.textContent = weekdayFmt.format(d);
      h.append(num, rest);
      grid = document.createElement('div');
      grid.className = 'grid';
      sec.append(h, grid);
      frag.append(sec);
    }
    const b = document.createElement('button');
    b.className = 'print';
    b.dataset.id = p.id;
    const img = document.createElement('img');
    const url = URL.createObjectURL(p.thumb);
    diaryUrls.push(url);
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    const time = document.createElement('span');
    time.className = 'p-time';
    time.textContent = timeFmt.format(d);
    b.append(img, time);
    if (p.mx) {
      const badge = document.createElement('span');
      badge.className = 'p-badge';
      badge.textContent = '2×';
      b.append(badge);
    }
    if (p.note) {
      const note = document.createElement('span');
      note.className = 'p-note';
      note.textContent = '✎';
      b.append(note);
    }
    grid.append(b);
  }
  el.diaryDays.replaceChildren(frag);
}

function showScreen(name) {
  el.toast.classList.remove('show');
  state.screen = name === 'camera' ? 'camera' : 'diary';
  el.camera.hidden = name !== 'camera';
  el.diary.hidden = name === 'camera';
  el.viewer.hidden = name !== 'viewer';
  if (name === 'camera') {
    if (!state.still) resumeCamera();
  } else {
    pauseCamera();
  }
}

async function openDiary(push = true) {
  if (push) history.pushState({ s: 'diary' }, '');
  showScreen('diary');
  await renderDiary();
}

/* ---------------- Viewer ---------------- */

let current = null;
let viewerUrl;
let noteTimer;

async function showPhoto(id) {
  const p = await db.get(id);
  if (!p) return;
  current = p;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(p.blob);
  el.viewerImg.src = viewerUrl;
  const d = new Date(p.createdAt);
  const tags = [FILTERS[p.filter]?.name ?? p.filter];
  if (p.mx) tags.push(`MX · ${MODES[p.mode] ?? ''}`.trim());
  el.viewerMeta.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `${fullFmt.format(d)}, ${timeFmt.format(d)}`;
  const sub = document.createElement('div');
  sub.className = 'vm-sub';
  sub.textContent = tags.join(' · ');
  el.viewerMeta.append(title, sub);
  el.viewerNote.value = p.note || '';
}

async function openViewer(id) {
  history.pushState({ s: 'viewer' }, '');
  el.viewer.hidden = false;
  await showPhoto(id);
}

function closeViewer() {
  flushNote();
  el.viewer.hidden = true;
  current = null;
  renderDiary();
}

function flushNote() {
  clearTimeout(noteTimer);
  if (!current) return;
  const note = el.viewerNote.value;
  if (note !== (current.note || '')) {
    current.note = note;
    db.update(current.id, { note });
  }
}

function step(dir) {
  if (!current) return;
  const i = diaryItems.findIndex((p) => p.id === current.id);
  const next = diaryItems[i + dir];
  if (!next) return;
  flushNote();
  showPhoto(next.id);
}

function fileName(p) {
  const d = new Date(p.createdAt);
  const pad = (x) => String(x).padStart(2, '0');
  return `feeltr-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.jpg`;
}

function download(p) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(p.blob);
  a.download = fileName(p);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function share(p) {
  const file = new File([p.blob], fileName(p), { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: p.note || undefined });
    } catch (e) {
      if (e.name !== 'AbortError') download(p);
    }
  } else {
    download(p);
  }
}

/* ---------------- Toast ---------------- */

let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2400);
}

/* ---------------- Events ---------------- */

el.shutter.addEventListener('click', shoot);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && state.screen === 'camera' && el.viewer.hidden) { e.preventDefault(); shoot(); }
});

document.querySelectorAll('.filter-chip').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.filter;
  updateUI();
}));
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.mode = Number(b.dataset.mode);
  updateUI();
}));
el.mixRange.addEventListener('input', () => {
  state.mix = Number(el.mixRange.value) / 100;
  setRangeFill(el.mixRange);
  persist();
});

el.btnMx.addEventListener('click', () => {
  state.mx = !state.mx;
  if (!state.mx) state.shot1 = null;
  updateUI();
  toast(state.mx ? 'Мультиэкспозиция: два кадра в одном' : 'Мультиэкспозиция выключена');
});
el.mxReset.addEventListener('click', () => {
  state.shot1 = null;
  updateUI();
});

el.btnFormat.addEventListener('click', () => {
  const keys = Object.keys(FORMATS);
  state.format = keys[(keys.indexOf(state.format) + 1) % keys.length];
  updateUI();
});

el.btnFlip.addEventListener('click', () => {
  state.facing = state.facing === 'user' ? 'environment' : 'user';
  persist();
  if (state.still) state.still = null;
  updateUI();
  startCamera();
});

const pickFile = () => el.fileInput.click();
el.btnImport.addEventListener('click', pickFile);
$('#vfImport').addEventListener('click', pickFile);
$('#vfRetry').addEventListener('click', startCamera);
el.fileInput.addEventListener('change', () => {
  importFile(el.fileInput.files[0]);
  el.fileInput.value = '';
});
el.stillChip.addEventListener('click', clearStill);

el.btnDiary.addEventListener('click', () => openDiary());
$('#diaryBack').addEventListener('click', () => history.back());
el.diaryList.addEventListener('scroll', () => {
  el.diary.classList.toggle('scrolled', el.diaryList.scrollTop > 28);
}, { passive: true });
el.diaryList.addEventListener('click', (e) => {
  const b = e.target.closest('.print');
  if (b) openViewer(b.dataset.id);
});

$('#viewerClose').addEventListener('click', () => history.back());
el.viewerNote.addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 500);
});
el.viewerNote.addEventListener('blur', flushNote);
$('#viewerShare').addEventListener('click', () => current && share(current));
$('#viewerSave').addEventListener('click', () => current && download(current));
$('#viewerDelete').addEventListener('click', async () => {
  if (!current || !confirm('Удалить этот кадр из дневника?')) return;
  const i = diaryItems.findIndex((p) => p.id === current.id);
  await db.remove(current.id);
  diaryItems.splice(i, 1);
  const latest = await db.latest();
  setLastThumb(latest?.thumb);
  refreshCounter();
  const next = diaryItems[i] || diaryItems[i - 1];
  if (next) showPhoto(next.id);
  else history.back();
});

let touchX = null;
el.viewerStage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
el.viewerStage.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
});
document.addEventListener('keydown', (e) => {
  if (el.viewer.hidden || e.target === el.viewerNote) return;
  if (e.key === 'ArrowRight') step(1);
  if (e.key === 'ArrowLeft') step(-1);
});

window.addEventListener('popstate', (e) => {
  const s = e.state?.s;
  if (!el.viewer.hidden && s !== 'viewer') closeViewer();
  if (s === 'diary') { if (state.screen !== 'diary') openDiary(false); }
  else if (s !== 'viewer') showScreen('camera');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pauseCamera(); flushNote(); }
  else if (state.screen === 'camera' && !state.still) resumeCamera();
});

/* ---------------- Install ---------------- */

let installEvent;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('#btnInstall').hidden = false;
});
$('#btnInstall').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#btnInstall').hidden = true;
});
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
let tipDismissed = false;
try { tipDismissed = localStorage.getItem('feeltr:iosTip') === '1'; } catch {}
if (isIOS && !standalone && !tipDismissed) $('#iosTip').hidden = false;
$('#iosTipClose').addEventListener('click', () => {
  $('#iosTip').hidden = true;
  try { localStorage.setItem('feeltr:iosTip', '1'); } catch {}
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW', e));
}
navigator.storage?.persist?.();

/* ---------------- Boot ---------------- */

updateUI();
refreshCounter();
db.latest().then((p) => setLastThumb(p?.thumb)).catch(() => {});
history.replaceState(null, '');
if (previewR) {
  startCamera();
  requestAnimationFrame(tick);
} else {
  showMessage('Этому устройству не хватает WebGL для плёночных фильтров.', false);
}
