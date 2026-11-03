'use strict';
const $ = (id) => document.getElementById(id);
const PALETTE = [['#3f8f4a', '#1d3f22'], ['#8a4fd1', '#2d1a52'], ['#d1784f', '#52281a'], ['#4f9ad1', '#1a3552'], ['#c9a23a', '#4a3a10'], ['#d14f7e', '#521a33']];
const colorsOf = (name) => { let h = 2166136261; for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0), 16777619); return PALETTE[(h >>> 0) % PALETTE.length]; };

async function call(channel, ...args) {
  const r = await window.voxa.call(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

let instances = [];
let selected = null;
let busy = false;

// ---------- витрина ----------
function render() {
  const row = $('cards');
  row.textContent = '';
  for (const inst of instances) {
    const [c1, c2] = colorsOf(inst.name);
    const card = document.createElement('div');
    card.className = 'card' + (inst.name === selected ? ' on' : '');
    card.style.setProperty('--c1', c1);
    card.style.setProperty('--c2', c2);
    card.tabIndex = 0;
    card.innerHTML = '<span class="tag"></span><b></b><small></small>';
    card.querySelector('.tag').textContent = inst.loader === 'fabric' ? 'Fabric' : 'Без модов';
    card.querySelector('b').textContent = inst.name;
    card.querySelector('small').textContent = inst.mc + (inst.lastPlayed ? ' · ' + ago(inst.lastPlayed) : '');
    const pick = () => { selected = inst.name; render(); };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    row.appendChild(card);
  }
  const add = document.createElement('button');
  add.className = 'card add';
  add.innerHTML = '<span>+</span>Новая сборка';
  add.addEventListener('click', openNew);
  row.appendChild(add);

  const cur = instances.find((i) => i.name === selected);
  const [c1, c2] = cur ? colorsOf(cur.name) : ['#2f7d4a', '#1d3f22'];
  document.querySelector('.bg').style.setProperty('--c1', c1);
  document.querySelector('.bg').style.setProperty('--c2', c2);
  $('play').disabled = !cur || busy;
  $('cardActions').hidden = !cur;
  $('meta').innerHTML = cur ? `<div><b>${cur.mc}</b>версия</div><div><b>${cur.loader === 'fabric' ? 'Fabric' : 'Vanilla'}</b>загрузчик</div>` : '';
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return m <= 1 ? 'только что' : `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

async function loadInstances() {
  instances = await call('instances:list');
  if (!instances.some((i) => i.name === selected)) selected = instances[0] ? instances[0].name : null;
  render();
}

// ---------- запуск и полоса прогресса ----------
function showStatus(p) {
  const box = $('status');
  box.hidden = false;
  $('meta').hidden = true;
  box.classList.toggle('err', !!p.error);
  $('statusText').textContent = p.text + (typeof p.progress === 'number' && p.progress < 1 ? ` — ${Math.round(p.progress * 100)}%` : '');
  const bar = $('statusBar').parentElement;
  bar.classList.toggle('indet', typeof p.progress !== 'number');
  $('statusBar').style.width = typeof p.progress === 'number' ? `${Math.round(p.progress * 100)}%` : '';
  if (p.stage === 'closed') { busy = false; render(); setTimeout(() => { if (!busy) { box.hidden = true; $('meta').hidden = false; } }, 4000); }
}
window.voxa.onProgress(showStatus);

$('play').addEventListener('click', async () => {
  if (!selected || busy) return;
  busy = true;
  render();
  try {
    await call('game:launch', selected);
  } catch (e) {
    busy = false;
    render();
    showStatus({ text: e.message, error: true, progress: null, stage: 'error' });
  }
});

$('openDir').addEventListener('click', () => selected && call('instances:open', selected));
$('delInst').addEventListener('click', async () => {
  if (!selected || !confirm(`Удалить сборку «${selected}» вместе с мирами и модами?`)) return;
  await call('instances:delete', selected);
  selected = null;
  await loadInstances();
});

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
    $('newMsg').textContent = 'Нет связи с серверами Mojang: ' + e.message;
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
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === name));
  document.querySelectorAll('.rail [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
}
document.querySelectorAll('.rail [data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('accBtn').addEventListener('click', () => { showView('settings'); $('setNick').focus(); });
$('setRam').addEventListener('input', () => { $('ramVal').textContent = $('setRam').value; });
$('saveSettings').addEventListener('click', async () => {
  try {
    const s = await call('settings:set', { nick: $('setNick').value, ramGb: $('setRam').value });
    $('nick').textContent = s.nick;
    $('setMsg').textContent = 'Сохранено';
    $('setMsg').classList.remove('err');
  } catch (e) {
    $('setMsg').textContent = e.message;
    $('setMsg').classList.add('err');
  }
});

(async function init() {
  const s = await call('settings:get');
  $('nick').textContent = s.nick;
  $('setNick').value = s.nick;
  $('setRam').value = s.ramGb;
  $('ramVal').textContent = s.ramGb;
  await loadInstances();
})();
