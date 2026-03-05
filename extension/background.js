const TAB_GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

const STORAGE_KEYS = {
  hostnameColors: "hostnameColors",
  groupRecords: "groupRecords",
  manualGroupRules: "manualGroupRules"
};

const MESSAGE_TYPES = {
  getSidePanelData: "GET_SIDEPANEL_DATA",
  openGroup: "OPEN_GROUP",
  toggleGroup: "TOGGLE_GROUP",
  setPinned: "SET_PINNED",
  moveGroup: "MOVE_GROUP",
  getManualGroupRules: "GET_MANUAL_GROUP_RULES",
  addManualGroupRule: "ADD_MANUAL_GROUP_RULE",
  removeManualGroupRule: "REMOVE_MANUAL_GROUP_RULE"
};

const inMemoryState = {
  hostnameColors: null,
  groupRecords: null,
  manualGroupRules: null,
  knownGroupNameByTabId: new Map(),
  groupOperationByKey: new Map(),
  duplicateCleanupDoneByWindowId: new Set(),
  reconcileTimerByWindowId: new Map(),
  reconcileInFlightByWindowId: new Map()
};

function getGroupKey(windowId, groupName) {
  const normalizedGroupName = normalizeGroupName(groupName || "");
  return `${windowId}::${normalizedGroupName}`;
}

function getRecordGroupName(record) {
  if (!record) {
    return "";
  }

  return normalizeGroupName(record.groupName || record.hostname || "");
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

function parseGroupableUrl(urlValue) {
  if (!isGroupableUrl(urlValue)) {
    return null;
  }

  try {
    return new URL(urlValue);
  } catch {
    return null;
  }
}

function getHostnameFromUrl(urlValue) {
  const parsed = parseGroupableUrl(urlValue);
  return parsed ? parsed.hostname : null;
}

function getHostnameFromTab(tab) {
  return getHostnameFromUrl(tab.url || tab.pendingUrl);
}

function normalizePathPrefix(pathPrefix) {
  if (!pathPrefix || typeof pathPrefix !== "string") {
    return "/";
  }

  const withLeadingSlash = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function normalizeGroupName(groupName) {
  if (!groupName || typeof groupName !== "string") {
    return "";
  }
  return groupName.trim();
}

function parseHostnameInput(hostnameOrUrl) {
  if (!hostnameOrUrl || typeof hostnameOrUrl !== "string") {
    return null;
  }

  const trimmed = hostnameOrUrl.trim();
  if (!trimmed) {
    return null;
  }

  const fromUrl = getHostnameFromUrl(trimmed);
  if (fromUrl) {
    return fromUrl;
  }

  if (/^[a-z0-9.-]+$/i.test(trimmed) && trimmed.includes(".")) {
    return trimmed.toLowerCase();
  }

  return null;
}

function doesRuleMatchParsedUrl(parsedUrl, rule) {
  if (!parsedUrl || !rule) {
    return false;
  }

  if (parsedUrl.hostname !== rule.hostname) {
    return false;
  }

  if (rule.pathPrefix === "/") {
    return true;
  }

  const pathname = parsedUrl.pathname || "/";
  return pathname === rule.pathPrefix || pathname.startsWith(`${rule.pathPrefix}/`);
}

async function getManualGroupRules() {
  if (inMemoryState.manualGroupRules) {
    return inMemoryState.manualGroupRules;
  }

  const loaded = await chrome.storage.local.get(STORAGE_KEYS.manualGroupRules);
  const rawRules = Array.isArray(loaded[STORAGE_KEYS.manualGroupRules]) ? loaded[STORAGE_KEYS.manualGroupRules] : [];

  const normalizedRules = [];
  let needsSave = false;

  for (const rule of rawRules) {
    const hostname = rule?.hostname || "";
    const groupName = normalizeGroupName(rule?.groupName);
    const pathPrefix = normalizePathPrefix(rule?.pathPrefix);

    if (!hostname || !groupName) {
      needsSave = true;
      continue;
    }

    let id = rule?.id;
    if (!id) {
      id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      needsSave = true;
    }

    normalizedRules.push({
      id,
      hostname,
      pathPrefix,
      groupName
    });
  }

  inMemoryState.manualGroupRules = normalizedRules;

  if (needsSave) {
    await saveManualGroupRules();
  }

  return inMemoryState.manualGroupRules;
}

async function saveManualGroupRules() {
  if (!inMemoryState.manualGroupRules) {
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.manualGroupRules]: inMemoryState.manualGroupRules });
}

