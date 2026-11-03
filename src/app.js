'use strict';
const $ = (id) => document.getElementById(id);
// цвета обложки сборки: светлый низ неба и тёмный верх
const ART = [['#f2a65a', '#7a3d1d'], ['#7cc3e8', '#2b6cb0'], ['#b48cff', '#3a1f7a'], ['#9be37a', '#2f6b30'], ['#ff9fb2', '#7a1f3d'], ['#ffd36b', '#8a5a12']];
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; };
const artOf = (name) => ART[hash(name) % ART.length];
const paint = (el, name) => { const [c1, c2] = artOf(name); el.style.setProperty('--c1', c1); el.style.setProperty('--c2', c2); };
const loaderName = (i) => (i.loader === 'fabric' ? 'Fabric' : 'Без модов');
const modCount = (i) => Object.values(i.mods || {}).filter((m) => (m.type || 'mod') === 'mod').length;
const plural = (n, one, few, many) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const modsText = (n) => `${n} ${plural(n, 'мод', 'мода', 'модов')}`;
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс' : String(n));
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ');
const fmtTime = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; };
const TRASH = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

async function call(channel, ...args) {
  const r = await window.voxa.call(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function toast(text, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, err ? 6000 : 3200);
}
// кнопка на время действия: блокируется, показывает текст, ошибки уходят во всплывашку
async function busyBtn(btn, text, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  if (text) btn.textContent = text;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; if (btn.textContent === text) btn.textContent = old; }
}

let instances = [];
let selected = null;
let game = 'idle'; // idle | starting | running
let runningName = null;

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return m <= 1 ? 'только что' : `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

// воксельный пейзаж в цветах сборки, у каждой сборки свой рельеф
let landId = 0;
function land(name) {
  const [c1, c2] = name ? artOf(name) : ['#3FE0BF', '#0F3B3A'];
  const W = 600, H = 300, s = 30, id = 'g' + (landId++);
  let seed = hash(name || '-') % 233280;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  let far = '', near = '', trees = '';
  for (let x = 0; x < W; x += s) {
    far += `<rect x="${x}" y="${115 + Math.floor(rnd() * 4) * 18}" width="${s}" height="${H}" fill="${c2}" opacity=".55"/>`;
    const h = 190 + Math.floor(rnd() * 3) * 15;
    near += `<rect x="${x}" y="${h}" width="${s}" height="${H}" fill="#4f9d45"/><rect x="${x}" y="${h + 13}" width="${s}" height="${H}" fill="#7a5233"/>`;
    if (rnd() < .18) trees += `<rect x="${x + 11}" y="${h - 45}" width="8" height="46" fill="#6b4a2b"/><rect x="${x - 4}" y="${h - 78}" width="${s + 8}" height="${s + 8}" fill="#2f6b30"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#${id})"/><circle cx="${420 + (hash(name || '') % 120)}" cy="70" r="28" fill="#fff3c9" opacity=".9"/>${far}${trees}${near}</svg>`;
}

// ==================== главная ====================
let bgFront = 'bgA';
let shownName;
function setBackground(name) {
  if (shownName === name) return;
  shownName = name;
  // две подложки по очереди: новая обложка плавно проявляется поверх старой
  const back = bgFront === 'bgA' ? 'bgB' : 'bgA';
  $(back).innerHTML = land(name);
  $(back).classList.add('on');
  $(bgFront).classList.remove('on');
  bgFront = back;
  const hero = $('hero');
  hero.classList.remove('anim');
  void hero.offsetWidth;
  hero.classList.add('anim');
}

