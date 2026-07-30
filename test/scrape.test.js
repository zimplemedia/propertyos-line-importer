import { beforeEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const direct = (id, {
  chatExists = true,
  tagIds = [],
  name = id,
  autoTagIds = ['must-not-leak'],
} = {}) => ({
  contactId: id,
  chatExists,
  chatAvailable: chatExists,
  friend: true,
  done: false,
  followedUp: false,
  spam: false,
  useManualChat: false,
  lastTalkedAt: chatExists ? 1781947777445 : null,
  tagIds,
  autoTagIds,
  profile: { userId: id, name, nickname: null, iconHash: `icon-${id}` },
});

const group = (id, options = {}) => ({
  ...direct(id, options),
  profile: {
    groupId: id,
    name: options.name ?? id,
    nickname: null,
    iconHash: `icon-${id}`,
    count: 1,
  },
});

const room = (id) => ({
  ...direct(id),
  profile: { roomId: id, name: 'Unsupported room', iconHash: 'room-icon' },
});

let currentApi;

mock.module('../src/oam-api.js', () => ({
  resolveOamBotId: (...args) => currentApi.resolveOamBotId(...args),
  fetchContactsPage: (...args) => currentApi.fetchContactsPage(...args),
  downloadChatCsv: (...args) => currentApi.downloadChatCsv(...args),
  fetchChatNotes: (...args) => currentApi.fetchChatNotes(...args),
  fetchChatMembers: (...args) => currentApi.fetchChatMembers(...args),
  fetchTags: (...args) => currentApi.fetchTags(...args),
  validateOamSession: (...args) => currentApi.validateOamSession(...args),
}));

function mockApi({
  botId = 'Ubot',
  getPage,
  pages,
  csv = (_botId, chatId) => `csv-${chatId}`,
  notes = (_botId, chatId) => [{
    noteId: `note-${chatId}`,
    body: 'sanitized',
    userBizId: 'admin',
    createdAt: 1,
    updatedAt: 2,
  }],
  members = async () => [{
    userId: 'U-member',
    name: 'Member',
    nickname: null,
    iconHash: 'member-icon',
  }],
  tags = async () => [{
    tagId: 'tag-1',
    name: 'Tag',
    count: 1,
    createdAt: 1,
    updatedAt: 2,
  }],
} = {}) {
  currentApi = {
    resolveOamBotId: async () => botId,
    fetchContactsPage: async (_bot, token) =>
      getPage ? getPage(token ?? null) : pages[token || '__first__'],
    downloadChatCsv: csv,
    fetchChatNotes: notes,
    fetchChatMembers: members,
    fetchTags: tags,
    validateOamSession: async () => true,
  };
}

const decodeCursor = (cursor) => JSON.parse(atob(cursor));

beforeEach(() => {
  mockApi({ pages: { __first__: { list: [], next: null } } });
});

test('worker-cache loss resumes cursor v2 by refetching and filtering acknowledged IDs', async () => {
  let pageFetches = 0;
  mockApi({
    getPage: () => {
      pageFetches += 1;
      return {
        list: [direct('U1'), direct('U2'), direct('U3')],
        next: null,
      };
    },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const first = await scrapeOam({ basicId: '@x', maxContacts: 2 });
  const state = decodeCursor(first.cursorOut);
  expect(state).toEqual({
    v: 2,
    botId: 'Ubot',
    pageToken: null,
    processedContactIds: ['U1', 'U2'],
    sequence: 1,
  });

  const second = await scrapeOam({
    basicId: '@x',
    cursor: first.cursorOut,
    maxContacts: 2,
  });
  expect(second.contacts.map((contact) => contact.chatId)).toEqual(['U3']);
  expect(second.done).toBe(true);
  expect(second.cursorOut).toBeNull();
  expect(pageFetches).toBe(2);
});

test('page reorder cannot repeat an acknowledged contact', async () => {
  let pageFetches = 0;
  mockApi({
    getPage: () => {
      pageFetches += 1;
      return {
        list:
          pageFetches === 1
            ? [direct('U1'), direct('U2'), direct('U3')]
            : [direct('U3'), direct('U1'), direct('U2')],
        next: null,
      };
    },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const first = await scrapeOam({ basicId: '@x', maxContacts: 1 });
  const second = await scrapeOam({
    basicId: '@x',
    cursor: first.cursorOut,
    maxContacts: 1,
  });

  expect(first.contacts.map((contact) => contact.chatId)).toEqual(['U1']);
  expect(second.contacts.map((contact) => contact.chatId)).toEqual(['U3']);
  expect(second.contacts.map((contact) => contact.chatId)).not.toContain('U1');
});

test('an all-no-chat page returns every person without history, notes, or roster calls', async () => {
  const calls = { csv: 0, notes: 0, members: 0 };
  mockApi({
    pages: {
      __first__: {
        list: [
          direct('U1', { chatExists: false, tagIds: ['tag-1'] }),
          direct('U2', { chatExists: false }),
        ],
        next: null,
      },
    },
    csv: async () => { calls.csv += 1; },
    notes: async () => { calls.notes += 1; },
    members: async () => { calls.members += 1; },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const result = await scrapeOam({ basicId: '@x', includeTagCatalog: true });

  expect(result.ok).toBe(true);
  expect(result.contacts.map((contact) => contact.chatId)).toEqual(['U1', 'U2']);
  expect(result.contacts[0]).toMatchObject({
    type: 'DIRECT',
    chatExists: false,
    csv: null,
    notes: [],
    notesComplete: false,
    historyComplete: false,
    tagIds: ['tag-1'],
  });
  expect(result.tagCatalog).toHaveLength(1);
  expect(calls).toEqual({ csv: 0, notes: 0, members: 0 });
});

test('a mixed page fetches chat-only data, group roster, carries manual tags, and skips rooms', async () => {
  const memberCalls = [];
  mockApi({
    pages: {
      __first__: {
        list: [
          direct('U-chat', { tagIds: ['tag-1'] }),
          direct('U-no-chat', { chatExists: false }),
          group('C-group', { tagIds: ['tag-1'] }),
          room('R-room'),
        ],
        next: null,
      },
    },
    members: async (_botId, chatId) => {
      memberCalls.push(chatId);
      return [{
        userId: 'U-member',
        name: 'Member',
        nickname: 'M',
        iconHash: 'member-icon',
      }];
    },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const result = await scrapeOam({ basicId: '@x' });
  const [chat, noChat, groupChat] = result.contacts;

  expect(result.unsupportedRoomCount).toBe(1);
  expect(result.contacts.map((contact) => contact.chatId)).toEqual([
    'U-chat',
    'U-no-chat',
    'C-group',
  ]);
  expect(chat).toMatchObject({
    chatExists: true,
    csv: 'csv-U-chat',
    historyComplete: true,
    notesComplete: true,
    tagIds: ['tag-1'],
  });
  expect(noChat.csv).toBeNull();
  expect(groupChat).toMatchObject({
    type: 'GROUP',
    rosterComplete: true,
    members: [{
      externalId: 'U-member',
      name: 'Member',
      nickname: 'M',
      iconHash: 'member-icon',
    }],
  });
  expect(memberCalls).toEqual(['C-group']);
  expect(JSON.stringify(result)).not.toContain('autoTagIds');
  expect(JSON.stringify(result)).not.toContain('must-not-leak');
});

test('missing tagIds fails instead of becoming an authoritative empty snapshot', async () => {
  const malformed = direct('U1');
  delete malformed.tagIds;
  mockApi({
    pages: { __first__: { list: [malformed], next: null } },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  expect(await scrapeOam({ basicId: '@x' })).toEqual({
    ok: false,
    error: 'LINE_OAM_CONTACT_INVALID',
  });
});

test('one oversized CSV fails explicitly and is never truncated', async () => {
  const history = 'แ'.repeat(20);
  mockApi({
    pages: { __first__: { list: [direct('U1')], next: null } },
    csv: async () => history,
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const result = await scrapeOam({
    basicId: '@x',
    singleHistoryMaxBytes: 30,
  });
  expect(result).toEqual({
    ok: false,
    error: 'LINE_OAM_HISTORY_TOO_LARGE',
  });
  expect(history).toHaveLength(20);
});

test('actual UTF-8 payload bytes close the batch before maxBytes', async () => {
  mockApi({
    pages: {
      __first__: {
        list: [direct('U1'), direct('U2')],
        next: null,
      },
    },
    csv: async (_botId, chatId) => `${chatId}-${'แ'.repeat(30)}`,
    notes: async () => [],
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const oneContact = await scrapeOam({
    basicId: '@x',
    maxContacts: 1,
    maxBytes: 50_000,
  });
  const bounded = await scrapeOam({
    basicId: '@x',
    maxBytes: oneContact.payloadBytes,
  });

  expect(bounded.contacts).toHaveLength(1);
  expect(bounded.payloadBytes).toBeLessThanOrEqual(oneContact.payloadBytes);
  expect(
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength
  ).toBe(bounded.payloadBytes);
});

test('retrying the same cursor produces the same deterministic receipt contract', async () => {
  mockApi({
    pages: {
      __first__: {
        list: [direct('U1'), direct('U2')],
        next: null,
      },
    },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  const first = await scrapeOam({ basicId: '@x', maxContacts: 1 });
  const retry = await scrapeOam({ basicId: '@x', maxContacts: 1 });

  expect(first.protocolVersion).toBe(2);
  expect(first.batchId).toMatch(/^oam-v2-0-[0-9a-f]{32}$/);
  expect(first.batchId).toBe(retry.batchId);
  expect(first.cursorIn).toBeNull();
  expect(first.cursorOut).toBe(retry.cursorOut);
  expect(first.contacts).toEqual(retry.contacts);
});

test('invalid cursor is distinct from session and network errors', async () => {
  mockApi({
    pages: { __first__: { list: [], next: null } },
  });
  const { scrapeOam } = await import('../src/scrape.js');

  expect(await scrapeOam({ basicId: '@x', cursor: 'not-a-v2-cursor' })).toEqual({
    ok: false,
    error: 'LINE_OAM_CURSOR_INVALID',
  });
});

test('ping advertises protocol v2 capabilities and versions stay locked at 0.4.0', async () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
  );
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => manifest,
      onMessageExternal: { addListener: (listener) => listeners.push(listener) },
    },
  };
  const { handle } = await import('../src/background.js');

  expect(await handle({ action: 'ping' })).toEqual({
    ok: true,
    version: '0.4.0',
    protocolVersion: 2,
    capabilities: {
      cursorV2: true,
      fullSnapshot: true,
      notes: true,
      tags: true,
      roomsSkipped: true,
    },
  });
  expect(manifest.version).toBe('0.4.0');
  expect(packageJson.version).toBe('0.4.0');
  expect(manifest.key).toMatch(/^MIIB/);
  expect(listeners).toHaveLength(1);
});
