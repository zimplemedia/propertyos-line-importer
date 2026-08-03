// chat.line.biz — the OA Manager console's private API, scraped IN THE BROWSER. The session
// cookie auto-attaches via credentials:'include' under host_permissions; it is never read here.
const BASE = "https://chat.line.biz";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "x-oa-chat-client-version": "20240513144702",
};
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every request to chat.line.biz passes through here, so raising the scraper's contact concurrency
// widens the work queue without widening the load OAM actually sees.
//
// MAX_IN_FLIGHT is the real protection. The spacing is only a burst damper for the moment many slots
// free at once — deliberately small, because it applies to EVERY request: one batch is ~51 of them,
// so each 10ms of spacing adds ~0.5s to that batch and the run is ~900 batches long.
const MAX_IN_FLIGHT = 12;
const MIN_REQUEST_SPACING_MS = 10;
let inFlight = 0;
let nextSlotAt = 0;
const waiting = [];

async function acquireRequestSlot() {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  inFlight++;
  // A monotonically advancing schedule, not a shared "last start" timestamp: concurrent acquirers
  // each claim their own slot instead of all reading the same value and waking together.
  const now = Date.now();
  const startAt = Math.max(now, nextSlotAt);
  nextSlotAt = startAt + MIN_REQUEST_SPACING_MS;
  if (startAt > now) await sleep(startAt - now);
}

function releaseRequestSlot() {
  inFlight--;
  waiting.shift()?.();
}

async function limitedFetch(url, options) {
  await acquireRequestSlot();
  try {
    return await fetch(url, options);
  } finally {
    releaseRequestSlot();
  }
}

async function oamFetch(
  path,
  { accept } = {},
  { maxRetries = 4, baseDelayMs = 500 } = {},
) {
  const headers = { ...HEADERS, ...(accept ? { Accept: accept } : {}) };
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await limitedFetch(BASE + path, {
        credentials: "include",
        headers,
      });
    } catch (e) {
      // A REJECTED fetch is a transient network drop (net::ERR_NETWORK_CHANGED on a WiFi/VPN switch,
      // a brief offline blip) — not an HTTP status, so it never reaches the RETRYABLE check below.
      // Back off and retry; only surface it once the attempts are spent.
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs);
        continue;
      }
      throw new Error("LINE_NETWORK_ERROR");
    }
    if (res.status === 401 || res.status === 403)
      throw new Error("LINE_OAM_COOKIE_INVALID");
    if (res.ok) return res;
    if (RETRYABLE.has(res.status) && attempt < maxRetries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(
        (ra > 0 ? ra * 1000 : baseDelayMs * 2 ** attempt) +
          Math.random() * baseDelayMs,
      );
      continue;
    }
    const error = new Error("LINE_API_ERROR");
    error.status = res.status;
    throw error;
  }
}

export async function validateOamSession() {
  try {
    await oamFetch("/api/v1/me");
    return true;
  } catch {
    return false;
  }
}

// Confirmed by the Task 1 spike (2026-06-29): GET /api/v1/bots?limit=1000&noFilter=true
// → { list: [ { botId, basicSearchId: '@handle', name, iconHash, ... } ] }
const BOTS_ENDPOINT = "/api/v1/bots?limit=1000&noFilter=true";
const normalizeHandle = (h) =>
  String(h || "")
    .replace(/^@/, "")
    .toLowerCase();

export async function resolveOamBotId(basicId) {
  const res = await oamFetch(BOTS_ENDPOINT);
  const data = await res.json();
  const list = data.list || data.bots || (Array.isArray(data) ? data : []);
  const target = normalizeHandle(basicId);
  const bot = list.find(
    (b) => normalizeHandle(b.basicSearchId || b.basicId) === target,
  );
  if (!bot) throw new Error("LINE_OAM_BOT_NOT_FOUND");
  return bot.botId || bot.id;
}

export async function fetchContactsPage(botId, pageToken) {
  const qs = new URLSearchParams({
    query: "",
    sortKey: "DISPLAY_NAME",
    sortOrder: "ASC",
    filterKey: "ALL",
    limit: "100",
  });
  if (pageToken) qs.set("next", pageToken);
  try {
    const res = await oamFetch(
      `/api/v2/bots/${endpointSegment(botId)}/contacts?${qs.toString()}`,
    );
    const data = await res.json();
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray(data.list) ||
      !(data.next == null || typeof data.next === "string")
    ) {
      throw new Error("LINE_OAM_CONTACT_INVALID");
    }
    return { list: data.list, next: data.next || null };
  } catch (error) {
    if (pageToken && [400, 404, 410].includes(error?.status)) {
      throw new Error("LINE_OAM_CURSOR_INVALID");
    }
    throw error;
  }
}

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const finiteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);
const endpointSegment = (value) => encodeURIComponent(String(value));

