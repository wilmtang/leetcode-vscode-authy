const DEFAULTS = {
    enabled: true,
    port: 17899,
    secret: "",
    cooldownMinutes: 30,
    showCookieOnlyButton: false,
    devMode: false,
    lastSyncAt: 0,
    lastSyncError: "",
    lastSyncErrorAt: 0,
    lastSyncErrorReason: "",
};

// Developer-mode capture. Only written when devMode is enabled, so the login
// secret is never persisted at rest for normal users. These keys live outside
// DEFAULTS because they are captured runtime data, not user settings.
const DEV_CAPTURE_KEYS = {
    devCapturedPayload: null,
    devCapturedAt: 0,
};

const api = typeof chrome !== "undefined" ? chrome : browser;

let syncTimer = null;
let syncInFlight = null;
let lastAutomaticCookieProbeAt = 0;

async function getSettings() {
    const stored = await storageGet(DEFAULTS);
    const settings = {
        enabled: stored.enabled !== false,
        port: normalizePort(stored.port),
        secret: typeof stored.secret === "string" ? stored.secret : "",
        cooldownMinutes: normalizeCooldownMinutes(stored.cooldownMinutes),
        showCookieOnlyButton: stored.showCookieOnlyButton === true,
        devMode: stored.devMode === true,
        lastSyncAt: normalizeTimestamp(stored.lastSyncAt),
        lastSyncError: typeof stored.lastSyncError === "string" ? stored.lastSyncError : "",
        lastSyncErrorAt: normalizeTimestamp(stored.lastSyncErrorAt),
        lastSyncErrorReason: typeof stored.lastSyncErrorReason === "string" ? stored.lastSyncErrorReason : "",
    };

    return addComputedSyncStatus(settings);
}

async function saveSettings(settings) {
    await storageSet({
        enabled: settings.enabled !== false,
        port: normalizePort(settings.port),
        secret: typeof settings.secret === "string" ? settings.secret : "",
        cooldownMinutes: normalizeCooldownMinutes(settings.cooldownMinutes),
        showCookieOnlyButton: settings.showCookieOnlyButton === true,
        devMode: settings.devMode === true,
    });

    if (settings.devMode !== true) {
        // Leaving dev mode wipes any captured login payload from storage.
        await storageSet({ devCapturedPayload: null, devCapturedAt: 0 });
    }
}

async function expireSyncCooldown(reason = "manual") {
    const settings = await getSettings();
    const cooldownMs = settings.cooldownMinutes * 60 * 1000;
    const expiredState = {
        lastSyncAt: settings.lastSyncAt ? Math.max(1, Date.now() - cooldownMs - 1000) : 0,
    };

    await storageSet(expiredState);

    return {
        ...addComputedSyncStatus({
            ...settings,
            ...expiredState,
        }),
        ok: true,
        message: "Ready. Open or refresh a leetcode.com page to sync cookies and browser request headers to VS Code.",
        reason,
    };
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

async function syncNow(reason = "manual", cookieOverride = "", requestHeadersOverride = null) {
    if (syncInFlight) {
        return { ok: false, skipped: true, error: "Sync already in progress." };
    }

    syncInFlight = syncNowInternal(reason, cookieOverride, requestHeadersOverride);

    try {
        return await syncInFlight;
    } finally {
        syncInFlight = null;
    }
}

async function syncNowInternal(reason, cookieOverride, requestHeadersOverride) {
    const settings = await getSettings();
    const syncReason = typeof reason === "string" && reason ? reason : "manual";

    if (!settings.enabled) {
        return {
            ...addComputedSyncStatus(settings),
            ok: false,
            skipped: true,
            error: "Auth sync is disabled. Turn it on in the extension settings before syncing.",
        };
    }

    const remainingMs = shouldRespectCooldown(syncReason, requestHeadersOverride) ? getCooldownRemainingMs(settings) : 0;
    if (remainingMs > 0) {
        return {
            ...addComputedSyncStatus(settings),
            ok: false,
            skipped: true,
            error: `Sync cooldown is active. Next sync is available in ${formatDuration(remainingMs)}.`,
            nextSyncAt: settings.lastSyncAt + settings.cooldownMinutes * 60 * 1000,
        };
    }

    const cookie = typeof cookieOverride === "string" && cookieOverride
        ? cookieOverride
        : await getLeetCodeCookieHeader();
    const loginCookieStatus = getLeetCodeLoginCookieStatus(cookie);

    if (!loginCookieStatus.ok) {
        if (isAutomaticSyncReason(syncReason)) {
            return {
                ...addComputedSyncStatus(settings),
                ok: false,
                skipped: true,
                error: loginCookieStatus.error,
                code: "missing-session-cookie",
            };
        }

        return recordSyncFailure(loginCookieStatus.error, syncReason, "missing-session-cookie", settings);
    }

    const replayableRequestHeaders = getReplayableRequestHeaders(requestHeadersOverride);

    if (settings.devMode) {
        // Persist the exact data we send so a developer can copy it from the
        // popup into the VS Code integration-test fixture. Captured before the
        // fetch so it still works when VS Code is not running.
        await storeDevPayload(cookie, replayableRequestHeaders);
    }

    const headers = {
        "Content-Type": "application/json",
    };

    if (settings.secret) {
        headers["X-LeetCode-AuthSync-Secret"] = settings.secret;
    }

    let response;

    try {
        response = await fetch(`http://127.0.0.1:${settings.port}/auth/update`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                cookie,
                requestHeaders: replayableRequestHeaders,
                source: "browser-extension",
                reason: syncReason,
                userAgent: getBrowserUserAgent(),
                updatedAt: Date.now(),
            }),
        });
    } catch (error) {
        return recordSyncFailure(getFetchFailureMessage(settings.port), syncReason, "vscode-unavailable", settings);
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        return recordSyncFailure(getServerFailureMessage(response.status, data.error), syncReason, "server-error", settings);
    }

    if (data.ok === false) {
        return recordSyncFailure(data.error || "VS Code rejected the LeetCode session update.", syncReason, "server-rejected", settings);
    }

    const lastSyncAt = Date.now();
    const successState = {
        lastSyncAt,
        lastSyncError: "",
        lastSyncErrorAt: 0,
        lastSyncErrorReason: "",
    };

    await storageSet(successState);

    return {
        ...data,
        ...addComputedSyncStatus({
            ...settings,
            ...successState,
        }),
        ok: true,
        message: data.message || "Synced your LeetCode session to VS Code.",
    };
}

