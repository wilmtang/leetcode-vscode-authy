// Host permissions the extension needs to read the LeetCode session and reach
// the VS Code server. On Chrome these are granted at install, so the popup's
// permission banner stays hidden; on Firefox MV3 they are optional and must be
// granted at runtime from a user gesture.
const REQUIRED_ORIGINS = ["https://leetcode.com/*", "http://127.0.0.1/*"];

const summaryElement = document.getElementById("summary");
const lastSyncElement = document.getElementById("last-sync");
const nextSyncElement = document.getElementById("next-sync");
const lastIssueRow = document.getElementById("last-issue-row");
const lastIssueElement = document.getElementById("last-issue");
const statusElement = document.getElementById("status");
const permissionSection = document.getElementById("permission-section");
const grantAccessButton = document.getElementById("grant-access");
const expireNowButton = document.getElementById("expire-now");
const cookieOnlySection = document.getElementById("cookie-only-section");
const cookieOnlySyncButton = document.getElementById("cookie-only-sync");
const optionsButton = document.getElementById("open-options");
const devSection = document.getElementById("dev-section");
const devCaptureStatus = document.getElementById("dev-capture-status");
const copyFixtureButton = document.getElementById("copy-fixture");
const clearFixtureButton = document.getElementById("clear-fixture");

let currentSettings = null;

document.addEventListener("DOMContentLoaded", async () => {
    await Promise.all([refreshSettings(), refreshPermissionState()]);
    setInterval(() => {
        refreshSettings();
        refreshPermissionState();
    }, 30 * 1000);
});

grantAccessButton.addEventListener("click", async () => {
    // permissions.request() must be called synchronously from this click so the
    // browser treats it as a user gesture, so it is invoked before any await.
    const granted = await requestRequiredPermissions();
    setStatus(
        granted
            ? "Access granted. Open or refresh a leetcode.com page to sync cookies and headers to VS Code."
            : "Access was not granted. The extension can't read your LeetCode session without it.",
        granted ? "success" : "error"
    );
    await refreshPermissionState();
    await refreshSettings();
});

if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(refreshPermissionState);
}

if (chrome.permissions && chrome.permissions.onRemoved) {
    chrome.permissions.onRemoved.addListener(refreshPermissionState);
}

expireNowButton.addEventListener("click", async () => {
    setStatus("Expiring sync cooldown...", "");
    const result = await sendMessage({ type: "expireNow", reason: "popup-expire-now" });
    setStatus(result.ok ? result.message || "Ready. Open or refresh a leetcode.com page to sync cookies and headers to VS Code." : result.error, getStatusKind(result));
    await refreshSettings();
});

cookieOnlySyncButton.addEventListener("click", async () => {
    setStatus("Sending cookies only...", "");
    const result = await sendMessage({ type: "syncNow", reason: "popup-cookie-only" });
    setStatus(result.ok ? result.message || "Synced cookies only to VS Code." : result.error, getStatusKind(result));
    await refreshSettings();
});

optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

copyFixtureButton.addEventListener("click", async () => {
    setStatus("Preparing test fixture...", "");
    let result = await sendMessage({ type: "getDevPayload" });
    if (!result.ok || !result.payload) {
        result = await sendMessage({ type: "captureDevPayloadNow" });
        if (!result.ok) {
            setStatus(result.error, "error");
            return;
        }
    }

    const json = JSON.stringify(result.payload, null, 2);
    const copied = await copyText(json);
    setStatus(
        copied
            ? "Test fixture copied. Paste into src/test/.secrets/leetcode-auth.local.json in VS Code."
            : "Could not copy to clipboard. Open the console to copy it manually.",
        copied ? "success" : "error"
    );
    if (!copied) {
        console.info("[leetcode-auth-sync] Test fixture:\n" + json);
    }
    await refreshDevSection();
});

clearFixtureButton.addEventListener("click", async () => {
    await sendMessage({ type: "clearDevPayload" });
    setStatus("Captured payload cleared.", "success");
    await refreshDevSection();
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

async function refreshPermissionState() {
    const granted = await hasRequiredPermissions();
    permissionSection.hidden = granted;
}

function hasRequiredPermissions() {
    return new Promise((resolve) => {
        if (!chrome.permissions || !chrome.permissions.contains) {
            // Without the permissions API there is nothing to gate on; assume the
            // host access was granted at install (Chrome's behaviour).
            resolve(true);
            return;
        }

        try {
            chrome.permissions.contains({ origins: REQUIRED_ORIGINS }, (granted) => {
                resolve(!chrome.runtime.lastError && granted === true);
            });
        } catch (error) {
            resolve(true);
        }
    });
}

function requestRequiredPermissions() {
    return new Promise((resolve) => {
        if (!chrome.permissions || !chrome.permissions.request) {
            resolve(false);
            return;
        }

        try {
            chrome.permissions.request({ origins: REQUIRED_ORIGINS }, (granted) => {
                resolve(!chrome.runtime.lastError && granted === true);
            });
        } catch (error) {
            resolve(false);
        }
    });
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
    void refreshDevSection();
}

async function refreshDevSection() {
    if (!currentSettings || currentSettings.devMode !== true) {
        devSection.hidden = true;
        return;
    }

    devSection.hidden = false;
    const result = await sendMessage({ type: "getDevPayload" });
    renderDevCaptureStatus(result);
}

function renderDevCaptureStatus(result) {
    if (!result || !result.ok || !result.payload) {
        devCaptureStatus.textContent = "No payload captured yet. Refresh a leetcode.com page, then click Copy test fixture.";
        clearFixtureButton.disabled = true;
        return;
    }

    const headerCount = result.payload.requestHeaders ? Object.keys(result.payload.requestHeaders).length : 0;
    const when = result.capturedAt ? formatRelativeTime(result.capturedAt) : "just now";
    devCaptureStatus.textContent = `Captured ${when}: cookie + ${headerCount} browser header(s).`;
    clearFixtureButton.disabled = false;
}

async function copyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        // Fall through to the execCommand fallback below.
    }

    try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        return ok;
    } catch (error) {
        return false;
    }
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
