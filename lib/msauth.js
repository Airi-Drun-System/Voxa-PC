'use strict';
// Вход через аккаунт Microsoft по той же цепочке, что у официального лаунчера:
// код входа Microsoft -> токен Microsoft -> Xbox Live -> XSTS -> токен Minecraft -> профиль (ник, UUID, скин).
// Здесь нет Electron: fetch передаётся снаружи, поэтому test/msauth.test.js проверяет цепочку на поддельных ответах.

// Клиент официального лаунчера Minecraft. Своё приложение в Azure для входа в Minecraft сейчас нужно отдельно
// согласовывать с Mojang, а этим клиентом пользуются многие сторонние лаунчеры.
const CLIENT_ID = '00000000402b5328';
const REDIRECT = 'https://login.live.com/oauth20_desktop.srf';
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const AUTHORIZE = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN = 'https://login.live.com/oauth20_token.srf';
const XBL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile';
// токен Minecraft живёт сутки; обновляем заранее, чтобы он не истёк посреди игры
const MARGIN = 3 * 60 * 60 * 1000;

/** Ошибка входа. relogin: сохранённый вход больше не действует, нужно войти заново */
class AuthError extends Error {
  constructor(message, relogin = false) { super(message); this.relogin = relogin; }
}

/** Страница входа Microsoft; prompt=select_account — можно выбрать другой аккаунт */
function authorizeUrl() {
  const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', scope: SCOPE, redirect_uri: REDIRECT, prompt: 'select_account' });
  return `${AUTHORIZE}?${q}`;
}

/** Куда Microsoft отправил окно: { code }, { error, description } или null, если вход ещё идёт */
function parseRedirect(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin + u.pathname !== REDIRECT) return null;
  const code = u.searchParams.get('code');
  if (code) return { code };
  const error = u.searchParams.get('error');
  return error ? { error, description: u.searchParams.get('error_description') || '' } : null;
}

async function send(fetch, url, { form, json, token } = {}) {
  const headers = { Accept: 'application/json' };
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers, body });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: r.status, ok: r.ok, data };
}

async function msToken(fetch, params) {
  const r = await send(fetch, TOKEN, { form: { client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE, ...params } });
  if (r.ok && r.data && r.data.access_token) return { access: r.data.access_token, refresh: r.data.refresh_token || null };
  const err = r.data && r.data.error;
  // invalid_grant: код входа или сохранённый вход устарел, отозван или пароль сменили
  if (err === 'invalid_grant') throw new AuthError('Вход Microsoft больше не действует, войди заново', true);
  throw new AuthError(`Microsoft не пустил (${err || r.status})`);
}

