const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

const STORAGE_KEYS = {
  hostnameColors: "hostnameColors",
  groupRecords: "groupRecords"
};

const MESSAGE_TYPES = {
  getSidePanelData: "GET_SIDEPANEL_DATA",
  openGroup: "OPEN_GROUP",
  toggleGroup: "TOGGLE_GROUP",
  setPinned: "SET_PINNED",
  moveGroup: "MOVE_GROUP"
};

const inMemoryState = {
  hostnameColors: null,
  groupRecords: null,
  knownHostnameByTabId: new Map(),
  groupOperationByKey: new Map()
};

function getGroupKey(windowId, hostname) {
  return `${windowId}::${hostname}`;
}

function isGroupableUrl(urlValue) {
  if (!urlValue || typeof urlValue !== "string") {
    return false;
  }

  const blockedProtocols = ["chrome:", "about:", "data:", "file:", "devtools:", "chrome-extension:"];

  try {
    const parsed = new URL(urlValue);
    return !blockedProtocols.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function getHostnameFromUrl(urlValue) {
  if (!isGroupableUrl(urlValue)) {
    return null;
  }

  try {
    return new URL(urlValue).hostname;
  } catch {
    return null;
  }
}

function getHostnameFromTab(tab) {
  return getHostnameFromUrl(tab.url || tab.pendingUrl);
}

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function uniqueUrls(urls) {
  const seen = new Set();
  const result = [];

  for (const value of urls) {
    if (!isGroupableUrl(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

async function runSerializedGroupOperation(groupKey, operation) {
  const previousOperation = inMemoryState.groupOperationByKey.get(groupKey) || Promise.resolve();

  const nextOperation = previousOperation
    .catch(() => {})
    .then(operation)
    .finally(() => {
      if (inMemoryState.groupOperationByKey.get(groupKey) === nextOperation) {
        inMemoryState.groupOperationByKey.delete(groupKey);
      }
    });

  inMemoryState.groupOperationByKey.set(groupKey, nextOperation);
  return nextOperation;
}

async function getHostnameColors() {
  if (inMemoryState.hostnameColors) {
    return inMemoryState.hostnameColors;
  }

  const loaded = await chrome.storage.local.get(STORAGE_KEYS.hostnameColors);
  inMemoryState.hostnameColors = loaded[STORAGE_KEYS.hostnameColors] || {};
  return inMemoryState.hostnameColors;
}

async function saveHostnameColors() {
  if (!inMemoryState.hostnameColors) {
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.hostnameColors]: inMemoryState.hostnameColors });
}

async function getOrAssignColor(hostname) {
  const hostnameColors = await getHostnameColors();
  if (hostnameColors[hostname]) {
    return hostnameColors[hostname];
  }

  const colorIndex = hashString(hostname) % TAB_GROUP_COLORS.length;
  const assignedColor = TAB_GROUP_COLORS[colorIndex];
  hostnameColors[hostname] = assignedColor;
  await saveHostnameColors();
  return assignedColor;
}

async function getGroupRecords() {
  if (inMemoryState.groupRecords) {
    return inMemoryState.groupRecords;
  }

  const loaded = await chrome.storage.local.get(STORAGE_KEYS.groupRecords);
  inMemoryState.groupRecords = loaded[STORAGE_KEYS.groupRecords] || {};
  return inMemoryState.groupRecords;
}

async function saveGroupRecords() {
  if (!inMemoryState.groupRecords) {
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.groupRecords]: inMemoryState.groupRecords });
}

async function getGroupRecord(windowId, hostname) {
  const records = await getGroupRecords();
  return records[getGroupKey(windowId, hostname)] || null;
}

async function upsertGroupRecord(windowId, hostname, updates) {
  const records = await getGroupRecords();
  const key = getGroupKey(windowId, hostname);
  const existing = records[key] || {
    windowId,
    hostname,
    pinned: false,
    urls: [],
    lastActiveTabId: null,
    mruAt: 0,
    toggledOff: false,
    color: null
  };

  records[key] = { ...existing, ...updates };
  await saveGroupRecords();
  return records[key];
}

async function deleteGroupRecord(windowId, hostname) {
  const records = await getGroupRecords();
  const key = getGroupKey(windowId, hostname);
  if (!records[key]) {
    return;
  }
  delete records[key];
  await saveGroupRecords();
}

async function getGroupForHostname(windowId, hostname) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((group) => group.title === hostname) || null;
}

async function createOrUpdateGroupForTab(tab, hostname) {
  if (!tab || tab.id == null || tab.windowId == null || tab.incognito) {
    return;
  }

  const groupKey = getGroupKey(tab.windowId, hostname);

  await runSerializedGroupOperation(groupKey, async () => {
    let latestTab;
    try {
      latestTab = await chrome.tabs.get(tab.id);
    } catch {
      return;
    }

    if (!latestTab || latestTab.incognito || latestTab.windowId !== tab.windowId) {
      return;
    }

    const latestHostname = getHostnameFromTab(latestTab);
    if (latestHostname !== hostname) {
      return;
    }

    const color = await getOrAssignColor(hostname);
    let matchingGroup = await getGroupForHostname(latestTab.windowId, hostname);

    if (!matchingGroup) {
      const createdGroupId = await chrome.tabs.group({ tabIds: [latestTab.id] });
      await chrome.tabGroups.update(createdGroupId, { title: hostname, color });
      return;
    }

    if (matchingGroup.color !== color || matchingGroup.title !== hostname) {
      await chrome.tabGroups.update(matchingGroup.id, { title: hostname, color });
      matchingGroup = await getGroupForHostname(latestTab.windowId, hostname);
    }

    if (!matchingGroup || latestTab.groupId === matchingGroup.id) {
      return;
    }

    await chrome.tabs.group({ groupId: matchingGroup.id, tabIds: [latestTab.id] });
  });
}

async function getOpenTabsForHostname(windowId, hostname) {
  const group = await getGroupForHostname(windowId, hostname);
  if (!group) {
    return [];
  }
  return chrome.tabs.query({ windowId, groupId: group.id });
}

async function touchGroupUsage(windowId, hostname, lastActiveTabId) {
  const updates = { mruAt: Date.now() };
  if (lastActiveTabId != null) {
    updates.lastActiveTabId = lastActiveTabId;
  }
  await upsertGroupRecord(windowId, hostname, updates);
}

async function activateByRule(windowId, hostname, lastActiveTabId) {
  if (lastActiveTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastActiveTabId);
      if (tab && tab.windowId === windowId && getHostnameFromTab(tab) === hostname) {
        await chrome.tabs.update(tab.id, { active: true });
        await upsertGroupRecord(windowId, hostname, { lastActiveTabId: tab.id });
        return tab.id;
      }
    } catch {
    }
  }

  const openTabs = await getOpenTabsForHostname(windowId, hostname);
  if (!openTabs.length) {
    return null;
  }

  openTabs.sort((a, b) => a.index - b.index);
  const firstTab = openTabs[0];
  await chrome.tabs.update(firstTab.id, { active: true });
  await upsertGroupRecord(windowId, hostname, { lastActiveTabId: firstTab.id });
  return firstTab.id;
}

