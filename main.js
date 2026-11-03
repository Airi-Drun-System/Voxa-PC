'use strict';
const { app, BrowserWindow, ipcMain, shell, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const { safeName, javaFeature, validNick, fabricId, insideDir, allowedUrl } = require('./lib/util');

// Всё хранится в %APPDATA%\Voxa: общие файлы игры в shared, у каждой сборки своя папка с модами и мирами
const ROOT = path.join(app.getPath('appData'), 'Voxa');
const SHARED = path.join(ROOT, 'shared');
const INSTANCES = path.join(ROOT, 'instances');
const JAVA_DIR = path.join(ROOT, 'java');
const SETTINGS = path.join(ROOT, 'settings.json');
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
for (const d of [SHARED, INSTANCES, JAVA_DIR]) fs.mkdirSync(d, { recursive: true });

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
// Сеть Chromium вместо fetch из Node: учитывает прокси и VPN Windows и системные сертификаты
async function fetch(url, opts) {
  try { return await net.fetch(url, opts); }
  catch (e) { throw new Error(`Нет связи с ${new URL(url).hostname} (${(e.cause && e.cause.code) || e.message})`); }
}
// Modrinth просит у программ понятный User-Agent
const HEADERS = { 'User-Agent': 'Airi-Drun-System/Voxa-PC/0.1.0' };
const MODRINTH = 'https://api.modrinth.com/v2';
async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`Сервер ответил ${r.status}: ${url}`);
  return r.json();
}

const getSettings = () => Object.assign({ nick: 'Player', ramGb: 4 }, readJson(SETTINGS, {}));
const instanceDir = (name) => path.join(INSTANCES, safeName(name));

let manifestCache = null;
async function manifest() {
  if (!manifestCache) manifestCache = await getJson(MANIFEST);
  return manifestCache;
}

// ---------- Java: свой JRE от Adoptium под каждую версию, чтобы игроку ничего не ставить ----------
function findJavaw(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry, 'bin', 'javaw.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
async function ensureJava(major, report) {
  // shortcut: автоскачивание только для Windows x64; на других системах берём java из PATH, пока нет сборок под них
  if (process.platform !== 'win32') return 'java';
  const feature = javaFeature(major);
  const dir = path.join(JAVA_DIR, String(feature));
  const existing = findJavaw(dir);
  if (existing) return existing;

  const url = `https://api.adoptium.net/v3/binary/latest/${feature}/ga/windows/x64/jre/hotspot/normal/eclipse`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать Java ${feature} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    report({ stage: 'java', text: `Скачиваю Java ${feature}`, progress: total ? got / total : null });
  }
  report({ stage: 'java', text: `Распаковываю Java ${feature}`, progress: null });
  new AdmZip(Buffer.concat(chunks)).extractAllTo(dir, true);
  const javaw = findJavaw(dir);
  if (!javaw) throw new Error(`В архиве Java ${feature} нет javaw.exe`);
  return javaw;
}

// ---------- сборки ----------
function listInstances() {
  return fs.readdirSync(INSTANCES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readJson(path.join(INSTANCES, d.name, 'instance.json'), null))
    .filter(Boolean)
    .sort((a, b) => (b.lastPlayed || b.created || 0) - (a.lastPlayed || a.created || 0));
}

async function createInstance({ name, mc, loader }) {
  const clean = safeName(name);
  const dir = instanceDir(clean);
  if (fs.existsSync(dir)) throw new Error('Сборка с таким названием уже есть');
  const inst = { name: clean, mc, loader: loader === 'fabric' ? 'fabric' : 'vanilla', created: Date.now() };
  if (inst.loader === 'fabric') {
    const loaders = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}`);
    const stable = loaders.find((l) => l.loader.stable) || loaders[0];
    if (!stable) throw new Error(`Fabric пока не поддерживает ${mc}`);
    inst.loaderVersion = stable.loader.version;
  }
  writeJson(path.join(dir, 'instance.json'), inst);
  return inst;
}

// ---------- моды и сборки с Modrinth ----------
async function download(url, dest, sha1) {
  if (!allowedUrl(url)) throw new Error(`Файл не с Modrinth: ${url}`);
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`Не скачалось (${r.status}): ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== sha1) throw new Error(`Файл повреждён: ${path.basename(dest)}`);
  if (dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
  return buf;
}
const q = (v) => encodeURIComponent(JSON.stringify(v));
const sha1Of = (f) => f.hashes && f.hashes.sha1;

