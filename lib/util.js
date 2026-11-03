'use strict';
const path = require('path');
// Чистые помощники без Electron и сети: их проверяет test/util.test.js

/** Имя сборки становится именем папки: убираем всё, что Windows не разрешает в путях */
function safeName(name) {
  const s = String(name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s.replace(/^\.+/, '') || 'Сборка';
}

/** Mojang просит Java 16 только у 1.17; у Adoptium нет JRE 16, 17 с ней совместима */
function javaFeature(major) {
  const m = Number(major) || 8;
  return m === 16 ? 17 : m;
}

/** Ник офлайн-профиля по правилам Minecraft: 3–16 символов, латиница, цифры, _ */
function validNick(nick) {
  return /^[A-Za-z0-9_]{3,16}$/.test(String(nick || ''));
}

/** Id версии Fabric в папке versions, такой же, как у официального установщика */
function fabricId(mc, loader) {
  return `fabric-loader-${loader}-${mc}`;
}

/** Путь файла из сборки .mrpack внутри папки сборки; «../» и абсолютные пути не пускаем */
function insideDir(dir, rel) {
  const p = path.resolve(dir, String(rel));
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Опасный путь в сборке: ${rel}`);
  return p;
}

/** Скачиваем только с хостов, которые Modrinth разрешает в .mrpack */
const HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
function allowedUrl(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && HOSTS.includes(u.hostname); } catch { return false; }
}

/** Ширина и высота PNG из заголовка IHDR; null, если это не PNG */
function skinSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Тип контента из окна: всё незнакомое считаем модом */
const contentType = (t) => (t === 'resourcepack' || t === 'shader' ? t : 'mod');
const contentDir = (t) => ({ mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' })[contentType(t)];
/** Имя без «.disabled»: так Prism и Voxa выключают моды, не удаляя их */
const baseFile = (f) => String(f).replace(/\.disabled$/, '');
const isContentFile = (f, t) => (contentType(t) === 'mod' ? /\.jar$/i : /\.zip$/i).test(baseFile(f));

/** «Имя», «Имя 2», «Имя 3»… — первое свободное */
function uniqueName(name, exists) {
  const base = safeName(name);
  if (!exists(base)) return base;
  for (let i = 2; ; i++) {
    const n = safeName(`${base.slice(0, 36)} ${i}`);
    if (!exists(n)) return n;
  }
}

module.exports = { safeName, javaFeature, validNick, fabricId, insideDir, allowedUrl, skinSize, contentType, contentDir, baseFile, isContentFile, uniqueName };
