const summaryElement = document.getElementById("summary");
const lastSyncElement = document.getElementById("last-sync");
const nextSyncElement = document.getElementById("next-sync");
const lastIssueRow = document.getElementById("last-issue-row");
const lastIssueElement = document.getElementById("last-issue");
const statusElement = document.getElementById("status");
const syncButton = document.getElementById("sync-now");
const optionsButton = document.getElementById("open-options");

let currentSettings = null;

document.addEventListener("DOMContentLoaded", async () => {
    await refreshSettings();
    setInterval(renderSettings, 30 * 1000);
});

syncButton.addEventListener("click", async () => {
    setStatus("Syncing...", "");
    const result = await sendMessage({ type: "syncNow", reason: "popup" });
    setStatus(result.ok ? result.message || "Synced your LeetCode session to VS Code." : result.error, getStatusKind(result));
    await refreshSettings();
});

optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

async function refreshSettings() {
    currentSettings = await sendMessage({ type: "getSettings" });
    renderSettings();
}

function renderSettings() {
    if (!currentSettings) {
        return;
    }

    summaryElement.textContent = formatConnection(currentSettings);
    lastSyncElement.textContent = formatTimestamp(currentSettings.lastSyncAt);
    nextSyncElement.textContent = formatNextSync(currentSettings);
    renderLastIssue(currentSettings);
}

function renderLastIssue(settings) {
    if (!settings.lastSyncError || !settings.lastSyncErrorAt) {
        lastIssueRow.hidden = true;
        lastIssueElement.textContent = "";
        return;
    }

    const prefix = isAutomaticSyncReason(settings.lastSyncErrorReason)
        ? "Automatic sync failed"
        : "Sync failed";
    lastIssueElement.textContent = `${prefix} ${formatRelativeTime(settings.lastSyncErrorAt)}: ${settings.lastSyncError}`;
    lastIssueRow.hidden = false;
}

function formatConnection(settings) {
    const enabledText = settings.enabled !== false ? "Enabled" : "Disabled";
    const secretText = settings.secret ? "shared secret set" : "no shared secret";
    return `${enabledText}. Sending to VS Code on port ${settings.port || 17899}; ${secretText}.`;
}

function formatNextSync(settings) {
    if (settings.enabled === false) {
        return "Disabled";
    }

    if (!settings.lastSyncAt) {
        return "Ready now";
    }

    const nextSyncAt = Number(settings.nextSyncAt || 0);
    const remainingMs = nextSyncAt - Date.now();

    if (nextSyncAt > 0 && remainingMs > 0) {
        return `In ${formatDuration(remainingMs, "ceil")}`;
    }

    return "Ready now";
}

function formatTimestamp(timestamp) {
    if (!timestamp) {
        return "Never";
    }

    return `${formatRelativeTime(timestamp)} (${new Date(timestamp).toLocaleString([], {
        dateStyle: "medium",
        timeStyle: "short",
    })})`;
}

function formatRelativeTime(timestamp) {
    const elapsedMs = Date.now() - Number(timestamp);

    if (!Number.isFinite(elapsedMs)) {
        return "";
    }

    if (elapsedMs < 45 * 1000) {
        return "just now";
    }

    return `${formatDuration(elapsedMs, "floor")} ago`;
}

function formatDuration(milliseconds, rounding) {
    const totalMinutes = Math.max(
        1,
        rounding === "floor"
            ? Math.floor(milliseconds / (60 * 1000))
            : Math.ceil(milliseconds / (60 * 1000))
    );
    const hours = Math.floor(totalMinutes / 60);
    const remainingMinutes = totalMinutes % 60;

    if (hours > 0) {
        return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    }

    return `${totalMinutes}m`;
}

function isAutomaticSyncReason(reason) {
    return reason === "leetcode-xhr";
}

function getStatusKind(result) {
    if (result.ok) {
        return "success";
    }

    return result.skipped ? "info" : "error";
}

function sendMessage(message) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(message, (response) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
                resolve({ ok: false, error: lastError.message });
                return;
            }

            resolve(response || { ok: false, error: "No response from extension." });
        });
    });
}

function setStatus(message, kind) {
    statusElement.textContent = message || "";
    statusElement.className = `status ${kind || ""}`.trim();
}
