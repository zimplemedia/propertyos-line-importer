import { afterEach, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
const realFetch = globalThis.fetch;
const realRandom = Math.random;

afterEach(() => {
  globalThis.fetch = realFetch;
  Math.random = realRandom;
});

test("OAM requests use the 35-request production candidate ceiling", async () => {
  const { MAX_IN_FLIGHT, RATE_LIMIT_FALLBACK_MS } =
    await import("../src/oam-api.js");
  expect(MAX_IN_FLIGHT).toBe(35);
  expect(RATE_LIMIT_FALLBACK_MS).toBe(30_000);
});

test("sanitized tag fixture pins the observed list envelope", () => {
  const envelope = fixture("tags.json");
  expect(Object.keys(envelope)).toEqual(["list"]);
  expect(Array.isArray(envelope.list)).toBe(true);
  expect(envelope.list.length).toBeGreaterThan(1);
  expect(envelope.list).toEqual(
    envelope.list.map(({ tagId, name, count, createdAt, updatedAt }) => ({
      tagId,
      name,
      count,
      createdAt,
      updatedAt,
    })),
  );
});

test("sanitized contacts fixture covers supported rows, no-chat, tags, and rooms", () => {
  const page = fixture("contacts-page.json");
  const direct = page.list.find(
    (contact) => contact.contactId === "U-OAM-DIRECT",
  );
  const group = page.list.find(
    (contact) => contact.contactId === "C-OAM-GROUP",
  );
  const noChat = page.list.find(
    (contact) => contact.contactId === "U-OAM-NO-CHAT",
  );
  const room = page.list.find((contact) => contact.contactId === "R-OAM-ROOM");

  expect(direct.profile.userId).toBe(direct.contactId);
  expect(group.profile.groupId).toBe(group.contactId);
  expect(noChat.chatExists).toBe(false);
  expect(room.profile.roomId).toBe(room.contactId);
  for (const contact of page.list) {
    expect(Array.isArray(contact.tagIds)).toBe(true);
    expect(Array.isArray(contact.autoTagIds)).toBe(true);
  }
});

test("sanitized note fixtures pin empty and populated envelopes and five note fields", () => {
  const empty = fixture("notes-empty-page.json");
  const populated = fixture("notes-page.json");

  expect(empty).toEqual({ list: [], total: 0 });
  expect(populated.total).toBe(populated.list.length);
  expect(Object.keys(populated.list[0]).sort()).toEqual(
    ["noteId", "body", "userBizId", "createdAt", "updatedAt"].sort(),
  );
});

test("fetchChatNotes rejects a truncated note envelope without a continuation cursor", async () => {
  const { fetchChatNotes } = await import("../src/oam-api.js");
  expect(typeof fetchChatNotes).toBe("function");

  const populated = fixture("notes-page.json");
  global.fetch = async () =>
    new Response(
      JSON.stringify({ ...populated, total: populated.list.length + 1 }),
      {
        status: 200,
      },
    );

  await expect(fetchChatNotes("B1", "U-OAM-DIRECT")).rejects.toThrow(
    "LINE_OAM_NOTES_INCOMPLETE",
  );
});

test("fetchChatNotes follows next to exhaustion and returns a complete normalized snapshot", async () => {
  const makeNote = (index) => ({
    noteId: `note-${index}`,
    body: `Sanitized note ${index}`,
    userBizId: "sanitized-admin-id",
    createdAt: 1700000000000 + index,
    updatedAt: 1700000001000 + index,
    secret: "drop-me",
  });
  const allNotes = Array.from({ length: 25 }, (_, index) =>
    makeNote(index + 1),
  );
  const pages = {
    "": { list: allNotes.slice(0, 20), next: "notes-page-2", total: 25 },
    "notes-page-2": { list: allNotes.slice(20), total: 25 },
  };
  const requests = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    requests.push(parsed);
    return new Response(
      JSON.stringify(pages[parsed.searchParams.get("next") || ""]),
      { status: 200 },
    );
  };

  const { fetchChatNotes } = await import("../src/oam-api.js");
  expect(await fetchChatNotes("B1", "U-OAM-DIRECT")).toEqual(
    allNotes.map(({ noteId, body, userBizId, createdAt, updatedAt }) => ({
      noteId,
      body,
      userBizId,
      createdAt,
      updatedAt,
    })),
  );
  expect(requests).toHaveLength(2);
  expect(requests[0].searchParams.get("limit")).toBe("20");
  expect(requests[0].searchParams.get("withTotal")).toBe("true");
  expect(requests[0].searchParams.get("next")).toBeNull();
  expect(requests[1].searchParams.get("next")).toBe("notes-page-2");
});