async function resolveGroupNameFromUrl(urlValue) {
  const parsed = parseGroupableUrl(urlValue);
  if (!parsed) {
    return null;
  }

  const rules = await getManualGroupRules();
  for (const rule of rules) {
    if (doesRuleMatchParsedUrl(parsed, rule)) {
      return rule.groupName;
    }
  }

  return parsed.hostname;
}

async function getGroupNameFromTab(tab) {
  if (!tab) {
    return null;
  }
  return resolveGroupNameFromUrl(tab.url || tab.pendingUrl);
}

async function addManualGroupRule(ruleInput) {
  const hostname = parseHostnameInput(ruleInput?.hostnameOrUrl || "");
  if (!hostname) {
    throw new Error("Rule hostname/url is invalid");
  }

  const groupName = normalizeGroupName(ruleInput?.groupName);
  if (!groupName) {
    throw new Error("Group name is required");
  }

  const pathPrefix = normalizePathPrefix(ruleInput?.pathPrefix || "/");
  const rules = await getManualGroupRules();

  const duplicate = rules.find(
    (rule) => rule.hostname === hostname && rule.pathPrefix === pathPrefix && rule.groupName === groupName
  );

  if (!duplicate) {
    rules.unshift({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      hostname,
      pathPrefix,
      groupName
    });
    await saveManualGroupRules();
  }

  inMemoryState.duplicateCleanupDoneByWindowId.clear();
  return getManualGroupRules();
}

async function removeManualGroupRule(ruleId) {
  const rules = await getManualGroupRules();
  const nextRules = rules.filter((rule) => rule.id !== ruleId);
  if (nextRules.length === rules.length) {
    return rules;
  }

  inMemoryState.manualGroupRules = nextRules;
  await saveManualGroupRules();
  inMemoryState.duplicateCleanupDoneByWindowId.clear();
  return nextRules;
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
  const rawRecords = loaded[STORAGE_KEYS.groupRecords] || {};
  const normalizedRecords = {};
  let needsSave = false;

  for (const [rawKey, rawRecord] of Object.entries(rawRecords)) {
    if (!rawRecord || !Number.isInteger(rawRecord.windowId)) {
      needsSave = true;
      continue;
    }

    const groupName = getRecordGroupName(rawRecord);
    if (!groupName) {
      needsSave = true;
      continue;
    }

    const key = getGroupKey(rawRecord.windowId, groupName);
    normalizedRecords[key] = {
      windowId: rawRecord.windowId,
      groupName,
      pinned: Boolean(rawRecord.pinned),
      urls: uniqueUrls(Array.isArray(rawRecord.urls) ? rawRecord.urls : []),
      lastActiveTabId: rawRecord.lastActiveTabId ?? null,
      mruAt: Number(rawRecord.mruAt || 0),
      toggledOff: Boolean(rawRecord.toggledOff),
      color: rawRecord.color || null
    };

    if (key !== rawKey || rawRecord.groupName !== groupName || "hostname" in rawRecord) {
      needsSave = true;
    }
  }

  inMemoryState.groupRecords = normalizedRecords;

  if (needsSave) {
    await saveGroupRecords();
  }

  return inMemoryState.groupRecords;
}

async function saveGroupRecords() {
  if (!inMemoryState.groupRecords) {
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.groupRecords]: inMemoryState.groupRecords });
}

async function getGroupRecord(windowId, groupName) {
  const records = await getGroupRecords();
  return records[getGroupKey(windowId, groupName)] || null;
}

