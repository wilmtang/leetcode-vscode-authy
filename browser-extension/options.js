const enabledInput = document.getElementById("enabled");
const portInput = document.getElementById("port");
const secretInput = document.getElementById("secret");
const cooldownMinutesInput = document.getElementById("cooldown-minutes");
const showCookieOnlyButtonInput = document.getElementById("show-cookie-only-button");
const statusElement = document.getElementById("status");
const form = document.getElementById("options-form");
const syncButton = document.getElementById("sync-now");

document.addEventListener("DOMContentLoaded", loadSettings);

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings();
});

showCookieOnlyButtonInput.addEventListener("change", async () => {
    await saveSettings(false);
    setStatus(
        showCookieOnlyButtonInput.checked
            ? "Cookie-only sync button enabled in the popup."
            : "Cookie-only sync button hidden from the popup.",
        "success"
    );
});

syncButton.addEventListener("click", async () => {
    await saveSettings(false);
    setStatus("Sending cookies only...", "");
    const result = await sendMessage({ type: "syncNow", reason: "options-cookie-only" });
    setStatus(result.ok ? result.message || "Cookie-only sync sent to VS Code." : result.error, getStatusKind(result));
});

async function loadSettings() {
    const settings = await sendMessage({ type: "getSettings" });
    enabledInput.checked = settings.enabled !== false;
    portInput.value = settings.port || 17899;
    secretInput.value = settings.secret || "";
    cooldownMinutesInput.value = settings.cooldownMinutes || 30;
    showCookieOnlyButtonInput.checked = settings.showCookieOnlyButton === true;
}

async function saveSettings(showSaved = true) {
    const result = await sendMessage({
        type: "saveSettings",
        settings: {
            enabled: enabledInput.checked,
            port: portInput.value,
            secret: secretInput.value,
            cooldownMinutes: cooldownMinutesInput.value,
            showCookieOnlyButton: showCookieOnlyButtonInput.checked,
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

function getStatusKind(result) {
    if (result.ok) {
        return "success";
    }

    return result.skipped ? "info" : "error";
}
