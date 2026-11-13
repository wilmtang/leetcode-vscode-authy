const fs = require("fs");

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message || error);
        process.exit(1);
    });
}

function readConfig(env = process.env) {
    const accessToken = (env.CHROME_WEBSTORE_TOKEN || "").trim();
    return {
        accessToken,
        clientId: accessToken ? "" : getRequiredEnv("CHROME_WEBSTORE_CLIENT_ID", env),
        clientSecret: accessToken ? "" : getRequiredEnv("CHROME_WEBSTORE_CLIENT_SECRET", env),
        refreshToken: accessToken ? "" : getRequiredEnv("CHROME_WEBSTORE_REFRESH_TOKEN", env),
        publisherId: getRequiredEnv("CHROME_WEBSTORE_PUBLISHER_ID", env),
        extensionId: getRequiredEnv("CHROME_WEBSTORE_EXTENSION_ID", env),
        zipPath: getRequiredEnv("CHROME_WEBSTORE_ZIP", env),
    };
}

async function main(env = process.env, fetchImpl = fetch, waitMs = 10000) {
    const config = readConfig(env);
    const accessToken = await getAccessToken(config, fetchImpl);

    const uploadResult = await uploadPackage(accessToken, config, fetchImpl);
    console.log(`Chrome Web Store upload state: ${uploadResult.uploadState || "unknown"}`);

    if (uploadResult.uploadState === "FAILED" || (uploadResult.itemError && uploadResult.itemError.length)) {
        const failureDetail = (uploadResult.itemError && uploadResult.itemError.length)
            ? uploadResult.itemError
            : uploadResult;
        throw new Error(`Chrome Web Store upload failed: ${JSON.stringify(failureDetail, null, 2)}`);
    }

    if (waitMs > 0) {
        console.log(`Waiting ${waitMs / 1000} seconds for the Web Store to process the uploaded package before publishing...`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const publishResult = await publishItem(accessToken, config, fetchImpl);
    console.log(`Chrome Web Store publish response: ${JSON.stringify(publishResult)}`);
    return { uploadResult, publishResult };
}

async function getAccessToken(config, fetchImpl = fetch) {
    if (config.accessToken) {
        return config.accessToken;
    }

    const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: "refresh_token",
    });

    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
    });

    const data = await parseResponseBody(response);

    if (!response.ok || !data.access_token) {
        throw new Error(`Failed to refresh Chrome Web Store access token (HTTP ${response.status}): ${JSON.stringify(data)}`);
    }

    return data.access_token;
}

async function uploadPackage(accessToken, config, fetchImpl = fetch) {
    const zip = fs.readFileSync(config.zipPath);
    const response = await fetchImpl(
        `https://chromewebstore.googleapis.com/upload/v2/publishers/${config.publisherId}/items/${config.extensionId}:upload`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/zip",
            },
            body: zip,
        }
    );

    return parseApiResponse(response, "upload Chrome Web Store package");
}

async function publishItem(accessToken, config, fetchImpl = fetch) {
    const response = await fetchImpl(
        `https://chromewebstore.googleapis.com/v2/publishers/${config.publisherId}/items/${config.extensionId}:publish`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        }
    );

    return parseApiResponse(response, "publish Chrome Web Store item");
}

async function parseResponseBody(response) {
    const text = await response.text();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}

async function parseApiResponse(response, action) {
    const data = await parseResponseBody(response);

    if (!response.ok) {
        throw new Error(`Failed to ${action} (HTTP ${response.status}): ${JSON.stringify(data)}`);
    }

    return data;
}

function getRequiredEnv(name, env = process.env) {
    const value = (env[name] || "").trim();

    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return value;
}

module.exports = {
    readConfig,
    getAccessToken,
    uploadPackage,
    publishItem,
    parseApiResponse,
    main,
};