test("fetchChatNotes rejects looping cursors, duplicate notes, and changing totals", async () => {
  const note = (noteId) => ({
    noteId,
    body: "Sanitized note",
    userBizId: null,
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
  });
  const { fetchChatNotes } = await import("../src/oam-api.js");

  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { list: [note("note-1")], next: "repeat", total: 3 }
          : { list: [note("note-2")], next: "repeat", total: 3 },
      ),
      { status: 200 },
    );
  };
  await expect(fetchChatNotes("B1", "U1")).rejects.toThrow(
    "LINE_OAM_NOTES_INVALID",
  );

  call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { list: [note("note-1")], next: "page-2", total: 2 }
          : { list: [note("note-1")], total: 2 },
      ),
      { status: 200 },
    );
  };
  await expect(fetchChatNotes("B1", "U1")).rejects.toThrow(
    "LINE_OAM_NOTES_INVALID",
  );

  call = 0;
  globalThis.fetch = async () => {
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { list: [note("note-1")], next: "page-2", total: 2 }
          : { list: [note("note-2")], total: 3 },
      ),
      { status: 200 },
    );
  };
  await expect(fetchChatNotes("B1", "U1")).rejects.toThrow(
    "LINE_OAM_NOTES_INVALID",
  );
});

test("fetchTags accepts only the observed list envelope and normalizes allowlisted fields", async () => {
  const { fetchTags } = await import("../src/oam-api.js");
  const envelope = fixture("tags.json");
  const tags = envelope.list;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        list: tags.map((tag) => ({ ...tag, secret: "drop-me" })),
      }),
      { status: 200 },
    );

  expect(await fetchTags("B1")).toEqual(tags);

  globalThis.fetch = async () =>
    new Response(JSON.stringify(tags), { status: 200 });
  await expect(fetchTags("B1")).rejects.toThrow("LINE_OAM_TAGS_INVALID");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ list: [{ ...tags[0], tagId: "" }] }), {
      status: 200,
    });
  await expect(fetchTags("B1")).rejects.toThrow("LINE_OAM_TAGS_INVALID");
});

test("fetchChatNotes normalizes only the five observed note fields", async () => {
  const { fetchChatNotes } = await import("../src/oam-api.js");
  const notes = fixture("notes-page.json");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ...notes,
        list: notes.list.map((note) => ({ ...note, secret: "drop-me" })),
      }),
      { status: 200 },
    );

  expect(await fetchChatNotes("B1", "U-OAM-DIRECT")).toEqual(notes.list);
});

test("new OAM endpoints retry 429 and map cookie expiry without exposing a Cookie header", async () => {
  const { fetchChatNotes, fetchTags } = await import("../src/oam-api.js");
  const tagsEnvelope = fixture("tags.json");
  const tags = tagsEnvelope.list;
  const notes = fixture("notes-page.json");
  const calls = [];
  Math.random = () => 0;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) {
      return new Response("", {
        status: 429,
        headers: { "retry-after": "0.001" },
      });
    }
    return new Response(JSON.stringify(tagsEnvelope), { status: 200 });
  };

  expect(await fetchTags("B1")).toEqual(tags);
  expect(calls).toHaveLength(2);
  for (const { options } of calls) {
    expect(options.credentials).toBe("include");
    expect(options.headers.Cookie).toBeUndefined();
  }

  globalThis.fetch = async () => new Response("", { status: 401 });
  await expect(fetchTags("B1")).rejects.toThrow("LINE_OAM_COOKIE_INVALID");
  globalThis.fetch = async () => new Response("", { status: 403 });
  await expect(fetchChatNotes("B1", "U1")).rejects.toThrow(
    "LINE_OAM_COOKIE_INVALID",
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify(notes), { status: 200 });
  expect(await fetchChatNotes("B1", "U1")).toEqual(notes.list);
});

test("persistent 429 stops after three total OAM request attempts", async () => {
  const { fetchTags } = await import("../src/oam-api.js");
  let calls = 0;
  Math.random = () => 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("", {
      status: 429,
      headers: { "retry-after": "0.001" },
    });
  };

  await expect(fetchTags("B1")).rejects.toThrow("LINE_OAM_RATE_LIMITED");
  expect(calls).toBe(3);
});

