import { beforeEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

const direct = (
  id,
  {
    chatExists = true,
    tagIds = [],
    name = id,
    autoTagIds = ["must-not-leak"],
  } = {},
) => ({
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
  profile: { roomId: id, name: "Unsupported room", iconHash: "room-icon" },
});

let currentApi;

mock.module("../src/oam-api.js", () => ({
  resolveOamBotId: (...args) => currentApi.resolveOamBotId(...args),
  fetchContactsPage: (...args) => currentApi.fetchContactsPage(...args),
  downloadChatCsv: (...args) => currentApi.downloadChatCsv(...args),
  fetchChatNotes: (...args) => currentApi.fetchChatNotes(...args),
  fetchChatMembers: (...args) => currentApi.fetchChatMembers(...args),
  fetchTags: (...args) => currentApi.fetchTags(...args),
  validateOamSession: (...args) => currentApi.validateOamSession(...args),
}));

function mockApi({
  botId = "Ubot",
  getPage,
  pages,
  csv = (_botId, chatId) => `csv-${chatId}`,
  notes = (_botId, chatId) => [
    {
      noteId: `note-${chatId}`,
      body: "sanitized",
      userBizId: "admin",
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  members = async () => [
    {
      userId: "U-member",
      name: "Member",
      nickname: null,
      iconHash: "member-icon",
    },
  ],
  tags = async () => [
    {
      tagId: "tag-1",
      name: "Tag",
      count: 1,
      createdAt: 1,
      updatedAt: 2,
    },
  ],
} = {}) {
  currentApi = {
    resolveOamBotId: async () => botId,
    fetchContactsPage: async (_bot, token) =>
      getPage ? getPage(token ?? null) : pages[token || "__first__"],
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

test("worker-cache loss resumes from the next server-owned LINE page cursor", async () => {
  let pageFetches = 0;
  mockApi({
    getPage: (token) => {
      pageFetches += 1;
      return token === null
        ? { list: [direct("U1"), direct("U2")], next: "page-2" }
        : { list: [direct("U3")], next: null };
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const first = await scrapeOam({ basicId: "@x" });
  const state = decodeCursor(first.cursorOut);
  expect(state).toEqual({
    botId: "Ubot",
    pageToken: "page-2",
    processedContactIds: [],
    sequence: 1,
  });

  const second = await scrapeOam({
    basicId: "@x",
    cursor: first.cursorOut,
  });
  expect(second.contacts.map((contact) => contact.chatId)).toEqual(["U3"]);
  expect(second.done).toBe(true);
  expect(second.cursorOut).toBeNull();
  expect(pageFetches).toBe(2);
});

test("an all-no-chat page returns every person without history, notes, or roster calls", async () => {
  const calls = { csv: 0, notes: 0, members: 0 };
  mockApi({
    pages: {
      __first__: {
        list: [
          direct("U1", { chatExists: false, tagIds: ["tag-1"] }),
          direct("U2", { chatExists: false }),
        ],
        next: null,
      },
    },
    csv: async () => {
      calls.csv += 1;
    },
    notes: async () => {
      calls.notes += 1;
    },
    members: async () => {
      calls.members += 1;
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x", includeTagCatalog: true });

  expect(result.ok).toBe(true);
  expect(result.contacts.map((contact) => contact.chatId)).toEqual([
    "U1",
    "U2",
  ]);
  expect(result.contacts[0]).toMatchObject({
    type: "DIRECT",
    chatExists: false,
    csv: null,
    notes: [],
    notesComplete: false,
    historyComplete: false,
    tagIds: ["tag-1"],
  });
  expect(result.tagCatalog).toHaveLength(1);
  expect(calls).toEqual({ csv: 0, notes: 0, members: 0 });
});

test("a mixed page fetches chat-only data, group roster, carries manual tags, and skips rooms", async () => {
  const memberCalls = [];
  mockApi({
    pages: {
      __first__: {
        list: [
          direct("U-chat", { tagIds: ["tag-1"] }),
          direct("U-no-chat", { chatExists: false }),
          group("C-group", { tagIds: ["tag-1"] }),
          room("R-room"),
        ],
        next: null,
      },
    },
    members: async (_botId, chatId) => {
      memberCalls.push(chatId);
      return [
        {
          userId: "U-member",
          name: "Member",
          nickname: "M",
          iconHash: "member-icon",
        },
      ];
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x" });
  const [chat, noChat, groupChat] = result.contacts;

  expect(result.unsupportedRoomCount).toBe(1);
  expect(result.contacts.map((contact) => contact.chatId)).toEqual([
    "U-chat",
    "U-no-chat",
    "C-group",
  ]);
  expect(chat).toMatchObject({
    chatExists: true,
    csv: "csv-U-chat",
    historyComplete: true,
    notesComplete: true,
    tagIds: ["tag-1"],
  });
  expect(noChat.csv).toBeNull();
  expect(groupChat).toMatchObject({
    type: "GROUP",
    rosterComplete: true,
    members: [
      {
        externalId: "U-member",
        name: "Member",
        nickname: "M",
        iconHash: "member-icon",
      },
    ],
  });
  expect(memberCalls).toEqual(["C-group"]);
  expect(JSON.stringify(result)).not.toContain("autoTagIds");
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});

test("missing tagIds fails instead of becoming an authoritative empty snapshot", async () => {
  const malformed = direct("U1");
  delete malformed.tagIds;
  mockApi({
    pages: { __first__: { list: [malformed], next: null } },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  expect(await scrapeOam({ basicId: "@x" })).toEqual({
    ok: false,
    error: "LINE_OAM_CONTACT_INVALID",
  });
});

test("a CSV larger than the former per-history ceiling is forwarded whole", async () => {
  const history = "x".repeat(1_300_000);
  mockApi({
    pages: { __first__: { list: [direct("U1")], next: null } },
    csv: async () => history,
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x" });
  expect(result.ok).toBe(true);
  expect(result.contacts).toHaveLength(1);
  expect(result.contacts[0].csv).toBe(history);
  expect(result).not.toHaveProperty("payloadBytes");
});

test("retrying the same cursor produces the same deterministic receipt contract", async () => {
  mockApi({
    pages: {
      __first__: {
        list: [direct("U1"), direct("U2")],
        next: null,
      },
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const first = await scrapeOam({ basicId: "@x" });
  const retry = await scrapeOam({ basicId: "@x" });

  expect(first).not.toHaveProperty("protocolVersion");
  expect(first.batchId).toBe("oam-0-3e225b5ce81eac7115eb527eaf22b172");
  expect(first.batchId).toBe(retry.batchId);
  expect(first.cursorIn).toBeNull();
  expect(first.cursorOut).toBe(retry.cursorOut);
  expect(first.contacts).toEqual(retry.contacts);
});

test("the complete 100-contact source page schedules while HTTP concurrency is limited separately", async () => {
  let inFlight = 0;
  let peakInFlight = 0;
  mockApi({
    pages: {
      __first__: {
        list: Array.from({ length: 100 }, (_, i) => direct(`U${i}`)),
        next: null,
      },
    },
    csv: async (_botId, chatId) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return `csv-${chatId}`;
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x" });

  expect(result.contacts).toHaveLength(100);
  // oam-api is mocked here, so this observes source-page scheduling rather than its independent
  // 35-request network ceiling.
  expect(peakInFlight).toBe(100);
});

test("an exhausted request aborts sibling work and preserves the rate-limit error", async () => {
  let abortedSiblings = 0;
  mockApi({
    pages: {
      __first__: {
        list: Array.from({ length: 100 }, (_, i) => direct(`U${i}`)),
        next: null,
      },
    },
    csv: async (_botId, chatId, { signal }) => {
      if (chatId === "U0") throw new Error("LINE_OAM_RATE_LIMITED");
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          abortedSiblings += 1;
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  expect(await scrapeOam({ basicId: "@x" })).toEqual({
    ok: false,
    error: "LINE_OAM_RATE_LIMITED",
  });
  expect(abortedSiblings).toBeGreaterThan(0);
});

test("out-of-order completion still yields page order and a prefix cursor", async () => {
  const finished = [];
  mockApi({
    pages: {
      __first__: {
        list: [direct("U1"), direct("U2"), direct("U3"), direct("U4")],
        next: null,
      },
    },
    // Later contacts settle first; a fold that trusted completion order would reverse the batch.
    csv: async (_botId, chatId) => {
      const rank = Number(chatId.slice(1));
      await new Promise((resolve) => setTimeout(resolve, (5 - rank) * 10));
      finished.push(chatId);
      return `csv-${chatId}`;
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x" });

  expect(finished[0]).toBe("U4");
  expect(result.contacts.map((contact) => contact.chatId)).toEqual([
    "U1",
    "U2",
    "U3",
    "U4",
  ]);
  expect(result.done).toBe(true);
});

test("the complete LINE source page is fetched before advancing to its next cursor", async () => {
  const fetched = [];
  mockApi({
    pages: {
      __first__: {
        list: Array.from({ length: 10 }, (_, i) => direct(`U${i}`)),
        next: "page-2",
      },
    },
    csv: async (_botId, chatId) => {
      fetched.push(chatId);
      return `csv-${chatId}`;
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x" });

  expect(result.contacts).toHaveLength(10);
  expect(fetched.sort()).toEqual(
    Array.from({ length: 10 }, (_, i) => `U${i}`).sort(),
  );
  expect(decodeCursor(result.cursorOut)).toMatchObject({
    pageToken: "page-2",
    processedContactIds: [],
  });
});

test("a batch of many contacts is forwarded without a PropertyOS byte ceiling", async () => {
  mockApi({
    pages: {
      __first__: {
        list: Array.from({ length: 8 }, (_, i) =>
          direct(`U${i}`, { tagIds: ["tag-1"] }),
        ),
        next: null,
      },
    },
    csv: async (_botId, chatId) => `${chatId}-${"แ".repeat(40)}`,
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x", includeTagCatalog: true });

  expect(result.contacts).toHaveLength(8);
  expect(result).not.toHaveProperty("payloadBytes");
});

test("one full 100-contact LINE page is one PropertyOS batch", async () => {
  mockApi({
    pages: {
      __first__: {
        list: Array.from({ length: 100 }, (_, i) =>
          direct(`U${i}`, { chatExists: false }),
        ),
        next: null,
      },
    },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  const result = await scrapeOam({ basicId: "@x" });

  expect(result.contacts).toHaveLength(100);
  expect(result.cursorOut).toBeNull();
  expect(result.done).toBe(true);
});

test("invalid cursor is distinct from session and network errors", async () => {
  mockApi({
    pages: { __first__: { list: [], next: null } },
  });
  const { scrapeOam } = await import("../src/scrape.js");

  expect(await scrapeOam({ basicId: "@x", cursor: "not-a-cursor" })).toEqual({
    ok: false,
    error: "LINE_OAM_CURSOR_INVALID",
  });
  const versionedCursor = btoa(
    JSON.stringify({
      v: 3,
      botId: "Ubot",
      pageToken: null,
      processedContactIds: [],
      sequence: 1,
    }),
  );
  expect(await scrapeOam({ basicId: "@x", cursor: versionedCursor })).toEqual({
    ok: false,
    error: "LINE_OAM_CURSOR_INVALID",
  });
});

test("ping reports the diagnostic extension version", async () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => manifest,
      onMessageExternal: {
        addListener: (listener) => listeners.push(listener),
      },
    },
  };
  const { handle } = await import("../src/background.js");

  expect(await handle({ action: "ping" })).toEqual({
    ok: true,
    version: "0.4.11",
  });
  expect(manifest.version).toBe("0.4.11");
  expect(packageJson.version).toBe("0.4.11");
  expect(manifest.key).toMatch(/^MIIB/);
  expect(listeners).toHaveLength(1);
});
