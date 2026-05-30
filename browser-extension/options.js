const enabledInput = document.getElementById("enabled");
const portInput = document.getElementById("port");
const secretInput = document.getElementById("secret");
const cooldownMinutesInput = document.getElementById("cooldown-minutes");
const statusElement = document.getElementById("status");
const form = document.getElementById("options-form");
const syncButton = document.getElementById("sync-now");

document.addEventListener("DOMContentLoaded", loadSettings);

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings();
});

syncButton.addEventListener("click", async () => {
    await saveSettings(false);
    setStatus("Syncing...", "");
    const result = await sendMessage({ type: "syncNow", reason: "options" });
    setStatus(result.ok ? result.message || "LeetCode cookie synced." : result.error, result.ok ? "success" : "error");
});

async function loadSettings() {
    const settings = await sendMessage({ type: "getSettings" });
    enabledInput.checked = settings.enabled !== false;
    portInput.value = settings.port || 17899;
    secretInput.value = settings.secret || "";
    cooldownMinutesInput.value = settings.cooldownMinutes || 30;
}

async function saveSettings(showSaved = true) {
    const result = await sendMessage({
        type: "saveSettings",
        settings: {
            enabled: enabledInput.checked,
            port: portInput.value,
            secret: secretInput.value,
            cooldownMinutes: cooldownMinutesInput.value,
        },
    });

    if (showSaved) {
        setStatus(result.ok ? "Settings saved." : result.error, result.ok ? "success" : "error");
    }
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