function renderHome() {
  const cur = instances.find((i) => i.name === selected);
  setBackground(cur ? cur.name : '');
  $('badge').textContent = cur ? `${loaderName(cur)} · ${cur.mc}` : '';
  $('title').textContent = cur ? cur.name : 'Voxa';
  $('sub').textContent = cur
    ? [cur.loader === 'fabric' ? modsText(modCount(cur)) : 'Чистый Minecraft', cur.playTime ? `наиграно ${fmtTime(cur.playTime)}` : '', cur.lastPlayed ? `последний раз ${ago(cur.lastPlayed)}` : 'ещё не запускалась'].filter(Boolean).join(', ')
    : 'Создай первую сборку: выбери версию Minecraft, и можно играть.';
  $('modsCount').textContent = cur ? modCount(cur) : 0;
  for (const id of ['modsBtn', 'manageBtn', 'dirBtn']) $(id).hidden = !cur;
  if (cur && cur.loader !== 'fabric') $('modsBtn').hidden = true;
  renderPlay();

  const box = $('cards');
  const firstTime = !box.childElementCount;
  box.textContent = '';
  const add = document.createElement('button');
  add.className = 'bc new';
  add.textContent = '+';
  add.title = 'Новая сборка';
  add.addEventListener('click', openNew);
  box.appendChild(add);
  instances.forEach((inst, i) => {
    const b = document.createElement('button');
    b.className = 'bc' + (inst.name === selected ? ' on' : '');
    b.style.setProperty('--i', i + 1);
    if (!firstTime) b.style.animation = 'none';
    b.innerHTML = `<span class="a">${land(inst.name)}</span><span><b></b><small></small></span>`;
    b.querySelector('b').textContent = inst.name;
    b.querySelector('small').textContent = `${inst.mc} · ${inst.loader === 'fabric' ? modsText(modCount(inst)) : 'без модов'}`;
    b.addEventListener('click', () => { selected = inst.name; render(); });
    b.addEventListener('dblclick', launch);
    box.appendChild(b);
  });
}

function renderPlay() {
  const btn = $('playBtn');
  const mine = runningName === selected;
  btn.classList.toggle('stop', game === 'running' && mine);
  btn.disabled = game === 'starting' || (game === 'running' && !mine);
  if (game === 'idle') { $('playText').textContent = selected ? 'Играть' : 'Новая сборка'; $('playFill').style.width = '0'; }
  else if (!mine) $('playText').textContent = 'Игра уже идёт';
  else if (game === 'running') $('playText').textContent = 'Остановить';
  else $('playText').textContent = 'Запуск…';
  $('instPlay').textContent = game === 'running' && mine ? 'Остановить' : 'Играть';
  $('instPlay').disabled = game === 'starting' || (game === 'running' && !mine);
  $('stopBtn').disabled = game !== 'running';
}

function render() {
  renderHome();
  renderCatInst();
  if ($('inst').classList.contains('on')) renderInst();
}

async function loadInstances() {
  instances = await call('instances:list');
  if (!instances.some((i) => i.name === selected)) selected = instances[0] ? instances[0].name : null;
  render();
}

$('modsBtn').addEventListener('click', () => openInst('mod'));
$('manageBtn').addEventListener('click', () => openInst('opts'));
$('dirBtn').addEventListener('click', () => selected && call('instances:open', selected));

// ==================== запуск, прогресс и лог ====================
let hideTimer = 0;
function showProgress(p) {
  if (p.stage === 'pack') { showStatus(p.text, null); return; }
  const pct = typeof p.progress === 'number' ? Math.round(p.progress * 100) : null;
  showStatus(p.text + (pct !== null && pct < 100 ? ` · ${pct}%` : ''), pct, p.error);
  if (p.error) toast(p.text, true);
  $('playFill').style.width = pct === null || p.stage === 'running' ? '0' : `${pct}%`;
  if (p.stage === 'running') { game = 'running'; setLogState(); skinMood('wave'); hideStatus(3000); }
  if (p.stage === 'closed' || p.stage === 'error') {
    game = 'idle';
    runningName = null;
    setLogState();
    skinMood('idle');
    loadInstances();
    hideStatus(p.error ? 9000 : 4000);
    // игра упала — сразу показываем лог, как Prism
    if (p.error && p.code) openInst('log');
  }
}
function showStatus(text, pct, err) {
  const st = $('status');
  clearTimeout(hideTimer);
  if (st.hidden) { st.hidden = false; st.style.animation = 'none'; void st.offsetWidth; st.style.animation = ''; }
  st.classList.toggle('err', !!err);
  st.classList.toggle('indet', pct === null && !err);
  st.style.setProperty('--p', pct || 0);
  $('statusText').textContent = text;
}
function hideStatus(ms) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { $('status').hidden = true; }, ms); }
window.voxa.onProgress(showProgress);

