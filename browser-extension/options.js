const enabledInput = document.getElementById("enabled");
const portInput = document.getElementById("port");
const secretInput = document.getElementById("secret");
const cooldownMinutesInput = document.getElementById("cooldown-minutes");
const showCookieOnlyButtonInput = document.getElementById("show-cookie-only-button");
const devModeInput = document.getElementById("dev-mode");
const statusElement = document.getElementById("status");
const form = document.getElementById("options-form");
const syncButton = document.getElementById("sync-now");
const settingsControls = Array.from(form.querySelectorAll("input, button"));
let persistedSettings = null;

document.addEventListener("DOMContentLoaded", loadSettings);

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings();
});

showCookieOnlyButtonInput.addEventListener("change", async () => {
    const previous = persistedSettings ? persistedSettings.showCookieOnlyButton === true : !showCookieOnlyButtonInput.checked;
    const result = await saveSettings(false);
    if (!result.ok) {
        showCookieOnlyButtonInput.checked = previous;
        setStatus(result.error || "Could not save settings.", "error");
        return;
    }
    setStatus(
        showCookieOnlyButtonInput.checked
            ? "\"Sync cookies only now\" button enabled in the popup."
            : "\"Sync cookies only now\" button hidden from the popup.",
        "success"
    );
});

devModeInput.addEventListener("change", async () => {
    const previous = persistedSettings ? persistedSettings.devMode === true : !devModeInput.checked;
    const result = await saveSettings(false);
    if (!result.ok) {
        devModeInput.checked = previous;
        setStatus(result.error || "Could not save settings or clear the captured payload.", "error");
        return;
    }
    setStatus(
        devModeInput.checked
            ? "Developer mode enabled. Refresh a leetcode.com page, then copy the test fixture from the popup."
            : "Developer mode disabled. Captured payload cleared.",
        "success"
    );
});

syncButton.addEventListener("click", async () => {
    const saved = await saveSettings(false);
    if (!saved.ok) {
        setStatus(saved.error || "Could not save settings.", "error");
        return;
    }
    setStatus("Sending cookies only...", "");
    const result = await sendMessage({ type: "syncNow", reason: "options-cookie-only" });
    setStatus(result.ok ? result.message || "Synced cookies only to VS Code." : result.error, getStatusKind(result));
});

async function loadSettings() {
    const settings = await sendMessage({ type: "getSettings" });
    if (!settings.ok && settings.error) {
        setStatus(settings.error, "error");
        return;
    }
    persistedSettings = { ...settings };
    enabledInput.checked = settings.enabled !== false;
    portInput.value = settings.port || 17899;
    secretInput.value = settings.secret || "";
    cooldownMinutesInput.value = settings.cooldownMinutes || 30;
    showCookieOnlyButtonInput.checked = settings.showCookieOnlyButton === true;
    devModeInput.checked = settings.devMode === true;
}

async function saveSettings(showSaved = true) {
    const settings = {
            enabled: enabledInput.checked,
            port: portInput.value,
            secret: secretInput.value,
            cooldownMinutes: cooldownMinutesInput.value,
            showCookieOnlyButton: showCookieOnlyButtonInput.checked,
            devMode: devModeInput.checked,
    };
    setFormDisabled(true);
    const result = await sendMessage({ type: "saveSettings", settings });
    setFormDisabled(false);

    if (result.ok) {
        persistedSettings = { ...settings };
    }

    if (showSaved) {
        setStatus(result.ok ? "Settings saved." : result.error, result.ok ? "success" : "error");
    }
    return result;
}

function setFormDisabled(disabled) {
    for (const control of settingsControls) {
        control.disabled = disabled;
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
