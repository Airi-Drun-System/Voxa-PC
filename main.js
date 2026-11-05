'use strict';
const { app, BrowserWindow, ipcMain, shell, net, session, dialog, safeStorage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Client, Authenticator } = require('minecraft-launcher-core');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const { safeName, javaFeature, validNick, fabricId, insideDir, allowedUrl, skinSize, contentType, contentDir, isContentFile, baseFile, uniqueName } = require('./lib/util');
const msauth = require('./lib/msauth');

// Всё хранится в %APPDATA%\Voxa: общие файлы игры в shared, у каждой сборки своя папка с модами и мирами
const ROOT = path.join(app.getPath('appData'), 'Voxa');
const SHARED = path.join(ROOT, 'shared');
const INSTANCES = path.join(ROOT, 'instances');
const JAVA_DIR = path.join(ROOT, 'java');
const SETTINGS = path.join(ROOT, 'settings.json');
const SKIN = path.join(ROOT, 'skin.png');
const ACCOUNT = path.join(ROOT, 'account.bin');
const ACCOUNT_SKIN = path.join(ROOT, 'account-skin.png');
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

const getSettings = () => Object.assign({ nick: 'Player', ramGb: 4, minimize: true }, readJson(SETTINGS, {}));
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

// ---------- контент сборки: моды, ресурспаки, шейдеры ----------
async function download(url, dest, sha1) {
  if (!allowedUrl(url)) throw new Error(`Файл не с Modrinth: ${url}`);
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`Не скачалось (${r.status}): ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha1 && crypto.createHash('sha1').update(buf).digest('hex') !== sha1) throw new Error(`Файл повреждён: ${path.basename(dest || url)}`);
  if (dest) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, buf); }
  return buf;
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Modrinth ответил ${r.status}`);
  return r.json();
}
const q = (v) => encodeURIComponent(JSON.stringify(v));
const sha1Of = (f) => f.hashes && f.hashes.sha1;
const fileSha1 = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const primary = (v) => v.files.find((f) => f.primary) || v.files[0];
const LOADERS = { mod: ['fabric'], resourcepack: ['minecraft'], shader: ['iris'] };

async function searchModrinth({ query, kind, mc, offset, sort }) {
  const type = ['modpack', 'resourcepack', 'shader'].includes(kind) ? kind : 'mod';
  const facets = [[`project_type:${type}`]];
  if (type === 'mod' || type === 'modpack') facets.push(['categories:fabric']);
  if (type === 'shader') facets.push(['categories:iris']);
  if (type !== 'modpack' && mc) facets.push([`versions:${mc}`]);
  const index = ['relevance', 'downloads', 'newest', 'updated'].includes(sort) ? sort : query ? 'relevance' : 'downloads';
  const r = await getJson(`${MODRINTH}/search?limit=24&offset=${Number(offset) || 0}&index=${index}&query=${encodeURIComponent(query || '')}&facets=${q(facets)}`);
  return { total: r.total_hits, hits: r.hits.map((h) => ({ id: h.project_id, title: h.title, desc: h.description, icon: h.icon_url, downloads: h.downloads, author: h.author })) };
}

function readInstance(name) {
  const dir = instanceDir(name);
  const inst = readJson(path.join(dir, 'instance.json'), null);
  if (!inst) throw new Error('Сборка не найдена');
  inst.mods = inst.mods || {};
  return { inst, dir, save: () => writeJson(path.join(dir, 'instance.json'), inst) };
}
function needsFabric(inst, type) {
  if (type !== 'resourcepack' && inst.loader !== 'fabric') throw new Error('Моды и шейдеры ставятся только в сборки на Fabric');
}