async function launch() {
  if (game === 'running' && runningName === selected) { await call('game:stop'); return; }
  if (game !== 'idle') return;
  if (!selected) { openNew(); return; }
  game = 'starting';
  runningName = selected;
  logLines = [];
  $('logPre').textContent = '';
  setLogState();
  skinMood('walk');
  try {
    await call('game:launch', selected);
  } catch (e) {
    showProgress({ text: e.message, error: true, progress: null, stage: 'error' });
  }
}
$('playBtn').addEventListener('click', launch);
$('instPlay').addEventListener('click', launch);
$('stopBtn').addEventListener('click', () => call('game:stop'));

// лог игры: копим строки, рисуем раз в кадр, чтобы окно не тормозило
let logLines = [];
let logQueued = false;
window.voxa.onLog((chunk) => {
  for (const line of String(chunk).split(/\r?\n/)) if (line) logLines.push(line);
  if (logLines.length > 4000) logLines = logLines.slice(-3000);
  if (!logQueued) { logQueued = true; requestAnimationFrame(flushLog); }
});
function flushLog() {
  logQueued = false;
  if (!$('paneLog').classList.contains('on')) return;
  const pre = $('logPre');
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const line of logLines.slice(-1500)) {
    const s = document.createElement('span');
    s.textContent = line + '\n';
    if (/ERROR|Exception|FATAL|Caused by/.test(line)) s.className = 'e';
    else if (/WARN/.test(line)) s.className = 'w';
    else if (line.startsWith('[Voxa]')) s.className = 'v';
    frag.appendChild(s);
  }
  pre.textContent = '';
  pre.appendChild(frag);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
function setLogState() {
  const el = $('logState');
  el.classList.toggle('live', game !== 'idle');
  el.textContent = game === 'running' ? `Идёт игра: ${runningName}` : game === 'starting' ? 'Запуск…' : logLines.length ? 'Игра закрыта, лог последнего запуска' : 'Игра не запущена';
  renderPlay();
}
$('logCopy').addEventListener('click', () => { navigator.clipboard.writeText(logLines.join('\n')); toast('Лог скопирован'); });
$('logsDir').addEventListener('click', () => selected && call('instances:openSub', selected, 'logs'));

// ==================== скин: большой 3D, крутится мышкой ====================
const DEFAULT_SKIN = (() => {
  // свой скин по умолчанию: заливаем все грани модели, детали только спереди
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const r = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const SKIN = '#e8b48a', HAIR = '#3a2a1f', TOP = '#3FE0BF', TOP2 = '#14A88F', PANTS = '#2b3a55', SHOE = '#1b2234';
  r(0, 0, 32, 16, SKIN); r(8, 0, 8, 8, HAIR); r(0, 8, 32, 2, HAIR); r(24, 8, 8, 6, HAIR); r(0, 10, 2, 3, HAIR); r(22, 10, 2, 3, HAIR);
  r(9, 12, 2, 2, '#1b1b24'); r(13, 12, 2, 2, '#1b1b24'); r(11, 14, 2, 1, '#b07a58');
  r(16, 16, 24, 16, TOP); r(20, 20, 8, 2, TOP2); r(23, 22, 2, 6, '#B9FFF0');
  r(40, 16, 16, 16, TOP); r(40, 29, 16, 3, SKIN); r(48, 16, 4, 4, SKIN);
  r(32, 48, 16, 16, TOP); r(32, 61, 16, 3, SKIN); r(40, 48, 4, 4, SKIN);
  r(0, 16, 16, 16, PANTS); r(0, 29, 16, 3, SHOE); r(16, 48, 16, 16, PANTS); r(16, 61, 16, 3, SHOE);
  return c;
})();

