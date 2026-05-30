const DEFAULTS = {
    enabled: true,
    port: 17899,
    secret: "",
};

const COOKIE_NAMES = ["LEETCODE_SESSION", "csrftoken", "cf_clearance", "__cf_bm"];
const api = typeof chrome !== "undefined" ? chrome : browser;

let syncTimer = null;

async function getSettings() {
    const stored = await storageGet(DEFAULTS);
    return {
        enabled: stored.enabled !== false,
        port: normalizePort(stored.port),
        secret: typeof stored.secret === "string" ? stored.secret : "",
    };
}

async function saveSettings(settings) {
    await storageSet({
        enabled: settings.enabled !== false,
        port: normalizePort(settings.port),
        secret: typeof settings.secret === "string" ? settings.secret : "",
    });
}

async function getLeetCodeCookieHeader() {
    const cookies = await getCookiesForLeetCode();
    const uniqueCookies = new Map();

    for (const cookie of cookies) {
        if (!COOKIE_NAMES.includes(cookie.name)) {
            continue;
        }

        uniqueCookies.set(`${cookie.name}:${cookie.domain}:${cookie.path}`, cookie);
    }

    return Array.from(uniqueCookies.values())
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
}

async function getCookiesForLeetCode() {
    const byDomain = await cookiesGetAll({ domain: "leetcode.com" });
    const byUrl = await cookiesGetAll({ url: "https://leetcode.com/" });
    const uniqueCookies = new Map();

    for (const cookie of [...byDomain, ...byUrl]) {
        uniqueCookies.set(`${cookie.name}:${cookie.domain}:${cookie.path}`, cookie);
    }

    return Array.from(uniqueCookies.values());
}

async function syncNow(reason = "manual") {
    const settings = await getSettings();

    if (!settings.enabled) {
        return { ok: false, error: "Auth sync is disabled." };
    }

    const cookie = await getLeetCodeCookieHeader();

    if (!cookie || !cookie.includes("LEETCODE_SESSION=")) {
        return { ok: false, error: "No LeetCode session cookie found. Please log in to leetcode.com first." };
    }

    const headers = {
        "Content-Type": "application/json",
    };

    if (settings.secret) {
        headers["X-LeetCode-AuthSync-Secret"] = settings.secret;
    }

    const response = await fetch(`http://127.0.0.1:${settings.port}/auth/update`, {
        method: "POST",
        headers,
        body: JSON.stringify({
            cookie,
            source: "browser-extension",
            reason,
            updatedAt: Date.now(),
        }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        return {
            ok: false,
            error: data.error || `HTTP ${response.status}`,
        };
    }

    return data;
}

function scheduleSync(reason) {
    if (syncTimer) {
        clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(() => {
        syncNow(reason).catch((error) => {
            console.warn(`[leetcode-auth-sync] Sync failed: ${error.message || String(error)}`);
        });
    }, 1000);
}

function normalizePort(port) {
    const parsed = Number(port);
    if (Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535) {
        return parsed;
    }

    return DEFAULTS.port;
}

function storageGet(defaults) {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        return browser.storage.local.get(defaults);
    }

    return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function storageSet(values) {
    if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
        return browser.storage.local.set(values);
    }

    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function cookiesGetAll(query) {
    if (typeof browser !== "undefined" && browser.cookies) {
        return browser.cookies.getAll(query);
    }

    return new Promise((resolve) => chrome.cookies.getAll(query, resolve));
}

function createAlarm() {
    api.alarms.create("periodic-sync", { periodInMinutes: 5 });
}

api.runtime.onInstalled.addListener(() => {
    createAlarm();
    scheduleSync("install");
});

api.runtime.onStartup.addListener(() => {
    createAlarm();
    scheduleSync("startup");
});

api.cookies.onChanged.addListener((changeInfo) => {
    const cookie = changeInfo.cookie;
    if (cookie.domain.includes("leetcode.com") && COOKIE_NAMES.includes(cookie.name)) {
        scheduleSync("cookie-change");
    }
});

api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.url && tab.url.startsWith("https://leetcode.com/")) {
        scheduleSync("leetcode-page-load");
    }
});

api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "periodic-sync") {
        scheduleSync("periodic");
    }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") {
        return false;
    }

    if (message.type === "syncNow") {
        syncNow(message.reason || "manual").then(sendResponse, (error) => {
            sendResponse({ ok: false, error: error.message || String(error) });
        });
        return true;
    }

    if (message.type === "getSettings") {
        getSettings().then(sendResponse, (error) => {
            sendResponse({ ok: false, error: error.message || String(error) });
        });
        return true;
    }

    if (message.type === "saveSettings") {
        saveSettings(message.settings || {}).then(() => sendResponse({ ok: true }), (error) => {
            sendResponse({ ok: false, error: error.message || String(error) });
        });
        return true;
    }

    return false;
});
