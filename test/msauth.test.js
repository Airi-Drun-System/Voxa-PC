'use strict';
const assert = require('assert');
const ms = require('../lib/msauth');

// поддельные серверы Microsoft, Xbox и Minecraft: отвечают как настоящие, запросы записываются
const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const MC_TOKEN = jwt({ xuid: '2535400000000001', sub: 'x' });
function fakeNet(over = {}) {
  const calls = [];
  const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const routes = {
    'https://login.live.com/oauth20_token.srf': (o) => {
      const f = new URLSearchParams(o.body);
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'dead') return reply(400, { error: 'invalid_grant' });
      return reply(200, { access_token: 'EwMS', refresh_token: f.get('grant_type') === 'refresh_token' && f.get('refresh_token') === 'keep' ? undefined : 'M.R3_new', expires_in: 3600 });
    },
    'https://user.auth.xboxlive.com/user/authenticate': () => reply(200, { Token: 'XBL', DisplayClaims: { xui: [{ uhs: '123' }] } }),
    'https://xsts.auth.xboxlive.com/xsts/authorize': () => reply(200, { Token: 'XSTS', DisplayClaims: { xui: [{ uhs: '123' }] } }),
    'https://api.minecraftservices.com/authentication/login_with_xbox': () => reply(200, { access_token: MC_TOKEN, expires_in: 86400 }),
    'https://api.minecraftservices.com/minecraft/profile': () => reply(200, { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch', skins: [{ state: 'INACTIVE', url: 'http://textures.minecraft.net/texture/old' }, { state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/abc', variant: 'SLIM' }] }),
    ...over
  };
  const fetch = async (url, o) => {
    calls.push({ url, ...o, json: o.headers['Content-Type'] === 'application/json' ? JSON.parse(o.body) : null });
    return (routes[url] || (() => reply(404)))(o, calls.filter((c) => c.url === url).length);
  };
  return { fetch, calls };
}

(async () => {
  // страница входа и разбор адреса, на который вернулся Microsoft
  const u = new URL(ms.authorizeUrl());
  assert.strictEqual(u.origin + u.pathname, 'https://login.live.com/oauth20_authorize.srf');
  assert.strictEqual(u.searchParams.get('client_id'), '00000000402b5328');
  assert.strictEqual(u.searchParams.get('redirect_uri'), ms.REDIRECT);
  assert.strictEqual(u.searchParams.get('scope'), 'service::user.auth.xboxlive.com::MBI_SSL');
  assert.deepStrictEqual(ms.parseRedirect('https://login.live.com/oauth20_desktop.srf?code=M.C5_BAY.2.U.x&lc=1049'), { code: 'M.C5_BAY.2.U.x' });
  assert.deepStrictEqual(ms.parseRedirect('https://login.live.com/oauth20_desktop.srf?error=access_denied&error_description=The+user+has+denied'), { error: 'access_denied', description: 'The user has denied' });
  assert.strictEqual(ms.parseRedirect('https://login.live.com/ppsecure/post.srf?code=x'), null);
  assert.strictEqual(ms.parseRedirect('https://login.live.com.evil.com/oauth20_desktop.srf?code=x'), null);
  assert.strictEqual(ms.parseRedirect('http://login.live.com/oauth20_desktop.srf?code=x'), null);
  assert.strictEqual(ms.parseRedirect('https://login.live.com/oauth20_desktop.srf'), null);
  assert.strictEqual(ms.parseRedirect('не адрес'), null);

  // первый вход: вся цепочка и что именно уходит на серверы
  const now = 1_700_000_000_000;
  let net = fakeNet();
  const a = await ms.login(net.fetch, 'M.C5_code', now);
  assert.deepStrictEqual(net.calls.map((c) => new URL(c.url).hostname), ['login.live.com', 'user.auth.xboxlive.com', 'xsts.auth.xboxlive.com', 'api.minecraftservices.com', 'api.minecraftservices.com']);
  const form = new URLSearchParams(net.calls[0].body);
  assert.strictEqual(form.get('grant_type'), 'authorization_code');
  assert.strictEqual(form.get('code'), 'M.C5_code');
  assert.strictEqual(form.get('client_id'), '00000000402b5328');
  assert.strictEqual(form.get('redirect_uri'), ms.REDIRECT);
  assert.strictEqual(net.calls[1].json.Properties.RpsTicket, 'EwMS');
  assert.strictEqual(net.calls[1].json.RelyingParty, 'http://auth.xboxlive.com');
  assert.deepStrictEqual(net.calls[2].json.Properties.UserTokens, ['XBL']);
  assert.strictEqual(net.calls[2].json.RelyingParty, 'rp://api.minecraftservices.com/');
  assert.strictEqual(net.calls[3].json.identityToken, 'XBL3.0 x=123;XSTS');
  assert.strictEqual(net.calls[4].method, 'GET');
  assert.strictEqual(net.calls[4].headers.Authorization, `Bearer ${MC_TOKEN}`);
  assert.deepStrictEqual(a, {
    refresh: 'M.R3_new', token: MC_TOKEN, expires: now + 86400 * 1000,
    uuid: '069a79f444e94726a5befca90e38aaf5', name: 'Notch', xuid: '2535400000000001',
    skin: { url: 'https://textures.minecraft.net/texture/abc', slim: true }
  });

  // токен для запуска игры и лог без токена
  const auth = ms.toMclc({ ...a, clientId: 'c1' });
  assert.strictEqual(auth.access_token, MC_TOKEN);
  assert.strictEqual(auth.name, 'Notch');
  assert.strictEqual(auth.uuid, a.uuid);
  assert.strictEqual(auth.user_properties, '{}');
  assert.deepStrictEqual(auth.meta, { type: 'msa', demo: false, xuid: '2535400000000001', clientId: 'c1' });
  assert.strictEqual(ms.hideToken(`--accessToken ${MC_TOKEN} --uuid x`, MC_TOKEN), '--accessToken <токен скрыт> --uuid x');
  assert.strictEqual(ms.hideToken('просто строка', null), 'просто строка');

  // токен Minecraft обновляем заранее, за 3 часа до конца
  assert.ok(ms.fresh(a, now));
  assert.ok(ms.fresh(a, now + 20 * 3600e3));
  assert.ok(!ms.fresh(a, now + 22 * 3600e3));
  assert.ok(!ms.fresh(null, now));

  // обновление входа: новый refresh-токен сохраняется, а если Microsoft его не прислал — остаётся старый
  net = fakeNet();
  const b = await ms.refresh(net.fetch, { refresh: 'M.R3_old' }, now);
  assert.strictEqual(new URLSearchParams(net.calls[0].body).get('refresh_token'), 'M.R3_old');
  assert.strictEqual(b.refresh, 'M.R3_new');
  assert.strictEqual((await ms.refresh(fakeNet().fetch, { refresh: 'keep' }, now)).refresh, 'keep');
  // отозванный вход: нужно войти заново
  await assert.rejects(ms.refresh(fakeNet().fetch, { refresh: 'dead' }), (e) => e.relogin === true);
  await assert.rejects(ms.refresh(fakeNet().fetch, {}), (e) => e.relogin === true);

  // Xbox не принял токен без приставки: пробуем t= и d=
  net = fakeNet({ 'https://user.auth.xboxlive.com/user/authenticate': (o, n) => (n < 3 ? { status: 400, ok: false, text: async () => '' } : { status: 200, ok: true, text: async () => JSON.stringify({ Token: 'XBL' }) }) });
  await ms.login(net.fetch, 'c', now);
  assert.deepStrictEqual(net.calls.filter((c) => c.url.includes('xboxlive.com/user')).map((c) => c.json.Properties.RpsTicket), ['EwMS', 't=EwMS', 'd=EwMS']);
  // сервер упал (500) — повторять с приставками бессмысленно
  net = fakeNet({ 'https://user.auth.xboxlive.com/user/authenticate': () => ({ status: 503, ok: false, text: async () => '' }) });
  await assert.rejects(ms.login(net.fetch, 'c'), /Xbox Live не принял вход \(503\)/);
  assert.strictEqual(net.calls.filter((c) => c.url.includes('xboxlive.com/user')).length, 1);

  // понятные причины отказа
  const xerr = (code) => fakeNet({ 'https://xsts.auth.xboxlive.com/xsts/authorize': () => ({ status: 401, ok: false, text: async () => JSON.stringify({ Identity: '0', XErr: code, Message: '', Redirect: 'https://start.ui.xboxlive.com/CreateAccount' }) }) }).fetch;
  await assert.rejects(ms.login(xerr(2148916233), 'c'), /нет профиля Xbox/);
  await assert.rejects(ms.login(xerr(2148916238), 'c'), /детский аккаунт/);
  await assert.rejects(ms.login(xerr(2148916235), 'c'), /недоступен в стране/);
  await assert.rejects(ms.login(xerr(123), 'c'), /не пустил в Minecraft \(123\)/);
  await assert.rejects(ms.login(fakeNet({ 'https://api.minecraftservices.com/minecraft/profile': () => ({ status: 404, ok: false, text: async () => '{"path":"/minecraft/profile","errorType":"NOT_FOUND"}' }) }).fetch, 'c'), /нет Minecraft: Java Edition/);
  await assert.rejects(ms.login(fakeNet({ 'https://api.minecraftservices.com/authentication/login_with_xbox': () => ({ status: 429, ok: false, text: async () => '' }) }).fetch, 'c'), /подожди пару минут/);
  await assert.rejects(ms.login(fakeNet({ 'https://login.live.com/oauth20_token.srf': () => ({ status: 400, ok: false, text: async () => '{"error":"invalid_request"}' }) }).fetch, 'c'), (e) => /invalid_request/.test(e.message) && !e.relogin);

  // профиль без скинов и токен не-JWT: вход работает, просто без картинки и xuid
  const c = await ms.login(fakeNet({
    'https://api.minecraftservices.com/authentication/login_with_xbox': () => ({ status: 200, ok: true, text: async () => '{"access_token":"opaque","expires_in":86400}' }),
    'https://api.minecraftservices.com/minecraft/profile': () => ({ status: 200, ok: true, text: async () => '{"id":"u","name":"Steve","skins":[]}' })
  }).fetch, 'c', now);
  assert.strictEqual(c.skin, null);
  assert.strictEqual(c.xuid, null);
  assert.strictEqual(ms.toMclc(c).meta.xuid, '0');

  console.log('msauth: ok');
})().catch((e) => { console.error(e); process.exit(1); });