let viewer = null;
function initViewer() {
  try {
    const cv = $('skin3d');
    viewer = new skinview3d.SkinViewer({ canvas: cv, width: cv.clientWidth || 300, height: cv.clientHeight || 420, skin: DEFAULT_SKIN });
    viewer.controls.enableZoom = false;
    viewer.controls.enablePan = false;
    viewer.fov = 40;
    viewer.zoom = 0.86;
    viewer.playerObject.rotation.y = -0.45;
    viewer.animation = new skinview3d.IdleAnimation();
    new ResizeObserver(() => { if (cv.clientWidth) viewer.setSize(cv.clientWidth, cv.clientHeight); }).observe(cv);
  } catch {
    viewer = null; // без WebGL показываем плоскую фигурку
    $('skin3d').hidden = true;
    $('skinCv').hidden = false;
  }
}
// скин живой: идёт, пока игра грузится, машет, когда она запустилась
function skinMood(mood) {
  if (!viewer) return;
  if (mood === 'walk') { viewer.animation = new skinview3d.WalkingAnimation(); viewer.animation.speed = 1.2; }
  else if (mood === 'wave') { viewer.animation = new skinview3d.WaveAnimation(); setTimeout(() => { if (game !== 'starting') skinMood('idle'); }, 2600); }
  else viewer.animation = new skinview3d.IdleAnimation();
}

function drawFlat(img) {
  const tall = img.height >= 64;
  const fig = $('skinCv').getContext('2d');
  fig.clearRect(0, 0, 16, 32);
  fig.imageSmoothingEnabled = false;
  const part = (sx, sy, w, h, dx, dy) => fig.drawImage(img, sx, sy, w, h, dx, dy, w, h);
  part(8, 8, 8, 8, 4, 0); part(20, 20, 8, 12, 4, 8); part(44, 20, 4, 12, 0, 8); part(4, 20, 4, 12, 4, 20);
  if (tall) { part(36, 52, 4, 12, 12, 8); part(20, 52, 4, 12, 8, 20); } else { part(44, 20, 4, 12, 12, 8); part(4, 20, 4, 12, 8, 20); }
  part(40, 8, 8, 8, 4, 0);
  const face = $('faceCv').getContext('2d');
  face.imageSmoothingEnabled = false;
  face.clearRect(0, 0, 8, 8);
  face.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
  face.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
}
function showSkin(dataUrl, greet) {
  if (!dataUrl) { drawFlat(DEFAULT_SKIN); if (viewer) viewer.loadSkin(DEFAULT_SKIN); return; }
  const img = new Image();
  img.onload = () => { drawFlat(img); if (viewer) { viewer.loadSkin(img); if (greet) skinMood('wave'); } };
  img.src = dataUrl;
}
async function pickSkin() {
  try {
    const url = await call('skin:pick');
    if (url) { showSkin(url, true); toast('Скин обновлён'); }
  } catch (e) { toast(e.message, true); }
}
$('skinBtn').addEventListener('click', pickSkin);
$('skinPick').addEventListener('click', pickSkin);
$('skinReset').addEventListener('click', async () => { await call('skin:reset'); showSkin(null); toast('Вернул скин по умолчанию'); });
$('railFace').addEventListener('click', () => openTab('settings'));

