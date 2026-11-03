'use strict';
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

module.exports = { safeName, javaFeature, validNick, fabricId };
