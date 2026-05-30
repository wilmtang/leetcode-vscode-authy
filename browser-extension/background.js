const DEFAULTS = {
    enabled: true,
    port: 17899,
    secret: "",
    cooldownMinutes: 30,
    lastSyncAt: 0,
};

const api = typeof chrome !== "undefined" ? chrome : browser;

let syncTimer = null;
let syncInFlight = null;

async function getSettings() {
    const stored = await storageGet(DEFAULTS);
    return {
        enabled: stored.enabled !== false,
        port: normalizePort(stored.port),
        secret: typeof stored.secret === "string" ? stored.secret : "",
        cooldownMinutes: normalizeCooldownMinutes(stored.cooldownMinutes),
        lastSyncAt: normalizeTimestamp(stored.lastSyncAt),
    };
}

async function saveSettings(settings) {
    await storageSet({
        enabled: settings.enabled !== false,
        port: normalizePort(settings.port),
        secret: typeof settings.secret === "string" ? settings.secret : "",
        cooldownMinutes: normalizeCooldownMinutes(settings.cooldownMinutes),
    });
}

async function getLeetCodeCookieHeader() {
    const cookies = await getCookiesForLeetCode();
    const uniqueCookies = new Map();

    for (const cookie of cookies) {
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

async function syncNow(reason = "manual", cookieOverride = "") {
    if (syncInFlight) {
        return { ok: false, skipped: true, error: "Sync already in progress." };
    }

    syncInFlight = syncNowInternal(reason, cookieOverride);

    try {
        return await syncInFlight;
    } finally {
        syncInFlight = null;
    }
}

async function syncNowInternal(reason, cookieOverride) {
    const settings = await getSettings();

    if (!settings.enabled) {
        return { ok: false, error: "Auth sync is disabled." };
    }

    const remainingMs = getCooldownRemainingMs(settings);
    if (remainingMs > 0) {
        return {
            ok: false,
            skipped: true,
            error: `Sync cooldown active. Try again in ${formatDuration(remainingMs)}.`,
            nextSyncAt: settings.lastSyncAt + settings.cooldownMinutes * 60 * 1000,
        };
    }

    const cookie = typeof cookieOverride === "string" && cookieOverride
        ? cookieOverride
        : await getLeetCodeCookieHeader();

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

    if (data.ok === false) {
        return {
            ok: false,
            error: data.error || "VS Code rejected the cookie update.",
        };
    }

    const lastSyncAt = Date.now();
    await storageSet({ lastSyncAt });

    return {
        ...data,
        ok: true,
        lastSyncAt,
    };
}

function scheduleSync(reason, cookie) {
    if (syncTimer) {
        clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(() => {
        syncTimer = null;
        syncNow(reason, cookie).catch((error) => {
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

function normalizeCooldownMinutes(minutes) {
    const parsed = Number(minutes);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 1440) {
        return Math.round(parsed);
    }

    return DEFAULTS.cooldownMinutes;
}

function normalizeTimestamp(timestamp) {
    const parsed = Number(timestamp);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getCooldownRemainingMs(settings) {
    if (!settings.lastSyncAt) {
        return 0;
    }

    const cooldownMs = settings.cooldownMinutes * 60 * 1000;
    return Math.max(0, settings.lastSyncAt + cooldownMs - Date.now());
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes <= 0) {
        return `${seconds}s`;
    }

    if (seconds === 0) {
        return `${minutes}m`;
    }

    return `${minutes}m ${seconds}s`;
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

function getCookieHeaderFromRequest(details) {
    for (const header of details.requestHeaders || []) {
        if (typeof header.name === "string" && header.name.toLowerCase() === "cookie") {
            return typeof header.value === "string" ? header.value : "";
        }
    }

    return "";
}

function handleLeetCodeXhr(details) {
    const cookie = getCookieHeaderFromRequest(details);

    if (cookie && cookie.includes("LEETCODE_SESSION=")) {
        scheduleSync("leetcode-xhr", cookie);
    }
}

function registerLeetCodeXhrListener() {
    if (!api.webRequest || !api.webRequest.onBeforeSendHeaders) {
        console.warn("[leetcode-auth-sync] webRequest is unavailable; automatic XHR sync is disabled.");
        return;
    }

    const filter = {
        urls: ["https://leetcode.com/*"],
        types: ["xmlhttprequest"],
    };

    try {
        api.webRequest.onBeforeSendHeaders.addListener(handleLeetCodeXhr, filter, ["requestHeaders", "extraHeaders"]);
    } catch (error) {
        api.webRequest.onBeforeSendHeaders.addListener(handleLeetCodeXhr, filter, ["requestHeaders"]);
    }
}

registerLeetCodeXhrListener();

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