// ==================== страница сборки ====================
let itab = 'mod';
function openInst(tab) {
  if (!selected) { openNew(); return; }
  if (tab) itab = tab;
  openTab('inst');
}
function renderInst() {
  const cur = instances.find((i) => i.name === selected);
  if (!cur) { openTab('home'); return; }
  $('instCover').innerHTML = land(cur.name);
  $('instTitle').textContent = cur.name;
  $('instFacts').textContent = [`Minecraft ${cur.mc}`, loaderName(cur), cur.playTime ? `наиграно ${fmtTime(cur.playTime)}` : '', cur.lastPlayed ? `запуск ${ago(cur.lastPlayed)}` : ''].filter(Boolean).join(' · ');
  const fabric = cur.loader === 'fabric';
  document.querySelector('[data-itab=mod]').hidden = !fabric;
  document.querySelector('[data-itab=shader]').hidden = !fabric;
  if (!fabric && (itab === 'mod' || itab === 'shader')) itab = 'resourcepack';
  showITab(itab);
}
function showITab(tab) {
  itab = tab;
  document.querySelectorAll('#instTabs [data-itab]').forEach((b) => b.classList.toggle('on', b.dataset.itab === tab));
  const pane = { worlds: 'paneWorlds', log: 'paneLog', opts: 'paneOpts' }[tab] || 'paneContent';
  document.querySelectorAll('.ipane').forEach((p) => p.classList.toggle('on', p.id === pane));
  requestAnimationFrame(moveTabLine);
  if (pane === 'paneContent') loadContent();
  if (tab === 'worlds') loadWorlds();
  if (tab === 'log') { setLogState(); flushLog(); const pre = $('logPre'); pre.scrollTop = pre.scrollHeight; }
  if (tab === 'opts') fillOpts();
}
function moveTabLine() {
  const on = document.querySelector('#instTabs button.on');
  if (!on) return;
  $('tabLine').style.left = on.offsetLeft + 10 + 'px';
  $('tabLine').style.width = on.offsetWidth - 20 + 'px';
}
document.querySelectorAll('#instTabs [data-itab]').forEach((b) => b.addEventListener('click', () => showITab(b.dataset.itab)));

// --- моды, ресурспаки, шейдеры ---
const SUB = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
let contentItems = [];
let contentSeq = 0;
async function loadContent() {
  const seq = ++contentSeq;
  const type = itab;
  $('updBtn').hidden = type !== 'mod';
  $('updBar').hidden = true;
  $('addBtn').textContent = { mod: '+ Добавить моды', resourcepack: '+ Добавить ресурспаки', shader: '+ Добавить шейдеры' }[type];
  $('contentList').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  try {
    const items = await call('content:list', selected, type);
    if (seq !== contentSeq) return;
    contentItems = items;
    renderContent();
  } catch (e) {
    if (seq === contentSeq) $('contentList').innerHTML = '';
    toast(e.message, true);
  }
}
function iconOrTile(img, src, name) {
  if (src) { img.src = src; return; }
  const t = document.createElement('i');
  t.className = 'tile';
  paint(t, name);
  img.replaceWith(t);
}
function renderContent() {
  const q = $('localSearch').value.trim().toLowerCase();
  const box = $('contentList');
  box.textContent = '';
  const shown = contentItems.filter((c) => c.title.toLowerCase().includes(q) || c.file.toLowerCase().includes(q));
  if (!shown.length) {
    box.innerHTML = `<p class="empty">${contentItems.length ? 'Ничего не нашлось' : 'Пусто. Нажми «Добавить», откроется каталог Modrinth. Или положи файлы в папку.'}</p>`;
    return;
  }
  shown.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (c.enabled ? '' : ' off');
    row.style.setProperty('--i', i);
    row.innerHTML = '<img class="tile" alt=""><span class="info"><b></b><small></small></span><span class="rowBtns"><button class="sw" role="switch"></button><button class="del" title="Удалить">' + TRASH + '</button></span>';
    iconOrTile(row.querySelector('img'), c.icon, c.title);
    row.querySelector('b').textContent = c.title;
    row.querySelector('small').textContent = [c.version, c.file, fmtSize(c.size)].filter(Boolean).join(' · ');
    const sw = row.querySelector('.sw');
    const paintSw = () => { sw.classList.toggle('on', c.enabled); sw.setAttribute('aria-checked', c.enabled); sw.title = c.enabled ? 'Выключить' : 'Включить'; row.classList.toggle('off', !c.enabled); };
    paintSw();
    sw.addEventListener('click', async () => {
      try {
        c.file = await call('content:toggle', selected, itab, c.file);
        c.enabled = !c.enabled;
        paintSw();
      } catch (e) { toast(e.message, true); }
    });
    row.querySelector('.del').addEventListener('click', async () => {
      try {
        await call('content:remove', selected, itab, c.file);
        contentItems = contentItems.filter((x) => x !== c);
        row.classList.add('gone');
        setTimeout(() => { row.remove(); if (!contentItems.length) renderContent(); }, 300);
        instances = await call('instances:list');
        renderHome();
      } catch (e) { toast(e.message, true); }
    });
    box.appendChild(row);
  });
}
$('localSearch').addEventListener('input', renderContent);
$('subDir').addEventListener('click', () => call('instances:openSub', selected, SUB[itab]));
$('addBtn').addEventListener('click', () => {
  document.querySelector(`input[name=kind][value=${itab}]`).checked = true;
  catTarget = selected;
  openTab('catalog');
});
$('updBtn').addEventListener('click', () => busyBtn($('updBtn'), 'Проверяю…', async () => {
  const list = await call('mods:updates', selected);
  if (!list.length) { toast('Все моды свежие'); return; }
  $('updText').textContent = `Есть обновления: ${modsText(list.length)}`;
  $('updBar').hidden = false;
}));
$('updAll').addEventListener('click', () => busyBtn($('updAll'), 'Обновляю…', async () => {
  const n = await call('mods:updateAll', selected);
  hideStatus(1500);
  $('updBar').hidden = true;
  toast(`Обновлено: ${modsText(n)}`);
  loadContent();
}));