async function xboxUser(fetch, msAccess) {
  // токен этого клиента Xbox принимает как есть; приставки t= и d= — запасные варианты формата
  let r;
  for (const pre of ['', 't=', 'd=']) {
    r = await send(fetch, XBL, { json: { Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: pre + msAccess }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' } });
    if (r.ok && r.data && r.data.Token) return r.data.Token;
    if (r.status !== 400 && r.status !== 401) break;
  }
  throw new AuthError(`Xbox Live не принял вход (${r.status})`);
}

// коды XErr, с которыми XSTS отказывает аккаунту
const XERR = {
  2148916227: 'Этот аккаунт заблокирован в Xbox Live',
  2148916229: 'Родительский контроль не разрешает этому аккаунту игру по сети. Это меняется в настройках семьи Microsoft',
  2148916233: 'У этого аккаунта Microsoft ещё нет профиля Xbox. Зайди под ним на xbox.com, создай профиль и попробуй снова',
  2148916235: 'Xbox Live недоступен в стране, указанной в этом аккаунте',
  2148916236: 'Аккаунту нужно подтвердить возраст на xbox.com',
  2148916237: 'Аккаунту нужно подтвердить возраст на xbox.com',
  2148916238: 'Это детский аккаунт: взрослый должен добавить его в семью на account.microsoft.com/family'
};

async function xsts(fetch, xblToken) {
  const r = await send(fetch, XSTS, { json: { Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' } });
  const xui = r.ok && r.data && r.data.DisplayClaims && r.data.DisplayClaims.xui && r.data.DisplayClaims.xui[0];
  if (xui && xui.uhs && r.data.Token) return { token: r.data.Token, uhs: xui.uhs };
  const code = r.data && r.data.XErr;
  throw new AuthError(XERR[code] || `Xbox Live не пустил в Minecraft (${code || r.status})`);
}

async function minecraftToken(fetch, x) {
  const r = await send(fetch, MC_LOGIN, { json: { identityToken: `XBL3.0 x=${x.uhs};${x.token}` } });
  if (r.ok && r.data && r.data.access_token) return { token: r.data.access_token, expiresIn: Number(r.data.expires_in) || 86400 };
  throw new AuthError(r.status === 429 ? 'Слишком много входов подряд, подожди пару минут' : `Сервер Minecraft не принял вход (${r.status})`);
}

async function profile(fetch, mcToken) {
  const r = await send(fetch, MC_PROFILE, { token: mcToken });
  if (r.ok && r.data && r.data.id && r.data.name) return r.data;
  if (r.status === 404) {
    throw new AuthError('На этом аккаунте нет Minecraft: Java Edition. Если игра куплена или есть Game Pass, один раз зайди в официальный лаунчер или на minecraft.net и выбери ник');
  }
  throw new AuthError(`Не получилось узнать профиль Minecraft (${r.status})`);
}

/** Поле xuid из токена Minecraft (это JWT); игре оно нужно для статистики, без него тоже работает */
function xuidOf(token) {
  try { return String(JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).xuid || '') || null; } catch { return null; }
}

async function finish(fetch, ms, now) {
  const x = await xsts(fetch, await xboxUser(fetch, ms.access));
  const mc = await minecraftToken(fetch, x);
  const p = await profile(fetch, mc.token);
  const skins = p.skins || [];
  const skin = skins.find((s) => s.state === 'ACTIVE') || skins[0];
  return {
    refresh: ms.refresh, token: mc.token, expires: now + mc.expiresIn * 1000,
    uuid: p.id, name: p.name, xuid: xuidOf(mc.token),
    skin: skin && skin.url ? { url: String(skin.url).replace(/^http:/, 'https:'), slim: skin.variant === 'SLIM' } : null
  };
}

/** Первый вход: код со страницы Microsoft -> аккаунт (токены, ник, UUID, скин) */
async function login(fetch, code, now = Date.now()) {
  return finish(fetch, await msToken(fetch, { grant_type: 'authorization_code', code }), now);
}

/** Обновить вход без окна по сохранённому refresh-токену Microsoft */
async function refresh(fetch, account, now = Date.now()) {
  if (!account || !account.refresh) throw new AuthError('Вход Microsoft больше не действует, войди заново', true);
  const ms = await msToken(fetch, { grant_type: 'refresh_token', refresh_token: account.refresh });
  return finish(fetch, { access: ms.access, refresh: ms.refresh || account.refresh }, now);
}

/** Токен Minecraft ещё поживёт (с запасом на долгую игру) */
const fresh = (account, now = Date.now()) => !!(account && account.token && account.expires - now > MARGIN);

/** Аккаунт в формате minecraft-launcher-core */
function toMclc(account) {
  return {
    access_token: account.token,
    client_token: account.clientId || account.uuid,
    uuid: account.uuid,
    name: account.name,
    user_properties: '{}',
    meta: { type: 'msa', demo: false, xuid: account.xuid || '0', clientId: account.clientId || account.uuid }
  };
}

/** Строка лога без токена: minecraft-launcher-core пишет в лог все аргументы запуска, а лог показывают другим */
function hideToken(line, token) {
  return token ? String(line).split(token).join('<токен скрыт>') : String(line);
}

module.exports = { CLIENT_ID, REDIRECT, SCOPE, AuthError, authorizeUrl, parseRedirect, login, refresh, fresh, toMclc, hideToken, xuidOf };