// ставит мод, ресурспак или шейдер; для модов ещё и обязательные зависимости (например, Fabric API)
async function installContent(inst, dir, projectId, info, seen = new Set()) {
  if (seen.has(projectId)) return;
  seen.add(projectId);
  const type = info.type || 'mod';
  const versions = await getJson(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${q(LOADERS[type])}&game_versions=${q([inst.mc])}`);
  const v = versions[0];
  if (!v) throw new Error(`У «${info.title || projectId}» нет версии под ${inst.mc}`);
  const file = primary(v);
  const name = path.basename(file.filename);
  const old = inst.mods[projectId];
  await download(file.url, insideDir(dir, path.join(contentDir(type), name)), sha1Of(file));
  if (old && old.file !== name) fs.rmSync(insideDir(dir, path.join(contentDir(type), old.file)), { force: true });
  inst.mods[projectId] = { file: name, title: info.title || name.replace(/\.(jar|zip)$/, ''), type, icon: info.icon || (old && old.icon) || null, version: v.version_number };
  if (type !== 'mod') return;
  for (const d of v.dependencies || []) {
    if (d.dependency_type === 'required' && d.project_id && !inst.mods[d.project_id]) await installContent(inst, dir, d.project_id, { type: 'mod' }, seen);
  }
}

// список файлов в папке контента; моды, положенные руками, узнаём на Modrinth по хешу
async function listContent(name, type) {
  const { inst, dir, save } = readInstance(name);
  const folder = path.join(dir, contentDir(type));
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => isContentFile(f, type)) : [];
  const byFile = new Map(Object.entries(inst.mods).filter(([, m]) => (m.type || 'mod') === type).map(([id, m]) => [m.file, id]));
  const unknown = files.filter((f) => !byFile.has(baseFile(f)));
  if (unknown.length) {
    try {
      const hashes = Object.fromEntries(unknown.map((f) => [fileSha1(path.join(folder, f)), f]));
      const found = await postJson(`${MODRINTH}/version_files`, { hashes: Object.keys(hashes), algorithm: 'sha1' });
      const ids = [...new Set(Object.values(found).map((v) => v.project_id))];
      const projects = ids.length ? await getJson(`${MODRINTH}/projects?ids=${q(ids)}`) : [];
      for (const [hash, v] of Object.entries(found)) {
        const p = projects.find((x) => x.id === v.project_id);
        const f = baseFile(hashes[hash]);
        inst.mods[v.project_id] = { file: f, title: p ? p.title : f, type, icon: p ? p.icon_url : null, version: v.version_number };
        byFile.set(f, v.project_id);
      }
      if (ids.length) save();
    } catch { /* без сети просто покажем имена файлов */ }
  }
  return files.map((f) => {
    const id = byFile.get(baseFile(f));
    const m = id ? inst.mods[id] : null;
    return { file: f, enabled: !f.endsWith('.disabled'), id, title: m ? m.title : baseFile(f), icon: m ? m.icon : null, version: m ? m.version : '', size: fs.statSync(path.join(folder, f)).size };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function toggleContent(name, type, file) {
  const { dir } = readInstance(name);
  const from = insideDir(dir, path.join(contentDir(type), path.basename(file)));
  const to = file.endsWith('.disabled') ? from.slice(0, -'.disabled'.length) : from + '.disabled';
  fs.renameSync(from, to);
  return path.basename(to);
}
function removeContent(name, type, file) {
  const { inst, dir, save } = readInstance(name);
  fs.rmSync(insideDir(dir, path.join(contentDir(type), path.basename(file))), { force: true });
  for (const [id, m] of Object.entries(inst.mods)) if (m.file === baseFile(file)) delete inst.mods[id];
  save();
  return true;
}

// обновления модов одним запросом по хешам, как в Prism
async function checkUpdates(name) {
  const { inst, dir } = readInstance(name);
  const folder = path.join(dir, 'mods');
  if (!fs.existsSync(folder)) return [];
  const files = fs.readdirSync(folder).filter((f) => isContentFile(f, 'mod'));
  const hashes = Object.fromEntries(files.map((f) => [fileSha1(path.join(folder, f)), f]));
  if (!files.length) return [];
  const latest = await postJson(`${MODRINTH}/version_files/update`, { hashes: Object.keys(hashes), algorithm: 'sha1', loaders: ['fabric'], game_versions: [inst.mc] });
  return Object.entries(latest)
    .filter(([hash, v]) => sha1Of(primary(v)) !== hash)
    .map(([hash, v]) => ({ file: hashes[hash], projectId: v.project_id, version: v.version_number, url: primary(v).url, newFile: path.basename(primary(v).filename), sha1: sha1Of(primary(v)) }));
}
async function applyUpdates(name, report) {
  const list = await checkUpdates(name);
  const { inst, dir, save } = readInstance(name);
  let done = 0;
  for (const u of list) {
    const disabled = u.file.endsWith('.disabled');
    await download(u.url, insideDir(dir, path.join('mods', u.newFile + (disabled ? '.disabled' : ''))), u.sha1);
    if (u.file !== u.newFile + (disabled ? '.disabled' : '')) fs.rmSync(insideDir(dir, path.join('mods', u.file)), { force: true });
    const m = inst.mods[u.projectId];
    if (m) Object.assign(m, { file: u.newFile, version: u.version });
    report({ stage: 'pack', text: `Обновляю моды ${++done}/${list.length}` });
  }
  save();
  return list.length;
}

// ---------- сборки с Modrinth и из файла .mrpack ----------
async function installPackBuffer(buf, title, report) {
  const zip = new AdmZip(buf);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Это не сборка Modrinth (.mrpack)');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));
  const deps = index.dependencies || {};
  if (!deps.minecraft || !deps['fabric-loader']) throw new Error('Пока ставлю только сборки на Fabric');

  const inst = await createInstance({ name: uniqueName(title || index.name, (n) => fs.existsSync(instanceDir(n))), mc: deps.minecraft, loader: 'fabric' });
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
async function installPack(projectId, title, report) {
  const versions = await getJson(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version?loaders=${q(['fabric'])}`);
  if (!versions[0]) throw new Error('Пока ставлю только сборки на Fabric');
  const packFile = primary(versions[0]);
  report({ stage: 'pack', text: 'Скачиваю сборку' });
  return installPackBuffer(await download(packFile.url, null, sha1Of(packFile)), title, report);
}

