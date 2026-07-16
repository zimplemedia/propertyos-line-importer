import { resolveOamBotId, fetchContactsPage, downloadChatCsv, fetchChatMembers } from './oam-api.js';

const isGroup = (c) => !!c.profile?.groupId;

// Mirrors the server's oamChatState picker: chat-state flags only — name/photo/ids have
// first-class homes on the Contact row and must not get a second, staler copy here.
const oamChatState = (c) => ({
  chatAvailable: c.chatAvailable ?? null,
  friend: c.friend ?? null,
  done: c.done ?? null,
  followedUp: c.followedUp ?? null,
  spam: c.spam ?? null,
  useManualChat: c.useManualChat ?? null,
  lastTalkedAt: c.lastTalkedAt ?? null,
});

const encodeCursor = (obj) => btoa(JSON.stringify(obj));
const decodeCursor = (s) => {
  try {
    return JSON.parse(atob(s));
  } catch {
    return null;
  }
};

// One-entry cache of the current contacts page. A batch returns ≤25 chats but a page holds 100,
// so consecutive scrapeOam calls land on the same pageToken — without this, each page is
// re-fetched once per batch (~4×). Module state dies with the MV3 service worker; the fallback
// is just a re-fetch. Also pins offset-resume to one snapshot of the DISPLAY_NAME-sorted list.
let contactsPageCache = null; // { key, list, next }

export function resetContactsPageCache() {
  contactsPageCache = null;
}

async function getContactsPage(botId, pageToken) {
  const key = `${botId}:${pageToken || ''}`;
  if (contactsPageCache?.key !== key) {
    const { list, next } = await fetchContactsPage(botId, pageToken);
    contactsPageCache = { key, list, next };
  }
  return contactsPageCache;
}

/**
 * Scrape one bounded batch of the OA's chats. The returned cursor fully encodes resume position
 * ({ botId, pageToken, offset }) so the MV3 worker can be killed between calls. `pageToken` is the
 * OAM `next` token that FETCHES the current contacts page (undefined = first page); `offset` is how
 * many chatExists contacts of that page were already returned.
 */
// maxBytes is the binding bound (batches of fat chats close early and resume via the offset
// cursor); maxContacts is just the ceiling for pages of small chats.
export async function scrapeOam({ basicId, cursor, maxContacts = 100, maxBytes = 1_500_000 }) {
  try {
    const state = cursor ? decodeCursor(cursor) : null;
    let botId = state?.botId;
    const pageToken = state?.pageToken;
    const offset = state?.offset || 0;
    if (!botId) botId = await resolveOamBotId(basicId);

    const { list, next } = await getContactsPage(botId, pageToken);
    const chats = (list || []).filter((c) => c.chatExists);

    // Download CSVs in small concurrent waves (instead of one-at-a-time) to cut per-batch wait.
    // Each wave is a contiguous slice so `offset` advances correctly for the resumable cursor.
    const POOL = 6;
    const contacts = [];
    let bytes = 0;
    let i = offset;
    while (i < chats.length && contacts.length < maxContacts && bytes < maxBytes) {
      const waveSize = Math.min(POOL, maxContacts - contacts.length, chats.length - i);
      const wave = chats.slice(i, i + waveSize);
      const csvs = await Promise.all(wave.map((c) => downloadChatCsv(botId, c.contactId)));
      const memberLists = await Promise.all(wave.map((c) => (isGroup(c) ? fetchChatMembers(botId, c.contactId) : null)));
      wave.forEach((c, j) => {
        bytes += csvs[j].length;
        const entry = {
          chatId: c.contactId,
          name: c.profile?.name || '',
          iconHash: c.profile?.iconHash || null,
          csv: csvs[j],
          type: isGroup(c) ? 'GROUP' : 'USER',
          metadata: oamChatState(c),
        };
        if (isGroup(c)) {
          entry.members = memberLists[j];
          if (c.profile?.count && memberLists[j].length < c.profile.count) {
            console.warn(`[scrape] group ${c.contactId}: fetched ${memberLists[j].length}/${c.profile.count} members`);
          }
        }
        contacts.push(entry);
      });
      i += waveSize;
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