// --- миры ---
async function loadWorlds() {
  const box = $('worldList');
  box.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  try {
    const worlds = await call('instances:worlds', selected);
    box.textContent = '';
    if (!worlds.length) { box.innerHTML = '<p class="empty">Миров пока нет. Они появятся после первой игры.</p>'; return; }
    worlds.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.setProperty('--i', i);
      row.innerHTML = '<img class="tile" alt=""><span class="info"><b></b><small></small></span>';
      iconOrTile(row.querySelector('img'), w.icon, w.name);
      row.querySelector('b').textContent = w.name;
      row.querySelector('small').textContent = `Последний раз ${ago(w.mtime)}`;
      box.appendChild(row);
    });
  } catch (e) { box.textContent = ''; toast(e.message, true); }
}
$('savesDir').addEventListener('click', () => call('instances:openSub', selected, 'saves'));
$('shotsDir').addEventListener('click', () => call('instances:openSub', selected, 'screenshots'));

// --- настройки сборки ---
let globalRam = 4;
function fillOpts() {
  const cur = instances.find((i) => i.name === selected);
  $('optName').value = cur.name;
  $('optRamOwn').checked = !!cur.ramGb;
  $('optRam').value = cur.ramGb || globalRam;
  $('optRam').disabled = !cur.ramGb;
  $('optRamVal').textContent = `${$('optRam').value} ГБ`;
}
$('optRamOwn').addEventListener('change', () => { $('optRam').disabled = !$('optRamOwn').checked; });
$('optRam').addEventListener('input', () => { $('optRamVal').textContent = `${$('optRam').value} ГБ`; });
$('optSave').addEventListener('click', () => busyBtn($('optSave'), 'Сохраняю…', async () => {
  const inst = await call('instances:update', selected, { name: $('optName').value, ramGb: $('optRamOwn').checked ? Number($('optRam').value) : null });
  selected = inst.name;
  await loadInstances();
  toast('Сохранено');
}));
$('optDel').addEventListener('click', async () => {
  if (!confirm(`Удалить сборку «${selected}» вместе с мирами и модами?`)) return;
  try {
    await call('instances:delete', selected);
    toast(`Сборка «${selected}» удалена`);
    selected = null;
    await loadInstances();
    openTab('home');
  } catch (e) { toast(e.message, true); }
});
$('instCopy').addEventListener('click', () => busyBtn($('instCopy'), 'Копирую…', async () => {
  const inst = await call('instances:copy', selected);
  selected = inst.name;
  await loadInstances();
  toast(`Готово: «${inst.name}»`);
}));
$('instDir').addEventListener('click', () => call('instances:open', selected));