async function searchModrinth({ query, kind, mc }) {
  const facets = [[`project_type:${kind === 'modpack' ? 'modpack' : 'mod'}`], ['categories:fabric']];
  if (kind !== 'modpack' && mc) facets.push([`versions:${mc}`]);
  const r = await getJson(`${MODRINTH}/search?limit=30&index=${query ? 'relevance' : 'downloads'}&query=${encodeURIComponent(query || '')}&facets=${q(facets)}`);
  return r.hits.map((h) => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, downloads: h.downloads, author: h.author }));
}

// ставит мод и все обязательные для него моды (например, Fabric API)
async function installMod(inst, dir, projectId, title, seen = new Set()) {
  if (seen.has(projectId)) return;
  seen.add(projectId);
  const versions = await getJson(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${q(['fabric'])}&game_versions=${q([inst.mc])}`);
  const v = versions[0];
  if (!v) throw new Error(`У мода ${title || projectId} нет версии под ${inst.mc} Fabric`);
  const file = v.files.find((f) => f.primary) || v.files[0];
  const name = path.basename(file.filename);
  inst.mods = inst.mods || {};
  const old = inst.mods[projectId];
  await download(file.url, insideDir(dir, path.join('mods', name)), sha1Of(file));
  if (old && old.file !== name) fs.rmSync(path.join(dir, 'mods', old.file), { force: true });
  inst.mods[projectId] = { file: name, title: title || name.replace(/\.jar$/, '') };
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id && !inst.mods[d.project_id]) await installMod(inst, dir, d.project_id, null, seen);
  }
}

function fabricInstance(name) {
  const dir = instanceDir(name);
  const inst = readJson(path.join(dir, 'instance.json'), null);
  if (!inst) throw new Error('Сборка не найдена');
  if (inst.loader !== 'fabric') throw new Error('Моды ставятся только в сборки на Fabric');
  return { inst, dir };
}

async function installPack(projectId, title, report) {
  const versions = await getJson(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${q(['fabric'])}`);
  const v = versions[0];
  if (!v) throw new Error('Пока ставлю только сборки на Fabric');
  const packFile = v.files.find((f) => f.primary) || v.files[0];
  report({ stage: 'pack', text: 'Скачиваю сборку' });
  const zip = new AdmZip(await download(packFile.url, null, sha1Of(packFile)));
  const index = JSON.parse(zip.readAsText('modrinth.index.json'));
  const deps = index.dependencies || {};
  if (!deps.minecraft || !deps['fabric-loader']) throw new Error('Пока ставлю только сборки на Fabric');

  const inst = await createInstance({ name: title, mc: deps.minecraft, loader: 'fabric' });
  const dir = instanceDir(inst.name);
  try {
    inst.loaderVersion = deps['fabric-loader'];
    const files = (index.files || []).filter((f) => !(f.env && f.env.client === 'unsupported'));
    let done = 0;
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async (f) => {
        await download((f.downloads || []).find(allowedUrl) || f.downloads[0], insideDir(dir, f.path), sha1Of(f));
        report({ stage: 'pack', text: `Скачиваю моды ${++done}/${files.length}` });
      }));
    }
    for (const e of zip.getEntries()) {
      const m = /^(client-)?overrides\/(.+)$/.exec(e.entryName);
      if (!m || e.isDirectory) continue;
      const dest = insideDir(dir, m[2]);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
    }
    writeJson(path.join(dir, 'instance.json'), inst);
    return inst;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true }); // недокачанная сборка не нужна
    throw err;
  }
}

