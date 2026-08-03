import {
  downloadChatCsv,
  fetchChatMembers,
  fetchChatNotes,
  fetchContactsPage,
  fetchTags,
  resolveOamBotId,
} from "./oam-api.js";

export const CURSOR_VERSION = 2;
export const MAX_CONTACTS = 25;
// Contacts fetched at once. Each one costs 2-3 OAM requests (CSV, notes, and a group's roster pages),
// and oam-api caps the real network concurrency, so this is a work-unit width, not a request budget.
//
// Measured against a real OA: a batch is ~50 requests and the round trip to chat.line.biz is ~330ms,
// so the scrape is latency-bound, not throughput-bound. Widening this is the only lever that moves
// it — request spacing was measured to have no effect at these values.
export const CONTACT_CONCURRENCY = 12;
export const MAX_PAYLOAD_BYTES = 1_500_000;
export const MAX_SINGLE_HISTORY_BYTES = 1_250_000;

const encoder = new TextEncoder();
const encodedBytes = (value) =>
  encoder.encode(JSON.stringify(value)).byteLength;
const stringBytes = (value) => encoder.encode(value).byteLength;
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const finiteNumberOrNull = (value) =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const encodeCursor = (value) => btoa(JSON.stringify(value));

function decodeCursor(cursor) {
  try {
    const value = JSON.parse(atob(cursor));
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join(",") !==
        "botId,pageToken,processedContactIds,sequence,v" ||
      value.v !== CURSOR_VERSION ||
      !nonEmptyString(value.botId) ||
      !(value.pageToken === null || nonEmptyString(value.pageToken)) ||
      !Array.isArray(value.processedContactIds) ||
      value.processedContactIds.length > 100 ||
      value.processedContactIds.some((id) => !nonEmptyString(id)) ||
      new Set(value.processedContactIds).size !==
        value.processedContactIds.length ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0
    ) {
      throw new Error("invalid cursor");
    }
    return value;
  } catch {
    throw new Error("LINE_OAM_CURSOR_INVALID");
  }
}