// ==================== каталог Modrinth ====================
const kind = () => document.querySelector('input[name=kind]:checked').value;
let catTarget = null;
let catOffset = 0;
let catSeq = 0;
let catTimer = 0;
function renderCatInst() {
  const k = kind();
  const ok = instances.filter((i) => k === 'resourcepack' || i.loader === 'fabric');
  const sel = $('catInst');
  const keep = catTarget || sel.value || selected;
  sel.textContent = '';
  for (const i of ok) { const o = document.createElement('option'); o.value = i.name; o.textContent = `В сборку: ${i.name}`; sel.appendChild(o); }
  sel.value = ok.some((i) => i.name === keep) ? keep : (ok[0] || {}).name || '';
  catTarget = null;
}
const catInst = () => instances.find((i) => i.name === $('catInst').value);

async function searchCatalog(more) {
  const k = kind();
  renderCatInst();
  const inst = catInst();
  const seq = ++catSeq;
  const box = $('catList');
  $('catInst').hidden = k === 'modpack';
  $('importBtn').hidden = k !== 'modpack';
  if (!more) { catOffset = 0; box.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div>'; }
  if (k !== 'modpack' && !inst) {
    box.innerHTML = `<p class="empty">${k === 'resourcepack' ? 'Сначала создай сборку на главной.' : 'Моды и шейдеры ставятся в сборку на Fabric. Создай её на главной через «+».'}</p>`;
    $('catMore').hidden = true;
    return;
  }
  let res;
  try {
    res = await call('mods:search', { query: $('catSearch').value.trim(), kind: k, mc: inst && inst.mc, offset: catOffset, sort: $('catSort').value });
  } catch (e) {
    if (seq !== catSeq) return;
    box.innerHTML = '<p class="empty"></p>';
    box.firstChild.textContent = 'Нет связи с Modrinth: ' + e.message;
    return;
  }
  if (seq !== catSeq) return; // пришёл ответ на старый запрос
  if (!more) box.textContent = '';
  if (!res.hits.length && !more) box.innerHTML = '<p class="empty">Ничего не нашлось</p>';
  const have = new Set(Object.keys((inst && inst.mods) || {}));
  res.hits.forEach((h, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.setProperty('--i', i);
    row.innerHTML = '<img class="tile" alt=""><span class="info"><b></b><small></small></span><span class="rowBtns"><button class="go"></button></span>';
    iconOrTile(row.querySelector('img'), h.icon, h.title);
    row.querySelector('b').textContent = h.title;
    row.querySelector('small').textContent = `${h.author} · ${fmtNum(h.downloads)} скачиваний · ${h.desc}`;
    const b = row.querySelector('.go');
    if (k === 'modpack') {
      b.textContent = 'Установить сборку';
      b.addEventListener('click', () => busyBtn(b, 'Ставлю…', async () => {
        const created = await call('packs:install', h.id, h.title);
        hideStatus(1500);
        selected = created.name;
        await loadInstances();
        toast(`Сборка «${created.name}» готова`);
      }));
    } else if (have.has(h.id)) {
      b.textContent = 'Установлено';
      b.disabled = true;
    } else {
      b.textContent = 'Установить';
      b.addEventListener('click', async () => {
        const target = inst.name;
        let ok = false;
        await busyBtn(b, 'Ставлю…', async () => {
          await call('content:install', target, h.id, { title: h.title, icon: h.icon, type: k });
          ok = true;
          toast(`«${h.title}» установлен в «${target}»`);
          instances = await call('instances:list');
          renderHome();
        });
        if (ok) { b.textContent = 'Установлено'; b.disabled = true; }
      });
    }
    box.appendChild(row);
  });
  catOffset += res.hits.length;
  $('catMore').hidden = catOffset >= res.total || !res.hits.length;
}
$('catSearch').addEventListener('input', () => { clearTimeout(catTimer); catTimer = setTimeout(() => searchCatalog(), 350); });
$('catInst').addEventListener('change', () => { catTarget = $('catInst').value; searchCatalog(); });
$('catSort').addEventListener('change', () => searchCatalog());
document.querySelectorAll('input[name=kind]').forEach((r) => r.addEventListener('change', () => searchCatalog()));
$('catMore').addEventListener('click', () => busyBtn($('catMore'), 'Загружаю…', () => searchCatalog(true)));
$('importBtn').addEventListener('click', () => busyBtn($('importBtn'), 'Импортирую…', async () => {
  const inst = await call('packs:import');
  if (!inst) return;
  hideStatus(1500);
  selected = inst.name;
  await loadInstances();
  toast(`Сборка «${inst.name}» импортирована`);
}));

// ==================== новая сборка ====================
let versionsLoaded = false;
async function openNew() {
  $('newMsg').textContent = '';
  $('newMsg').classList.remove('err');
  $('newDlg').showModal();
  if (versionsLoaded) return;
  $('newVer').innerHTML = '<option>Загружаю версии…</option>';
  try {
    const list = await call('versions:list');
    $('newVer').innerHTML = '';
    for (const v of list) { const o = document.createElement('option'); o.value = o.textContent = v; $('newVer').appendChild(o); }
    versionsLoaded = true;
  } catch (e) {
    $('newMsg').textContent = 'Не загрузился список версий. ' + e.message;
    $('newMsg').classList.add('err');
  }
}
$('newForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  $('newOk').disabled = true;
  $('newMsg').textContent = 'Создаю…';
  try {
    const inst = await call('instances:create', {
      name: $('newName').value,
      mc: $('newVer').value,
      loader: document.querySelector('input[name=loader]:checked').value
    });
    selected = inst.name;
    $('newDlg').close();
    $('newName').value = '';
    await loadInstances();
    openTab('home');
    toast(`Сборка «${inst.name}» создана`);
  } catch (err) {
    $('newMsg').textContent = err.message;
    $('newMsg').classList.add('err');
  } finally {
    $('newOk').disabled = false;
  }
});