function scheduleSync(reason, cookie, requestHeaders = null) {
    if (syncTimer) {
        clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(() => {
        syncTimer = null;
        syncNow(reason, cookie, requestHeaders).then((result) => {
            if (result && !result.ok && !result.skipped) {
                console.warn(`[leetcode-auth-sync] Sync failed: ${result.error}`);
            }
        }, (error) => {
            const message = error.message || String(error);
            void recordSyncFailure(message, reason, "unexpected-error").catch(() => undefined);
            console.warn(`[leetcode-auth-sync] Sync failed: ${message}`);
        });
    }, 1000);
}

async function recordSyncFailure(error, reason, code, settings = null) {
    const lastSyncError = error || "Sync failed.";
    const lastSyncErrorAt = Date.now();
    const lastSyncErrorReason = typeof reason === "string" && reason ? reason : "manual";

    await storageSet({
        lastSyncError,
        lastSyncErrorAt,
        lastSyncErrorReason,
    });

    const baseSettings = settings || await getSettings();

    return {
        ...addComputedSyncStatus({
            ...baseSettings,
            lastSyncError,
            lastSyncErrorAt,
            lastSyncErrorReason,
        }),
        ok: false,
        error: lastSyncError,
        code,
    };
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

function addComputedSyncStatus(settings) {
    const cooldownRemainingMs = getCooldownRemainingMs(settings);
    const nextSyncAt = cooldownRemainingMs > 0
        ? settings.lastSyncAt + settings.cooldownMinutes * 60 * 1000
        : 0;

    return {
        ...settings,
        cooldownRemainingMs,
        nextSyncAt,
    };
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

function getLeetCodeLoginCookieStatus(cookieHeader) {
    if (!cookieHeader || typeof cookieHeader !== "string") {
        return {
            ok: false,
            error: "No LeetCode cookies were found. Sign in to leetcode.com in this browser, then sync again.",
        };
    }

    const cookies = parseCookieHeader(cookieHeader);
    const sessionToken = cookies.get("LEETCODE_SESSION");

    if (!hasUsableCookieToken(sessionToken)) {
        return {
            ok: false,
            error: "LeetCode cookies were found, but they do not include a valid LEETCODE_SESSION login token. Sign in to leetcode.com in this browser, then sync again.",
        };
    }

    return { ok: true };
}

function isAutomaticSyncReason(reason) {
    return reason === "leetcode-xhr";
}

function shouldRespectCooldown(reason, requestHeaders = null) {
    return isAutomaticSyncReason(reason) && Object.keys(getReplayableRequestHeaders(requestHeaders)).length === 0;
}

function parseCookieHeader(cookieHeader) {
    const cookies = new Map();

    for (const part of cookieHeader.split(";")) {
        const trimmed = part.trim();
        const separatorIndex = trimmed.indexOf("=");

        if (separatorIndex <= 0) {
            continue;
        }

        cookies.set(trimmed.slice(0, separatorIndex), trimmed.slice(separatorIndex + 1));
    }

    return cookies;
}

function hasUsableCookieToken(value) {
    if (typeof value !== "string") {
        return false;
    }

    const token = value.trim();
    return !!token && token !== "null" && token !== "undefined" && token !== "deleted";
}

function getFetchFailureMessage(port) {
    return `No VS Code LeetCode auth sync server was found on port ${port}. Open VS Code with the LeetCode extension enabled, or set the same auth sync port in both places.`;
}

function getServerFailureMessage(status, error) {
    const serverMessage = typeof error === "string" && error ? error : "";
    const lowerServerMessage = serverMessage.toLowerCase();

    if (status === 401 && lowerServerMessage.includes("secret")) {
        return "The shared secret does not match VS Code. Update the browser extension secret or the VS Code leetcode.authSync.secret setting.";
    }

    if (status === 400 && lowerServerMessage.includes("leetcode") && lowerServerMessage.includes("cookie")) {
        return "VS Code rejected the request because it did not include a usable LeetCode login session cookie.";
    }

    if (status === 404) {
        return "VS Code responded, but the auth sync endpoint was not found. Make sure the VS Code LeetCode extension is up to date.";
    }

    return serverMessage || `VS Code returned HTTP ${status}.`;
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

function getBrowserUserAgent() {
    return typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
}

async function storeDevPayload(cookie, requestHeaders) {
    await storageSet({
        devCapturedPayload: buildDevFixture(cookie, requestHeaders),
        devCapturedAt: Date.now(),
    });
}

function buildDevFixture(cookie, requestHeaders) {
    return {
        endpoint: "leetcode",
        cookie,
        userAgent: getBrowserUserAgent(),
        requestHeaders: requestHeaders && typeof requestHeaders === "object" ? requestHeaders : {},
    };
}

async function getDevPayload() {
    const stored = await storageGet(DEV_CAPTURE_KEYS);
    return {
        ok: true,
        payload: stored.devCapturedPayload || null,
        capturedAt: normalizeTimestamp(stored.devCapturedAt),
    };
}

async function captureDevPayloadNow() {
    const settings = await getSettings();
    if (!settings.devMode) {
        return { ok: false, error: "Enable Developer mode in the extension settings first." };
    }

    const cookie = await getLeetCodeCookieHeader();
    const loginCookieStatus = getLeetCodeLoginCookieStatus(cookie);
    if (!loginCookieStatus.ok) {
        return { ok: false, error: loginCookieStatus.error };
    }

    // Cookie-only capture (no live browser request headers). Refresh a
    // leetcode.com page to capture the full Cloudflare/browser headers through
    // the automatic XHR sync instead.
    await storeDevPayload(cookie, {});
    return { ok: true, payload: buildDevFixture(cookie, {}), capturedAt: Date.now() };
}

async function clearDevPayload() {
    await storageSet({ devCapturedPayload: null, devCapturedAt: 0 });
    return { ok: true };
}

function getReplayableRequestHeaders(requestHeaders) {
    const headers = {};

    for (const header of requestHeaders || []) {
        if (!header || typeof header.name !== "string" || typeof header.value !== "string") {
            continue;
        }

        const name = header.name.toLowerCase();
        if (isReplayableLeetCodeHeader(name)) {
            headers[name] = header.value;
        }
    }

    return headers;
}

function isReplayableLeetCodeHeader(name) {
    return [
        "accept",
        "accept-language",
        "authorization",
        "connection",
        "dnt",
        "priority",
        "sec-ch-ua",
        "sec-ch-ua-arch",
        "sec-ch-ua-bitness",
        "sec-ch-ua-full-version",
        "sec-ch-ua-full-version-list",
        "sec-ch-ua-mobile",
        "sec-ch-ua-model",
        "sec-ch-ua-platform",
        "sec-ch-ua-platform-version",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "sec-gpc",
        "te",
        "user-agent",
    ].includes(name);
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
    const requestHeaders = details.requestHeaders || [];

    if (cookie && getLeetCodeLoginCookieStatus(cookie).ok) {
        scheduleSync("leetcode-xhr", cookie, requestHeaders);
        return;
    }

    const now = Date.now();
    if (!cookie && now - lastAutomaticCookieProbeAt > 60 * 1000) {
        lastAutomaticCookieProbeAt = now;
        scheduleSync("leetcode-xhr", "");
    }
}

function registerLeetCodeXhrListener() {
    if (!api.webRequest || !api.webRequest.onBeforeSendHeaders) {
        console.warn("[leetcode-auth-sync] webRequest is unavailable; automatic XHR sync is disabled.");
        return;
    }

    // Re-register from scratch so a newly granted leetcode.com host permission
    // (optional on Firefox MV3, granted at runtime from the popup) takes effect
    // without restarting the browser.
    if (api.webRequest.onBeforeSendHeaders.hasListener(handleLeetCodeXhr)) {
        api.webRequest.onBeforeSendHeaders.removeListener(handleLeetCodeXhr);
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

if (api.permissions && api.permissions.onAdded) {
    api.permissions.onAdded.addListener(() => registerLeetCodeXhrListener());
}

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

    if (message.type === "expireNow") {
        expireSyncCooldown(message.reason || "manual").then(sendResponse, (error) => {
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

    if (message.type === "getDevPayload") {
        getDevPayload().then(sendResponse, (error) => {
            sendResponse({ ok: false, error: error.message || String(error) });
        });
        return true;
    }

    if (message.type === "captureDevPayloadNow") {
        captureDevPayloadNow().then(sendResponse, (error) => {
            sendResponse({ ok: false, error: error.message || String(error) });
        });
        return true;
    }

    if (message.type === "clearDevPayload") {
        clearDevPayload().then(sendResponse, (error) => {
            sendResponse({ ok: false, error: error.message || String(error) });
        });
        return true;
    }

    return false;
});
