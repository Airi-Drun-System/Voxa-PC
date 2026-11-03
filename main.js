'use strict';
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
const AdmZip = require('adm-zip');
const { safeName, javaFeature, validNick, fabricId } = require('./lib/util');

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
async function getJson(url) {
  const r = await fetch(url);
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
handle('game:launch', (event, name) => launch(name, (p) => event.sender.send('progress', p)));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
