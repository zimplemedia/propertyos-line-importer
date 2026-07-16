import { test, expect } from 'bun:test';

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
    c2: { list: [{ userId: 'U2', name: 'Tukta', iconHash: 'h2' }] },
  };
  globalThis.fetch = async (url) => {
    const next = new URL('https://chat.line.biz' + url.replace('https://chat.line.biz', '')).searchParams.get('next') || '';
    return new Response(JSON.stringify(pages[next]), { status: 200 });
  };
  const { fetchChatMembers } = await import('../src/oam-api.js');
  const members = await fetchChatMembers('B1', 'C7f664');
  expect(members).toEqual([
    { userId: 'U1', name: 'Mew', iconHash: 'h1' },
    { userId: 'U2', name: 'Tukta', iconHash: 'h2' },
  ]);
});
