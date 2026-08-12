import * as assert from "assert";
import * as net from "net";
import * as vscode from "vscode";
import { authSyncServer } from "../../auth/authSyncServer";
import { globalState } from "../../globalState";

class MemoryMemento {
    private readonly values: Map<string, unknown> = new Map<string, unknown>();
    public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
    public update(key: string, value: unknown): Promise<void> {
        if (value === undefined) { this.values.delete(key); } else { this.values.set(key, value); }
        return Promise.resolve();
    }
}

class MemorySecrets {
    private readonly values: Map<string, string> = new Map<string, string>();
    public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
    public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
    public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
    public onDidChange(): vscode.Event<void> { return (() => new vscode.Disposable(() => undefined)) as vscode.Event<void>; }
}

describe("auth sync lifecycle", () => {
    it("bounds shutdown with an incomplete request socket", async function () {
        this.timeout(7000);
        const port: number = 18987;
        (global as unknown as { __LC_TEST_CONFIG__: { [key: string]: unknown } }).__LC_TEST_CONFIG__ = {
            "authSync.enabled": true,
            "authSync.port": port,
        };
        await globalState.initialize({
            globalState: new MemoryMemento(),
            secrets: new MemorySecrets(),
            subscriptions: [],
        } as unknown as vscode.ExtensionContext);
        await authSyncServer.start();
        const socket: net.Socket = net.createConnection(port, "127.0.0.1");
        socket.on("error", () => undefined);
        await new Promise<void>((resolve: () => void) => socket.once("connect", resolve));
        socket.write("POST /auth/update HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100\r\n\r\n{");

        const startedAt: number = Date.now();
        await authSyncServer.stop();

        assert.ok(Date.now() - startedAt < 3500, "shutdown should destroy incomplete sockets after its grace period");
        socket.destroy();
    });
});