test("one 429 allows only its owner to probe before reopening the shared gate", async () => {
  const { fetchTags } = await import("../src/oam-api.js");
  const tagsEnvelope = fixture("tags.json");
  const callTimes = [];
  let releaseProbe;
  let markProbeStarted;
  const probeStarted = new Promise((resolve) => {
    markProbeStarted = resolve;
  });
  globalThis.fetch = async () => {
    callTimes.push(Date.now());
    if (callTimes.length === 1) {
      return new Response("", {
        status: 429,
        headers: { "retry-after": "0.05" },
      });
    }
    if (callTimes.length === 2) {
      markProbeStarted();
      return new Promise((resolve) => {
        releaseProbe = () =>
          resolve(new Response(JSON.stringify(tagsEnvelope), { status: 200 }));
      });
    }
    return new Response(JSON.stringify(tagsEnvelope), { status: 200 });
  };

  const first = fetchTags("B1");
  while (callTimes.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  // Give limitedFetch's response continuation time to close the gate before adding another caller.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = fetchTags("B1");

  await probeStarted;
  expect(callTimes).toHaveLength(2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // The unrelated caller remains parked even though the cooldown expired; only the owner probes.
  expect(callTimes).toHaveLength(2);
  releaseProbe();
  await Promise.all([first, second]);
  expect(callTimes).toHaveLength(3);
  expect(Math.min(...callTimes.slice(1)) - callTimes[0]).toBeGreaterThanOrEqual(
    40,
  );
});

test("validateOamSession is true on 200, false on 401", async () => {
  const { validateOamSession } = await import("../src/oam-api.js");
  global.fetch = async () => new Response("{}", { status: 200 });
  expect(await validateOamSession()).toBe(true);
  global.fetch = async () => new Response("no", { status: 401 });
  expect(await validateOamSession()).toBe(false);
});

test("resolveOamBotId matches basicId (ignoring @ and case), else throws", async () => {
  const { resolveOamBotId } = await import("../src/oam-api.js");
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        list: [
          { botId: "Uaaa", basicSearchId: "@070qfvsc" },
          { botId: "Ubbb", basicSearchId: "@other" },
        ],
      }),
      { status: 200 },
    );
  expect(await resolveOamBotId("070QFVSC")).toBe("Uaaa");
  global.fetch = async () =>
    new Response(JSON.stringify({ list: [] }), { status: 200 });
  await expect(resolveOamBotId("@nope")).rejects.toThrow(
    "LINE_OAM_BOT_NOT_FOUND",
  );
});

test("downloadChatCsv returns text; 401 throws LINE_OAM_COOKIE_INVALID", async () => {
  const { downloadChatCsv } = await import("../src/oam-api.js");
  global.fetch = async () => new Response("Sender type,...", { status: 200 });
  expect(await downloadChatCsv("Ub", "c1")).toContain("Sender type");
  global.fetch = async () => new Response("", { status: 401 });
  await expect(downloadChatCsv("Ub", "c1")).rejects.toThrow(
    "LINE_OAM_COOKIE_INVALID",
  );
});

test("oamFetch retries a rejected fetch (network drop) then succeeds", async () => {
  const { downloadChatCsv } = await import("../src/oam-api.js");
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("Failed to fetch"); // e.g. net::ERR_NETWORK_CHANGED
    return new Response("Sender type,ok", { status: 200 });
  };
  expect(await downloadChatCsv("Ub", "c1")).toContain("Sender type");
  expect(calls).toBe(2); // dropped once, retried, recovered
});

test("fetch sends credentials:include and no Cookie header", async () => {
  const { fetchContactsPage } = await import("../src/oam-api.js");
  let opts;
  let requestedUrl;
  global.fetch = async (url, o) => {
    requestedUrl = new URL(String(url));
    opts = o;
    return new Response(JSON.stringify({ list: [], next: null }), {
      status: 200,
    });
  };
  await fetchContactsPage("Ub");
  expect(opts.credentials).toBe("include");
  expect(opts.headers.Cookie).toBeUndefined();
  expect(requestedUrl.searchParams.get("sortKey")).toBe("LAST_TALKED_AT");
  expect(requestedUrl.searchParams.get("sortOrder")).toBe("ASC");
});

test("contacts rejects a source page larger than the requested 100", async () => {
  const { fetchContactsPage } = await import("../src/oam-api.js");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        list: Array.from({ length: 101 }, (_, index) => ({
          contactId: `U${index}`,
        })),
        next: null,
      }),
      { status: 200 },
    );

  await expect(fetchContactsPage("B1")).rejects.toThrow(
    "LINE_OAM_CONTACT_INVALID",
  );
});

