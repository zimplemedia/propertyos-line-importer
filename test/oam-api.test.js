import { afterEach, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
const realRandom = Math.random;

afterEach(() => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
});

test('sanitized tag fixture pins the observed bare-array envelope', () => {
  const tags = fixture('tags.json');
  expect(Array.isArray(tags)).toBe(true);
  expect(tags.length).toBeGreaterThan(1);
  expect(tags.list).toBeUndefined();
  expect(tags).toEqual(
    tags.map(({ tagId, name, count, createdAt, updatedAt }) => ({
      tagId,
      name,
      count,
      createdAt,
      updatedAt,
    }))
  );
});

test('sanitized contacts fixture covers supported rows, no-chat, tags, and rooms', () => {
  const page = fixture('contacts-page.json');
  const direct = page.list.find((contact) => contact.contactId === 'U-OAM-DIRECT');
  const group = page.list.find((contact) => contact.contactId === 'C-OAM-GROUP');
  const noChat = page.list.find((contact) => contact.contactId === 'U-OAM-NO-CHAT');
  const room = page.list.find((contact) => contact.contactId === 'R-OAM-ROOM');

  expect(direct.profile.userId).toBe(direct.contactId);
  expect(group.profile.groupId).toBe(group.contactId);
  expect(noChat.chatExists).toBe(false);
  expect(room.profile.roomId).toBe(room.contactId);
  for (const contact of page.list) {
    expect(Array.isArray(contact.tagIds)).toBe(true);
    expect(Array.isArray(contact.autoTagIds)).toBe(true);
  }
});

test('sanitized note fixtures pin empty and populated envelopes and five note fields', () => {
  const empty = fixture('notes-empty-page.json');
  const populated = fixture('notes-page.json');

  expect(empty).toEqual({ list: [], total: 0 });
  expect(populated.total).toBe(populated.list.length);
  expect(Object.keys(populated.list[0]).sort()).toEqual(
    ['noteId', 'body', 'userBizId', 'createdAt', 'updatedAt'].sort()
  );
});

test('fetchChatNotes must reject a truncated note envelope until pagination is exhausted', async () => {
  const { fetchChatNotes } = await import('../src/oam-api.js');
  expect(typeof fetchChatNotes).toBe('function');

  const populated = fixture('notes-page.json');
  global.fetch = async () =>
    new Response(JSON.stringify({ ...populated, total: populated.list.length + 1 }), {
      status: 200,
    });

  await expect(fetchChatNotes('B1', 'U-OAM-DIRECT')).rejects.toThrow(
    'LINE_OAM_NOTES_INCOMPLETE'
  );
});

test('fetchTags accepts only the bare array and normalizes allowlisted fields', async () => {
  const { fetchTags } = await import('../src/oam-api.js');
  const tags = fixture('tags.json');
  globalThis.fetch = async () =>
    new Response(JSON.stringify(tags.map((tag) => ({ ...tag, secret: 'drop-me' }))), {
      status: 200,
    });

  expect(await fetchTags('B1')).toEqual(tags);

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ list: tags }), { status: 200 });
  await expect(fetchTags('B1')).rejects.toThrow('LINE_OAM_TAGS_INVALID');

  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ ...tags[0], tagId: '' }]), { status: 200 });
  await expect(fetchTags('B1')).rejects.toThrow('LINE_OAM_TAGS_INVALID');
});

test('fetchChatNotes normalizes only the five observed note fields', async () => {
  const { fetchChatNotes } = await import('../src/oam-api.js');
  const notes = fixture('notes-page.json');
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ...notes,
        list: notes.list.map((note) => ({ ...note, secret: 'drop-me' })),
      }),
      { status: 200 }
    );

  expect(await fetchChatNotes('B1', 'U-OAM-DIRECT')).toEqual(notes.list);
});