async function restoreGroupTabs(windowId, hostname) {
  const record = (await getGroupRecord(windowId, hostname)) || (await upsertGroupRecord(windowId, hostname, {}));
  const urls = uniqueUrls(record.urls || []);
  if (!urls.length) {
    return [];
  }

  const createdTabs = [];
  for (const url of urls) {
    const created = await chrome.tabs.create({ windowId, url, active: false });
    createdTabs.push(created);
  }

  for (const created of createdTabs) {
    await createOrUpdateGroupForTab(created, hostname);
  }

  return getOpenTabsForHostname(windowId, hostname);
}

async function openGroup(windowId, hostname) {
  let record = await getGroupRecord(windowId, hostname);
  if (!record) {
    record = await upsertGroupRecord(windowId, hostname, {});
  }

  let openTabs = await getOpenTabsForHostname(windowId, hostname);
  if (!openTabs.length) {
    openTabs = await restoreGroupTabs(windowId, hostname);
  }

  await upsertGroupRecord(windowId, hostname, { toggledOff: false });
  const activatedTabId = await activateByRule(windowId, hostname, record.lastActiveTabId);
  await touchGroupUsage(windowId, hostname, activatedTabId);
}

async function toggleGroupOff(windowId, hostname) {
  const openTabs = await getOpenTabsForHostname(windowId, hostname);
  const openUrls = uniqueUrls(openTabs.map((tab) => tab.url).filter(Boolean));
  const record = await getGroupRecord(windowId, hostname);
  const urls = uniqueUrls([...(record?.urls || []), ...openUrls]);

  if (openTabs.length) {
    await chrome.tabs.remove(openTabs.map((tab) => tab.id));
  }

  await upsertGroupRecord(windowId, hostname, {
    urls,
    toggledOff: true
  });
  await touchGroupUsage(windowId, hostname, record?.lastActiveTabId || null);
}

async function toggleGroup(windowId, hostname) {
  const record = await getGroupRecord(windowId, hostname);
  const openTabs = await getOpenTabsForHostname(windowId, hostname);

  if (record?.toggledOff) {
    if (openTabs.length) {
      const mergedUrls = uniqueUrls([...(record.urls || []), ...openTabs.map((tab) => tab.url).filter(Boolean)]);
      await upsertGroupRecord(windowId, hostname, {
        toggledOff: false,
        urls: mergedUrls
      });
      const activatedTabId = await activateByRule(windowId, hostname, record.lastActiveTabId);
      await touchGroupUsage(windowId, hostname, activatedTabId);
      return;
    }

    await openGroup(windowId, hostname);
    return;
  }

  if (openTabs.length) {
    await toggleGroupOff(windowId, hostname);
    return;
  }

  await openGroup(windowId, hostname);
}

