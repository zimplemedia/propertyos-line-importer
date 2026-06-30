import { resolveOamBotId, fetchContactsPage, downloadChatCsv } from './oam-api.js';

const encodeCursor = (obj) => btoa(JSON.stringify(obj));
const decodeCursor = (s) => {
  try {
    return JSON.parse(atob(s));
  } catch {
    return null;
  }
};

/**
 * Scrape one bounded batch of the OA's chats. The returned cursor fully encodes resume position
 * ({ botId, pageToken, offset }) so the MV3 worker can be killed between calls. `pageToken` is the
 * OAM `next` token that FETCHES the current contacts page (undefined = first page); `offset` is how
 * many chatExists contacts of that page were already returned.
 */
export async function scrapeOam({ basicId, cursor, maxContacts = 25, maxBytes = 1_500_000 }) {
  try {
    const state = cursor ? decodeCursor(cursor) : null;
    let botId = state?.botId;
    const pageToken = state?.pageToken;
    const offset = state?.offset || 0;
    if (!botId) botId = await resolveOamBotId(basicId);

    const { list, next } = await fetchContactsPage(botId, pageToken);
    const chats = (list || []).filter((c) => c.chatExists);

    const contacts = [];
    let bytes = 0;
    let i = offset;
    for (; i < chats.length; i++) {
      if (contacts.length >= maxContacts || bytes >= maxBytes) break; // always ≥1 (checked after first push)
      const c = chats[i];
      const csv = await downloadChatCsv(botId, c.contactId);
      bytes += csv.length;
      contacts.push({ chatId: c.contactId, name: c.profile?.name || '', iconHash: c.profile?.iconHash || null, csv });
    }

    const pageDone = i >= chats.length;
    let nextCursor;
    let done;
    if (pageDone && next) {
      nextCursor = encodeCursor({ botId, pageToken: next, offset: 0 });
      done = false;
    } else if (pageDone) {
      nextCursor = null;
      done = true;
    } else {
      nextCursor = encodeCursor({ botId, pageToken, offset: i });
      done = false;
    }

    return { ok: true, botId, contacts, cursor: nextCursor, done };
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('LINE_OAM_COOKIE_INVALID')) return { ok: false, error: 'LINE_OAM_COOKIE_INVALID' };
    if (msg.includes('LINE_OAM_BOT_NOT_FOUND')) return { ok: false, error: 'LINE_OAM_BOT_NOT_FOUND' };
    return { ok: false, error: 'LINE_API_ERROR', details: msg };
  }
}
