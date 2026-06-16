// Installs a module-resolution hook so that `require("vscode")` returns the
// lightweight stub. Loaded via .mocharc.json `require` before any test module
// (and therefore before any production module) is imported.
const Module = require("module");
const vscodeStub = require("./vscode-stub");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
        return vscodeStub;
    }
    return originalLoad.call(this, request, parent, isMain);
};
