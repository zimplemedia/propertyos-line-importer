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
  const { downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  __resetCsvForTests();
  global.fetch = async () => new Response("Sender type,...", { status: 200 });
  expect(await downloadChatCsv("Ub", "c1")).toContain("Sender type");
  __resetCsvForTests(); // avoid a real 67ms spacing wait between these two unrelated calls
  global.fetch = async () => new Response("", { status: 401 });
  await expect(downloadChatCsv("Ub", "c1")).rejects.toThrow(
    "LINE_OAM_COOKIE_INVALID",
  );
});

test("oamFetch retries a rejected fetch (network drop) then succeeds", async () => {
  const { downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  __resetCsvForTests();
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

  const calls = Array.from({ length: MAX_IN_FLIGHT + 15 }, () =>
    fetchTags("B1"),
  );
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
  // Non-CSV endpoints are never subject to the CSV-only 67ms spacing gate: with none, all 10 should
  // start within a couple of milliseconds of each other.
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
  return {
    now,
    sleepFn,
    advance: (ms) => {
      t += ms;
    },
  };
}

// --- CSV admission spacing --------------------------------------------------------------------

test("concurrent CSV calls produce actual fetch starts at least 67ms apart", async () => {
  const { downloadChatCsv, CSV_START_SPACING_MS, __resetCsvForTests } =
    await import("../src/oam-api.js");
  __resetCsvForTests();
  const dispatchTimes = [];
  globalThis.fetch = async () => {
    dispatchTimes.push(Date.now());
    return new Response("Sender type,ok", { status: 200 });
  };
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => downloadChatCsv("B1", `c${i}`)),
  );
  dispatchTimes.sort((a, b) => a - b);
  for (let i = 1; i < dispatchTimes.length; i++) {
    expect(dispatchTimes[i] - dispatchTimes[i - 1]).toBeGreaterThanOrEqual(
      CSV_START_SPACING_MS - 1,
    );
  }
});

test("a delayed timer/browser wake-up does not release multiple CSV calls simultaneously", async () => {
  const { downloadChatCsv, CSV_START_SPACING_MS, __resetCsvForTests } =
    await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  const dispatchTimes = [];
  globalThis.fetch = async () => {
    dispatchTimes.push(now());
    return new Response("Sender type,ok", { status: 200 });
  };
  // All 5 calls arrive "at once" (a single Promise.all tick) -- the equivalent of several overdue
  // timers all firing together after a suspended tab wakes up. The serialized spacing chain must
  // still stagger their actual dispatches one at a time against the fake clock.
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => downloadChatCsv("B1", `c${i}`)),
  );
  dispatchTimes.sort((a, b) => a - b);
  expect(dispatchTimes).toEqual([0, 67, 134, 201, 268]);
  for (let i = 1; i < dispatchTimes.length; i++) {
    expect(dispatchTimes[i] - dispatchTimes[i - 1]).toBe(CSV_START_SPACING_MS);
  }
});

// --- CSV 429 recovery: 2s probe, 60s fallback, three attempts total ---------------------------

test("a CSV 429 waits 2s before exactly one probe; success reopens the gate", async () => {
  const { downloadChatCsv, CSV_FIRST_429_RETRY_MS, __resetCsvForTests } =
    await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  let calls = 0;
  const callTimes = [];
  globalThis.fetch = async () => {
    calls += 1;
    callTimes.push(now());
    if (calls === 1) return new Response("", { status: 429 });
    return new Response("Sender type,ok", { status: 200 });
  };
  const result = await downloadChatCsv("B1", "c1");
  expect(result).toContain("Sender type");
  expect(calls).toBe(2);
  expect(callTimes[1] - callTimes[0]).toBe(CSV_FIRST_429_RETRY_MS);
});

test("if the first probe also 429s, the same request waits 60s before its third and final attempt", async () => {
  const {
    downloadChatCsv,
    CSV_FIRST_429_RETRY_MS,
    CSV_FINAL_429_RETRY_MS,
    __resetCsvForTests,
  } = await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  let calls = 0;
  const callTimes = [];
  globalThis.fetch = async () => {
    calls += 1;
    callTimes.push(now());
    if (calls <= 2) return new Response("", { status: 429 });
    return new Response("Sender type,ok", { status: 200 });
  };
  const result = await downloadChatCsv("B1", "c1");
  expect(result).toContain("Sender type");
  expect(calls).toBe(3);
  expect(callTimes[1] - callTimes[0]).toBe(CSV_FIRST_429_RETRY_MS);
  expect(callTimes[2] - callTimes[1]).toBe(CSV_FINAL_429_RETRY_MS);
});

