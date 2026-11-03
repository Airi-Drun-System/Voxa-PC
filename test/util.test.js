'use strict';
const assert = require('assert');
const path = require('path');
const { safeName, javaFeature, validNick, fabricId, insideDir, allowedUrl, skinSize, contentType, contentDir, baseFile, isContentFile, uniqueName } = require('../lib/util');

assert.strictEqual(safeName('Выживание 1.21'), 'Выживание 1.21');
assert.strictEqual(safeName('a/b\\c:d*?"<>|'), 'abcd');
assert.strictEqual(safeName('...'), 'Сборка');
assert.strictEqual(safeName('  '), 'Сборка');
assert.strictEqual(safeName('x'.repeat(60)).length, 40);

assert.strictEqual(javaFeature(16), 17);
assert.strictEqual(javaFeature(21), 21);
assert.strictEqual(javaFeature(undefined), 8);

assert.ok(validNick('Vegas_01'));
assert.ok(!validNick('ab'));
assert.ok(!validNick('Вегас'));

assert.strictEqual(fabricId('1.21.1', '0.16.9'), 'fabric-loader-0.16.9-1.21.1');
const base = path.resolve('inst');
assert.strictEqual(insideDir(base, 'mods/a.jar'), path.join(base, 'mods', 'a.jar'));
assert.throws(() => insideDir(base, '../evil.exe'));
assert.throws(() => insideDir(base, '/etc/x'));
assert.throws(() => insideDir(base, 'mods/../../x'));
assert.throws(() => insideDir(base, '.'));
assert.ok(allowedUrl('https://cdn.modrinth.com/data/x.jar'));
assert.ok(!allowedUrl('http://cdn.modrinth.com/data/x.jar'));
assert.ok(!allowedUrl('https://evil.com/x.jar'));
assert.ok(!allowedUrl('https://cdn.modrinth.com.evil.com/x.jar'));
const png = Buffer.alloc(24); png.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(64, 16); png.writeUInt32BE(32, 20);
assert.deepStrictEqual(skinSize(png), { w: 64, h: 32 });
assert.strictEqual(skinSize(Buffer.from('not a png at all, really')), null);
assert.strictEqual(contentType('shader'), 'shader');
assert.strictEqual(contentType('../x'), 'mod');
assert.strictEqual(contentDir('shader'), 'shaderpacks');
assert.strictEqual(baseFile('sodium.jar.disabled'), 'sodium.jar');
assert.ok(isContentFile('sodium.jar.disabled', 'mod'));
assert.ok(!isContentFile('config.txt', 'mod'));
assert.ok(isContentFile('Faithful.zip', 'resourcepack'));
const taken = new Set(['Мир', 'Мир 2']);
assert.strictEqual(uniqueName('Мир', (n) => taken.has(n)), 'Мир 3');
assert.strictEqual(uniqueName('Новый', (n) => taken.has(n)), 'Новый');
console.log('util: ok');