async function upsertGroupRecord(windowId, groupName, updates) {
  const records = await getGroupRecords();
  const key = getGroupKey(windowId, groupName);
  const existing = records[key] || {
    windowId,
    groupName,
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

async function deleteGroupRecord(windowId, groupName) {
  const records = await getGroupRecords();
  const key = getGroupKey(windowId, groupName);
  if (!records[key]) {
    return;
  }
  delete records[key];
  await saveGroupRecords();
}

async function getGroupForHostname(windowId, hostname) {
  const tabs = await chrome.tabs.query({ windowId });
  const hostnameGroupTabCount = new Map();

  for (const tab of tabs) {
    if (tab.groupId == null || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      continue;
    }

    const groupName = await getGroupNameFromTab(tab);
    if (groupName !== hostname) {
      continue;
    }

    hostnameGroupTabCount.set(tab.groupId, (hostnameGroupTabCount.get(tab.groupId) || 0) + 1);
  }

  if (hostnameGroupTabCount.size > 0) {
    const sortedGroupIds = Array.from(hostnameGroupTabCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([groupId]) => groupId);

    for (const groupId of sortedGroupIds) {
      try {
        return await chrome.tabGroups.get(groupId);
      } catch {
      }
    }
  }

  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find((group) => group.title === hostname) || null;
}

async function createOrUpdateGroupForTab(tab, groupName) {
  if (!tab || tab.id == null || tab.windowId == null || tab.incognito) {
    return;
  }

  const groupKey = getGroupKey(tab.windowId, groupName);

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

    const latestGroupName = await getGroupNameFromTab(latestTab);
    if (latestGroupName !== groupName) {
      return;
    }

    const isActive = Boolean(latestTab.active);
    const color = await getOrAssignColor(groupName);
    let matchingGroup = await getGroupForHostname(latestTab.windowId, groupName);

    if (!matchingGroup) {
      const createdGroupId = await chrome.tabs.group({ tabIds: [latestTab.id] });
      await chrome.tabGroups.update(createdGroupId, { title: groupName, color, collapsed: false });
      if (isActive) {
        await chrome.tabs.update(latestTab.id, { active: true });
      }
      return;
    }

    if (matchingGroup.color !== color || matchingGroup.title !== groupName || matchingGroup.collapsed) {
      await chrome.tabGroups.update(matchingGroup.id, { title: groupName, color, collapsed: false });
      matchingGroup = await getGroupForHostname(latestTab.windowId, groupName);
    }

    if (!matchingGroup) {
      return;
    }

    if (latestTab.groupId === matchingGroup.id) {
      if (isActive && matchingGroup.collapsed) {
        await chrome.tabGroups.update(matchingGroup.id, { collapsed: false });
      }
      if (isActive) {
        await chrome.tabs.update(latestTab.id, { active: true });
      }
      return;
    }

    if (isActive && matchingGroup.collapsed) {
      await chrome.tabGroups.update(matchingGroup.id, { collapsed: false });
    }

    await chrome.tabs.group({ groupId: matchingGroup.id, tabIds: [latestTab.id] });
    if (isActive) {
      await chrome.tabs.update(latestTab.id, { active: true });
    }
  });
}

async function getOpenTabsForGroupName(windowId, groupName) {
  const group = await getGroupForHostname(windowId, groupName);
  if (!group) {
    return [];
  }
  return chrome.tabs.query({ windowId, groupId: group.id });
}

async function touchGroupUsage(windowId, groupName, lastActiveTabId) {
  const updates = { mruAt: Date.now() };
  if (lastActiveTabId != null) {
    updates.lastActiveTabId = lastActiveTabId;
  }
  await upsertGroupRecord(windowId, groupName, updates);
}

async function activateByRule(windowId, groupName, lastActiveTabId) {
  if (lastActiveTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastActiveTabId);
      const tabGroupName = await getGroupNameFromTab(tab);
      if (tab && tab.windowId === windowId && tabGroupName === groupName) {
        await chrome.tabs.update(tab.id, { active: true });
        await upsertGroupRecord(windowId, groupName, { lastActiveTabId: tab.id });
        return tab.id;
      }
    } catch {
    }
  }

  const openTabs = await getOpenTabsForGroupName(windowId, groupName);
  if (!openTabs.length) {
    return null;
  }

  openTabs.sort((a, b) => a.index - b.index);
  const firstTab = openTabs[0];
  await chrome.tabs.update(firstTab.id, { active: true });
  await upsertGroupRecord(windowId, groupName, { lastActiveTabId: firstTab.id });
  return firstTab.id;
}

async function restoreGroupTabs(windowId, groupName) {
  const record = (await getGroupRecord(windowId, groupName)) || (await upsertGroupRecord(windowId, groupName, {}));
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
    await createOrUpdateGroupForTab(created, groupName);
  }

  return getOpenTabsForGroupName(windowId, groupName);
}

