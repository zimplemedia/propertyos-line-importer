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

// Every request to chat.line.biz shares this pool. Live testing (2026-08-11/12, see
// docs/line-oam-rate-limit-live-test-report.md) found concurrency never moves LINE's private
// messages.csv boundary — only the CSV-specific gate below does — so this ceiling exists purely to
// bound real network/browser load, not to protect against the 429. A request starts the instant a
// slot frees up.
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
    // Wait outside the capacity pool so parked callers cannot prevent the single recovery probe
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
        // One 429 closes a gate shared by every non-CSV chat.line.biz request. Retry-After wins when
        // LINE provides it; the fallback is 30 seconds, and only this first failed request may probe.
        // messages.csv does not use this gate at all — see the CSV-specific gate below.
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

// --- messages.csv: dedicated admission control -----------------------------------------------
//
// Confirmed by live testing (2026-08-11/12; docs/line-oam-rate-limit-live-test-report.md §11-§12):
// LINE admits roughly 1,000 messages.csv requests per rolling 60-second window, counted at fetch()
// dispatch, not response completion. A steady 67ms start-to-start spacing keeps a single stream
// (~896/min measured) comfortably under that boundary indefinitely — 3,000 consecutive requests ran
// with zero 429s. Concurrency does not move the boundary (§11.4/§12.2), so this is a pure pacing
// control, entirely separate from the general MAX_IN_FLIGHT pool and the general rate gate above:
// closing it never delays /contacts, notes, tags, members, or session checks.
//
// Recovery after a real 429 (§12.9) is not a fixed 30-second cooldown — how long it takes depends on
// how old the oldest still-counted admission already is, which varies with recent traffic shape. A
// short probe after 2s is frequently already enough; 60s is the conservative fallback for when it
// is not. Only the request that first observed the 429 ever probes; every other CSV request — already
// in flight or newly arriving — parks until that owner succeeds or exhausts its own three attempts.
export const CSV_START_SPACING_MS = 67;
export const CSV_FIRST_429_RETRY_MS = 2_000;
export const CSV_FINAL_429_RETRY_MS = 60_000;

let csvClock = { now: Date.now, sleepFn: sleep };
let csvNextDispatchAt = 0;
let csvSpacingChain = Promise.resolve();

let csvGateOpen = true;
let csvGateOwner = null;
let csvGateStage = null; // "first" | "final" — meaningful only while csvGateOpen is false
let csvGateDeadline = 0;
let csvGateFailed = false;
const csvGateWaiters = new Set();
let activeCsvScrapeCycles = 0;

// Testing-only seam: inject a fake clock/sleep and reset every module-level CSV state variable so
// tests do not wait on the real 67ms/2s/60s production values or leak state between tests. Never
// called outside tests; calling with no argument restores the real clock.
export function __resetCsvForTests({ now = Date.now, sleepFn = sleep } = {}) {
  csvClock = { now, sleepFn };
  csvNextDispatchAt = 0;
  csvSpacingChain = Promise.resolve();
  csvGateOpen = true;
  csvGateOwner = null;
  csvGateStage = null;
  csvGateDeadline = 0;
  csvGateFailed = false;
  csvGateWaiters.clear();
  activeCsvScrapeCycles = 0;
}

function notifyCsvGateWaiters() {
  for (const resolve of csvGateWaiters) resolve();
  csvGateWaiters.clear();
}

function waitForCsvGateChange(signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      csvGateWaiters.delete(finish);
      resolve();
    };
    const onAbort = () => {
      csvGateWaiters.delete(finish);
      reject(abortError(signal));
    };
    csvGateWaiters.add(finish);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// A small serialized mutex, not a timestamp ledger: concurrent callers queue on csvSpacingChain so
// only one caller at a time checks/advances csvNextDispatchAt. This is what stops a delayed or
// suspended tab from releasing several overdue CSV requests together — each queued caller, once its
// turn comes, is measured against the PREVIOUS caller's freshly-advanced pointer, not wall-clock
// "now," so they always end up staggered by CSV_START_SPACING_MS regardless of when they woke up.
async function acquireCsvSpacing(signal) {
  const myTurn = csvSpacingChain.catch(() => {});
  let releaseChain;
  csvSpacingChain = new Promise((resolve) => {
    releaseChain = resolve;
  });
  try {
    await myTurn;
    throwIfAborted(signal);
    const wait = csvNextDispatchAt - csvClock.now();
    if (wait > 0) await csvClock.sleepFn(wait, signal);
    throwIfAborted(signal);
    csvNextDispatchAt =
      Math.max(csvNextDispatchAt, csvClock.now()) + CSV_START_SPACING_MS;
  } finally {
    releaseChain();
  }
}

function csvRateLimitedError() {
  return new Error("LINE_OAM_RATE_LIMITED");
}

function csvRetryDelayMs(response, fallbackMs) {
  return parseRetryAfterHeader(response) ?? fallbackMs;
}

// Waits until this request may attempt a CSV fetch: the gate is open, or this request is the
// designated recovery owner and its current wait stage has elapsed. Every other CSV request —
// already in flight when the gate closed, or newly arriving — stays parked here until the owner
// resolves the gate one way or the other.
async function waitForCsvGate(requestId, signal) {
  for (;;) {
    throwIfAborted(signal);
    if (csvGateFailed) throw csvRateLimitedError();
    if (csvGateOpen) return;
    if (csvGateOwner === requestId) {
      const remaining = csvGateDeadline - csvClock.now();
      if (remaining > 0) {
        await csvClock.sleepFn(remaining, signal);
        continue;
      }
      return;
    }
    await waitForCsvGateChange(signal);
  }
}

