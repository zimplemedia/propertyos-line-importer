// chat.line.biz — the OA Manager console's private API, scraped IN THE BROWSER. The session
// cookie auto-attaches via credentials:'include' under host_permissions; it is never read here.
const BASE = "https://chat.line.biz";
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "x-oa-chat-client-version": "20240513144702",
};
const RETRYABLE = new Set([500, 502, 503, 504]);
export const RATE_LIMIT_FALLBACK_MS = 30_000;

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("LINE_API_ERROR");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// LINE's undocumented OAM quota is scoped to messages.csv downloads specifically — live testing
// (2026-08-11) showed /contacts, notes, and members are unaffected, and a fixed ~1,000-download
// budget triggers a 429 regardless of HTTP concurrency or request pacing. A proactive pause of ~35s
// once ~900 have been admitted was confirmed live to reset the budget before LINE ever needs to
// reject anything: three consecutive 900-request cycles (2,700 total) ran with zero 429s. Counting
// happens at admission (request start), not completion, so requests already in flight when the 900th
// is admitted can't cause an overshoot.
export const CSV_QUOTA_BUDGET = 900;
export const CSV_QUOTA_PAUSE_MS = 35_000;

/**
 * A serialized admission governor for one endpoint. `budget`/`pauseMs`/`now`/`sleepFn` are
 * injectable so tests can exercise the state machine without waiting on real 35-second timers.
 * Intentionally in-memory only: if the MV3 service worker restarts mid-window, the count is lost
 * and a fresh window starts immediately. That's an acceptable tradeoff, not a bug — losing this
 * counter can cost at most one extra reactive 429 (handled by the cooldown gate below); it cannot
 * advance an unacknowledged server cursor or lose already-collected data, since neither of those
 * ever depends on this governor's state.
 */
export function createCsvQuotaGovernor({
  budget = CSV_QUOTA_BUDGET,
  pauseMs = CSV_QUOTA_PAUSE_MS,
  now = Date.now,
  sleepFn = sleep,
} = {}) {
  let admitted = 0;
  let lastAdmissionAt = 0;
  let pausedUntil = 0;

  async function acquire(signal) {
    throwIfAborted(signal);
    for (;;) {
      throwIfAborted(signal);
      const t = now();
      // Natural inactivity reset: idle for >= pauseMs since the last admission clears the window
      // even if the explicit pause branch below was never triggered.
      if (admitted > 0 && t - lastAdmissionAt >= pauseMs) {
        admitted = 0;
        pausedUntil = 0;
      }
      if (pausedUntil > 0) {
        const remaining = pausedUntil - t;
        if (remaining > 0) {
          await sleepFn(remaining, signal);
          continue;
        }
        admitted = 0;
        pausedUntil = 0;
        continue;
      }
      if (admitted >= budget) {
        pausedUntil = now() + pauseMs;
        continue;
      }
      admitted += 1;
      lastAdmissionAt = now();
      return;
    }
  }

  return { acquire };
}

let csvQuotaGovernor = createCsvQuotaGovernor();

// Testing-only seam: lets tests substitute a small-budget/fake-clock governor without waiting on
// the real 900-request/35-second production values. Never called outside tests. Calling it with no
// argument restores the real default.
export function __setCsvQuotaGovernorForTests(governor) {
  csvQuotaGovernor = governor ?? createCsvQuotaGovernor();
}

// Every request to chat.line.biz passes through here. A 100-contact batch remains the durable work
// unit, and at most 35 private requests run concurrently. A request starts the instant a slot frees
// up — live testing showed millisecond-level request-start spacing never affects the messages.csv
// quota above, so it isn't worth the added latency.
export const MAX_IN_FLIGHT = 35;
let inFlight = 0;
let rateLimitUntil = 0;
let rateLimitProbeOwner = null;
const waiting = [];
const rateGateWaiters = new Set();

function notifyRateGateWaiters() {
  for (const resolve of rateGateWaiters) resolve();
  rateGateWaiters.clear();
}

function waitForRateGateChange(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      rateGateWaiters.delete(finish);
      resolve();
    };
    const onAbort = () => {
      rateGateWaiters.delete(finish);
      reject(abortError(signal));
    };
    rateGateWaiters.add(finish);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function canPassRateGate(requestId) {
  if (rateLimitUntil === 0) return true;
  return Date.now() >= rateLimitUntil && rateLimitProbeOwner === requestId;
}