async function openGroup(windowId, groupName) {
  let record = await getGroupRecord(windowId, groupName);
  if (!record) {
    record = await upsertGroupRecord(windowId, groupName, {});
  }

  let openTabs = await getOpenTabsForGroupName(windowId, groupName);
  if (!openTabs.length) {
    openTabs = await restoreGroupTabs(windowId, groupName);
  }

  await upsertGroupRecord(windowId, groupName, { toggledOff: false });
  const activatedTabId = await activateByRule(windowId, groupName, record.lastActiveTabId);
  await touchGroupUsage(windowId, groupName, activatedTabId);
}

async function toggleGroupOff(windowId, groupName) {
  const openTabs = await getOpenTabsForGroupName(windowId, groupName);
  const openUrls = uniqueUrls(openTabs.map((tab) => tab.url).filter(Boolean));
  const record = await getGroupRecord(windowId, groupName);
  const urls = uniqueUrls([...(record?.urls || []), ...openUrls]);

  if (openTabs.length) {
    await chrome.tabs.remove(openTabs.map((tab) => tab.id));
  }

  await upsertGroupRecord(windowId, groupName, {
    urls,
    toggledOff: true
  });
  await touchGroupUsage(windowId, groupName, record?.lastActiveTabId || null);
}

async function toggleGroup(windowId, groupName) {
  const record = await getGroupRecord(windowId, groupName);
  const openTabs = await getOpenTabsForGroupName(windowId, groupName);

  if (record?.toggledOff) {
    if (openTabs.length) {
      const mergedUrls = uniqueUrls([...(record.urls || []), ...openTabs.map((tab) => tab.url).filter(Boolean)]);
      await upsertGroupRecord(windowId, groupName, {
        toggledOff: false,
        urls: mergedUrls
      });
      const activatedTabId = await activateByRule(windowId, groupName, record.lastActiveTabId);
      await touchGroupUsage(windowId, groupName, activatedTabId);
      return;
    }

    await openGroup(windowId, groupName);
    return;
  }

  if (openTabs.length) {
    await toggleGroupOff(windowId, groupName);
    return;
  }

  await openGroup(windowId, groupName);
}

async function setPinned(windowId, groupName, pinned) {
  await upsertGroupRecord(windowId, groupName, { pinned: Boolean(pinned) });
}

async function mergeUrls(targetUrls, sourceUrls) {
  return uniqueUrls([...(targetUrls || []), ...(sourceUrls || [])]);
}

async function moveGroup(sourceWindowId, groupName, targetWindowId) {
  if (sourceWindowId === targetWindowId) {
    return;
  }

  const sourceRecord = await getGroupRecord(sourceWindowId, groupName);
  const sourceOpenTabs = await getOpenTabsForGroupName(sourceWindowId, groupName);
  const sourceOpenUrls = uniqueUrls(sourceOpenTabs.map((tab) => tab.url).filter(Boolean));
  const sourceUrls = await mergeUrls(sourceRecord?.urls || [], sourceOpenUrls);

  const targetRecord = await getGroupRecord(targetWindowId, groupName);
  const targetMergedUrls = await mergeUrls(targetRecord?.urls || [], sourceUrls);
  const color = await getOrAssignColor(groupName);

  if (sourceOpenTabs.length) {
    const tabIds = sourceOpenTabs.map((tab) => tab.id);
    await chrome.tabs.move(tabIds, { windowId: targetWindowId, index: -1 });
    for (const tabId of tabIds) {
      try {
        const movedTab = await chrome.tabs.get(tabId);
        await createOrUpdateGroupForTab(movedTab, groupName);
      } catch {
      }
    }
  }

  await upsertGroupRecord(targetWindowId, groupName, {
    pinned: Boolean(sourceRecord?.pinned || targetRecord?.pinned),
    urls: targetMergedUrls,
    toggledOff: false,
    color
  });

  await touchGroupUsage(targetWindowId, groupName, null);
  await deleteGroupRecord(sourceWindowId, groupName);
  await reconcileWindow(sourceWindowId);
  await reconcileWindow(targetWindowId);
}

