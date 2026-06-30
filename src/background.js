import { validateOamSession } from './oam-api.js';
import { scrapeOam } from './scrape.js';

const VERSION = chrome.runtime.getManifest().version;

async function handle(message) {
  switch (message?.action) {
    case 'ping':
      return { ok: true, version: VERSION };
    case 'checkSession':
      return { ok: true, loggedIn: await validateOamSession() };
    case 'scrapeOam':
      return await scrapeOam(message);
    default:
      return { ok: false, error: 'LINE_API_ERROR', details: 'unknown action' };
  }
}

// Only origins in manifest externally_connectable.matches can reach this. Return true to keep the
// channel open for the async sendResponse.
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: 'LINE_API_ERROR', details: String(e?.message || e) }));
  return true;
});
