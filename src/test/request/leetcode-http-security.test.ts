import * as assert from "assert";
import * as http from "http";
import { AddressInfo } from "net";
import { createHeaders, requestJson } from "../../request/leetcode-http";

describe("leetcode HTTP security boundaries", () => {
    it("does not follow redirects while carrying authenticated request headers", async () => {
        let destinationHits: number = 0;
        const destination: http.Server = http.createServer((_req, res) => {
            destinationHits++;
            res.setHeader("Content-Type", "application/json");
            res.end("{}");
        });
        const redirect: http.Server = http.createServer((_req, res) => {
            const destinationPort: number = (destination.address() as AddressInfo).port;
            res.statusCode = 302;
            res.setHeader("Location", `http://127.0.0.1:${destinationPort}/capture`);
            res.end();
        });

        await listen(destination);
        await listen(redirect);
        try {
            const redirectPort: number = (redirect.address() as AddressInfo).port;
            await assert.rejects(
                requestJson({
                    method: "GET",
                    url: `http://127.0.0.1:${redirectPort}/start`,
                    headers: { Cookie: "LEETCODE_SESSION=secret" },
                }, { label: "redirect regression" }),
                /HTTP status|http error/i,
            );
            assert.strictEqual(destinationHits, 0, "redirect destination must never receive the authenticated request");
        } finally {
            await Promise.all([close(redirect), close(destination)]);
        }
    });

    it("drops hop-by-hop and malformed replayed browser headers", () => {
        const headers: { [key: string]: string } = createHeaders(
            "LEETCODE_SESSION=session; csrftoken=csrf",
            "https://leetcode.com/",
            {
                browserRequestHeaders: {
                    accept: "text/plain\r\nX-Injected: yes",
                    connection: "keep-alive",
                    priority: "u=1",
                    te: "trailers",
                },
            },
        );

        assert.strictEqual(headers["Accept"], "*/*");
        assert.strictEqual(headers["Connection"], undefined);
        assert.strictEqual(headers["TE"], undefined);
        assert.strictEqual(headers["Priority"], "u=1");
    });

    it("rejects cookie values containing header-control characters", () => {
        assert.throws(
            () => createHeaders("LEETCODE_SESSION=session\r\nX-Injected: yes; csrftoken=csrf", "https://leetcode.com/"),
            /invalid or excessive header data/,
        );
    });

    it("aborts an in-flight node request when its operation is cancelled", async () => {
        const hanging: http.Server = http.createServer(() => { /* leave the response open */ });
        await listen(hanging);
        let cancelled: boolean = false;
        const startedAt: number = Date.now();
        try {
            const port: number = (hanging.address() as AddressInfo).port;
            setTimeout(() => { cancelled = true; }, 50);
            await assert.rejects(
                requestJson({ method: "GET", url: `http://127.0.0.1:${port}/hang` }, {
                    label: "cancellation regression",
                    isCancelled: () => cancelled,
                }),
                /cancelled/i,
            );
            assert.ok(Date.now() - startedAt < 1000, "cancellation must not wait for the transport timeout");
        } finally {
            await close(hanging);
        }
    });
});

function listen(server: http.Server): Promise<void> {
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: http.Server): Promise<void> {
    return new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
}
