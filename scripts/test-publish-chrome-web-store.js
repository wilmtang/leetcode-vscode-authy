const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getAccessToken, main, parseApiResponse, readConfig } = require("./publish-chrome-web-store");

async function testPreMintedTokenSkipsOAuth() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cws-publish-test-"));
    const zipPath = path.join(tmpDir, "ext.zip");
    fs.writeFileSync(zipPath, Buffer.from("PK-test-zip"));

    try {
        const calls = [];
        const fetchMock = async (url, init) => {
            calls.push({ url, headers: init.headers });
            if (url.endsWith(":upload")) {
                return {
                    ok: true,
                    status: 200,
                    async text() { return JSON.stringify({ uploadState: "SUCCESS" }); },
                };
            }
            if (url.endsWith(":publish")) {
                return {
                    ok: true,
                    status: 200,
                    async text() { return JSON.stringify({ status: ["OK"] }); },
                };
            }
            throw new Error(`Unexpected URL: ${url}`);
        };

        const result = await main(
            {
                CHROME_WEBSTORE_TOKEN: "ya29.wif-access-token",
                CHROME_WEBSTORE_PUBLISHER_ID: "pub-123",
                CHROME_WEBSTORE_EXTENSION_ID: "ext-456",
                CHROME_WEBSTORE_ZIP: zipPath,
            },
            fetchMock,
            0
        );

        assert.strictEqual(result.uploadResult.uploadState, "SUCCESS");
        assert.deepStrictEqual(result.publishResult.status, ["OK"]);
        assert.strictEqual(calls.length, 2);
        assert.ok(calls[0].url.includes("/upload/v2/publishers/pub-123/items/ext-456:upload"));
        assert.ok(calls[1].url.includes("/v2/publishers/pub-123/items/ext-456:publish"));
        assert.strictEqual(calls[0].headers.Authorization, "Bearer ya29.wif-access-token");
        assert.strictEqual(calls[1].headers.Authorization, "Bearer ya29.wif-access-token");
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function testOAuthFallbackUsedWhenTokenBlank() {
    const config = readConfig({
        CHROME_WEBSTORE_TOKEN: "   ",
        CHROME_WEBSTORE_CLIENT_ID: "cid",
        CHROME_WEBSTORE_CLIENT_SECRET: "csec",
        CHROME_WEBSTORE_REFRESH_TOKEN: "rtok",
        CHROME_WEBSTORE_PUBLISHER_ID: "pub",
        CHROME_WEBSTORE_EXTENSION_ID: "ext",
        CHROME_WEBSTORE_ZIP: "/tmp/ext.zip",
    });

    const token = await getAccessToken(config, async (url) => {
        assert.strictEqual(url, "https://oauth2.googleapis.com/token");
        return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ access_token: "ya29.oauth-token" }); },
        };
    });
    assert.strictEqual(token, "ya29.oauth-token");
}

function testMissingRefreshCredentialsRejectedWithoutToken() {
    assert.throws(
        () => readConfig({
            CHROME_WEBSTORE_PUBLISHER_ID: "pub",
            CHROME_WEBSTORE_EXTENSION_ID: "ext",
            CHROME_WEBSTORE_ZIP: "/tmp/ext.zip",
        }),
        /CHROME_WEBSTORE_CLIENT_ID/
    );
}

async function testUploadFailureStatesRejectWithFullPayload() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cws-publish-fail-"));
    const zipPath = path.join(tmpDir, "ext.zip");
    fs.writeFileSync(zipPath, Buffer.from("PK-test-zip"));

    try {
        const env = {
            CHROME_WEBSTORE_TOKEN: "ya29.wif-access-token",
            CHROME_WEBSTORE_PUBLISHER_ID: "pub-123",
            CHROME_WEBSTORE_EXTENSION_ID: "ext-456",
            CHROME_WEBSTORE_ZIP: zipPath,
        };

        await assert.rejects(
            () => main(env, async () => ({
                ok: true,
                status: 200,
                async text() { return JSON.stringify({ uploadState: "FAILED", itemError: [] }); },
            }), 0),
            /uploadState": "FAILED"/
        );

        await assert.rejects(
            () => main(env, async () => ({
                ok: true,
                status: 200,
                async text() { return JSON.stringify({ uploadState: "FAILED" }); },
            }), 0),
            /uploadState": "FAILED"/
        );

        await assert.rejects(
            () => main(env, async () => ({
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        uploadState: "FAILURE",
                        itemError: [{ error_code: "PKG_INVALID", error_detail: "bad zip" }],
                    });
                },
            }), 0),
            /PKG_INVALID/
        );

        await assert.rejects(
            () => main(env, async (url) => {
                if (url.endsWith(":upload")) {
                    return { ok: true, status: 200, async text() { return JSON.stringify({ uploadState: "SUCCESS" }); } };
                }
                return { ok: false, status: 403, async text() { return ""; } };
            }, 0),
            /HTTP 403/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function testNonJsonAndMissingAccessTokenErrors() {
    await assert.rejects(
        () => parseApiResponse({
            ok: false,
            status: 502,
            async text() { return "<html>Bad Gateway</html>"; },
        }, "upload Chrome Web Store package"),
        /HTTP 502.*Bad Gateway/
    );

    const config = readConfig({
        CHROME_WEBSTORE_CLIENT_ID: "cid",
        CHROME_WEBSTORE_CLIENT_SECRET: "csec",
        CHROME_WEBSTORE_REFRESH_TOKEN: "rtok",
        CHROME_WEBSTORE_PUBLISHER_ID: "pub",
        CHROME_WEBSTORE_EXTENSION_ID: "ext",
        CHROME_WEBSTORE_ZIP: "/tmp/ext.zip",
    });

    await assert.rejects(
        () => getAccessToken(config, async () => ({
            ok: true,
            status: 200,
            async text() { return JSON.stringify({ token_type: "Bearer" }); },
        })),
        /HTTP 200/
    );
}

Promise.resolve()
    .then(testPreMintedTokenSkipsOAuth)
    .then(testOAuthFallbackUsedWhenTokenBlank)
    .then(testMissingRefreshCredentialsRejectedWithoutToken)
    .then(testUploadFailureStatesRejectWithFullPayload)
    .then(testNonJsonAndMissingAccessTokenErrors)
    .then(() => console.log("Chrome Web Store publish script tests passed."))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
