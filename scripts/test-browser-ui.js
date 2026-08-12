const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function element() {
    return {
        checked: false,
        value: "",
        textContent: "",
        className: "",
        disabled: false,
        hidden: false,
        listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        querySelectorAll() { return []; },
    };
}

async function testOptionsRollback() {
    const elements = new Map();
    const get = (id) => {
        if (!elements.has(id)) { elements.set(id, element()); }
        return elements.get(id);
    };
    const documentListeners = {};
    const document = {
        getElementById: get,
        addEventListener(type, listener) { documentListeners[type] = listener; },
    };
    get("options-form").querySelectorAll = () => [get("show-cookie-only-button"), get("dev-mode")];
    const chrome = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                if (message.type === "getSettings") {
                    callback({ ok: true, enabled: true, port: 17899, cooldownMinutes: 30, showCookieOnlyButton: false, devMode: false });
                } else {
                    callback({ ok: false, error: "storage failed" });
                }
            },
        },
    };
    runScript("browser-extension/options.js", { document, chrome, console, Promise, Array });
    await documentListeners.DOMContentLoaded();
    get("show-cookie-only-button").checked = true;
    await get("show-cookie-only-button").listeners.change();
    assert.strictEqual(get("show-cookie-only-button").checked, false);
    assert.strictEqual(get("status").className, "status error");
}

async function testPopupClearFailure() {
    const elements = new Map();
    const get = (id) => {
        if (!elements.has(id)) { elements.set(id, element()); }
        return elements.get(id);
    };
    const document = { getElementById: get, addEventListener() {} };
    const chrome = {
        runtime: {
            lastError: null,
            sendMessage(message, callback) { callback({ ok: false, error: message.type === "clearDevPayload" ? "clear failed" : "unavailable" }); },
            openOptionsPage() {},
        },
        storage: { onChanged: { addListener() {} } },
        permissions: null,
    };
    runScript("browser-extension/popup.js", {
        document, chrome, console, Promise, Array, Map, Date,
        setInterval() { return 0; },
        navigator: {},
    });
    await get("clear-fixture").listeners.click();
    assert.strictEqual(get("status").textContent, "clear failed");
    assert.strictEqual(get("status").className, "status error");
}

function testPrimaryButtonContrastAndReducedMotion() {
    const css = fs.readFileSync(path.join(__dirname, "..", "browser-extension", "styles.css"), "utf8");
    const primaryColors = Array.from(css.matchAll(/--primary:\s*(#[0-9a-f]{6})/gi), (match) => match[1]);
    assert.strictEqual(primaryColors.length, 2, "light and dark primary colors must both be declared");
    for (const primary of primaryColors) {
        assert.ok(contrastRatio(primary, "#ffffff") >= 4.5, `${primary} must meet WCAG AA against white text`);
    }
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
}

function contrastRatio(first, second) {
    const luminance = (hex) => {
        const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255);
        const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const lighter = Math.max(luminance(first), luminance(second));
    const darker = Math.min(luminance(first), luminance(second));
    return (lighter + 0.05) / (darker + 0.05);
}

function runScript(relativePath, globals) {
    const filename = path.join(__dirname, "..", relativePath);
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), globals, { filename });
}

Promise.resolve()
    .then(testOptionsRollback)
    .then(testPopupClearFailure)
    .then(testPrimaryButtonContrastAndReducedMotion)
    .then(() => console.log("Browser UI persistence tests passed."))
    .catch((error) => { console.error(error); process.exitCode = 1; });