async function setPinned(windowId, hostname, pinned) {
  await upsertGroupRecord(windowId, hostname, { pinned: Boolean(pinned) });
}

async function mergeUrls(targetUrls, sourceUrls) {
  return uniqueUrls([...(targetUrls || []), ...(sourceUrls || [])]);
}

async function moveGroup(sourceWindowId, hostname, targetWindowId) {
  if (sourceWindowId === targetWindowId) {
    return;
  }

  const sourceRecord = await getGroupRecord(sourceWindowId, hostname);
  const sourceOpenTabs = await getOpenTabsForHostname(sourceWindowId, hostname);
  const sourceOpenUrls = uniqueUrls(sourceOpenTabs.map((tab) => tab.url).filter(Boolean));
  const sourceUrls = await mergeUrls(sourceRecord?.urls || [], sourceOpenUrls);

  const targetRecord = await getGroupRecord(targetWindowId, hostname);
  const targetMergedUrls = await mergeUrls(targetRecord?.urls || [], sourceUrls);
  const color = await getOrAssignColor(hostname);

  if (sourceOpenTabs.length) {
    const tabIds = sourceOpenTabs.map((tab) => tab.id);
    await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });
    for (const tabId of tabIds) {
      try {
        const movedTab = await chrome.tabs.get(tabId);
        await createOrUpdateGroupForTab(movedTab, hostname);
      } catch {
      }
    }
  }

  await upsertGroupRecord(targetWindowId, hostname, {
    pinned: Boolean(sourceRecord?.pinned || targetRecord?.pinned),
    urls: targetMergedUrls,
    toggledOff: false,
    color
  });

  await touchGroupUsage(targetWindowId, hostname, null);
  await deleteGroupRecord(sourceWindowId, hostname);
  await reconcileWindow(sourceWindowId);
  await reconcileWindow(targetWindowId);
}

async function reconcileWindow(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  let windowInfo;
  try {
    windowInfo = await chrome.windows.get(windowId);
  } catch {
    return;
  }

  if (!windowInfo || windowInfo.incognito) {
    return;
  }

  const tabs = await chrome.tabs.query({ windowId });
  const byHostname = new Map();

  for (const tab of tabs) {
    if (tab.id == null || tab.incognito) {
      continue;
    }

    const hostname = getHostnameFromTab(tab);
    if (!hostname) {
      continue;
    }

    inMemoryState.knownHostnameByTabId.set(tab.id, hostname);

    if (!byHostname.has(hostname)) {
      byHostname.set(hostname, []);
    }
    byHostname.get(hostname).push(tab);
    await createOrUpdateGroupForTab(tab, hostname);
  }

  const records = await getGroupRecords();
  const touchedKeys = new Set();

  for (const [hostname, hostTabs] of byHostname.entries()) {
    const key = getGroupKey(windowId, hostname);
    touchedKeys.add(key);
    const existing = records[key] || {
      windowId,
      hostname,
      pinned: false,
      urls: [],
      lastActiveTabId: null,
      mruAt: 0,
      toggledOff: false,
      color: null
    };

    const color = await getOrAssignColor(hostname);
    const activeTab = hostTabs.find((tab) => tab.active);

    records[key] = {
      ...existing,
      windowId,
      hostname,
      urls: uniqueUrls(hostTabs.map((tab) => tab.url).filter(Boolean)),
      toggledOff: false,
      color,
      lastActiveTabId: activeTab ? activeTab.id : existing.lastActiveTabId
    };
  }

  const allKeys = Object.keys(records);
  for (const key of allKeys) {
    const record = records[key];
    if (!record || record.windowId !== windowId || touchedKeys.has(key)) {
      continue;
    }

    if (!record.pinned && !record.toggledOff) {
      delete records[key];
    }
  }

  await saveGroupRecords();
}

async function reconcileAllNormalWindows() {
  const windows = await chrome.windows.getAll();
  for (const currentWindow of windows) {
    if (currentWindow.incognito) {
      continue;
    }
    await reconcileWindow(currentWindow.id);
  }
}

async function getCurrentActiveHostname(windowId) {
  const activeTabs = await chrome.tabs.query({ windowId, active: true });
  const activeTab = activeTabs[0];
  if (!activeTab) {
    return null;
  }
  return getHostnameFromTab(activeTab);
}

