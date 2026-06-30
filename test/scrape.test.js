import { test, expect, mock } from 'bun:test';

function mockApi({ botId = 'Ubot', pages }) {
  // pages: keyed by pageToken ('__first__' for the initial page) → { list, next }
  mock.module('../src/oam-api.js', () => ({
    resolveOamBotId: async () => botId,
    fetchContactsPage: async (_b, token) => pages[token || '__first__'],
    downloadChatCsv: async (_b, chatId) => `csv-${chatId}`,
  }));
}

test('single full page → done, all contacts, cursor null', async () => {
  mockApi({
    pages: {
      __first__: {
        list: [
          { contactId: 'a', chatExists: true, profile: { name: 'A', iconHash: 'ha' } },
          { contactId: 'b', chatExists: false },
          { contactId: 'c', chatExists: true, profile: { name: 'C', iconHash: 'hc' } },
        ],
        next: null,
      },
    },
  });
  const { scrapeOam } = await import('../src/scrape.js');
  const r = await scrapeOam({ basicId: '@x' });
  expect(r.ok).toBe(true);
  expect(r.contacts.map((c) => c.chatId)).toEqual(['a', 'c']); // chatExists only
  expect(r.contacts[0].csv).toBe('csv-a');
  expect(r.done).toBe(true);
  expect(r.cursor).toBeNull();
});

test('maxContacts splits a page → mid-page cursor, then resumes', async () => {
  const page = {
    list: [
      { contactId: 'a', chatExists: true, profile: {} },
      { contactId: 'b', chatExists: true, profile: {} },
      { contactId: 'c', chatExists: true, profile: {} },
    ],
    next: null,
  };
  mockApi({ pages: { __first__: page } });
  const { scrapeOam } = await import('../src/scrape.js');
  const first = await scrapeOam({ basicId: '@x', maxContacts: 2 });
  expect(first.contacts.map((c) => c.chatId)).toEqual(['a', 'b']);
  expect(first.done).toBe(false);
  const second = await scrapeOam({ basicId: '@x', cursor: first.cursor, maxContacts: 2 });
  expect(second.contacts.map((c) => c.chatId)).toEqual(['c']);
  expect(second.done).toBe(true);
});

test('advances across pages via next token', async () => {
  mockApi({
    pages: {
      __first__: { list: [{ contactId: 'a', chatExists: true, profile: {} }], next: 'TOK2' },
      TOK2: { list: [{ contactId: 'b', chatExists: true, profile: {} }], next: null },
    },
  });
  const { scrapeOam } = await import('../src/scrape.js');
  const first = await scrapeOam({ basicId: '@x', maxContacts: 25 });
  expect(first.contacts.map((c) => c.chatId)).toEqual(['a']);
  expect(first.done).toBe(false);
  const second = await scrapeOam({ basicId: '@x', cursor: first.cursor });
  expect(second.contacts.map((c) => c.chatId)).toEqual(['b']);
  expect(second.done).toBe(true);
});

test('maps a cookie-expiry error to the contract shape', async () => {
  mock.module('../src/oam-api.js', () => ({
    resolveOamBotId: async () => {
      throw new Error('LINE_OAM_COOKIE_INVALID');
    },
    fetchContactsPage: async () => ({ list: [], next: null }),
    downloadChatCsv: async () => '',
  }));
  const { scrapeOam } = await import('../src/scrape.js');
  const r = await scrapeOam({ basicId: '@x' });
  expect(r).toEqual({ ok: false, error: 'LINE_OAM_COOKIE_INVALID' });
});