async function batchIdFor(cursorIn, sequence) {
  const material = `${CURSOR_VERSION}\n${sequence}\n${cursorIn ?? "<FIRST_BATCH>"}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(material),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `oam-v${CURSOR_VERSION}-${sequence}-${hex.slice(0, 32)}`;
}

function oamState(contact) {
  return {
    chatAvailable: contact.chatAvailable ?? null,
    done: contact.done ?? null,
    followedUp: contact.followedUp ?? null,
    spam: contact.spam ?? null,
    useManualChat: contact.useManualChat ?? null,
  };
}

function classifyContact(contact) {
  if (
    !contact ||
    typeof contact !== "object" ||
    !nonEmptyString(contact.contactId)
  ) {
    throw new Error("LINE_OAM_CONTACT_INVALID");
  }
  if (contact.profile?.roomId || contact.contactId.startsWith("R"))
    return "ROOM";
  if (contact.profile?.groupId) return "GROUP";
  if (contact.profile?.userId) return "DIRECT";
  throw new Error("LINE_OAM_CONTACT_INVALID");
}

function normalizeContact(contact, type) {
  if (
    typeof contact.chatExists !== "boolean" ||
    !Array.isArray(contact.tagIds) ||
    contact.tagIds.some((tagId) => !nonEmptyString(tagId)) ||
    new Set(contact.tagIds).size !== contact.tagIds.length ||
    !finiteNumberOrNull(contact.lastTalkedAt ?? null)
  ) {
    throw new Error("LINE_OAM_CONTACT_INVALID");
  }

  const expectedProfileId =
    type === "GROUP" ? contact.profile?.groupId : contact.profile?.userId;
  if (expectedProfileId !== contact.contactId) {
    throw new Error("LINE_OAM_CONTACT_INVALID");
  }

  return {
    chatId: contact.contactId,
    type,
    chatExists: contact.chatExists,
    name:
      typeof contact.profile?.name === "string" ? contact.profile.name : null,
    nickname:
      typeof contact.profile?.nickname === "string"
        ? contact.profile.nickname
        : null,
    iconHash:
      typeof contact.profile?.iconHash === "string"
        ? contact.profile.iconHash
        : null,
    lastTalkedAt: contact.lastTalkedAt ?? null,
    isSubscribed: typeof contact.friend === "boolean" ? contact.friend : null,
    oamState: oamState(contact),
    tagIds: [...contact.tagIds],
  };
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) throw new Error("LINE_OAM_MEMBERS_INVALID");
  return members.map((member) => {
    if (
      !member ||
      typeof member !== "object" ||
      !nonEmptyString(member.userId)
    ) {
      throw new Error("LINE_OAM_MEMBERS_INVALID");
    }
    return {
      externalId: member.userId,
      name: typeof member.name === "string" ? member.name : null,
      nickname: typeof member.nickname === "string" ? member.nickname : null,
      iconHash: typeof member.iconHash === "string" ? member.iconHash : null,
    };
  });
}

async function collectContact({
  botId,
  rawContact,
  type,
  singleHistoryMaxBytes,
}) {
  const contact = normalizeContact(rawContact, type);
  if (!contact.chatExists) {
    return {
      ...contact,
      csv: null,
      historyComplete: false,
      notes: [],
      notesComplete: false,
      ...(type === "GROUP" ? { members: [], rosterComplete: false } : {}),
    };
  }

  const [csv, notes, members] = await Promise.all([
    downloadChatCsv(botId, contact.chatId),
    fetchChatNotes(botId, contact.chatId),
    type === "GROUP"
      ? fetchChatMembers(botId, contact.chatId)
      : Promise.resolve(null),
  ]);
  if (typeof csv !== "string") throw new Error("LINE_OAM_HISTORY_INVALID");
  if (stringBytes(csv) > singleHistoryMaxBytes) {
    throw new Error("LINE_OAM_HISTORY_TOO_LARGE");
  }
  if (!Array.isArray(notes)) throw new Error("LINE_OAM_NOTES_INVALID");

  return {
    ...contact,
    csv,
    historyComplete: true,
    notes,
    notesComplete: true,
    ...(type === "GROUP"
      ? { members: normalizeMembers(members), rosterComplete: true }
      : {}),
  };
}

/**
 * Fetch the planned contacts with at most CONTACT_CONCURRENCY in flight, annotating each entry in
 * place. Indices are handed out in page order, so whatever goes unfetched is always a suffix, which
 * is what lets the caller fold deterministically. Once the completed contacts already exceed the
 * batch budget no further work is started — the rest of the page belongs to the next batch anyway.
 */
async function collectPlanned({
  planned,
  botId,
  singleHistoryMaxBytes,
  byteLimit,
}) {
  let nextIndex = 0;
  let fetchedBytes = 0;
  let budgetSpent = false;

  async function worker() {
    for (;;) {
      if (budgetSpent) return;
      const index = nextIndex++;
      if (index >= planned.length) return;
      const entry = planned[index];
      if (entry.type === "ROOM") continue;
      try {
        entry.contact = await collectContact({
          botId,
          rawContact: entry.rawContact,
          type: entry.type,
          singleHistoryMaxBytes,
        });
        entry.bytes = encodedBytes(entry.contact);
        entry.fetched = true;
        fetchedBytes += entry.bytes;
        if (fetchedBytes > byteLimit) budgetSpent = true;
      } catch (error) {
        entry.error = error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONTACT_CONCURRENCY, planned.length) }, worker),
  );
}

function cursorAfterPage({
  botId,
  currentPageToken,
  nextPageToken,
  pageIds,
  processedIds,
  sequence,
}) {
  const processed = new Set(processedIds);
  if (pageIds.every((id) => processed.has(id))) {
    if (!nextPageToken) return { cursorOut: null, done: true };
    return {
      cursorOut: encodeCursor({
        v: CURSOR_VERSION,
        botId,
        pageToken: nextPageToken,
        processedContactIds: [],
        sequence: sequence + 1,
      }),
      done: false,
    };
  }
  return {
    cursorOut: encodeCursor({
      v: CURSOR_VERSION,
      botId,
      pageToken: currentPageToken,
      processedContactIds: processedIds,
      sequence: sequence + 1,
    }),
    done: false,
  };
}

// JSON.stringify of an array is '[' + items.join(',') + ']', and a plain contact serializes the same
// standalone as it does inside the array. So the exact payload size is derivable from each contact's
// own byte count, measured once, instead of re-encoding the whole growing batch per candidate.
const contactsArrayBytes = (byteList) =>
  byteList.length === 0
    ? 2
    : 2 + byteList.reduce((total, bytes) => total + bytes, 0) + byteList.length - 1;

function withExactPayloadBytes(result, contactByteList) {
  const arrayBytes = contactsArrayBytes(contactByteList);
  let payloadBytes = 0;
  for (;;) {
    // Only the envelope is re-encoded; '"contacts":[]' contributes exactly the 2 bytes swapped out.
    const next =
      encodedBytes({ ...result, contacts: [], payloadBytes }) - 2 + arrayBytes;
    if (next === payloadBytes) return { ...result, payloadBytes };
    payloadBytes = next;
  }
}

function safeError(error) {
  const code = String(error?.message || error);
  const allowlisted = new Set([
    "LINE_API_ERROR",
    "LINE_NETWORK_ERROR",
    "LINE_OAM_BOT_NOT_FOUND",
    "LINE_OAM_CONTACT_INVALID",
    "LINE_OAM_COOKIE_INVALID",
    "LINE_OAM_CURSOR_INVALID",
    "LINE_OAM_HISTORY_INVALID",
    "LINE_OAM_HISTORY_TOO_LARGE",
    "LINE_OAM_MEMBERS_INVALID",
    "LINE_OAM_NOTES_INCOMPLETE",
    "LINE_OAM_NOTES_INVALID",
    "LINE_OAM_PAYLOAD_TOO_LARGE",
    "LINE_OAM_TAGS_INVALID",
  ]);
  const matched = [...allowlisted].find((candidate) =>
    code.includes(candidate),
  );
  return { ok: false, error: matched ?? "LINE_API_ERROR" };
}

/**
 * Collect one server-acknowledgeable OAM batch.
 *
 * Cursor v2 records acknowledged IDs from the current DISPLAY_NAME-sorted page. Every resume
 * refetches that page and filters those IDs, so MV3 eviction and page reorder cannot fall back to a
 * numeric offset. The browser cookie remains entirely inside fetch(credentials:'include').
 */
export async function scrapeOam({
  basicId,
  cursor = null,
  includeTagCatalog = false,
  maxContacts = MAX_CONTACTS,
  maxBytes = MAX_PAYLOAD_BYTES,
  singleHistoryMaxBytes = MAX_SINGLE_HISTORY_BYTES,
}) {
  try {
    const cursorIn = cursor ?? null;
    const state = cursorIn
      ? decodeCursor(cursorIn)
      : {
          v: CURSOR_VERSION,
          botId: await resolveOamBotId(basicId),
          pageToken: null,
          processedContactIds: [],
          sequence: 0,
        };
    const botId = state.botId;
    const contactLimit = Math.min(
      MAX_CONTACTS,
      Math.max(
        1,
        Number.isSafeInteger(maxContacts) ? maxContacts : MAX_CONTACTS,
      ),
    );
    const byteLimit = Math.min(
      MAX_PAYLOAD_BYTES,
      Math.max(
        1,
        Number.isSafeInteger(maxBytes) ? maxBytes : MAX_PAYLOAD_BYTES,
      ),
    );
    const historyLimit = Math.min(
      MAX_SINGLE_HISTORY_BYTES,
      Math.max(
        1,
        Number.isSafeInteger(singleHistoryMaxBytes)
          ? singleHistoryMaxBytes
          : MAX_SINGLE_HISTORY_BYTES,
      ),
    );
    const batchId = await batchIdFor(cursorIn, state.sequence);
    const tagCatalog = includeTagCatalog ? await fetchTags(botId) : undefined;
    const page = await fetchContactsPage(botId, state.pageToken);
    if (
      !page ||
      !Array.isArray(page.list) ||
      !(
        page.next === null ||
        page.next === undefined ||
        nonEmptyString(page.next)
      )
    ) {
      throw new Error("LINE_OAM_CONTACT_INVALID");
    }
    const pageIds = page.list.map((contact) => contact?.contactId);
    if (
      pageIds.some((id) => !nonEmptyString(id)) ||
      new Set(pageIds).size !== pageIds.length
    ) {
      throw new Error("LINE_OAM_CONTACT_INVALID");
    }

    const acknowledged = new Set(state.processedContactIds);
    const processedIds = [...state.processedContactIds];
    const contacts = [];
    const contactByteList = [];
    let unsupportedRoomCount = 0;

    const resultFor = (
      candidateContacts,
      candidateByteList,
      candidateProcessedIds,
      roomCount,
    ) => {
      const position = cursorAfterPage({
        botId,
        currentPageToken: state.pageToken,
        nextPageToken: page.next ?? null,
        pageIds,
        processedIds: candidateProcessedIds,
        sequence: state.sequence,
      });
      return withExactPayloadBytes(
        {
          ok: true,
          batchId,
          cursorIn,
          cursorOut: position.cursorOut,
          done: position.done,
          botId,
          ...(tagCatalog ? { tagCatalog } : {}),
          contacts: candidateContacts,
          unsupportedRoomCount: roomCount,
        },
        candidateByteList,
      );
    };

    // Plan the page in display order first, without touching the network. Rooms cost nothing, so they
    // are consumed exactly where the serial walk consumed them: greedily, until a contact the batch
    // cannot take ends the walk.
    const planned = [];
    let plannedContacts = 0;
    for (const rawContact of page.list) {
      if (acknowledged.has(rawContact.contactId)) continue;
      const type = classifyContact(rawContact);
      if (type === "ROOM") {
        planned.push({ type, rawContact });
        continue;
      }
      if (plannedContacts >= contactLimit) break;
      planned.push({ type, rawContact });
      plannedContacts += 1;
    }

    await collectPlanned({
      planned,
      botId,
      singleHistoryMaxBytes: historyLimit,
      byteLimit,
    });

    // Fold in page order. An entry past the cut is never consulted, so a contact this batch would not
    // have reached can neither fail it nor be acknowledged — exactly as when each fetch was serial.
    for (const entry of planned) {
      if (entry.type === "ROOM") {
        acknowledged.add(entry.rawContact.contactId);
        processedIds.push(entry.rawContact.contactId);
        unsupportedRoomCount += 1;
        continue;
      }
      if (entry.error) throw entry.error;
      if (!entry.fetched) break;

      const candidate = resultFor(
        [...contacts, entry.contact],
        [...contactByteList, entry.bytes],
        [...processedIds, entry.rawContact.contactId],
        unsupportedRoomCount,
      );
      if (candidate.payloadBytes > byteLimit) {
        if (contacts.length === 0)
          throw new Error("LINE_OAM_PAYLOAD_TOO_LARGE");
        break;
      }
      contacts.push(entry.contact);
      contactByteList.push(entry.bytes);
      acknowledged.add(entry.rawContact.contactId);
      processedIds.push(entry.rawContact.contactId);
    }

    const result = resultFor(
      contacts,
      contactByteList,
      processedIds,
      unsupportedRoomCount,
    );
    if (result.payloadBytes > byteLimit) {
      throw new Error("LINE_OAM_PAYLOAD_TOO_LARGE");
    }
    return result;
  } catch (error) {
    return safeError(error);
  }
}