let running = null;
async function launch(name, report) {
  if (running) throw new Error('Игра уже запускается');
  const dir = instanceDir(name);
  const inst = readJson(path.join(dir, 'instance.json'), null);
  if (!inst) throw new Error('Сборка не найдена');
  const settings = getSettings();
  if (!validNick(settings.nick)) throw new Error('Ник: 3–16 латинских букв, цифр или _');

  report({ stage: 'prepare', text: 'Готовлю сборку', progress: null });
  const entry = (await manifest()).versions.find((v) => v.id === inst.mc);
  if (!entry) throw new Error(`Версия ${inst.mc} не найдена у Mojang`);
  const versionJson = await getJson(entry.url);
  const javaPath = await ensureJava(versionJson.javaVersion && versionJson.javaVersion.majorVersion, report);

  let custom;
  if (inst.loader === 'fabric') {
    custom = fabricId(inst.mc, inst.loaderVersion);
    const profilePath = path.join(SHARED, 'versions', custom, `${custom}.json`);
    if (!fs.existsSync(profilePath)) {
      report({ stage: 'loader', text: 'Ставлю Fabric', progress: null });
      writeJson(profilePath, await getJson(`https://meta.fabricmc.net/v2/versions/loader/${inst.mc}/${inst.loaderVersion}/profile/json`));
    }
  }

  inst.lastPlayed = Date.now();
  writeJson(path.join(dir, 'instance.json'), inst);

  // загрузчик файлов игры видит прокси только из переменных окружения
  // shortcut: SOCKS-прокси он не умеет, тогда нужен VPN в режиме TUN
  const proxy = /PROXY ([^;\s]+)/.exec(await session.defaultSession.resolveProxy('https://piston-data.mojang.com'));
  if (proxy) process.env.HTTPS_PROXY = process.env.HTTP_PROXY = `http://${proxy[1]}`;

  const client = new Client();
  running = client;
  let started = false;
  client.on('progress', (e) => report({ stage: 'files', text: e.type === 'assets' ? 'Скачиваю ресурсы игры' : 'Скачиваю файлы игры', progress: e.total ? e.task / e.total : null }));
  client.on('data', () => {
    if (!started) { started = true; report({ stage: 'running', text: 'Игра запущена', progress: 1 }); }
  });
  client.on('close', (code) => {
    running = null;
    report({ stage: 'closed', text: code ? `Игра закрылась с ошибкой (код ${code})` : 'Игра закрыта', progress: null, error: !!code });
  });

  const opts = {
    authorization: Authenticator.getAuth(settings.nick),
    root: SHARED,
    version: { number: inst.mc, type: 'release', custom },
    memory: { max: `${settings.ramGb}G`, min: '1G' },
    javaPath,
    overrides: { gameDirectory: dir }
  };
  const proc = await client.launch(opts);
  if (!proc) { running = null; throw new Error('Не удалось запустить игру, подробности в логе'); }
  return true;
}

// ---------- окно ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 700, minWidth: 900, minHeight: 560,
    backgroundColor: '#0f1218',
    title: 'Voxa',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
  try { return { ok: true, data: await fn(event, ...args) }; }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});

handle('settings:get', () => getSettings());
handle('settings:set', (_e, patch) => {
  const s = Object.assign(getSettings(), {
    nick: String(patch.nick || '').trim(),
    ramGb: Math.min(32, Math.max(1, Math.round(Number(patch.ramGb) || 4)))
  });
  if (!validNick(s.nick)) throw new Error('Ник: 3–16 латинских букв, цифр или _');
  writeJson(SETTINGS, s);
  return s;
});
handle('versions:list', async () => (await manifest()).versions.filter((v) => v.type === 'release').map((v) => v.id));
handle('instances:list', () => listInstances());
handle('instances:create', (_e, data) => createInstance(data));
handle('instances:delete', (_e, name) => { fs.rmSync(instanceDir(name), { recursive: true, force: true }); return true; });
handle('instances:open', (_e, name) => shell.openPath(instanceDir(name)));
handle('mods:search', (_e, opts) => searchModrinth(opts || {}));
handle('mods:install', async (_e, name, projectId, title) => {
  const { inst, dir } = fabricInstance(name);
  try { await installMod(inst, dir, projectId, title); } finally { writeJson(path.join(dir, 'instance.json'), inst); }
  return inst;
});
handle('mods:remove', (_e, name, projectId) => {
  const { inst, dir } = fabricInstance(name);
  const m = inst.mods && inst.mods[projectId];
  if (m) { fs.rmSync(insideDir(dir, path.join('mods', m.file)), { force: true }); delete inst.mods[projectId]; }
  writeJson(path.join(dir, 'instance.json'), inst);
  return inst;
});
handle('packs:install', (event, projectId, title) => installPack(projectId, title, (p) => event.sender.send('progress', p)));
handle('game:launch', (event, name) => launch(name, (p) => event.sender.send('progress', p)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
