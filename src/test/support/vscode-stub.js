// Minimal `vscode` stand-in so production modules and the generated bundle can
// be loaded under plain Node without an Extension Host. Only the surface
// exercised at module load or by the offline tests is implemented.

function createOutputChannel(name) {
    return {
        name: name,
        appendLine() { return undefined; },
        append() { return undefined; },
        clear() { return undefined; },
        show() { return undefined; },
        hide() { return undefined; },
        dispose() { return undefined; },
    };
}

// Records every created item (id, alignment, priority) and its visibility so
// status bar tests can assert on what a real host would render.
const createdStatusBarItems = [];

function createStatusBarItem(idOrAlignment, alignmentOrPriority, maybePriority) {
    const hasId = typeof idOrAlignment === "string";
    const item = {
        id: hasId ? idOrAlignment : undefined,
        alignment: hasId ? alignmentOrPriority : idOrAlignment,
        priority: hasId ? maybePriority : alignmentOrPriority,
        name: undefined,
        text: "",
        tooltip: "",
        command: undefined,
        backgroundColor: undefined,
        accessibilityInformation: undefined,
        visible: false,
        disposed: false,
        show() { this.visible = true; },
        hide() { this.visible = false; },
        dispose() { this.visible = false; this.disposed = true; },
    };
    createdStatusBarItems.push(item);
    return item;
}

function getConfiguration() {
    // Integration tests can override config (e.g. the endpoint) by setting
    // global.__LC_TEST_CONFIG__ before exercising the API. Unit tests leave it
    // unset, so every get() returns the caller's supplied default unchanged.
    const overrides = (global.__LC_TEST_CONFIG__ && typeof global.__LC_TEST_CONFIG__ === "object") ? global.__LC_TEST_CONFIG__ : {};
    return {
        get(key, defaultValue) {
            return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaultValue;
        },
        update() { return Promise.resolve(); },
        has(key) { return Object.prototype.hasOwnProperty.call(overrides, key); },
        inspect() { return undefined; },
    };
}

module.exports = {
    env: {
        appName: "Visual Studio Code",
        appRoot: "/tmp/vscode-test-app",
        isTelemetryEnabled: false,
        machineId: "test-machine",
        sessionId: "test-session",
        uriScheme: "vscode",
    },
    languages: {
        registerCodeLensProvider() { return { dispose() { return undefined; } }; },
    },
    window: {
        createOutputChannel: createOutputChannel,
        createStatusBarItem: createStatusBarItem,
        __createdStatusBarItems: createdStatusBarItems,
        showErrorMessage() { return Promise.resolve(undefined); },
        showInformationMessage() { return Promise.resolve(undefined); },
        showWarningMessage() { return Promise.resolve(undefined); },
        withProgress(_options, task) { return task({ report() { return undefined; } }); },
    },
    workspace: {
        getConfiguration: getConfiguration,
        onDidChangeConfiguration() { return { dispose() { return undefined; } }; },
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor {
        constructor(id) { this.id = id; }
    },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    Uri: {
        file(p) { return { fsPath: p, path: p, scheme: "file", toString() { return p; } }; },
        parse(value) { return { toString() { return value; } }; },
    },
    EventEmitter: class EventEmitter {
        constructor() {
            this.listeners = [];
            this.event = (listener) => {
                this.listeners.push(listener);
                return { dispose: () => { this.listeners = this.listeners.filter((entry) => entry !== listener); } };
            };
        }
        fire(value) { for (const listener of this.listeners.slice()) { listener(value); } }
        dispose() { this.listeners = []; }
    },
    Disposable: class Disposable {
        dispose() { return undefined; }
    },
};