// The only place CSV gate state changes on a 429. The first failure since an open gate closes it and
// claims ownership (stage "first", CSV_FIRST_429_RETRY_MS). A sibling failing while the gate is
// already closed changes nothing — no deadline extension, no second probe, matching the ratchet fix
// in pauseForRateLimit above. The owner's own repeat failure advances "first" → "final"
// (CSV_FINAL_429_RETRY_MS); a third failure is terminal and every parked waiter gives up too, since
// nothing will ever reopen the gate from here.
function handleCsvRateLimit(response, requestId) {
  if (csvGateOpen) {
    csvGateOpen = false;
    csvGateOwner = requestId;
    csvGateStage = "first";
    csvGateDeadline =
      csvClock.now() + csvRetryDelayMs(response, CSV_FIRST_429_RETRY_MS);
    return;
  }
  if (csvGateOwner !== requestId) return;
  if (csvGateStage === "first") {
    csvGateStage = "final";
    csvGateDeadline =
      csvClock.now() + csvRetryDelayMs(response, CSV_FINAL_429_RETRY_MS);
    return;
  }
  csvGateFailed = true;
  notifyCsvGateWaiters();
}

function openCsvGate() {
  csvGateOpen = true;
  csvGateOwner = null;
  csvGateStage = null;
  csvGateFailed = false;
  notifyCsvGateWaiters();
}

/**
 * Mark one top-level scrape as the owner of the current CSV recovery cycle.
 *
 * A third 429 intentionally fails every CSV request belonging to that scrape. The failed gate must
 * survive until all of those requests have unwound, otherwise an aborted sibling could wake and
 * continue the old batch. A later explicit scrape (the frontend's Resume action) may start with a
 * fresh gate, but only once no older top-level scrape remains active.
 */
export function beginCsvScrapeCycle() {
  if (activeCsvScrapeCycles === 0 && csvGateFailed) openCsvGate();
  activeCsvScrapeCycles += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activeCsvScrapeCycles = Math.max(0, activeCsvScrapeCycles - 1);
  };
}

// If the owner's request fails for a reason other than a 429 (network error, cookie expiry, abort)
// while holding ownership, the gate must not stay closed forever waiting for a probe that will
// never come.
function abandonCsvGateOwner(requestId) {
  if (csvGateOwner !== requestId) return;
  openCsvGate();
}

async function csvFetch(url, signal) {
  const requestId = Symbol("csv");
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 1. Wait for the CSV gate outside the general HTTP pool — a parked recovery wait can run for
      //    up to 60s and must not hold a capacity slot the whole time.
      await waitForCsvGate(requestId, signal);
      // 2. Acquire general HTTP capacity (shared with every other endpoint).
      await waitForCapacity(signal);
      let response;
      try {
        // 3. Serialize the final spacing check immediately before fetch, so waiting for capacity
        //    above can never let two CSV requests dispatch together.
        await acquireCsvSpacing(signal);
        // 4. Recheck: a sibling's 429 may have closed the gate while we waited for capacity/spacing.
        if (!csvGateOpen && csvGateOwner !== requestId) {
          releaseRequestSlot();
          continue;
        }
        throwIfAborted(signal);
        // 5. Record actual dispatch by calling fetch() now, immediately after the checks above.
        response = await fetch(url, {
          credentials: "include",
          headers: { ...HEADERS, Accept: "text/csv,*/*" },
          signal,
        });
      } catch (networkError) {
        // 6. Release resources correctly on abort or error.
        releaseRequestSlot();
        throwIfAborted(signal);
        abandonCsvGateOwner(requestId);
        if (attempt < 2) {
          await sleep(500 * 2 ** attempt + Math.random() * 500, signal);
          continue;
        }
        throw new Error("LINE_NETWORK_ERROR");
      }
      releaseRequestSlot();
      if (response.status === 401 || response.status === 403) {
        abandonCsvGateOwner(requestId);
        throw new Error("LINE_OAM_COOKIE_INVALID");
      }
      if (response.ok) {
        if (csvGateOwner === requestId) openCsvGate();
        return response;
      }
      if (response.status === 429) {
        handleCsvRateLimit(response, requestId);
        if (attempt === 2) throw csvRateLimitedError();
        continue;
      }
      if (RETRYABLE.has(response.status) && attempt < 2) {
        await sleep(500 * 2 ** attempt + Math.random() * 500, signal);
        continue;
      }
      abandonCsvGateOwner(requestId);
      const error = new Error("LINE_API_ERROR");
      error.status = response.status;
      throw error;
    }
    // Unreachable: the loop always returns or throws by the third attempt.
    throw csvRateLimitedError();
  } catch (error) {
    if (signal?.aborted) abandonCsvGateOwner(requestId);
    throw error;
  }
}

export async function downloadChatCsv(
  botId,
  chatId,
  { timezoneOffset = -420, signal } = {},
) {
  const url = `${BASE}/download/${endpointSegment(botId)}/${endpointSegment(chatId)}/messages.csv?timezoneOffset=${timezoneOffset}`;
  const res = await csvFetch(url, signal);
  return res.text();
}
