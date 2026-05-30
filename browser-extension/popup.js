const summaryElement = document.getElementById("summary");
const statusElement = document.getElementById("status");
const syncButton = document.getElementById("sync-now");
const optionsButton = document.getElementById("open-options");

document.addEventListener("DOMContentLoaded", async () => {
    const settings = await sendMessage({ type: "getSettings" });
    summaryElement.textContent = `${settings.enabled ? "Enabled" : "Disabled"} on port ${settings.port || 17899}. Secret ${settings.secret ? "enabled" : "disabled"}.`;
});

syncButton.addEventListener("click", async () => {
    setStatus("Syncing...", "");
    const result = await sendMessage({ type: "syncNow", reason: "popup" });
    setStatus(result.ok ? result.message || "LeetCode cookie synced." : result.error, result.ok ? "success" : "error");
});

optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
});

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
