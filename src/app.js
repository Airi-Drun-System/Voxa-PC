'use strict';
const $ = (id) => document.getElementById(id);
// цвета обложки сборки: светлый низ неба и тёмный верх
const ART = [['#f2a65a', '#7a3d1d'], ['#7cc3e8', '#2b6cb0'], ['#b48cff', '#3a1f7a'], ['#9be37a', '#2f6b30'], ['#ff9fb2', '#7a1f3d'], ['#ffd36b', '#8a5a12']];
const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return h >>> 0; };
const artOf = (name) => ART[hash(name) % ART.length];
const paint = (el, name) => { const [c1, c2] = artOf(name); el.style.setProperty('--c1', c1); el.style.setProperty('--c2', c2); };
const loaderName = (i) => (i.loader === 'fabric' ? 'Fabric' : 'Без модов');
const modCount = (i) => Object.keys(i.mods || {}).length;

async function call(channel, ...args) {
  const r = await window.voxa.call(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

let instances = [];
let selected = null;
let busy = false;
let nick = 'Player';

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return m <= 1 ? 'только что' : `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
const modsWord = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'мод' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'мода' : 'модов');

// воксельный пейзаж в цветах сборки, у каждой сборки свой рельеф
function land(name) {
  const [c1, c2] = name ? artOf(name) : ['#3FE0BF', '#0F3B3A'];
  const W = 600, H = 300, s = 30, id = 'g' + hash(name || '-');
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

// ---------- главная ----------
function renderHome() {
  const cur = instances.find((i) => i.name === selected);
  $('bg').innerHTML = land(cur && cur.name);
  $('badge').textContent = cur ? `${loaderName(cur)} · ${cur.mc}` : '';
  $('title').textContent = cur ? cur.name : 'Voxa';
  $('sub').textContent = cur
    ? [cur.loader === 'fabric' ? `${modCount(cur)} ${modsWord(modCount(cur))}` : 'Чистый Minecraft', cur.lastPlayed ? `последний раз ${ago(cur.lastPlayed)}` : 'ещё не запускалась'].join(', ')
    : 'Создай первую сборку: выбери версию Minecraft, и можно играть.';
  $('modsCount').textContent = cur ? modCount(cur) : 0;
  for (const id of ['modsBtn', 'dirBtn', 'delBtn']) $(id).hidden = !cur;
  if (cur && cur.loader !== 'fabric') $('modsBtn').hidden = true;
  $('playText').textContent = busy ? $('playText').textContent : cur ? 'Играть' : 'Новая сборка';
  $('playBtn').disabled = busy;

  const box = $('cards');
  box.textContent = '';
  const add = document.createElement('button');
  add.className = 'bc new';
  add.textContent = '+';
  add.title = 'Новая сборка';
  add.addEventListener('click', openNew);
  box.appendChild(add);
  for (const inst of instances) {
    const b = document.createElement('button');
    b.className = 'bc' + (inst.name === selected ? ' on' : '');
    b.innerHTML = `<span class="a">${land(inst.name)}</span><span><b></b><small></small></span>`;
    b.querySelector('b').textContent = inst.name;
    b.querySelector('small').textContent = `${inst.mc} · ${inst.loader === 'fabric' ? `${modCount(inst)} ${modsWord(modCount(inst))}` : 'без модов'}`;
    b.addEventListener('click', () => { if (!busy) { selected = inst.name; render(); } });
    box.appendChild(b);
  }
}

function render() { renderHome(); renderModInst(); }

async function loadInstances() {
  instances = await call('instances:list');
  if (!instances.some((i) => i.name === selected)) selected = instances[0] ? instances[0].name : null;
  render();
}

$('modsBtn').addEventListener('click', () => { $('modInst').value = selected; openTab('mods'); });
$('dirBtn').addEventListener('click', () => selected && call('instances:open', selected));
$('delBtn').addEventListener('click', async () => {
  if (!selected || busy || !confirm(`Удалить сборку «${selected}» вместе с мирами и модами?`)) return;
  await call('instances:delete', selected);
  selected = null;
  await loadInstances();
});

// ---------- запуск: прогресс в чипе сверху и в кнопке ----------
let hideTimer = 0;
function showProgress(p) {
  if (p.stage === 'pack') { $('modMsg').textContent = p.text; return; }
  const pct = typeof p.progress === 'number' ? Math.round(p.progress * 100) : null;
  const st = $('status');
  clearTimeout(hideTimer);
  st.hidden = false;
  st.classList.toggle('err', !!p.error);
  st.classList.toggle('indet', pct === null && !p.error && busy);
  st.style.setProperty('--p', pct === null ? 0 : pct);
  $('statusText').textContent = p.text + (pct !== null && pct < 100 ? ` · ${pct}%` : '');
  $('playFill').style.width = pct === null || p.stage === 'running' ? '0' : `${pct}%`;
  if (p.stage === 'running') $('playText').textContent = 'Игра идёт';
  if (p.stage === 'closed' || p.stage === 'error') {
    busy = false;
    $('playFill').style.width = '0';
    $('playText').textContent = 'Играть';
    st.classList.remove('indet');
    loadInstances();
    hideTimer = setTimeout(() => { st.hidden = true; }, p.error ? 9000 : 4000);
  }
}
window.voxa.onProgress(showProgress);

async function launch() {
  if (busy) return;
  if (!selected) { openNew(); return; }
  busy = true;
  $('playText').textContent = 'Запуск…';
  render();
  try {
    await call('game:launch', selected);
  } catch (e) {
    showProgress({ text: e.message, error: true, progress: null, stage: 'error' });
  }
}
$('playBtn').addEventListener('click', launch);

// ---------- скин: фигура спереди из PNG 64×64 (или старого 64×32) ----------
const DEFAULT_SKIN = (() => {
  // свой скин по умолчанию, рисуем прямо на холсте
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const r = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  r(8, 8, 8, 8, '#e8b48a'); r(8, 8, 8, 2, '#3a2a1f'); r(9, 12, 2, 2, '#1b1b24'); r(13, 12, 2, 2, '#1b1b24'); r(11, 14, 2, 1, '#b07a58');
  r(20, 20, 8, 12, '#3FE0BF'); r(20, 20, 8, 2, '#14A88F'); r(23, 22, 2, 6, '#B9FFF0');
  r(44, 20, 4, 12, '#3FE0BF'); r(44, 29, 4, 3, '#e8b48a'); r(36, 52, 4, 12, '#3FE0BF'); r(36, 61, 4, 3, '#e8b48a');
  r(4, 20, 4, 12, '#2b3a55'); r(4, 29, 4, 3, '#1b2234'); r(20, 52, 4, 12, '#2b3a55'); r(20, 61, 4, 3, '#1b2234');
  return c;
})();

function drawSkin(img) {
  const tall = img.height >= 64;
  const fig = $('skinCv').getContext('2d');
  fig.clearRect(0, 0, 16, 32);
  fig.imageSmoothingEnabled = false;
  const part = (sx, sy, w, h, dx, dy, mirror) => {
    if (!mirror) return fig.drawImage(img, sx, sy, w, h, dx, dy, w, h);
    fig.save(); fig.translate(dx + w, dy); fig.scale(-1, 1); fig.drawImage(img, sx, sy, w, h, 0, 0, w, h); fig.restore();
  };
  // основной слой, затем второй (куртка, шапка); у старых скинов левые руки и ноги — зеркало правых
  part(8, 8, 8, 8, 4, 0); part(20, 20, 8, 12, 4, 8);
  part(44, 20, 4, 12, 0, 8); part(4, 20, 4, 12, 4, 20);
  if (tall) { part(36, 52, 4, 12, 12, 8); part(20, 52, 4, 12, 8, 20); } else { part(44, 20, 4, 12, 12, 8, true); part(4, 20, 4, 12, 8, 20, true); }
  part(40, 8, 8, 8, 4, 0);
  if (tall) { part(20, 36, 8, 12, 4, 8); part(44, 36, 4, 12, 0, 8); part(52, 52, 4, 12, 12, 8); part(4, 36, 4, 12, 4, 20); part(4, 52, 4, 12, 8, 20); }
  const face = $('faceCv').getContext('2d');
  face.imageSmoothingEnabled = false;
  face.clearRect(0, 0, 8, 8);
  face.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
  face.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
}
function showSkin(dataUrl) {
  if (!dataUrl) { drawSkin(DEFAULT_SKIN); return; }
  const img = new Image();
  img.onload = () => drawSkin(img);
  img.src = dataUrl;
}
async function pickSkin() {
  try {
    const url = await call('skin:pick');
    if (url) showSkin(url);
  } catch (e) {
    $('setMsg').textContent = e.message;
    $('setMsg').classList.add('err');
    openTab('settings');
  }
}
$('skinBtn').addEventListener('click', pickSkin);
$('skinPick').addEventListener('click', pickSkin);
$('skinReset').addEventListener('click', async () => { await call('skin:reset'); showSkin(null); });
$('railFace').addEventListener('click', () => openTab('settings'));

// ---------- моды и сборки с Modrinth ----------
const kind = () => document.querySelector('input[name=kind]:checked').value;
const modInst = () => instances.find((i) => i.name === $('modInst').value);
const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс' : String(n));
let modTimer = 0;
let modSeq = 0;

function renderModInst() {
  const keep = $('modInst').value;
  const fabric = instances.filter((i) => i.loader === 'fabric');
  $('modInst').textContent = '';
  for (const i of fabric) { const o = document.createElement('option'); o.value = o.textContent = i.name; $('modInst').appendChild(o); }
  $('modInst').value = fabric.some((i) => i.name === keep) ? keep : (fabric.some((i) => i.name === selected) ? selected : (fabric[0] || {}).name || '');
}

function modRow(icon, title, sub, btnText, onClick, danger) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = '<img class="tile" alt=""><span class="info"><b></b><small></small></span><span class="acts2"><button></button></span>';
  const img = row.querySelector('img');
  if (icon) img.src = icon;
  else { const t = document.createElement('i'); t.className = 'tile'; paint(t, title); img.replaceWith(t); }
  row.querySelector('b').textContent = title;
  row.querySelector('small').textContent = sub;
  const b = row.querySelector('button');
  b.textContent = btnText;
  b.className = danger ? 'danger' : 'go';
  if (onClick) b.addEventListener('click', () => onClick(b)); else b.disabled = true;
  return row;
}

async function withBusyButton(b, text, fn) {
  const all = document.querySelectorAll('#modList button');
  all.forEach((x) => { x.disabled = true; });
  b.textContent = text;
  $('modMsg').classList.remove('err');
  try { await fn(); } catch (e) { $('modMsg').textContent = e.message; $('modMsg').classList.add('err'); }
  await loadInstances();
  searchMods();
}

async function searchMods() {
  const k = kind();
  const inst = modInst();
  const seq = ++modSeq;
  const box = $('modList');
  $('modInst').hidden = k === 'modpack';
  $('modSearch').hidden = k === 'installed';
  if (k !== 'modpack' && !inst) {
    box.innerHTML = '<p class="empty">Моды ставятся в сборку на Fabric. Создай её на главной: «+ Новая».</p>';
    return;
  }
  if (k === 'installed') {
    box.textContent = '';
    const mods = Object.entries(inst.mods || {});
    if (!mods.length) box.innerHTML = '<p class="empty">В этой сборке пока нет модов, поставленных через Voxa.</p>';
    for (const [id, m] of mods) {
      box.appendChild(modRow(null, m.title, m.file, 'Удалить', (b) => withBusyButton(b, 'Удаляю…', async () => {
        await call('mods:remove', inst.name, id);
        $('modMsg').textContent = `Удалён: ${m.title}`;
      }), true));
    }
    return;
  }
  box.innerHTML = '<p class="empty">Ищу…</p>';
  let hits;
  try {
    hits = await call('mods:search', { query: $('modSearch').value.trim(), kind: k, mc: inst && inst.mc });
  } catch (e) {
    if (seq !== modSeq) return;
    box.innerHTML = '<p class="empty"></p>';
    box.firstChild.textContent = 'Нет связи с Modrinth: ' + e.message;
    return;
  }
  if (seq !== modSeq) return; // пришёл ответ на старый запрос
  box.textContent = '';
  if (!hits.length) box.innerHTML = '<p class="empty">Ничего не нашлось</p>';
  for (const h of hits) {
    const sub = `${h.author} · ${fmtNum(h.downloads)} скачиваний · ${h.desc}`;
    if (k === 'modpack') {
      box.appendChild(modRow(h.icon, h.title, sub, 'Установить сборку', (b) => withBusyButton(b, 'Ставлю…', async () => {
        const created = await call('packs:install', h.id, h.title);
        selected = created.name;
        $('modMsg').textContent = `Сборка «${created.name}» готова. Жми «Играть».`;
      })));
    } else {
      const has = inst.mods && inst.mods[h.id];
      box.appendChild(modRow(h.icon, h.title, sub, has ? 'Установлен' : 'Установить', has ? null : (b) => withBusyButton(b, 'Ставлю…', async () => {
        await call('mods:install', inst.name, h.id, h.title);
        $('modMsg').textContent = `Установлен: ${h.title}`;
      })));
    }
  }
}
$('modSearch').addEventListener('input', () => { clearTimeout(modTimer); modTimer = setTimeout(searchMods, 350); });
$('modInst').addEventListener('change', searchMods);
document.querySelectorAll('input[name=kind]').forEach((r) => r.addEventListener('change', () => { $('modMsg').textContent = ''; searchMods(); }));

// ---------- новая сборка ----------
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
  } catch (err) {
    $('newMsg').textContent = err.message;
    $('newMsg').classList.add('err');
  } finally {
    $('newOk').disabled = false;
  }
});

// ---------- разделы и настройки ----------
function openTab(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === name));
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  if (name === 'mods') { $('modMsg').textContent = ''; searchMods(); }
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

function setNick(n) { nick = n; $('nick').textContent = n; }
$('setRam').addEventListener('input', () => { $('ramVal').textContent = $('setRam').value; });
$('saveSettings').addEventListener('click', async () => {
  try {
    const s = await call('settings:set', { nick: $('setNick').value, ramGb: $('setRam').value });
    setNick(s.nick);
    $('setMsg').textContent = 'Сохранено';
    $('setMsg').classList.remove('err');
  } catch (e) {
    $('setMsg').textContent = e.message;
    $('setMsg').classList.add('err');
  }
});

(async function init() {
  const s = await call('settings:get');
  setNick(s.nick);
  $('setNick').value = s.nick;
  $('setRam').value = s.ramGb;
  $('ramVal').textContent = s.ramGb;
  showSkin(await call('skin:get'));
  await loadInstances();
})();
