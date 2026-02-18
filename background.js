const TAB_GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan"
];

const STORAGE_KEYS = {
  hostnameColors: "hostnameColors"
};

const inMemoryState = {
  hostnameColors: null,
  knownHostnameByTabId: new Map(),
  suppressAutoGroupForHostByTabId: new Map(),
  autoGroupingTabIds: new Set(),
  groupOperationByKey: new Map()
};

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

function getHostnameFromTab(tab) {
  const candidateUrl = tab.url || tab.pendingUrl;
  if (!isGroupableUrl(candidateUrl)) {
    return null;
  }

  try {
    return new URL(candidateUrl).hostname;
  } catch {
    return null;
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

function hashString(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function getGroupKey(windowId, hostname) {
  return `${windowId}::${hostname}`;
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

  await chrome.storage.local.set({
    [STORAGE_KEYS.hostnameColors]: inMemoryState.hostnameColors
  });
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

async function getGroupForHostname(windowId, hostname) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((group) => group.title === hostname) || null;
}

async function createOrUpdateGroupForTab(tab, hostname) {
  if (tab.incognito) {
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

    inMemoryState.autoGroupingTabIds.add(latestTab.id);

    try {
      let matchingGroup = await getGroupForHostname(latestTab.windowId, hostname);

      if (matchingGroup && latestTab.groupId === matchingGroup.id) {
        return;
      }

      if (!matchingGroup) {
        const createdGroupId = await chrome.tabs.group({ tabIds: [latestTab.id] });
        const color = await getOrAssignColor(hostname);

        await chrome.tabGroups.update(createdGroupId, {
          title: hostname,
          color,
          collapsed: true
        });

        return;
      }

      await chrome.tabs.group({ groupId: matchingGroup.id, tabIds: [latestTab.id] });
    } finally {
      inMemoryState.autoGroupingTabIds.delete(latestTab.id);
    }
  });
}

async function suppressUngroupedTabsForHostname(windowId, hostname) {
  if (!hostname) {
    return;
  }

  const tabs = await chrome.tabs.query({ windowId });

  for (const tab of tabs) {
    if (tab.id == null || tab.incognito || tab.groupId !== -1) {
      continue;
    }

    const tabHostname = getHostnameFromTab(tab);
    if (tabHostname === hostname) {
      inMemoryState.suppressAutoGroupForHostByTabId.set(tab.id, hostname);
      inMemoryState.knownHostnameByTabId.set(tab.id, hostname);
    }
  }
}

async function handlePossibleManualGroupChange(tabId, changeInfo, tab) {
  if (changeInfo.groupId === undefined || tab.incognito) {
    return false;
  }

  if (inMemoryState.autoGroupingTabIds.has(tabId)) {
    return false;
  }

  const hostname = getHostnameFromTab(tab);
  if (!hostname) {
    return false;
  }

  inMemoryState.suppressAutoGroupForHostByTabId.set(tabId, hostname);
  return true;
}

async function maybeAutoGroupTab(tabId, changeInfo, tab) {
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
  const hostnameChanged = previousHostname !== hostname;
  inMemoryState.knownHostnameByTabId.set(tabId, hostname);

  if (hostnameChanged) {
    inMemoryState.suppressAutoGroupForHostByTabId.delete(tabId);
  }

  if (!hostnameChanged) {
    const manualChanged = await handlePossibleManualGroupChange(tabId, changeInfo, tab);
    if (manualChanged) {
      return;
    }
  }

  const suppressedHostname = inMemoryState.suppressAutoGroupForHostByTabId.get(tabId);
  if (suppressedHostname && suppressedHostname === hostname) {
    return;
  }

  const shouldGroupNow = hostnameChanged || Boolean(changeInfo.url) || Boolean(changeInfo.pendingUrl) || changeInfo.status === "complete";

  if (!shouldGroupNow) {
    return;
  }

  try {
    await createOrUpdateGroupForTab(tab, hostname);
  } catch {
    // Ignore transient grouping errors from tab dragging/moving races.
  }
}

async function regroupExistingTabsInNormalWindows() {
  const windows = await chrome.windows.getAll({ populate: true });

  for (const currentWindow of windows) {
    if (currentWindow.incognito || !currentWindow.tabs) {
      continue;
    }

    for (const tab of currentWindow.tabs) {
      if (tab.id == null || tab.windowId == null || tab.incognito) {
        continue;
      }

      const hostname = getHostnameFromTab(tab);
      if (!hostname) {
        continue;
      }

      inMemoryState.knownHostnameByTabId.set(tab.id, hostname);

      try {
        await createOrUpdateGroupForTab(tab, hostname);
      } catch {
        // Ignore transient tab state issues during startup/reload.
      }
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  regroupExistingTabsInNormalWindows().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  regroupExistingTabsInNormalWindows().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  maybeAutoGroupTab(tabId, changeInfo, tab).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  maybeAutoGroupTab(tab.id, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab).catch(() => {});
});

chrome.tabs.onAttached.addListener(async (tabId) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await maybeAutoGroupTab(tabId, { status: tab.status, url: tab.url, pendingUrl: tab.pendingUrl }, tab);
  } catch {
    return;
  }
});

chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    await maybeAutoGroupTab(addedTabId, { status: tab.status, url: tab.url, pendingUrl: tab.pendingUrl }, tab);
  } catch {
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  inMemoryState.knownHostnameByTabId.delete(tabId);
  inMemoryState.suppressAutoGroupForHostByTabId.delete(tabId);
  inMemoryState.autoGroupingTabIds.delete(tabId);
});

chrome.tabGroups.onRemoved.addListener((removedGroup) => {
  suppressUngroupedTabsForHostname(removedGroup.windowId, removedGroup.title).catch(() => {});
});