test("global HTTP concurrency never exceeds the 35-request ceiling", async () => {
  const { fetchTags, MAX_IN_FLIGHT } = await import("../src/oam-api.js");
  const tagsEnvelope = fixture("tags.json");
  let active = 0;
  let peak = 0;
  const releasers = [];
  globalThis.fetch = () =>
    new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releasers.push(() => {
        active -= 1;
        resolve(new Response(JSON.stringify(tagsEnvelope), { status: 200 }));
      });
    });

  const calls = Array.from({ length: MAX_IN_FLIGHT + 15 }, () => fetchTags("B1"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(active).toBe(MAX_IN_FLIGHT);
  expect(peak).toBe(MAX_IN_FLIGHT);

  while (active > 0) {
    releasers.splice(0, releasers.length).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.all(calls);
  expect(peak).toBe(MAX_IN_FLIGHT);
});

test("there is no artificial gap between concurrently admitted request starts", async () => {
  const { fetchTags } = await import("../src/oam-api.js");
  const tagsEnvelope = fixture("tags.json");
  const starts = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    return new Response(JSON.stringify(tagsEnvelope), { status: 200 });
  };

  await Promise.all(Array.from({ length: 10 }, () => fetchTags("B1")));
  // With the old 10ms pacing, 10 concurrent requests would spread over >= 90ms. With none, they
  // should all start within a couple of milliseconds of each other.
  expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(10);
});

function makeFakeClock() {
  let t = 0;
  const now = () => t;
  // Concurrent waiters targeting the same deadline must not compound: each captures its own target
  // synchronously, then only ever advances the clock forward, never past what it itself needed.
  const sleepFn = (ms) => {
    const target = t + ms;
    return Promise.resolve().then(() => {
      if (t < target) t = target;
    });
  };
  return { now, sleepFn, advance: (ms) => { t += ms; } };
}

test("CSV governor admits all of the first 900 requests without any wait", async () => {
  const { createCsvQuotaGovernor, CSV_QUOTA_BUDGET } = await import(
    "../src/oam-api.js"
  );
  expect(CSV_QUOTA_BUDGET).toBe(900);
  const { now, sleepFn } = makeFakeClock();
  const governor = createCsvQuotaGovernor({ now, sleepFn });

  for (let i = 0; i < CSV_QUOTA_BUDGET; i++) {
    await governor.acquire();
  }
  expect(now()).toBe(0);
});

test("CSV admission 901 waits out the full continuous 35-second pause", async () => {
  const { createCsvQuotaGovernor, CSV_QUOTA_BUDGET, CSV_QUOTA_PAUSE_MS } =
    await import("../src/oam-api.js");
  expect(CSV_QUOTA_PAUSE_MS).toBe(35_000);
  const { now, sleepFn } = makeFakeClock();
  const governor = createCsvQuotaGovernor({ now, sleepFn });

  for (let i = 0; i < CSV_QUOTA_BUDGET; i++) await governor.acquire();
  const before = now();
  await governor.acquire();
  expect(now() - before).toBe(CSV_QUOTA_PAUSE_MS);
});

test("concurrent CSV callers cannot be admitted past the budget before the pause starts", async () => {
  const { createCsvQuotaGovernor } = await import("../src/oam-api.js");
  // Real clock/sleep with a scaled-down pause: fake-clock self-advancement resolves on a microtask
  // regardless of concurrency, which erases the real-world separation this test needs between
  // "admitted immediately" and "waiting out the pause." A small real pause keeps the test fast while
  // giving genuine wall-clock separation between those two outcomes.
  const governor = createCsvQuotaGovernor({ budget: 3, pauseMs: 30 });

  const resolved = [];
  const calls = Array.from({ length: 7 }, (_, index) =>
    governor.acquire().then(() => resolved.push(index)),
  );
  await new Promise((resolve) => setTimeout(resolve, 5)); // well before the 30ms pause can elapse
  expect(resolved.length).toBe(3);

  await Promise.all(calls);
  expect(resolved.length).toBe(7);
});

test("natural CSV inactivity for the full pause duration resets the budget on its own", async () => {
  const { createCsvQuotaGovernor } = await import("../src/oam-api.js");
  const { now, sleepFn, advance } = makeFakeClock();
  const governor = createCsvQuotaGovernor({ budget: 3, pauseMs: 1000, now, sleepFn });

  await governor.acquire();
  await governor.acquire();
  await governor.acquire(); // budget exhausted; nobody has tried a 4th yet
  advance(1000); // idle for the full pause with no caller pending
  const before = now();
  await governor.acquire(); // admitted immediately — the reset happened without an explicit pause
  expect(now()).toBe(before);
});

