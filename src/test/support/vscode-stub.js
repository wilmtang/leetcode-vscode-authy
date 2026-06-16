// Minimal `vscode` stand-in so that pure request/* modules (which transitively
// import modules that touch the vscode API at load time, e.g. the output
// channel and `env.appName`) can be unit-tested under plain mocha without the
// Extension Host. Only the surface exercised at module load / by the functions
// under test is implemented.

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
    env: { appName: "Visual Studio Code", machineId: "test-machine", sessionId: "test-session", uriScheme: "vscode" },
    window: {
        createOutputChannel: createOutputChannel,
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
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    Uri: {
        file(p) { return { fsPath: p, path: p, scheme: "file", toString() { return p; } }; },
        parse(value) { return { toString() { return value; } }; },
    },
    EventEmitter: class EventEmitter {
        event() { return undefined; }
        fire() { return undefined; }
        dispose() { return undefined; }
    },
    Disposable: class Disposable {
        dispose() { return undefined; }
    },
};