export async function fetchTags(botId) {
  const res = await oamFetch(`/api/v1/bots/${endpointSegment(botId)}/tags`);
  const data = await res.json();
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).length !== 1 ||
    !Object.hasOwn(data, "list") ||
    !Array.isArray(data.list)
  ) {
    throw new Error("LINE_OAM_TAGS_INVALID");
  }

  return data.list.map((tag) => {
    if (
      !tag ||
      typeof tag !== "object" ||
      !nonEmptyString(tag.tagId) ||
      typeof tag.name !== "string" ||
      !finiteNumber(tag.count) ||
      !finiteNumber(tag.createdAt) ||
      !finiteNumber(tag.updatedAt)
    ) {
      throw new Error("LINE_OAM_TAGS_INVALID");
    }
    return {
      tagId: tag.tagId,
      name: tag.name,
      count: tag.count,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    };
  });
}

// The sanitized private-contract fixtures currently prove only one envelope:
//   GET .../notes?limit=20&withTotal=true -> { list, total }
// No authenticated >20-note response has been safely supplied, so no offset/next parameter is
// invented here. A truncated envelope fails visibly and cannot become an authoritative snapshot.
export async function fetchChatNotes(botId, chatId) {
  const qs = new URLSearchParams({ limit: "20", withTotal: "true" });
  const res = await oamFetch(
    `/api/v1/bots/${endpointSegment(botId)}/chats/${endpointSegment(chatId)}/notes?${qs.toString()}`,
  );
  const data = await res.json();
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray(data.list) ||
    !Number.isSafeInteger(data.total) ||
    data.total < 0
  ) {
    throw new Error("LINE_OAM_NOTES_INVALID");
  }

  const notes = data.list.map((note) => {
    if (
      !note ||
      typeof note !== "object" ||
      !nonEmptyString(note.noteId) ||
      typeof note.body !== "string" ||
      !(note.userBizId === null || typeof note.userBizId === "string") ||
      !finiteNumber(note.createdAt) ||
      !finiteNumber(note.updatedAt)
    ) {
      throw new Error("LINE_OAM_NOTES_INVALID");
    }
    return {
      noteId: note.noteId,
      body: note.body,
      userBizId: note.userBizId,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  });

  if (data.total > notes.length) throw new Error("LINE_OAM_NOTES_INCOMPLETE");
  if (data.total !== notes.length) throw new Error("LINE_OAM_NOTES_INVALID");
  return notes;
}

// Group roster (excludes the OA host side), paged via `next` like /contacts so big groups are
// complete by construction. iconHash per member is what lets the server photo-match members.
export async function fetchChatMembers(botId, chatId) {
  const all = [];
  let next;
  do {
    const qs = new URLSearchParams({ limit: "100" });
    if (next) qs.set("next", next);
    const res = await oamFetch(
      `/api/v1/bots/${endpointSegment(botId)}/chats/${endpointSegment(chatId)}/members?${qs.toString()}`,
    );
    const data = await res.json();
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray(data.list) ||
      !(data.next == null || typeof data.next === "string")
    ) {
      throw new Error("LINE_OAM_MEMBERS_INVALID");
    }
    all.push(...data.list);
    next = data.next || null;
  } while (next);
  return all.map((m) => {
    if (!m || typeof m !== "object" || !nonEmptyString(m.userId)) {
      throw new Error("LINE_OAM_MEMBERS_INVALID");
    }
    return {
      userId: m.userId,
      name: typeof m.name === "string" ? m.name : "",
      nickname: typeof m.nickname === "string" ? m.nickname : null,
      iconHash: typeof m.iconHash === "string" ? m.iconHash : null,
    };
  });
}

export async function downloadChatCsv(
  botId,
  chatId,
  { timezoneOffset = -420 } = {},
) {
  const res = await oamFetch(
    `/download/${endpointSegment(botId)}/${endpointSegment(chatId)}/messages.csv?timezoneOffset=${timezoneOffset}`,
    {
      accept: "text/csv,*/*",
    },
  );
  return res.text();
}
