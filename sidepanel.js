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

const COLOR_BY_NAME = {
  grey: "#80868b",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#188038",
  pink: "#d01884",
  purple: "#8430ce",
  cyan: "#0b57d0",
  orange: "#e37400"
};

let refreshTimer = null;
let busyCounter = 0;

function setStatus(message) {
  const statusElement = document.getElementById("status");
  if (!statusElement) {
    return;
  }
  statusElement.textContent = message || "";
}

function setBusyState(isBusy) {
  if (isBusy) {
    busyCounter += 1;
  } else {
    busyCounter = Math.max(0, busyCounter - 1);
  }

  const disabled = busyCounter > 0;
  const controls = document.querySelectorAll("button, select");
  for (const control of controls) {
    control.disabled = disabled;
  }
}

async function runAction(actionLabel, action) {
  setBusyState(true);
  setStatus(`${actionLabel}...`);
  try {
    await action();
    setStatus(`${actionLabel} done`);
    setTimeout(() => {
      if (busyCounter === 0) {
        setStatus("");
      }
    }, 900);
  } catch {
    setStatus(`${actionLabel} failed`);
  } finally {
    setBusyState(false);
  }
}

function debounceRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh().catch(() => {});
  }, 120);
}

function sendMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function getCurrentWindowId() {
  const current = await chrome.windows.getCurrent();
  return current.id;
}

function createButton(label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function createMoveControls(group, windows, currentWindowId) {
  const wrapper = document.createElement("div");
  wrapper.className = "move-row";
  const targets = windows.filter((windowInfo) => windowInfo.id !== currentWindowId);

  const select = document.createElement("select");
  for (const target of targets) {
    const option = document.createElement("option");
    option.value = String(target.id);
    option.textContent = `Window ${target.id}`;
    select.appendChild(option);
  }

  const moveButton = createButton("Move", () => {
    runAction("Move group", async () => {
      if (!select.value) {
        return;
      }

      const response = await sendMessage(MESSAGE_TYPES.moveGroup, {
        sourceWindowId: currentWindowId,
        hostname: group.hostname,
        targetWindowId: Number(select.value)
      });

      if (!response?.ok) {
        throw new Error("Move failed");
      }

      await refresh();
    }).catch(() => {});
  });

  if (!targets.length) {
    select.disabled = true;
    moveButton.disabled = true;
  }

  wrapper.appendChild(select);
  wrapper.appendChild(moveButton);
  return wrapper;
}

function renderGroupRow(group, windows, currentWindowId) {
  const row = document.createElement("article");
  row.className = `group-row${group.active ? " active" : ""}`;
  row.style.borderLeftColor = COLOR_BY_NAME[group.color] || COLOR_BY_NAME.grey;

  const main = document.createElement("div");
  main.className = "group-main";

  const title = document.createElement("div");
  title.className = "group-title";

  const hostname = document.createElement("div");
  hostname.className = "group-hostname";
  hostname.title = group.hostname;
  hostname.textContent = group.hostname;

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = `${group.tabCount}`;

  title.appendChild(hostname);
  title.appendChild(badge);

  const meta = document.createElement("div");
  meta.className = "group-meta";
  const state = group.toggledOff ? "Closed" : "Open";
  const active = group.active ? " • Active" : "";
  meta.textContent = `${state}${active}`;

  main.appendChild(title);
  main.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "actions";

  const actionRow = document.createElement("div");
  actionRow.className = "action-row";

  actionRow.appendChild(
    createButton("Open", () => {
      runAction("Open group", async () => {
        const response = await sendMessage(MESSAGE_TYPES.openGroup, {
          windowId: currentWindowId,
          hostname: group.hostname
        });

        if (!response?.ok) {
          throw new Error("Open failed");
        }

        await refresh();
      }).catch(() => {});
    })
  );

  actionRow.appendChild(
    createButton("Toggle", () => {
      runAction("Toggle group", async () => {
        const response = await sendMessage(MESSAGE_TYPES.toggleGroup, {
          windowId: currentWindowId,
          hostname: group.hostname
        });

        if (!response?.ok) {
          throw new Error("Toggle failed");
        }

        await refresh();
      }).catch(() => {});
    })
  );

  actionRow.appendChild(
    createButton(group.pinned ? "Unpin" : "Pin", () => {
      runAction(group.pinned ? "Unpin group" : "Pin group", async () => {
        const response = await sendMessage(MESSAGE_TYPES.setPinned, {
          windowId: currentWindowId,
          hostname: group.hostname,
          pinned: !group.pinned
        });

        if (!response?.ok) {
          throw new Error("Pin failed");
        }

        await refresh();
      }).catch(() => {});
    })
  );

  actions.appendChild(actionRow);

  actions.appendChild(createMoveControls(group, windows, currentWindowId));

  row.appendChild(main);
  row.appendChild(actions);
  return row;
}

function renderGroupList(element, groups, windows, currentWindowId) {
  element.innerHTML = "";
  for (const group of groups) {
    element.appendChild(renderGroupRow(group, windows, currentWindowId));
  }
}

function renderRulesList(rules) {
  const rulesList = document.getElementById("rules-list");
  const rulesEmpty = document.getElementById("rules-empty");
  if (!rulesList || !rulesEmpty) {
    return;
  }

  rulesList.innerHTML = "";

  for (const rule of rules) {
    const row = document.createElement("article");
    row.className = "rule-row";

    const text = document.createElement("div");
    text.className = "rule-text";
    text.title = `${rule.hostname}${rule.pathPrefix} → ${rule.groupName}`;
    text.textContent = `${rule.hostname}${rule.pathPrefix} → ${rule.groupName}`;

    const removeButton = createButton("Remove", () => {
      runAction("Remove rule", async () => {
        const response = await sendMessage(MESSAGE_TYPES.removeManualGroupRule, { ruleId: rule.id });
        if (!response?.ok) {
          throw new Error("Rule remove failed");
        }

        await Promise.all([refresh(), refreshRules()]);
      }).catch(() => {});
    });

    row.appendChild(text);
    row.appendChild(removeButton);
    rulesList.appendChild(row);
  }

  rulesEmpty.hidden = rules.length > 0;
}

async function refreshRules() {
  const response = await sendMessage(MESSAGE_TYPES.getManualGroupRules);
  if (!response?.ok || !Array.isArray(response.rules)) {
    renderRulesList([]);
    return;
  }
  renderRulesList(response.rules);
}

function setupRuleForm() {
  const form = document.getElementById("rule-form");
  const hostnameInput = document.getElementById("rule-hostname-or-url");
  const pathPrefixInput = document.getElementById("rule-path-prefix");
  const groupNameInput = document.getElementById("rule-group-name");

  if (!form || !hostnameInput || !pathPrefixInput || !groupNameInput) {
    return;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    runAction("Add rule", async () => {
      const response = await sendMessage(MESSAGE_TYPES.addManualGroupRule, {
        hostnameOrUrl: hostnameInput.value,
        pathPrefix: pathPrefixInput.value,
        groupName: groupNameInput.value
      });

      if (!response?.ok) {
        throw new Error("Rule add failed");
      }

      pathPrefixInput.value = "";
      groupNameInput.value = "";
      await Promise.all([refresh(), refreshRules()]);
    }).catch(() => {});
  });
}