test('new OAM endpoints retry 429 and map cookie expiry without exposing a Cookie header', async () => {
  const { fetchChatNotes, fetchTags } = await import('../src/oam-api.js');
  const tags = fixture('tags.json');
  const notes = fixture('notes-page.json');
  const calls = [];
  Math.random = () => 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return new Response('', { status: 429, headers: { 'retry-after': '0.001' } });
    }
    return new Response(JSON.stringify(tags), { status: 200 });
  };

  expect(await fetchTags('B1')).toEqual(tags);
  expect(calls).toHaveLength(2);
  for (const { options } of calls) {
    expect(options.credentials).toBe('include');
    expect(options.headers.Cookie).toBeUndefined();
  }

  globalThis.fetch = async () => new Response('', { status: 401 });
  await expect(fetchTags('B1')).rejects.toThrow('LINE_OAM_COOKIE_INVALID');
  globalThis.fetch = async () => new Response('', { status: 403 });
  await expect(fetchChatNotes('B1', 'U1')).rejects.toThrow(
    'LINE_OAM_COOKIE_INVALID'
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify(notes), { status: 200 });
  expect(await fetchChatNotes('B1', 'U1')).toEqual(notes.list);
});

test('validateOamSession is true on 200, false on 401', async () => {
  const { validateOamSession } = await import('../src/oam-api.js');
  global.fetch = async () => new Response('{}', { status: 200 });
  expect(await validateOamSession()).toBe(true);
  global.fetch = async () => new Response('no', { status: 401 });
  expect(await validateOamSession()).toBe(false);
});

test('resolveOamBotId matches basicId (ignoring @ and case), else throws', async () => {
  const { resolveOamBotId } = await import('../src/oam-api.js');
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        list: [
          { botId: 'Uaaa', basicSearchId: '@070qfvsc' },
          { botId: 'Ubbb', basicSearchId: '@other' },
        ],
      }),
      { status: 200 }
    );
  expect(await resolveOamBotId('070QFVSC')).toBe('Uaaa');
  global.fetch = async () => new Response(JSON.stringify({ list: [] }), { status: 200 });
  await expect(resolveOamBotId('@nope')).rejects.toThrow('LINE_OAM_BOT_NOT_FOUND');
});

test('downloadChatCsv returns text; 401 throws LINE_OAM_COOKIE_INVALID', async () => {
  const { downloadChatCsv } = await import('../src/oam-api.js');
  global.fetch = async () => new Response('Sender type,...', { status: 200 });
  expect(await downloadChatCsv('Ub', 'c1')).toContain('Sender type');
  global.fetch = async () => new Response('', { status: 401 });
  await expect(downloadChatCsv('Ub', 'c1')).rejects.toThrow('LINE_OAM_COOKIE_INVALID');
});

test('oamFetch retries a rejected fetch (network drop) then succeeds', async () => {
  const { downloadChatCsv } = await import('../src/oam-api.js');
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('Failed to fetch'); // e.g. net::ERR_NETWORK_CHANGED
    return new Response('Sender type,ok', { status: 200 });
  };
  expect(await downloadChatCsv('Ub', 'c1')).toContain('Sender type');
  expect(calls).toBe(2); // dropped once, retried, recovered
});

test('fetch sends credentials:include and no Cookie header', async () => {
  const { fetchContactsPage } = await import('../src/oam-api.js');
  let opts;
  global.fetch = async (_url, o) => {
    opts = o;
    return new Response(JSON.stringify({ list: [], next: null }), { status: 200 });
  };
  await fetchContactsPage('Ub');
  expect(opts.credentials).toBe('include');
  expect(opts.headers.Cookie).toBeUndefined();
});

test('fetchChatMembers pages next to exhaustion and normalizes', async () => {
  const pages = {
    '': { list: [{ userId: 'U1', name: 'Mew', iconHash: 'h1' }], next: 'c2' },
    c2: { list: [{ userId: 'U2', name: 'Tukta', nickname: 'K.ตุ๊กตา', iconHash: 'h2' }] },
  };
  globalThis.fetch = async (url) => {
    const next = new URL('https://chat.line.biz' + url.replace('https://chat.line.biz', '')).searchParams.get('next') || '';
    return new Response(JSON.stringify(pages[next]), { status: 200 });
  };
  const { fetchChatMembers } = await import('../src/oam-api.js');
  const members = await fetchChatMembers('B1', 'C7f664');
  expect(members).toEqual([
    { userId: 'U1', name: 'Mew', nickname: null, iconHash: 'h1' },
    { userId: 'U2', name: 'Tukta', nickname: 'K.ตุ๊กตา', iconHash: 'h2' },
  ]);
});
