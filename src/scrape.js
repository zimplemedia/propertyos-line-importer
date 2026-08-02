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

function withExactPayloadBytes(result) {
  let payloadBytes = 0;
  for (;;) {
    const next = encodedBytes({ ...result, payloadBytes });
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
    let unsupportedRoomCount = 0;

    const resultFor = (candidateContacts, candidateProcessedIds, roomCount) => {
      const position = cursorAfterPage({
        botId,
        currentPageToken: state.pageToken,
        nextPageToken: page.next ?? null,
        pageIds,
        processedIds: candidateProcessedIds,
        sequence: state.sequence,
      });
      return withExactPayloadBytes({
        ok: true,
        batchId,
        cursorIn,
        cursorOut: position.cursorOut,
        done: position.done,
        botId,
        ...(tagCatalog ? { tagCatalog } : {}),
        contacts: candidateContacts,
        unsupportedRoomCount: roomCount,
      });
    };

    for (const rawContact of page.list) {
      if (acknowledged.has(rawContact.contactId)) continue;
      const type = classifyContact(rawContact);
      if (type === "ROOM") {
        acknowledged.add(rawContact.contactId);
        processedIds.push(rawContact.contactId);
        unsupportedRoomCount += 1;
        continue;
      }
      if (contacts.length >= contactLimit) break;

      const contact = await collectContact({
        botId,
        rawContact,
        type,
        singleHistoryMaxBytes: historyLimit,
      });
      const candidateProcessedIds = [...processedIds, rawContact.contactId];
      const candidate = resultFor(
        [...contacts, contact],
        candidateProcessedIds,
        unsupportedRoomCount,
      );
      if (candidate.payloadBytes > byteLimit) {
        if (contacts.length === 0)
          throw new Error("LINE_OAM_PAYLOAD_TOO_LARGE");
        break;
      }
      contacts.push(contact);
      acknowledged.add(rawContact.contactId);
      processedIds.push(rawContact.contactId);
    }

    const result = resultFor(contacts, processedIds, unsupportedRoomCount);
    if (result.payloadBytes > byteLimit) {
      throw new Error("LINE_OAM_PAYLOAD_TOO_LARGE");
    }
    return result;
  } catch (error) {
    return safeError(error);
  }
}