test("a third 429 throws LINE_OAM_RATE_LIMITED after exactly three total attempts, not three retries", async () => {
  const { downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("", { status: 429 });
  };
  await expect(downloadChatCsv("B1", "c1")).rejects.toThrow(
    "LINE_OAM_RATE_LIMITED",
  );
  expect(calls).toBe(3);
});

test("a later top-level scrape gets a fresh CSV gate after the previous scrape exhausts 429 recovery", async () => {
  const { beginCsvScrapeCycle, downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 3) return new Response("", { status: 429 });
    return new Response("Sender type,resumed", { status: 200 });
  };

  const endFailedScrape = beginCsvScrapeCycle();
  await expect(downloadChatCsv("B1", "failed-chat")).rejects.toThrow(
    "LINE_OAM_RATE_LIMITED",
  );

  // A scrape that overlaps the failed owner still belongs to the same failed cycle. It must not
  // reopen the gate or dispatch any additional request from the old browser collection.
  const endOverlappingScrape = beginCsvScrapeCycle();
  await expect(downloadChatCsv("B1", "old-sibling")).rejects.toThrow(
    "LINE_OAM_RATE_LIMITED",
  );
  expect(calls).toBe(3);
  endOverlappingScrape();
  endFailedScrape();

  // Once every old scrape has unwound, an explicit later Resume starts a fresh recovery cycle.
  const endResumedScrape = beginCsvScrapeCycle();
  await expect(downloadChatCsv("B1", "resumed-chat")).resolves.toContain(
    "resumed",
  );
  endResumedScrape();
  expect(calls).toBe(4);
});

test("a valid Retry-After overrides the applicable CSV fallback delay", async () => {
  const { downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  let calls = 0;
  const callTimes = [];
  globalThis.fetch = async () => {
    calls += 1;
    callTimes.push(now());
    if (calls === 1) {
      return new Response("", { status: 429, headers: { "retry-after": "5" } });
    }
    return new Response("Sender type,ok", { status: 200 });
  };
  await downloadChatCsv("B1", "c1");
  expect(callTimes[1] - callTimes[0]).toBe(5_000); // honored the 5s header, not the 2s fallback
});

// --- Sibling coordination ------------------------------------------------------------------

test("sibling 429s from the same burst do not extend the deadline or become additional probes, and resume at 67ms spacing after recovery", async () => {
  const {
    downloadChatCsv,
    CSV_START_SPACING_MS,
    CSV_FIRST_429_RETRY_MS,
    __resetCsvForTests,
  } = await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });

  const dispatched = [];
  let resolveOwnerFirst;
  let resolveSiblingFirst;
  const ownerFirstResponse = new Promise((r) => {
    resolveOwnerFirst = r;
  });
  const siblingFirstResponse = new Promise((r) => {
    resolveSiblingFirst = r;
  });
  let ownerAttempt = 0;
  let siblingAttempt = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes("owner-chat")) {
      ownerAttempt += 1;
      dispatched.push({ label: "owner", at: now() });
      if (ownerAttempt === 1) return ownerFirstResponse;
      return new Response("Sender type,owner-ok", { status: 200 });
    }
    siblingAttempt += 1;
    dispatched.push({ label: "sibling", at: now() });
    if (siblingAttempt === 1) return siblingFirstResponse;
    return new Response("Sender type,sibling-ok", { status: 200 });
  };

  const owner = downloadChatCsv("B1", "owner-chat");
  const sibling = downloadChatCsv("B1", "sibling-chat");

  // Let both first attempts actually dispatch (67ms apart on the fake clock, but neither has a
  // response yet) before either 429 is observed -- the "several CSV requests already in flight"
  // scenario from the brief.
  while (dispatched.length < 2) await new Promise((r) => setTimeout(r, 1));

  // The owner's 429 lands first, closing the gate and claiming ownership. The sibling's 429 -- from
  // the same in-flight burst -- lands right after, with a much larger retry-after that must NOT
  // extend the owner's 2s deadline or start a second probe. Both are resolved back-to-back with no
  // intervening macrotask: the fake clock's sleepFn resolves on a microtask regardless of its `ms`
  // argument, so a real setTimeout gap here would let the owner's entire 2s-wait-then-probe cycle
  // race to completion before the sibling's failure is even processed, defeating the test.
  resolveOwnerFirst(new Response("", { status: 429 }));
  resolveSiblingFirst(
    new Response("", { status: 429, headers: { "retry-after": "50" } }),
  );

  const [ownerResult, siblingResult] = await Promise.all([owner, sibling]);
  expect(ownerResult).toContain("owner-ok");
  expect(siblingResult).toContain("sibling-ok");
  // If the sibling's 50s retry-after had been honored as a new deadline, this would take 50s+ on
  // the fake clock. It resolves close to the owner's original 2s deadline instead.
  expect(now()).toBeLessThan(CSV_FIRST_429_RETRY_MS + 5_000);

  const ownerDispatches = dispatched
    .filter((d) => d.label === "owner")
    .map((d) => d.at);
  const siblingDispatches = dispatched
    .filter((d) => d.label === "sibling")
    .map((d) => d.at);
  expect(ownerDispatches).toHaveLength(2); // initial failure + the one probe
  expect(siblingDispatches).toHaveLength(2); // initial failure + resumed attempt (never a probe)
  // The sibling's resumed attempt went back through the normal 67ms spacing queue rather than
  // firing in lockstep with the owner's probe.
  expect(
    Math.abs(siblingDispatches[1] - ownerDispatches[1]),
  ).toBeGreaterThanOrEqual(CSV_START_SPACING_MS);
});