// ---------- управление сборкой ----------
function listWorlds(name) {
  const saves = path.join(instanceDir(name), 'saves');
  if (!fs.existsSync(saves)) return [];
  return fs.readdirSync(saves, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(saves, d.name, 'level.dat')))
    .map((d) => {
      const icon = path.join(saves, d.name, 'icon.png');
      return { name: d.name, mtime: fs.statSync(path.join(saves, d.name, 'level.dat')).mtimeMs, icon: fs.existsSync(icon) ? 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64') : null };
    })
    .sort((a, b) => b.mtime - a.mtime);
}
function updateInstance(name, patch) {
  const { inst, dir, save } = readInstance(name);
  if (patch.ramGb !== undefined) inst.ramGb = patch.ramGb ? Math.min(32, Math.max(1, Math.round(Number(patch.ramGb)))) : null;
  save();
  if (patch.name !== undefined && safeName(patch.name) !== inst.name) {
    if (running) throw new Error('Закрой игру, потом переименуй');
    const clean = safeName(patch.name);
    if (fs.existsSync(instanceDir(clean))) throw new Error('Сборка с таким названием уже есть');
    fs.renameSync(dir, instanceDir(clean));
    inst.name = clean;
    writeJson(path.join(instanceDir(clean), 'instance.json'), inst);
  }
  return inst;
}
function copyInstance(name) {
  const { inst, dir } = readInstance(name);
  const clean = uniqueName(`${inst.name} копия`, (n) => fs.existsSync(instanceDir(n)));
  fs.cpSync(dir, instanceDir(clean), { recursive: true });
  const copy = { ...inst, name: clean, created: Date.now() };
  delete copy.lastPlayed;
  delete copy.playTime;
  writeJson(path.join(instanceDir(clean), 'instance.json'), copy);
  return copy;
}

// ---------- запуск ----------
let running = null;
// ---------- аккаунт Microsoft ----------
// Без входа игра идёт под офлайн-ником. С входом — под профилем Minecraft: сервера с проверкой аккаунта и свой скин.
// Токены лежат в account.bin, зашифрованные средствами Windows (safeStorage): на другом ПК или под другим
// пользователем Windows их не расшифровать. Пароль Voxa не видит: его вводят на странице Microsoft.
const LOGIN_PARTITION = 'persist:msauth';
let account; // undefined — файл ещё не читали, null — входа нет

