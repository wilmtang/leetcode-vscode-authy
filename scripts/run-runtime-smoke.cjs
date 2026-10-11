const assert = require("assert");
const path = require("path");
if (process.argv[2]) {
    assert.strictEqual(process.versions.node.split(".")[0], process.argv[2], "unexpected smoke-test Node major");
}
require("../src/test/support/register-vscode");
require("../out/extension.js");
require(path.join(require("os").tmpdir(), "authy-runtime-smoke.cjs"));