async function waitForRateGate(requestId, signal) {
  for (;;) {
    throwIfAborted(signal);
    if (rateLimitUntil === 0) return;

    const remaining = rateLimitUntil - Date.now();
    if (remaining > 0) {
      await sleep(remaining, signal);
      continue;
    }

    // If the previous probe disappeared (abort, crash, or final failure), the first surviving caller
    // becomes the new probe. Otherwise every non-owner stays parked until that one request succeeds.
    if (rateLimitProbeOwner === null) rateLimitProbeOwner = requestId;
    if (rateLimitProbeOwner === requestId) return;
    await waitForRateGateChange(signal);
  }
}

async function waitForCapacity(signal) {
  throwIfAborted(signal);
  if (inFlight >= MAX_IN_FLIGHT) {
    let transferred = false;
    try {
      await new Promise((resolve, reject) => {
        const waiter = { resolve };
        const onAbort = () => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortError(signal));
        };
        waiter.resolve = () => {
          transferred = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        waiting.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      throwIfAborted(signal);
      // releaseRequestSlot transferred an existing slot to this waiter, so do not increment it.
      return;
    } catch (error) {
      // The transferred slot must not be lost if the signal aborts immediately after wake-up.
      if (transferred) releaseRequestSlot();
      throw error;
    }
  }
  throwIfAborted(signal);
  inFlight++;
}

async function acquireRequestSlot(requestId, signal) {
  for (;;) {
    // Wait outside the capacity pool so 100 parked callers cannot prevent the single recovery probe
    // from acquiring a slot after the cooldown.
    await waitForRateGate(requestId, signal);
    await waitForCapacity(signal);
    try {
      throwIfAborted(signal);
      if (!canPassRateGate(requestId)) {
        releaseRequestSlot();
        continue;
      }
      return;
    } catch (error) {
      releaseRequestSlot();
      throw error;
    }
  }
}

function releaseRequestSlot() {
  const waiter = waiting.shift();
  if (waiter) waiter.resolve();
  else inFlight--;
}

async function limitedFetch(url, options, requestId, signal) {
  await acquireRequestSlot(requestId, signal);
  try {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // A non-HTTP failure does not prove LINE is still throttling. Do not strand the queue behind a
      // probe that is now performing the separate network-error retry policy.
      if (rateLimitProbeOwner === requestId) openRateGate();
      throw error;
    }
    // Close the shared gate before releasing this capacity slot. Otherwise a queued request could
    // start in the small gap between limitedFetch returning and oamFetch inspecting the response.
    if (response.status === 429) pauseForRateLimit(response, requestId);
    else if (rateLimitProbeOwner === requestId) openRateGate();
    return response;
  } finally {
    releaseRequestSlot();
  }
}

function parseRetryAfterHeader(response) {
  const value = response.headers.get("retry-after")?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  return null;
}

function retryAfterMs(response) {
  return parseRetryAfterHeader(response) ?? RATE_LIMIT_FALLBACK_MS;
}

// The first 429 after an open gate sets the cooldown deadline and names its own requestId as the
// sole recovery probe. Every other request failing while the gate is ALREADY closed is a sibling
// from the same burst — same underlying event, arriving a few ms apart — and must not push the
// deadline further out; that ratchet effect used to double the effective cooldown at high
// concurrency (~60s instead of ~30s), even though LINE's own window never changed. The one
// exception is the probe itself: if its own retry gets 429'd again, that is new information (LINE
// is still throttling as of a later timestamp) and starts a fresh cooldown.
function pauseForRateLimit(response, requestId) {
  const wasOpen = rateLimitUntil === 0;
  const isProbe = rateLimitProbeOwner === requestId;
  if (!wasOpen && !isProbe) return;
  rateLimitProbeOwner ??= requestId;
  rateLimitUntil = Date.now() + retryAfterMs(response);
}

function openRateGate() {
  rateLimitUntil = 0;
  rateLimitProbeOwner = null;
  notifyRateGateWaiters();
}

function abandonRateLimitProbe(requestId) {
  if (rateLimitProbeOwner !== requestId) return;
  rateLimitProbeOwner = null;
  notifyRateGateWaiters();
}