function getAccount() {
  if (account === undefined) {
    account = null;
    try {
      if (fs.existsSync(ACCOUNT) && safeStorage.isEncryptionAvailable()) account = JSON.parse(safeStorage.decryptString(fs.readFileSync(ACCOUNT)));
    } catch { account = null; }
  }
  return account;
}
function saveAccount(a) {
  account = a;
  if (!a) { fs.rmSync(ACCOUNT, { force: true }); fs.rmSync(ACCOUNT_SKIN, { force: true }); return; }
  // без шифрования (бывает на Linux без связки ключей) вход живёт только до закрытия лаунчера
  if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(ACCOUNT, safeStorage.encryptString(JSON.stringify(a)));
}
// скин аккаунта для витрины качаем сами: окну лаунчера сторонние сайты закрыты
async function saveAccountSkin(a) {
  try {
    if (!a.skin) { fs.rmSync(ACCOUNT_SKIN, { force: true }); return; }
    const r = await fetch(a.skin.url);
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.ok && skinSize(buf)) fs.writeFileSync(ACCOUNT_SKIN, buf);
  } catch { /* без картинки скина вход всё равно работает */ }
}
// окну отдаём только ник и скин, токены остаются здесь
function accountInfo() {
  const a = getAccount();
  if (!a) return null;
  const skin = fs.existsSync(ACCOUNT_SKIN) ? 'data:image/png;base64,' + fs.readFileSync(ACCOUNT_SKIN).toString('base64') : null;
  return { name: a.name, uuid: a.uuid, skin };
}

// окно со страницей входа Microsoft; когда вход пройден, Microsoft перенаправляет его на REDIRECT с кодом
function microsoftLogin(parent) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      parent: parent || undefined, modal: !!parent, width: 500, height: 660,
      title: 'Вход в аккаунт Microsoft', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true, backgroundColor: '#ffffff',
      webPreferences: { partition: LOGIN_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    let done = false;
    const end = (err, code) => {
      if (done) return;
      done = true;
      if (!win.isDestroyed()) win.destroy();
      if (err) reject(err); else resolve(code);
    };
    const watch = (e, url) => {
      const r = msauth.parseRedirect((e && e.url) || url);
      if (!r) return;
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      if (r.code) end(null, r.code);
      else end(new Error(r.error === 'access_denied' ? 'Вход отменён' : `Microsoft: ${r.description || r.error}`));
    };
    win.webContents.on('will-redirect', watch);
    win.webContents.on('will-navigate', watch);
    win.webContents.on('did-navigate', watch);
    // «создать аккаунт», справка и прочие новые окна — в обычном браузере
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    win.on('closed', () => end(new Error('Вход отменён')));
    win.loadURL(msauth.authorizeUrl()).catch((e) => {
      // ERR_ABORTED — страница сама ушла на другой адрес или мы перехватили код, это не ошибка
      if (e.code !== 'ERR_ABORTED') end(new Error(`Не открылась страница входа Microsoft (${e.code || e.message})`));
    });
  });
}

// данные игрока для запуска: аккаунт Microsoft (с обновлением входа) или офлайн-ник
async function authorization(settings, report, log) {
  let a = getAccount();
  if (!a) return Authenticator.getAuth(settings.nick);
  if (!msauth.fresh(a)) {
    report({ stage: 'auth', text: 'Обновляю вход Microsoft', progress: null });
    try {
      a = Object.assign(await msauth.refresh(fetch, a), { clientId: a.clientId });
      saveAccount(a);
      saveAccountSkin(a);
    } catch (e) {
      if (e.relogin) { saveAccount(null); throw new Error(`${e.message}: Настройки → «Войти через Microsoft»`); }
      // нет связи с Microsoft: запускаем с прошлым входом, одиночная игра и LAN работают
      log(`[Voxa] Не получилось обновить вход Microsoft (${e.message}), запускаю с прошлым входом`);
    }
  }
  return msauth.toMclc(a);
}

