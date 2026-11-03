'use strict';
const $ = (id) => document.getElementById(id);
const PALETTE = [['#3f8f4a', '#1d3f22'], ['#8a4fd1', '#2d1a52'], ['#d1784f', '#52281a'], ['#4f9ad1', '#1a3552'], ['#c9a23a', '#4a3a10'], ['#d14f7e', '#521a33']];
const colorsOf = (name) => { let h = 2166136261; for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return PALETTE[(h >>> 0) % PALETTE.length]; };
const paint = (el, name) => { const [c1, c2] = colorsOf(name); el.style.setProperty('--c1', c1); el.style.setProperty('--c2', c2); };
const loaderName = (i) => (i.loader === 'fabric' ? 'Fabric' : 'Без модов');

async function call(channel, ...args) {
  const r = await window.voxa.call(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

let instances = [];
let selected = null;
let busy = false;

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return m <= 1 ? 'только что' : `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

function tileRow(inst, tag) {
  const el = document.createElement(tag);
  el.innerHTML = '<i class="tile"></i><span class="info"><b></b><small></small></span>';
  paint(el.querySelector('.tile'), inst.name);
  el.querySelector('b').textContent = inst.name;
  el.querySelector('small').textContent = `${inst.mc} · ${loaderName(inst)}` + (inst.lastPlayed ? ' · ' + ago(inst.lastPlayed) : '');
  return el;
}

// ---------- выбор сборки внизу ----------
function renderPicker() {
  const cur = instances.find((i) => i.name === selected);
  $('pickName').textContent = cur ? cur.name : 'Нет сборок';
  $('pickVer').textContent = cur ? `${cur.mc} · ${loaderName(cur)}` : 'создай первую';
  paint($('pickTile'), cur ? cur.name : '');
  $('playBtn').disabled = !cur || busy;

  const list = $('pickList');
  list.textContent = '';
  for (const inst of instances) {
    const b = tileRow(inst, 'button');
    b.setAttribute('role', 'option');
    b.classList.toggle('on', inst.name === selected);
    b.addEventListener('click', () => { selected = inst.name; list.hidden = true; render(); });
    list.appendChild(b);
  }
  const add = document.createElement('button');
  add.innerHTML = '<i class="tile" style="--c1:#3a3f47;--c2:#2a2e35"></i><span class="info"><b>+ Новая сборка</b></span>';
  add.addEventListener('click', () => { list.hidden = true; openNew(); });
  list.appendChild(add);
}
$('pickBtn').addEventListener('click', (e) => { e.stopPropagation(); $('pickList').hidden = !$('pickList').hidden; });
document.addEventListener('click', (e) => { if (!$('pickList').contains(e.target)) $('pickList').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('pickList').hidden = true; });

// ---------- вкладка «Сборки» ----------
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const box = $('list');
  box.textContent = '';
  const shown = instances.filter((i) => i.name.toLowerCase().includes(q) || i.mc.includes(q));
  if (!shown.length) {
    box.innerHTML = `<p class="empty">${instances.length ? 'Ничего не нашлось' : 'Пока ни одной сборки. Нажми «+ Новая сборка».'}</p>`;
    return;
  }
  for (const inst of shown) {
    const row = tileRow(inst, 'div');
    row.className = 'row';
    const acts = document.createElement('span');
    acts.className = 'acts';
    acts.innerHTML = '<button class="go">Играть</button><button>Папка</button><button class="danger">Удалить</button>';
    const [go, dir, del] = acts.children;
    go.disabled = busy;
    go.addEventListener('click', () => { selected = inst.name; showTab('play'); launch(); });
    dir.addEventListener('click', () => call('instances:open', inst.name));
    del.addEventListener('click', async () => {
      if (!confirm(`Удалить сборку «${inst.name}» вместе с мирами и модами?`)) return;
      await call('instances:delete', inst.name);
      await loadInstances();
    });
    row.appendChild(acts);
    box.appendChild(row);
  }
}
$('search').addEventListener('input', renderList);
$('newBtn').addEventListener('click', openNew);

function render() { renderPicker(); renderList(); renderModInst(); }

async function loadInstances() {
  instances = await call('instances:list');
  if (!instances.some((i) => i.name === selected)) selected = instances[0] ? instances[0].name : null;
  render();
}

// ---------- запуск: прогресс прямо в кнопке ----------
function showProgress(p) {
  if (p.stage === 'pack') { $('modMsg').textContent = p.text; return; }
  const btn = $('playBtn');
  const pct = typeof p.progress === 'number' ? p.progress : null;
  btn.classList.toggle('err', !!p.error);
  btn.classList.toggle('indet', pct === null && busy);
  $('playFill').style.width = pct === null ? '' : `${Math.round(pct * 100)}%`;
  $('playSub').textContent = p.text + (pct !== null && pct < 1 ? ` — ${Math.round(pct * 100)}%` : '');
  if (p.stage === 'running') { $('playText').textContent = 'ИГРА ИДЁТ'; btn.classList.remove('indet'); }
  if (p.stage === 'closed' || p.stage === 'error') {
    busy = false;
    btn.classList.remove('busy', 'indet');
    $('playText').textContent = 'ИГРАТЬ';
    $('playFill').style.width = '0';
    render();
    setTimeout(() => { if (!busy) { $('playSub').textContent = ''; btn.classList.remove('err'); } }, 5000);
  }
}
window.voxa.onProgress(showProgress);

async function launch() {
  if (!selected || busy) return;
  busy = true;
  $('playBtn').classList.add('busy');
  $('playText').textContent = 'ЗАПУСК';
  render();
  try {
    await call('game:launch', selected);
  } catch (e) {
    showProgress({ text: e.message, error: true, progress: null, stage: 'error' });
  }
}
$('playBtn').addEventListener('click', launch);

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
  row.innerHTML = '<img class="tile" alt=""><span class="info"><b></b><small></small></span><span class="acts"><button></button></span>';
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
    box.innerHTML = '<p class="empty">Моды ставятся в сборку на Fabric. Создай её во вкладке «Сборки».</p>';
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
        $('modMsg').textContent = `Сборка «${created.name}» готова. Жми ИГРАТЬ.`;
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

// ---------- вкладки и настройки ----------
function showTab(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === name));
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  // пункт игры в боковой панели подсвечен на всех её вкладках
  document.querySelector('.game').classList.toggle('on', name !== 'settings');
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  showTab(b.dataset.tab);
  if (b.dataset.tab === 'mods' && !$('modList').childElementCount) searchMods();
}));
$('accBtn').addEventListener('click', () => { showTab('settings'); $('setNick').focus(); });

const setNick = (n) => { $('nick').textContent = n; $('nick2').textContent = n; };
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
  await loadInstances();
})();