function toGroupItem(record, tabCount, activeHostname) {
  return {
    windowId: record.windowId,
    hostname: record.hostname,
    pinned: Boolean(record.pinned),
    toggledOff: Boolean(record.toggledOff),
    mruAt: Number(record.mruAt || 0),
    tabCount,
    color: record.color || "grey",
    active: activeHostname === record.hostname
  };
}

async function getSidePanelData(windowId) {
  await reconcileWindow(windowId);

  const records = await getGroupRecords();
  const tabs = await chrome.tabs.query({ windowId });
  const tabCountByHostname = new Map();

  for (const tab of tabs) {
    const hostname = getHostnameFromTab(tab);
    if (!hostname) {
      continue;
    }
    tabCountByHostname.set(hostname, (tabCountByHostname.get(hostname) || 0) + 1);
  }

  const windowRecords = Object.values(records).filter((record) => record.windowId === windowId);
  const activeHostname = await getCurrentActiveHostname(windowId);
  const pinned = [];
  const recent = [];

  for (const record of windowRecords) {
    const tabCount = tabCountByHostname.get(record.hostname) || 0;
    const item = toGroupItem(record, tabCount, activeHostname);
    if (record.pinned) {
      pinned.push(item);
    } else {
      recent.push(item);
    }
  }

  pinned.sort((a, b) => a.hostname.localeCompare(b.hostname));
  recent.sort((a, b) => b.mruAt - a.mruAt);

  const allWindows = await chrome.windows.getAll();
  const windows = allWindows
    .filter((windowInfo) => !windowInfo.incognito)
    .map((windowInfo) => ({ id: windowInfo.id, focused: Boolean(windowInfo.focused) }));

  return {
    windowId,
    activeHostname,
    pinned,
    recent: recent.slice(0, 4),
    windows,
    empty: pinned.length === 0 && recent.length === 0
  };
}

async function handlePotentialHostnameChange(tabId, changeInfo, tab) {
  if (!tab || tab.id == null || tab.windowId == null || tab.incognito) {
    return;
  }

  const candidateHostnameFromUrl = getHostnameFromUrl(changeInfo.url);
  const candidateHostnameFromPending = getHostnameFromUrl(changeInfo.pendingUrl);
  const hostname = candidateHostnameFromUrl || candidateHostnameFromPending || getHostnameFromTab(tab);
  if (!hostname) {
    return;
  }

  const previousHostname = inMemoryState.knownHostnameByTabId.get(tabId);
  inMemoryState.knownHostnameByTabId.set(tabId, hostname);

  const shouldGroupNow = previousHostname !== hostname || Boolean(changeInfo.url) || Boolean(changeInfo.pendingUrl) || changeInfo.status === "complete";
  if (!shouldGroupNow) {
    return;
  }

  await createOrUpdateGroupForTab(tab, hostname);
  await upsertGroupRecord(tab.windowId, hostname, { toggledOff: false });
  await reconcileWindow(tab.windowId);
}

chrome.runtime.onInstalled.addListener(() => {
  reconcileAllNormalWindows().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  reconcileAllNormalWindows().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handlePotentialHostnameChange(tabId, changeInfo, tab).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  handlePotentialHostnameChange(tab.id, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab).catch(() => {});
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await handlePotentialHostnameChange(tabId, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab);
    await reconcileWindow(attachInfo.newWindowId);
    await reconcileWindow(attachInfo.oldWindowId);
  } catch {
  }
});

chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    await handlePotentialHostnameChange(addedTabId, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab);
  } catch {
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  inMemoryState.knownHostnameByTabId.delete(tabId);
  reconcileWindow(removeInfo.windowId).catch(() => {});
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const hostname = getHostnameFromTab(tab);
    if (!hostname || tab.windowId == null) {
      return;
    }
    await touchGroupUsage(tab.windowId, hostname, tab.id);
    await reconcileWindow(tab.windowId);
  } catch {
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.windowId == null) {
    return;
  }
  reconcileWindow(group.windowId).catch(() => {});
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group.windowId == null) {
    return;
  }
  reconcileWindow(group.windowId).catch(() => {});
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const records = await getGroupRecords();
  for (const key of Object.keys(records)) {
    if (records[key]?.windowId === windowId) {
      delete records[key];
    }
  }
  await saveGroupRecords();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid message" });
      return;
    }

    if (message.type === MESSAGE_TYPES.getSidePanelData) {
      const data = await getSidePanelData(message.windowId);
      sendResponse({ ok: true, data });
      return;
    }

    if (message.type === MESSAGE_TYPES.openGroup) {
      await openGroup(message.windowId, message.hostname);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.toggleGroup) {
      await toggleGroup(message.windowId, message.hostname);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.setPinned) {
      await setPinned(message.windowId, message.hostname, message.pinned);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.moveGroup) {
      await moveGroup(message.sourceWindowId, message.hostname, message.targetWindowId);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, error: "Unsupported message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "Unknown error" });
  });

  return true;
});
