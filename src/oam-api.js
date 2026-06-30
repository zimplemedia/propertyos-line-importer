// chat.line.biz — the OA Manager console's private API, scraped IN THE BROWSER. The session
// cookie auto-attaches via credentials:'include' under host_permissions; it is never read here.
const BASE = 'https://chat.line.biz';
const HEADERS = { Accept: 'application/json, text/plain, */*', 'x-oa-chat-client-version': '20240513144702' };
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oamFetch(path, { accept } = {}, { maxRetries = 4, baseDelayMs = 500 } = {}) {
  const headers = { ...HEADERS, ...(accept ? { Accept: accept } : {}) };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { credentials: 'include', headers });
    if (res.status === 401 || res.status === 403) throw new Error('LINE_OAM_COOKIE_INVALID');
    if (res.ok) return res;
    if (RETRYABLE.has(res.status) && attempt < maxRetries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep((ra > 0 ? ra * 1000 : baseDelayMs * 2 ** attempt) + Math.random() * baseDelayMs);
      continue;
    }
    const body = await res.text().catch(() => '');
    throw new Error(`LINE_API_ERROR: ${path} ${res.status} ${body.slice(0, 200)}`);
  }
}

export async function validateOamSession() {
  try {
    await oamFetch('/api/v1/me');
    return true;
  } catch {
    return false;
  }
}

// Confirmed by the Task 1 spike (2026-06-29): GET /api/v1/bots?limit=1000&noFilter=true
// → { list: [ { botId, basicSearchId: '@handle', name, iconHash, ... } ] }
const BOTS_ENDPOINT = '/api/v1/bots?limit=1000&noFilter=true';
const normalizeHandle = (h) => String(h || '').replace(/^@/, '').toLowerCase();

export async function resolveOamBotId(basicId) {
  const res = await oamFetch(BOTS_ENDPOINT);
  const data = await res.json();
  const list = data.list || data.bots || (Array.isArray(data) ? data : []);
  const target = normalizeHandle(basicId);
  const bot = list.find((b) => normalizeHandle(b.basicSearchId || b.basicId) === target);
  if (!bot) throw new Error('LINE_OAM_BOT_NOT_FOUND');
  return bot.botId || bot.id;
}

export async function fetchContactsPage(botId, pageToken) {
  const qs = new URLSearchParams({ query: '', sortKey: 'DISPLAY_NAME', sortOrder: 'ASC', filterKey: 'ALL', limit: '100' });
  if (pageToken) qs.set('next', pageToken);
  const res = await oamFetch(`/api/v2/bots/${botId}/contacts?${qs.toString()}`);
  const data = await res.json();
  return { list: data.list || [], next: data.next || null };
}

export async function downloadChatCsv(botId, chatId, { timezoneOffset = -420 } = {}) {
  const res = await oamFetch(`/download/${botId}/${chatId}/messages.csv?timezoneOffset=${timezoneOffset}`, {
    accept: 'text/csv,*/*',
  });
  return res.text();
}