// --- Endpoint isolation ------------------------------------------------------------------------

test("notes, contacts, and members keep working while the CSV gate is closed", async () => {
  const {
    downloadChatCsv,
    fetchChatNotes,
    fetchContactsPage,
    fetchChatMembers,
    __resetCsvForTests,
  } = await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });
  let csvAttempt = 0;
  let resolveProbe;
  const probePending = new Promise((r) => {
    resolveProbe = r;
  });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.includes("messages.csv")) {
      csvAttempt += 1;
      if (csvAttempt === 1) return new Response("", { status: 429 });
      return probePending; // deliberately never auto-resolves, so it cannot race ahead of the
      // real-time waits below the way a fake-clock sleep otherwise would
    }
    if (path.includes("/notes"))
      return new Response(JSON.stringify({ list: [], total: 0 }), {
        status: 200,
      });
    if (path.includes("/contacts"))
      return new Response(JSON.stringify({ list: [], next: null }), {
        status: 200,
      });
    if (path.includes("/members"))
      return new Response(JSON.stringify({ list: [] }), { status: 200 });
    return new Response("{}", { status: 200 });
  };

  const pendingCsv = downloadChatCsv("B1", "c1"); // will 429, wait 2s (fake clock), then probe
  // Wait for the CSV request to actually reach its probe dispatch -- i.e. the 429, the 2s fake wait,
  // and the second fetch() call have all happened, and it is now genuinely stuck on probePending.
  while (csvAttempt < 2) await new Promise((r) => setTimeout(r, 1));

  await Promise.all([
    fetchChatNotes("B1", "c2"),
    fetchContactsPage("B1"),
    fetchChatMembers("B1", "c2"),
  ]);
  // None of these were delayed by the closed CSV gate -- the CSV request is still stuck waiting on
  // its own probe response.
  let csvSettled = false;
  pendingCsv.then(() => {
    csvSettled = true;
  });
  await Promise.resolve();
  expect(csvSettled).toBe(false);

  resolveProbe(new Response("Sender type,ok", { status: 200 }));
  await pendingCsv;
});

// --- Abort safety --------------------------------------------------------------------------

test("aborting the owner while it waits out its own probe delay reopens the gate for later callers", async () => {
  const { downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  let gateWaits = 0;
  // A real clock so the spacing check (csvNextDispatchAt vs. now()) naturally clears itself as real
  // time passes, paired with a sleepFn that resolves short (spacing-sized) waits normally but only
  // ever settles a long (gate-recovery-sized) wait via the abort signal. That lets the test abort
  // while genuinely still parked in the 2s/60s GATE wait specifically, instead of racing against a
  // self-resolving fake clock (whose sleeps all resolve on the next microtask regardless of the
  // requested duration, letting the whole three-attempt cycle race to completion before the abort
  // ever fires) or stalling forever on the unrelated, legitimately-short spacing wait a later call
  // must still serve against the aborted call's own real dispatch.
  const now = Date.now;
  const sleepFn = (ms, signal) => {
    if (ms < 1000) return new Promise((resolve) => setTimeout(resolve, ms));
    gateWaits += 1;
    return new Promise((resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("aborted"),
          ),
        { once: true },
      );
    });
  };
  __resetCsvForTests({ now, sleepFn });
  globalThis.fetch = async () => new Response("", { status: 429 });

  const controller = new AbortController();
  const first = downloadChatCsv("B1", "c1", { signal: controller.signal });
  while (gateWaits < 1) await new Promise((r) => setTimeout(r, 1));
  controller.abort();
  await expect(first).rejects.toThrow();

  // The gate must not be left stuck closed forever: a fresh call is free to become the new owner
  // immediately -- it may still owe the normal spacing gap against the aborted call's own real
  // dispatch, but it must never fall into ANOTHER gate-recovery wait, since nothing 429'd for it.
  globalThis.fetch = async () =>
    new Response("Sender type,ok", { status: 200 });
  const gateWaitsBefore = gateWaits;
  const result = await downloadChatCsv("B1", "c2");
  expect(result).toContain("Sender type");
  expect(gateWaits).toBe(gateWaitsBefore); // no additional 2s/60s gate wait was ever entered
});

