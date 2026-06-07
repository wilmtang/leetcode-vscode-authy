const summaryElement = document.getElementById("summary");
const lastSyncElement = document.getElementById("last-sync");
const nextSyncElement = document.getElementById("next-sync");
const lastIssueRow = document.getElementById("last-issue-row");
const lastIssueElement = document.getElementById("last-issue");
const statusElement = document.getElementById("status");
const expireNowButton = document.getElementById("expire-now");
const cookieOnlySection = document.getElementById("cookie-only-section");
const cookieOnlySyncButton = document.getElementById("cookie-only-sync");
const optionsButton = document.getElementById("open-options");

let currentSettings = null;

document.addEventListener("DOMContentLoaded", async () => {
    await refreshSettings();
    setInterval(refreshSettings, 30 * 1000);
});

expireNowButton.addEventListener("click", async () => {
    setStatus("Expiring sync cooldown...", "");
    const result = await sendMessage({ type: "expireNow", reason: "popup-expire-now" });
    setStatus(result.ok ? result.message || "Ready. Open or refresh a leetcode.com page to sync cookies and headers to VS Code." : result.error, getStatusKind(result));
    await refreshSettings();
});

cookieOnlySyncButton.addEventListener("click", async () => {
    setStatus("Sending cookies only...", "");
    const result = await sendMessage({ type: "syncNow", reason: "popup-cookie-only" });
    setStatus(result.ok ? result.message || "Cookie-only sync sent to VS Code." : result.error, getStatusKind(result));
    await refreshSettings();
});

optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === "local" && changes.showCookieOnlyButton) {
            refreshSettings();
        }
    });
}

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
    cookieOnlySection.hidden = currentSettings.showCookieOnlyButton !== true;
    cookieOnlySyncButton.hidden = currentSettings.showCookieOnlyButton !== true;
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
