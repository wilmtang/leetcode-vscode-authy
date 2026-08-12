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

function runScript(relativePath, globals) {
    const filename = path.join(__dirname, "..", relativePath);
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), globals, { filename });
}

Promise.resolve()
    .then(testOptionsRollback)
    .then(testPopupClearFailure)
    .then(() => console.log("Browser UI persistence tests passed."))
    .catch((error) => { console.error(error); process.exitCode = 1; });