// ==================== разделы и общие настройки ====================
function openTab(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === name));
  document.querySelectorAll('.rail [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $('railDot').style.top = document.querySelector(`.rail [data-tab=${name}]`).offsetTop + 'px';
  if (name === 'inst') renderInst();
  if (name === 'catalog') searchCatalog();
}
document.querySelectorAll('.rail [data-tab]').forEach((b) => b.addEventListener('click', () => (b.dataset.tab === 'inst' ? openInst() : openTab(b.dataset.tab))));

$('setRam').addEventListener('input', () => { $('ramVal').textContent = $('setRam').value; });
$('saveSettings').addEventListener('click', () => busyBtn($('saveSettings'), 'Сохраняю…', async () => {
  const s = await call('settings:set', { nick: $('setNick').value, ramGb: $('setRam').value });
  $('nick').textContent = s.nick;
  globalRam = s.ramGb;
  toast('Настройки сохранены');
}));

(async function init() {
  $('railDot').style.top = document.querySelector('.rail [data-tab=home]').offsetTop + 'px';
  const s = await call('settings:get');
  $('nick').textContent = s.nick;
  globalRam = s.ramGb;
  $('setNick').value = s.nick;
  $('setRam').value = s.ramGb;
  $('ramVal').textContent = s.ramGb;
  initViewer();
  showSkin(await call('skin:get'));
  await loadInstances();
})();