async function launch(name, report, log) {
  if (running) throw new Error('Игра уже запущена');
  const { inst, dir, save } = readInstance(name);
  const settings = getSettings();
  if (!getAccount() && !validNick(settings.nick)) throw new Error('Ник: 3–16 латинских букв, цифр или _');
  running = { name, proc: null };
  try {
    report({ stage: 'prepare', text: 'Готовлю сборку', progress: null });
    const auth = await authorization(settings, report, log);
    const online = auth.meta && auth.meta.type === 'msa';
    // minecraft-launcher-core пишет в лог все аргументы запуска, токен оттуда вырезаем
    const say = (line) => log(online ? msauth.hideToken(line, auth.access_token) : line);
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

    // скин для мода CustomSkinLoader: без мода файл просто лежит и ничему не мешает.
    // С аккаунтом Microsoft в игре и так виден скин аккаунта, его видят и другие игроки
    if (!online && fs.existsSync(SKIN)) {
      const dest = path.join(dir, 'CustomSkinLoader', 'LocalSkin', 'skins', `${settings.nick}.png`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(SKIN, dest);
    }

    inst.lastPlayed = Date.now();
    save();

    // загрузчик файлов игры видит прокси только из переменных окружения
    // shortcut: SOCKS-прокси он не умеет, тогда нужен VPN в режиме TUN
    const proxy = /PROXY ([^;\s]+)/.exec(await session.defaultSession.resolveProxy('https://piston-data.mojang.com'));
    if (proxy) process.env.HTTPS_PROXY = process.env.HTTP_PROXY = `http://${proxy[1]}`;

    const client = new Client();
    let started = 0;
    client.on('progress', (e) => report({ stage: 'files', text: e.type === 'assets' ? 'Скачиваю ресурсы игры' : 'Скачиваю файлы игры', progress: e.total ? e.task / e.total : null }));
    client.on('debug', (m) => say(`[Voxa] ${m}`));
    client.on('data', (d) => {
      say(String(d));
      if (!started) { started = Date.now(); report({ stage: 'running', text: 'Игра запущена', progress: 1 }); }
    });
    client.on('close', (code) => {
      running = null;
      if (started) {
        // перечитываем: пока шла игра, сборку могли поменять в лаунчере
        const fresh = readJson(path.join(dir, 'instance.json'), null);
        if (fresh) { fresh.playTime = (fresh.playTime || 0) + (Date.now() - started); writeJson(path.join(dir, 'instance.json'), fresh); }
      }
      report({ stage: 'closed', text: code ? `Игра закрылась с ошибкой (код ${code}), смотри лог` : 'Игра закрыта', progress: null, error: !!code, code });
    });

    const proc = await client.launch({
      authorization: auth,
      root: SHARED,
      version: { number: inst.mc, type: 'release', custom },
      // вся память сразу и настройки сборщика мусора как у официального лаунчера: без них игра подвисает на очистке памяти
      memory: { max: `${inst.ramGb || settings.ramGb}G`, min: `${inst.ramGb || settings.ramGb}G` },
      customArgs: ['-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC', '-XX:G1NewSizePercent=20', '-XX:G1ReservePercent=20', '-XX:MaxGCPauseMillis=50', '-XX:G1HeapRegionSize=32M'],
      javaPath,
      overrides: { gameDirectory: dir }
    });
    if (!proc) throw new Error('Не удалось запустить игру, подробности в логе');
    if (running) running.proc = proc;
    return true;
  } catch (e) {
    running = null;
    throw e;
  }
}

// ---------- Horizon: Minecraft 26.3 на Rust, отдельный режим ----------
// Ставим официальный лаунчер Horizon с GitHub автора, дальше он сам ставит игру и обновляется.
const HORIZON_DIR = path.join(ROOT, 'horizon');
const HZ_RELEASES = 'https://api.github.com/repos/ludovic111/horizon/releases?per_page=50';
const HZ_ASSET = 'horizon-launcher-windows-x64.zip';
const HZ_PAGE = 'https://github.com/ludovic111/horizon';
function findExe(dir, name, depth = 3) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory() && depth > 0) { const f = findExe(p, name, depth - 1); if (f) return f; }
  }
  return null;
}
const horizonExe = () => findExe(path.join(HORIZON_DIR, 'app'), 'horizon-launcher.exe');
function horizonStatus() {
  return { supported: process.platform === 'win32', installed: !!horizonExe(), tag: readJson(path.join(HORIZON_DIR, 'meta.json'), {}).tag || null };
}
async function horizonLatest() {
  const rels = await getJson(HZ_RELEASES);
  const rel = rels.find((r) => !r.draft && /^launcher/.test(r.tag_name) && r.assets.some((a) => a.name === HZ_ASSET));
  if (!rel) throw new Error('У Horizon сейчас нет сборки лаунчера для Windows');
  return rel;
}
async function horizonInstall(report) {
  if (process.platform !== 'win32') throw new Error('Horizon в Voxa пока ставится только на Windows');
  report({ stage: 'pack', text: 'Ищу свежий лаунчер Horizon' });
  const rel = await horizonLatest();
  const zipA = rel.assets.find((a) => a.name === HZ_ASSET), sumsA = rel.assets.find((a) => a.name === 'SHA256SUMS');
  // скачиваем только из релизов автора на GitHub
  if (!/^https:\/\/github\.com\/ludovic111\/horizon\/releases\/download\//.test(zipA.browser_download_url)) throw new Error('Странная ссылка на файл Horizon');
  const res = await fetch(zipA.browser_download_url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Horizon не скачался (${res.status})`);
  const total = Number(res.headers.get('content-length')) || zipA.size || 0, chunks = [];
  let got = 0;
  for await (const c of res.body) { chunks.push(c); got += c.length; report({ stage: 'pack', text: `Скачиваю Horizon ${total ? Math.round(got / total * 100) : ''}%` }); }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  if (sumsA) {
    const sums = await (await fetch(sumsA.browser_download_url, { headers: HEADERS })).text();
    const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(HZ_ASSET));
    const want = line && line.trim().split(/\s+/)[0].toLowerCase();
    const have = crypto.createHash('sha256').update(buf).digest('hex');
    if (want && want !== have) throw new Error('Файл Horizon повреждён или подменён: контрольная сумма не совпала');
  }
  report({ stage: 'pack', text: 'Распаковываю Horizon' });
  const tmp = path.join(HORIZON_DIR, 'app-new');
  fs.rmSync(tmp, { recursive: true, force: true });
  const zip = new AdmZip(buf);
  for (const e of zip.getEntries()) { // проверяем пути, как и у сборок Modrinth
    if (e.isDirectory) continue;
    const dest = insideDir(tmp, e.entryName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
  if (!findExe(tmp, 'horizon-launcher.exe')) throw new Error('В архиве Horizon нет horizon-launcher.exe');
  fs.rmSync(path.join(HORIZON_DIR, 'app'), { recursive: true, force: true });
  fs.renameSync(tmp, path.join(HORIZON_DIR, 'app'));
  writeJson(path.join(HORIZON_DIR, 'meta.json'), { tag: rel.tag_name, installed: Date.now() });
  return horizonStatus();
}
function horizonLaunch() {
  const exe = horizonExe();
  if (!exe) throw new Error('Horizon ещё не установлен');
  spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
  return true;
}

// ---------- окно ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 700, minWidth: 900, minHeight: 560,
    backgroundColor: '#08161B',
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
    ramGb: Math.min(32, Math.max(1, Math.round(Number(patch.ramGb) || 4))),
    minimize: patch.minimize !== false
  });
  if (!validNick(s.nick)) throw new Error('Ник: 3–16 латинских букв, цифр или _');
  writeJson(SETTINGS, s);
  return s;
});
handle('versions:list', async () => (await manifest()).versions.filter((v) => v.type === 'release').map((v) => v.id));
handle('instances:list', () => listInstances());
handle('instances:create', (_e, data) => createInstance(data));
handle('instances:delete', (_e, name) => {
  if (running && running.name === safeName(name)) throw new Error('Сначала закрой игру');
  fs.rmSync(instanceDir(name), { recursive: true, force: true });
  return true;
});
handle('instances:open', (_e, name) => shell.openPath(instanceDir(name)));
handle('instances:copy', (_e, name) => copyInstance(name));
handle('instances:update', (_e, name, patch) => updateInstance(name, patch || {}));
handle('instances:openSub', (_e, name, sub) => {
  const p = insideDir(instanceDir(name), ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots', 'logs'].includes(sub) ? sub : 'mods');
  fs.mkdirSync(p, { recursive: true });
  return shell.openPath(p);
});
handle('instances:worlds', (_e, name) => listWorlds(name));
handle('content:list', (_e, name, type) => listContent(name, contentType(type)));
handle('content:toggle', (_e, name, type, file) => toggleContent(name, contentType(type), file));
handle('content:remove', (_e, name, type, file) => removeContent(name, contentType(type), file));
handle('content:install', async (_e, name, projectId, info) => {
  const { inst, dir, save } = readInstance(name);
  const type = contentType(info && info.type);
  needsFabric(inst, type);
  try { await installContent(inst, dir, projectId, { ...info, type }); } finally { save(); }
  return inst;
});
handle('mods:updates', (_e, name) => checkUpdates(name));
handle('mods:updateAll', (event, name) => applyUpdates(name, (p) => event.sender.send('progress', p)));
handle('mods:search', (_e, opts) => searchModrinth(opts || {}));
handle('packs:install', (event, projectId, title) => installPack(projectId, title, (p) => event.sender.send('progress', p)));
handle('packs:import', async (event) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Сборка Modrinth', filters: [{ name: 'Сборка Modrinth', extensions: ['mrpack'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return installPackBuffer(fs.readFileSync(r.filePaths[0]), path.basename(r.filePaths[0], '.mrpack'), (p) => event.sender.send('progress', p));
});
const skinUrl = () => (fs.existsSync(SKIN) ? 'data:image/png;base64,' + fs.readFileSync(SKIN).toString('base64') : null);
handle('skin:get', () => skinUrl());
handle('skin:pick', async (event) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Скин Minecraft', filters: [{ name: 'PNG', extensions: ['png'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const buf = fs.readFileSync(r.filePaths[0]);
  const size = skinSize(buf);
  if (!size) throw new Error('Это не PNG-файл');
  if (size.w !== 64 || (size.h !== 64 && size.h !== 32)) throw new Error(`Скин должен быть 64×64, а этот ${size.w}×${size.h}`);
  fs.writeFileSync(SKIN, buf);
  return skinUrl();
});
handle('skin:reset', () => { fs.rmSync(SKIN, { force: true }); return null; });
handle('account:get', () => accountInfo());
let loggingIn = false;
handle('account:login', async (event) => {
  if (loggingIn) throw new Error('Окно входа уже открыто');
  loggingIn = true;
  try {
    const code = await microsoftLogin(BrowserWindow.fromWebContents(event.sender));
    const a = Object.assign(await msauth.login(fetch, code), { clientId: crypto.randomUUID() });
    saveAccount(a);
    await saveAccountSkin(a);
    return accountInfo();
  } finally { loggingIn = false; }
});
handle('account:logout', async () => {
  saveAccount(null);
  // забываем и вход на странице Microsoft, иначе следующий вход молча пустит тот же аккаунт
  await session.fromPartition(LOGIN_PARTITION).clearStorageData();
  return null;
});
handle('horizon:status', () => horizonStatus());
handle('horizon:install', (event) => horizonInstall((p) => { if (!event.sender.isDestroyed()) event.sender.send('progress', p); }));
handle('horizon:launch', () => horizonLaunch());
handle('horizon:open', () => { fs.mkdirSync(HORIZON_DIR, { recursive: true }); return shell.openPath(HORIZON_DIR); });
handle('horizon:page', () => shell.openExternal(HZ_PAGE));
handle('game:launch', (event, name) => {
  const send = (ch, v) => { if (!event.sender.isDestroyed()) event.sender.send(ch, v); };
  const win = BrowserWindow.fromWebContents(event.sender);
  return launch(name, (p) => {
    send('progress', p);
    // лаунчер прячется, пока идёт игра, чтобы не отнимать у неё видеокарту
    if (!win || win.isDestroyed() || !getSettings().minimize) return;
    if (p.stage === 'running') win.minimize();
    if (p.stage === 'closed' && win.isMinimized()) win.restore();
  }, (line) => send('log', line));
});
handle('game:stop', () => { if (running && running.proc) running.proc.kill(); return !!running; });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
