# PropertyOS LINE Importer

Imports your LINE Official Account chat history into PropertyOS. Your LINE session cookie never
leaves your browser — the extension scrapes `chat.line.biz` locally and sends only the chat data
to PropertyOS over your logged-in session. Since 0.4.18 the final batch of a Sync also carries the
OA Manager admin list (bizId and display name only), so PropertyOS can name the admin who wrote an
imported note. Since 0.4.19 a Sync without the PropertyOS dialog's "Notes" option skips the per-chat
notes download, which halves the rate-limited requests per chat. Since 0.4.20 the dialog's fourth
option, "Message presets", makes the first batch of a Sync also carry the OA's saved replies (id,
title, text, emojis, favourite and list position), which PropertyOS keeps as that account's message
presets; without it the saved replies are not read at all. Since 0.4.21 the Chat presets card's
"Sync from LINE OA" button asks for the saved replies alone (`catalogueOnly`): one batch with no
contacts, so no chat, note or tag is downloaded.

## Install (developer mode)

1. Download `propertyos-line-importer.zip` from the latest Release and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the unzipped folder.
4. In PropertyOS → Settings → Connection, open a LINE account and click **Import chats**.

Chrome will periodically warn about developer-mode extensions — that's expected for this
install method; keep it enabled.
