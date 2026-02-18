# Auto Tab Grouper (Chrome Extension)

Automatically groups Chrome tabs by exact hostname per window using Manifest V3.

## Features

- Creates one tab group per hostname (for example, `example.com`, `youtube.com`).
- Reuses existing hostname group in the same window for new matching tabs.
- Assigns a stable color per hostname and persists it in `chrome.storage.local`.
- Creates groups as collapsible Chrome tab groups (`collapsed: true` on first create).
- Keeps grouping isolated by window (same hostname in different windows = separate groups).
- Excludes incognito windows.
- Includes pinned tabs.

## Notes on Group Removal

Chrome automatically removes a tab group when its last tab is closed/removed. This extension relies on that native behavior.

## Project Files

- `manifest.json` — Manifest V3 config and permissions.
- `background.js` — Background service worker with grouping logic.

## Install (Load Unpacked)

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.

## How It Works

- On startup/install, existing tabs in normal windows are scanned and grouped by hostname.
- On tab updates, when URL/hostname is known or changed, the tab is grouped into its hostname group.
- If you manually move/ungroup a tab, auto-grouping is paused for that tab until the tab navigates to a different hostname.

## Quick Manual Test

1. Open tabs from different hostnames in one window and verify separate groups.
2. Open the same hostname in another window and verify it gets a separate group in that window.
3. Close all tabs in a group and verify Chrome removes that group.
4. Reload extension and verify existing tabs are grouped again with stable colors.
