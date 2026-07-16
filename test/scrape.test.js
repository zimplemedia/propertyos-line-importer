import { test, expect, mock, beforeEach } from 'bun:test';

function mockApi({ botId = 'Ubot', pages }) {
  // pages: keyed by pageToken ('__first__' for the initial page) → { list, next }
  mock.module('../src/oam-api.js', () => ({
    resolveOamBotId: async () => botId,
    fetchContactsPage: async (_b, token) => pages[token || '__first__'],
    downloadChatCsv: async (_b, chatId) => `csv-${chatId}`,
  }));
}

beforeEach(async () => {
  const { resetContactsPageCache } = await import('../src/scrape.js');
  resetContactsPageCache();
});

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

test('downloads CSVs concurrently within a batch while preserving order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  mock.module('../src/oam-api.js', () => ({
    resolveOamBotId: async () => 'Ubot',
    fetchContactsPage: async () => ({
      list: [
        { contactId: 'a', chatExists: true, profile: {} },
        { contactId: 'b', chatExists: true, profile: {} },
        { contactId: 'c', chatExists: true, profile: {} },
        { contactId: 'd', chatExists: true, profile: {} },
      ],
      next: null,
    }),
    downloadChatCsv: async (_b, chatId) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return `csv-${chatId}`;
    },
  }));
  const { scrapeOam } = await import('../src/scrape.js');
  const r = await scrapeOam({ basicId: '@x', maxContacts: 25 });
  expect(r.contacts.map((c) => c.chatId)).toEqual(['a', 'b', 'c', 'd']); // order preserved
  expect(r.contacts[0].csv).toBe('csv-a');
  expect(maxInFlight).toBeGreaterThan(1); // ran in parallel, not one-at-a-time
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

test('tags USER/GROUP and fetches members for group contacts', async () => {
  let membersFetchedFor = null;
  mock.module('../src/oam-api.js', () => ({
    resolveOamBotId: async () => 'Ubot',
    fetchContactsPage: async () => ({
      list: [
        { contactId: 'a', chatExists: true, profile: { name: 'A', iconHash: 'ha' } },
        { contactId: 'g1', chatExists: true, profile: { name: 'Group 1', iconHash: 'hg', groupId: 'G1', count: 2 } },
      ],
      next: null,
    }),
    downloadChatCsv: async (_b, chatId) => `csv-${chatId}`,
    fetchChatMembers: async (_b, chatId) => {
      membersFetchedFor = chatId;
      return [
        { userId: 'U1', name: 'Mew', iconHash: 'h1' },
        { userId: 'U2', name: 'Tukta', iconHash: 'h2' },
      ];
    },
  }));
  const { scrapeOam } = await import('../src/scrape.js');
  const r = await scrapeOam({ basicId: '@x' });
  expect(r.ok).toBe(true);
  const [user, group] = r.contacts;
  expect(user.type).toBe('USER');
  expect(user.members).toBeUndefined();
  expect(group.type).toBe('GROUP');
  expect(group.members).toEqual([
    { userId: 'U1', name: 'Mew', iconHash: 'h1' },
    { userId: 'U2', name: 'Tukta', iconHash: 'h2' },
  ]);
  expect(membersFetchedFor).toBe('g1');
});

test('reuses the cached contacts page across batch calls (one fetch per page)', async () => {
  let pageFetches = 0;
  mock.module('../src/oam-api.js', () => ({
    resolveOamBotId: async () => 'Ubot',
    fetchContactsPage: async () => {
      pageFetches++;
      return {
        list: [
          { contactId: 'a', chatExists: true, profile: {} },
          { contactId: 'b', chatExists: true, profile: {} },
          { contactId: 'c', chatExists: true, profile: {} },
        ],
        next: null,
      };
    },
    downloadChatCsv: async (_b, chatId) => `csv-${chatId}`,
  }));
  const { scrapeOam } = await import('../src/scrape.js');
  const first = await scrapeOam({ basicId: '@x', maxContacts: 2 });
  const second = await scrapeOam({ basicId: '@x', cursor: first.cursor, maxContacts: 2 });
  expect(first.contacts.map((c) => c.chatId)).toEqual(['a', 'b']);
  expect(second.contacts.map((c) => c.chatId)).toEqual(['c']);
  expect(second.done).toBe(true);
  expect(pageFetches).toBe(1); // page of 100 fetched once, not once per 25-batch
});