test("aborting a parked (non-owner) sibling does not strand it or corrupt the gate for others", async () => {
  const { downloadChatCsv, __resetCsvForTests } =
    await import("../src/oam-api.js");
  const { now, sleepFn } = makeFakeClock();
  __resetCsvForTests({ now, sleepFn });

  let ownerAttempt = 0;
  let siblingAttempt = 0;
  let resolveOwnerProbe;
  const ownerProbePending = new Promise((r) => {
    resolveOwnerProbe = r;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("owner")) {
      ownerAttempt += 1;
      if (ownerAttempt === 1) return new Response("", { status: 429 });
      return ownerProbePending; // stays pending until the test resolves it
    }
    siblingAttempt += 1;
    return new Response("Sender type,sibling-ok", { status: 200 });
  };

  const owner = downloadChatCsv("B1", "owner-chat");
  // Wait for the owner to reach its probe dispatch (429, 2s fake wait, second fetch() call) -- the
  // gate is now closed and stays closed until ownerProbePending is resolved.
  while (ownerAttempt < 2) await new Promise((r) => setTimeout(r, 1));

  const controller = new AbortController();
  const sibling = downloadChatCsv("B1", "sibling-chat", {
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 1));
  expect(siblingAttempt).toBe(0); // parked at the gate, never dispatched a fetch of its own

  controller.abort();
  await expect(sibling).rejects.toThrow();
  expect(siblingAttempt).toBe(0); // aborting while parked never dispatched a fetch at all

  // The owner's own recovery is completely unaffected by the sibling's abort.
  resolveOwnerProbe(new Response("Sender type,owner-ok", { status: 200 }));
  const ownerResult = await owner;
  expect(ownerResult).toContain("owner-ok");
});

test("aborting a CSV request while it waits for HTTP capacity does not leak the slot", async () => {
  const { downloadChatCsv, fetchTags, MAX_IN_FLIGHT, __resetCsvForTests } =
    await import("../src/oam-api.js");
  __resetCsvForTests();
  const tagsEnvelope = fixture("tags.json");
  let active = 0;
  let peak = 0;
  const releasers = [];
  globalThis.fetch = (url) =>
    new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releasers.push(() => {
        active -= 1;
        const body = String(url).includes("messages.csv")
          ? "Sender type,ok"
          : JSON.stringify(tagsEnvelope);
        resolve(new Response(body, { status: 200 }));
      });
    });

  // Fill the shared pool with fast non-CSV calls -- CSV fillers would need MAX_IN_FLIGHT * 67ms of
  // real spacing delay just to all dispatch, which is unrelated to what this test is checking.
  const fillers = Array.from({ length: MAX_IN_FLIGHT }, () => fetchTags("B1"));
  await new Promise((r) => setTimeout(r, 10));
  expect(active).toBe(MAX_IN_FLIGHT);

  const controller = new AbortController();
  const waiter = downloadChatCsv("B1", "waiter", { signal: controller.signal });
  controller.abort();
  await expect(waiter).rejects.toThrow();

  // The aborted waiter must not have leaked a phantom slot: draining the pool normally should let
  // every filler resolve, and peak concurrency should never have exceeded the real ceiling.
  releasers.splice(0).forEach((release) => release());
  await Promise.all(fillers);
  expect(peak).toBe(MAX_IN_FLIGHT);
});

// --- No governor exports remain --------------------------------------------------------------

test("no 900-request/35-second governor exports remain; the new CSV constants are exact", async () => {
  const mod = await import("../src/oam-api.js");
  expect(mod.CSV_QUOTA_BUDGET).toBeUndefined();
  expect(mod.CSV_QUOTA_PAUSE_MS).toBeUndefined();
  expect(mod.createCsvQuotaGovernor).toBeUndefined();
  expect(mod.csvQuotaGovernor).toBeUndefined();
  expect(mod.__setCsvQuotaGovernorForTests).toBeUndefined();
  expect(mod.CSV_START_SPACING_MS).toBe(67);
  expect(mod.CSV_FIRST_429_RETRY_MS).toBe(2_000);
  expect(mod.CSV_FINAL_429_RETRY_MS).toBe(60_000);
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
