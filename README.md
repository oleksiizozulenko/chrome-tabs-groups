# Auto Tab Grouper (Chrome Extension)

Automatically groups Chrome tabs by exact hostname per window and exposes a side panel groups bar.

## Features

- Automatic grouping by exact hostname (for example, `github.com`, `docs.google.com`).
- Stable hostname color assignment persisted in `chrome.storage.local`.
- Window-scoped group isolation (same hostname in different windows is tracked separately).
- Side panel UI with:
	- Pinned groups (always visible)
	- Last 4 non-pinned MRU groups
	- Active-group visual highlight
	- Tab count per hostname group
	- Open, Toggle, Pin/Unpin, and Move-to-window actions
- Toggle OFF closes all tabs for that group but keeps the group record.
- Toggle ON restores stored URLs for that group.
- Activation rule for open/restore:
	1. Activate `lastActiveTabId` if still valid.
	2. Otherwise activate the leftmost tab in the group.
- Moving a group merges with destination hostname group when it already exists.

## MRU Behavior

MRU order updates when:

- A tab from a group becomes active.
- A group is opened.
- A group is toggled.

Only the 4 most recent non-pinned groups are shown in the Recent section.

## Group Lifecycle

- Non-pinned groups with no open tabs are removed automatically.
- Pinned groups remain available even when all tabs are closed.
- Toggled-off groups remain available for reopening.

## Project Files

- `manifest.json` — Manifest V3 config, permissions, side panel registration.
- `background.js` — Service worker with grouping, MRU, state, and action handlers.
- `sidepanel.html` — Groups bar markup.
- `sidepanel.css` — Groups bar styles.
- `sidepanel.js` — Groups bar rendering and action wiring.

## Install (Load Unpacked)

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Open the extension side panel to use the groups bar.

## Quick Manual Test

1. Open tabs from multiple hostnames in one window and verify hostname groups are created.
2. Open extension side panel and verify Pinned + Recent sections render group rows.
3. Activate tabs in different groups and verify Recent order updates and active row highlight changes.
4. Toggle a group OFF and verify all its tabs close but the row remains available.
5. Toggle/open the same group and verify tabs restore and one tab becomes active per rule.
6. Pin a group, close all its tabs, and verify it stays visible.
7. Move a group to another window and verify it appears only in destination scope.