async function mergeDuplicateGroupNameGroups(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const groupedTabsByGroupName = new Map();

  for (const tab of tabs) {
    if (tab.id == null || tab.groupId == null || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      continue;
    }

    const groupName = await getGroupNameFromTab(tab);
    if (!groupName) {
      continue;
    }

    if (!groupedTabsByGroupName.has(groupName)) {
      groupedTabsByGroupName.set(groupName, []);
    }
    groupedTabsByGroupName.get(groupName).push(tab);
  }

  for (const [groupName, groupTabs] of groupedTabsByGroupName.entries()) {
    const tabsByGroupId = new Map();

    for (const tab of groupTabs) {
      if (!tabsByGroupId.has(tab.groupId)) {
        tabsByGroupId.set(tab.groupId, []);
      }
      tabsByGroupId.get(tab.groupId).push(tab);
    }

    if (tabsByGroupId.size <= 1) {
      continue;
    }

    const [targetGroupId] = Array.from(tabsByGroupId.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([groupId]) => groupId);

    for (const [groupId, groupedTabs] of tabsByGroupId.entries()) {
      if (groupId === targetGroupId) {
        continue;
      }

      const tabIdsToMove = groupedTabs.map((tab) => tab.id).filter((tabId) => tabId != null);
      if (!tabIdsToMove.length) {
        continue;
      }

      try {
        await chrome.tabs.group({ groupId: targetGroupId, tabIds: tabIdsToMove });
      } catch {
      }
    }

    const color = await getOrAssignColor(groupName);
    try {
      await chrome.tabGroups.update(targetGroupId, { title: groupName, color, collapsed: false });
    } catch {
    }
  }
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

  if (!inMemoryState.duplicateCleanupDoneByWindowId.has(windowId)) {
    await mergeDuplicateGroupNameGroups(windowId);
    inMemoryState.duplicateCleanupDoneByWindowId.add(windowId);
  }

  const tabs = await chrome.tabs.query({ windowId });
  const byGroupName = new Map();
  const groupOperations = [];

  for (const tab of tabs) {
    if (tab.id == null || tab.incognito) {
      continue;
    }

    const groupName = await getGroupNameFromTab(tab);
    if (!groupName) {
      continue;
    }

    inMemoryState.knownGroupNameByTabId.set(tab.id, groupName);

    if (!byGroupName.has(groupName)) {
      byGroupName.set(groupName, []);
    }
    byGroupName.get(groupName).push(tab);
    groupOperations.push(createOrUpdateGroupForTab(tab, groupName));
  }

  await Promise.allSettled(groupOperations);

  const records = await getGroupRecords();
  const touchedKeys = new Set();

  for (const [groupName, groupTabs] of byGroupName.entries()) {
    const key = getGroupKey(windowId, groupName);
    touchedKeys.add(key);
    const existing = records[key] || {
      windowId,
      groupName,
      pinned: false,
      urls: [],
      lastActiveTabId: null,
      mruAt: 0,
      toggledOff: false,
      color: null
    };

    const color = await getOrAssignColor(groupName);
    const activeTab = groupTabs.find((tab) => tab.active);

    records[key] = {
      ...existing,
      windowId,
      groupName,
      urls: uniqueUrls(groupTabs.map((tab) => tab.url).filter(Boolean)),
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

function scheduleReconcileWindow(windowId, delay = 120) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  if (inMemoryState.reconcileTimerByWindowId.has(windowId)) {
    clearTimeout(inMemoryState.reconcileTimerByWindowId.get(windowId));
  }

  const timer = setTimeout(() => {
    inMemoryState.reconcileTimerByWindowId.delete(windowId);

    const current = inMemoryState.reconcileInFlightByWindowId.get(windowId) || Promise.resolve();
    const next = current
      .catch(() => {})
      .then(() => reconcileWindow(windowId))
      .finally(() => {
        if (inMemoryState.reconcileInFlightByWindowId.get(windowId) === next) {
          inMemoryState.reconcileInFlightByWindowId.delete(windowId);
        }
      });

    inMemoryState.reconcileInFlightByWindowId.set(windowId, next);
  }, delay);

  inMemoryState.reconcileTimerByWindowId.set(windowId, timer);
}

async function getCurrentActiveGroupName(windowId) {
  const activeTabs = await chrome.tabs.query({ windowId, active: true });
  const activeTab = activeTabs[0];
  if (!activeTab) {
    return null;
  }
  return getGroupNameFromTab(activeTab);
}

function toGroupItem(record, tabCount, activeGroupName) {
  const groupName = getRecordGroupName(record);
  const isClosed = Boolean(record.toggledOff) && tabCount === 0;
  return {
    windowId: record.windowId,
    groupName,
    hostname: groupName,
    pinned: Boolean(record.pinned),
    toggledOff: isClosed,
    mruAt: Number(record.mruAt || 0),
    tabCount,
    color: record.color || "grey",
    active: activeGroupName === groupName
  };
}

async function getSidePanelData(windowId) {
  await reconcileWindow(windowId);

  const records = await getGroupRecords();
  const tabs = await chrome.tabs.query({ windowId });
  const tabCountByGroupName = new Map();

  for (const tab of tabs) {
    const groupName = await getGroupNameFromTab(tab);
    if (!groupName) {
      continue;
    }
    tabCountByGroupName.set(groupName, (tabCountByGroupName.get(groupName) || 0) + 1);
  }

  const windowRecords = Object.values(records).filter((record) => record.windowId === windowId);
  const activeGroupName = await getCurrentActiveGroupName(windowId);
  const pinned = [];
  const recent = [];

  for (const record of windowRecords) {
    const groupName = getRecordGroupName(record);
    if (!groupName) {
      continue;
    }

    const tabCount = tabCountByGroupName.get(groupName) || 0;
    if (tabCount > 0 && record.toggledOff) {
      await upsertGroupRecord(windowId, groupName, { toggledOff: false });
      record.toggledOff = false;
    }
    const item = toGroupItem(record, tabCount, activeGroupName);
    if (record.pinned) {
      pinned.push(item);
    } else {
      recent.push(item);
    }
  }

  pinned.sort((a, b) => a.groupName.localeCompare(b.groupName));
  recent.sort((a, b) => b.mruAt - a.mruAt);

  const allWindows = await chrome.windows.getAll();
  const windows = allWindows
    .filter((windowInfo) => !windowInfo.incognito)
    .map((windowInfo) => ({ id: windowInfo.id, focused: Boolean(windowInfo.focused) }));

  return {
    windowId,
    activeGroupName,
    activeHostname: activeGroupName,
    pinned,
    recent: recent.slice(0, 4),
    windows,
    empty: pinned.length === 0 && recent.length === 0
  };
}

async function handlePotentialGroupNameChange(tabId, changeInfo, tab) {
  if (!tab || tab.id == null || tab.windowId == null || tab.incognito) {
    return;
  }

  const groupName =
    (await resolveGroupNameFromUrl(changeInfo.url)) ||
    (await resolveGroupNameFromUrl(changeInfo.pendingUrl)) ||
    (await getGroupNameFromTab(tab));
  if (!groupName) {
    return;
  }

  const previousGroupName = inMemoryState.knownGroupNameByTabId.get(tabId);
  inMemoryState.knownGroupNameByTabId.set(tabId, groupName);

  const shouldGroupNow =
    previousGroupName !== groupName || Boolean(changeInfo.url) || Boolean(changeInfo.pendingUrl) || changeInfo.status === "complete";
  if (!shouldGroupNow) {
    return;
  }

  await upsertGroupRecord(tab.windowId, groupName, { toggledOff: false });

  try {
    await createOrUpdateGroupForTab(tab, groupName);
  } catch {
  }

  try {
    scheduleReconcileWindow(tab.windowId);
  } catch {
  }
}

chrome.runtime.onInstalled.addListener(() => {
  reconcileAllNormalWindows().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  reconcileAllNormalWindows().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  handlePotentialGroupNameChange(tabId, changeInfo, tab).catch(() => {});
});

chrome.tabs.onCreated.addListener((tab) => {
  handlePotentialGroupNameChange(tab.id, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab).catch(() => {});
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await handlePotentialGroupNameChange(tabId, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab);
    await reconcileWindow(attachInfo.newWindowId);
    await reconcileWindow(attachInfo.oldWindowId);
  } catch {
  }
});

chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    await handlePotentialGroupNameChange(addedTabId, { pendingUrl: tab.pendingUrl, url: tab.url, status: tab.status }, tab);
  } catch {
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  inMemoryState.knownGroupNameByTabId.delete(tabId);
  scheduleReconcileWindow(removeInfo.windowId);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const groupName = await getGroupNameFromTab(tab);
    if (!groupName || tab.windowId == null) {
      return;
    }
    await touchGroupUsage(tab.windowId, groupName, tab.id);
    scheduleReconcileWindow(tab.windowId);
  } catch {
  }
});