async function refresh() {
  const currentWindowId = await getCurrentWindowId();
  const response = await sendMessage(MESSAGE_TYPES.getSidePanelData, { windowId: currentWindowId });
  if (!response?.ok || !response.data) {
    setStatus("Unable to load groups");
    return;
  }

  const data = response.data;
  const pinnedList = document.getElementById("pinned-list");
  const recentList = document.getElementById("recent-list");
  const pinnedEmpty = document.getElementById("pinned-empty");
  const recentEmpty = document.getElementById("recent-empty");
  const emptyState = document.getElementById("empty-state");

  renderGroupList(pinnedList, data.pinned, data.windows, currentWindowId);
  renderGroupList(recentList, data.recent, data.windows, currentWindowId);
  pinnedEmpty.hidden = data.pinned.length > 0 || data.empty;
  recentEmpty.hidden = data.recent.length > 0 || data.empty;

  emptyState.hidden = !data.empty;
  if (!data.empty) {
    setStatus("");
  }
}

chrome.tabs.onActivated.addListener(debounceRefresh);
chrome.tabs.onUpdated.addListener(debounceRefresh);
chrome.tabs.onRemoved.addListener(debounceRefresh);
chrome.tabs.onCreated.addListener(debounceRefresh);
chrome.tabs.onAttached.addListener(debounceRefresh);
chrome.tabs.onDetached.addListener(debounceRefresh);
chrome.tabGroups.onUpdated.addListener(debounceRefresh);
chrome.tabGroups.onRemoved.addListener(debounceRefresh);
chrome.windows.onFocusChanged.addListener(debounceRefresh);

setupRuleForm();
Promise.all([refresh(), refreshRules()]).catch(() => {});