async function oamFetch(
  path,
  { accept, signal } = {},
  // Three attempts total: the initial request and at most two retries.
  { maxRetries = 2, baseDelayMs = 500 } = {},
) {
  const headers = { ...HEADERS, ...(accept ? { Accept: accept } : {}) };
  const requestId = Symbol(path);
  try {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      let res;
      try {
        res = await limitedFetch(
          BASE + path,
          {
            credentials: "include",
            headers,
          },
          requestId,
          signal,
        );
      } catch (e) {
        throwIfAborted(signal);
        // A REJECTED fetch is a transient network drop (net::ERR_NETWORK_CHANGED on a WiFi/VPN switch,
        // a brief offline blip) — not an HTTP status, so it never reaches the RETRYABLE check below.
        // Back off and retry; only surface it once the attempts are spent.
        if (attempt < maxRetries) {
          await sleep(
            baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs,
            signal,
          );
          continue;
        }
        throw new Error("LINE_NETWORK_ERROR");
      }
      if (res.status === 401 || res.status === 403)
        throw new Error("LINE_OAM_COOKIE_INVALID");
      if (res.ok) return res;
      if (res.status === 429) {
        // One 429 closes a gate shared by every chat.line.biz request. Retry-After wins when LINE
        // provides it; the fallback is 30 seconds, and only this first failed request may probe.
        if (attempt < maxRetries) continue;
        const error = new Error("LINE_OAM_RATE_LIMITED");
        error.status = res.status;
        throw error;
      }
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(
          baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs,
          signal,
        );
        continue;
      }
      const error = new Error("LINE_API_ERROR");
      error.status = res.status;
      throw error;
    }
  } finally {
    abandonRateLimitProbe(requestId);
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
    // Oldest activity first: a new message moves a contact forward into work we have not scanned
    // yet, instead of behind the cursor.
    sortKey: "LAST_TALKED_AT",
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
      data.list.length > 100 ||
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

// Confirmed with an authenticated sanitized probe (2026-08-11): notes use the same opaque `next`
// query cursor shape as contacts and members. Every page also reports `total`, which lets us reject
// a changing, duplicated, or prematurely terminated snapshot instead of deleting unseen notes.
export async function fetchChatNotes(botId, chatId, { signal } = {}) {
  const notes = [];
  const noteIds = new Set();
  const cursors = new Set();
  let expectedTotal = null;
  let next = null;

  do {
    const qs = new URLSearchParams({ limit: "20", withTotal: "true" });
    if (next) qs.set("next", next);
    const res = await oamFetch(
      `/api/v1/bots/${endpointSegment(botId)}/chats/${endpointSegment(chatId)}/notes?${qs.toString()}`,
      { signal },
    );
    const data = await res.json();
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      !Array.isArray(data.list) ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      !(data.next == null || nonEmptyString(data.next)) ||
      (expectedTotal !== null && data.total !== expectedTotal)
    ) {
      throw new Error("LINE_OAM_NOTES_INVALID");
    }
    expectedTotal ??= data.total;

    for (const note of data.list) {
      if (
        !note ||
        typeof note !== "object" ||
        !nonEmptyString(note.noteId) ||
        noteIds.has(note.noteId) ||
        typeof note.body !== "string" ||
        !(note.userBizId === null || typeof note.userBizId === "string") ||
        !finiteNumber(note.createdAt) ||
        !finiteNumber(note.updatedAt)
      ) {
        throw new Error("LINE_OAM_NOTES_INVALID");
      }
      noteIds.add(note.noteId);
      notes.push({
        noteId: note.noteId,
        body: note.body,
        userBizId: note.userBizId,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
    }

    if (notes.length > expectedTotal) {
      throw new Error("LINE_OAM_NOTES_INVALID");
    }
    const nextCursor = data.next || null;
    if (nextCursor) {
      if (
        data.list.length === 0 ||
        notes.length >= expectedTotal ||
        cursors.has(nextCursor)
      ) {
        throw new Error("LINE_OAM_NOTES_INVALID");
      }
      cursors.add(nextCursor);
    } else if (notes.length < expectedTotal) {
      throw new Error("LINE_OAM_NOTES_INCOMPLETE");
    }
    next = nextCursor;
  } while (next);

  if (notes.length !== expectedTotal) {
    throw new Error("LINE_OAM_NOTES_INVALID");
  }
  return notes;
}

// Group roster (excludes the OA host side), paged via `next` like /contacts so big groups are
// complete by construction. iconHash per member is what lets the server photo-match members.
export async function fetchChatMembers(botId, chatId, { signal } = {}) {
  const all = [];
  let next;
  do {
    const qs = new URLSearchParams({ limit: "100" });
    if (next) qs.set("next", next);
    const res = await oamFetch(
      `/api/v1/bots/${endpointSegment(botId)}/chats/${endpointSegment(chatId)}/members?${qs.toString()}`,
      { signal },
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
  { timezoneOffset = -420, signal } = {},
) {
  // Gated before entering the general concurrency pool: a CSV request waiting on the quota must
  // not hold one of the 35 HTTP slots, or it would starve non-CSV endpoints during the pause.
  await csvQuotaGovernor.acquire(signal);
  const res = await oamFetch(
    `/download/${endpointSegment(botId)}/${endpointSegment(chatId)}/messages.csv?timezoneOffset=${timezoneOffset}`,
    {
      accept: "text/csv,*/*",
      signal,
    },
  );
  return res.text();
}