test("non-CSV endpoints keep working while the CSV governor is paused", async () => {
  const {
    downloadChatCsv,
    fetchTags,
    createCsvQuotaGovernor,
    __setCsvQuotaGovernorForTests,
  } = await import("../src/oam-api.js");
  const { now, sleepFn, advance } = makeFakeClock();
  __setCsvQuotaGovernorForTests(
    createCsvQuotaGovernor({ budget: 1, pauseMs: 5000, now, sleepFn }),
  );
  const tagsEnvelope = fixture("tags.json");
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("messages.csv")) {
      return new Response("Sender type,ok", { status: 200 });
    }
    return new Response(JSON.stringify(tagsEnvelope), { status: 200 });
  };

  await downloadChatCsv("Ub", "c1"); // consumes the only admission
  const pendingCsv = downloadChatCsv("Ub", "c2"); // now paused for 5s (fake clock)

  expect(await fetchTags("B1")).toEqual(tagsEnvelope.list);

  advance(5000);
  await pendingCsv;
  __setCsvQuotaGovernorForTests();
});

test("an aborted CSV waiter stops promptly instead of waiting out the pause", async () => {
  const { createCsvQuotaGovernor } = await import("../src/oam-api.js");
  const governor = createCsvQuotaGovernor({ budget: 1, pauseMs: 5000 });
  await governor.acquire();

  const controller = new AbortController();
  const startedAt = Date.now();
  const pending = governor.acquire(controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(Date.now() - startedAt).toBeLessThan(100);
});

test("a sibling 429 with a larger retry-after does not extend the winning probe's cooldown", async () => {
  const { fetchTags, fetchChatMembers } = await import("../src/oam-api.js");
  const tagsEnvelope = fixture("tags.json");
  Math.random = () => 0;
  let tagsCalls = 0;
  let membersCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/tags")) {
      tagsCalls += 1;
      if (tagsCalls === 1) {
        return new Response("", {
          status: 429,
          headers: { "retry-after": "0.02" },
        });
      }
      return new Response(JSON.stringify(tagsEnvelope), { status: 200 });
    }
    membersCalls += 1;
    if (membersCalls === 1) {
      // The sibling's only failure — a much larger retry-after, arriving after the gate the tags
      // call already closed. It must succeed once retried so it doesn't become its own probe and
      // leave a second, unrelated cooldown active for later tests.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response("", { status: 429, headers: { "retry-after": "2" } });
    }
    return new Response(JSON.stringify({ list: [] }), { status: 200 });
  };

  const startedAt = Date.now();
  const tagsResult = fetchTags("B1");
  const membersResult = fetchChatMembers("B1", "C1");
  await tagsResult;
  const elapsed = Date.now() - startedAt;
  await membersResult;
  // If the sibling's 2-second retry-after had extended the cooldown (the ratchet bug), recovery
  // would take >2s. It should instead land close to the winning probe's own 20ms cooldown.
  expect(elapsed).toBeLessThan(500);
});

test("a repeat 429 from the probe itself establishes a fresh cooldown", async () => {
  const { fetchTags } = await import("../src/oam-api.js");
  const tagsEnvelope = fixture("tags.json");
  Math.random = () => 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response("", {
        status: 429,
        headers: { "retry-after": "0.03" },
      });
    }
    return new Response(JSON.stringify(tagsEnvelope), { status: 200 });
  };

  const startedAt = Date.now();
  await fetchTags("B1");
  const elapsed = Date.now() - startedAt;
  expect(calls).toBe(3);
  // Two sequential 30ms cooldowns (the first failure, then the probe's own repeat failure) — not
  // ~30ms (which would mean the repeat was wrongly treated as a non-extending sibling) and not
  // near-zero (which would mean it was ignored outright).
  expect(elapsed).toBeGreaterThanOrEqual(55);
  expect(elapsed).toBeLessThan(500);
});

test("fetchChatMembers pages next to exhaustion and normalizes", async () => {
  const pages = {
    "": { list: [{ userId: "U1", name: "Mew", iconHash: "h1" }], next: "c2" },
    c2: {
      list: [
        { userId: "U2", name: "Tukta", nickname: "K.ตุ๊กตา", iconHash: "h2" },
      ],
    },
  };
  globalThis.fetch = async (url) => {
    const next =
      new URL(
        "https://chat.line.biz" + url.replace("https://chat.line.biz", ""),
      ).searchParams.get("next") || "";
    return new Response(JSON.stringify(pages[next]), { status: 200 });
  };
  const { fetchChatMembers } = await import("../src/oam-api.js");
  const members = await fetchChatMembers("B1", "C7f664");
  expect(members).toEqual([
    { userId: "U1", name: "Mew", nickname: null, iconHash: "h1" },
    { userId: "U2", name: "Tukta", nickname: "K.ตุ๊กตา", iconHash: "h2" },
  ]);
});