chrome.tabGroups.onRemoved.addListener((group) => {
  if (group.windowId == null) {
    return;
  }
  scheduleReconcileWindow(group.windowId);
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group.windowId == null) {
    return;
  }
  if (group.title) {
    upsertGroupRecord(group.windowId, group.title, { toggledOff: false }).catch(() => {});
  }
  scheduleReconcileWindow(group.windowId);
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  inMemoryState.duplicateCleanupDoneByWindowId.delete(windowId);
  if (inMemoryState.reconcileTimerByWindowId.has(windowId)) {
    clearTimeout(inMemoryState.reconcileTimerByWindowId.get(windowId));
    inMemoryState.reconcileTimerByWindowId.delete(windowId);
  }
  inMemoryState.reconcileInFlightByWindowId.delete(windowId);
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
    const requireWindowId = (value) => Number.isInteger(value) && value >= 0;
    const requireGroupName = (value) => typeof value === "string" && value.trim().length > 0;

    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid message" });
      return;
    }

    if (message.type === MESSAGE_TYPES.getSidePanelData) {
      if (!requireWindowId(message.windowId)) {
        sendResponse({ ok: false, error: "windowId must be a non-negative integer" });
        return;
      }
      const data = await getSidePanelData(message.windowId);
      sendResponse({ ok: true, data });
      return;
    }

    if (message.type === MESSAGE_TYPES.openGroup) {
      const groupName = message.groupName || message.hostname;
      if (!requireWindowId(message.windowId) || !requireGroupName(groupName)) {
        sendResponse({ ok: false, error: "windowId and groupName are required" });
        return;
      }
      await openGroup(message.windowId, groupName);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.toggleGroup) {
      const groupName = message.groupName || message.hostname;
      if (!requireWindowId(message.windowId) || !requireGroupName(groupName)) {
        sendResponse({ ok: false, error: "windowId and groupName are required" });
        return;
      }
      await toggleGroup(message.windowId, groupName);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.setPinned) {
      const groupName = message.groupName || message.hostname;
      if (!requireWindowId(message.windowId) || !requireGroupName(groupName) || typeof message.pinned !== "boolean") {
        sendResponse({ ok: false, error: "windowId, groupName, and pinned(boolean) are required" });
        return;
      }
      await setPinned(message.windowId, groupName, message.pinned);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.moveGroup) {
      const groupName = message.groupName || message.hostname;
      if (
        !requireWindowId(message.sourceWindowId) ||
        !requireWindowId(message.targetWindowId) ||
        !requireGroupName(groupName)
      ) {
        sendResponse({ ok: false, error: "sourceWindowId, targetWindowId, and groupName are required" });
        return;
      }
      await moveGroup(message.sourceWindowId, groupName, message.targetWindowId);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === MESSAGE_TYPES.getManualGroupRules) {
      const rules = await getManualGroupRules();
      sendResponse({ ok: true, rules });
      return;
    }

    if (message.type === MESSAGE_TYPES.addManualGroupRule) {
      if (
        typeof message.hostnameOrUrl !== "string" ||
        typeof message.groupName !== "string" ||
        (message.pathPrefix != null && typeof message.pathPrefix !== "string")
      ) {
        sendResponse({ ok: false, error: "hostnameOrUrl and groupName are required strings" });
        return;
      }
      const rules = await addManualGroupRule({
        hostnameOrUrl: message.hostnameOrUrl,
        pathPrefix: message.pathPrefix,
        groupName: message.groupName
      });
      await reconcileAllNormalWindows();
      sendResponse({ ok: true, rules });
      return;
    }

    if (message.type === MESSAGE_TYPES.removeManualGroupRule) {
      if (!requireGroupName(message.ruleId)) {
        sendResponse({ ok: false, error: "ruleId is required" });
        return;
      }
      const rules = await removeManualGroupRule(message.ruleId);
      await reconcileAllNormalWindows();
      sendResponse({ ok: true, rules });
      return;
    }

    sendResponse({ ok: false, error: "Unsupported message type" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error?.message || "Unknown error" });
  });

  return true;
});
