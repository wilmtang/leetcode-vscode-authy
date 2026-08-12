// Copyright (c) jdneo. All rights reserved.
// SPDX-License-Identifier: AGPL-3.0-or-later

export type AuthIntentKind = "automatic-sync" | "manual-cookie" | "uri" | "refresh" | "sign-out";

export interface IAuthIntent {
    readonly kind: AuthIntentKind;
    readonly revision: number;
}

/**
 * Owns the ordering of every authentication intent in one extension window.
 * Awaited work must retain its token and check it immediately before commit.
 */
export class AuthIntentCoordinator {
    private revision: number = 0;
    private commitTail: Promise<void> = Promise.resolve();

    public begin(kind: AuthIntentKind): IAuthIntent {
        this.revision++;
        return { kind, revision: this.revision };
    }

    public capture(kind: AuthIntentKind = "refresh"): IAuthIntent {
        return { kind, revision: this.revision };
    }

    public isCurrent(intent: IAuthIntent): boolean {
        return intent.revision === this.revision;
    }

    public assertCurrent(intent: IAuthIntent): void {
        if (!this.isCurrent(intent)) {
            const error: Error = new Error("Authentication operation was superseded by a newer user intent.");
            error.name = "AuthIntentSupersededError";
            throw error;
        }
    }

    public getRevision(): number {
        return this.revision;
    }

    public commit<T>(intent: IAuthIntent, work: () => Promise<T>): Promise<T> {
        const operation: Promise<T> = this.commitTail.then(async () => {
            this.assertCurrent(intent);
            return work();
        });
        this.commitTail = operation.then(() => undefined, () => undefined);
        return operation;
    }
}
