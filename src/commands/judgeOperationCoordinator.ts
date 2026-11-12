export class JudgeOperationCoordinator {
    private operationId: number = 0;
    public begin(): number { return ++this.operationId; }
    public isCurrent(id: number): boolean { return id === this.operationId; }
}

export const judgeOperationCoordinator: JudgeOperationCoordinator = new JudgeOperationCoordinator();

/**
 * Admits one run at a time. A submit is not idempotent: a second one that
 * supersedes a first whose POST already left creates two submissions, and the
 * second usually hits LeetCode's rate limit.
 */
// tslint:disable-next-line:max-classes-per-file
export class InFlightGuard {
    private busy: boolean = false;
    public tryEnter(): boolean {
        if (this.busy) {
            return false;
        }
        this.busy = true;
        return true;
    }
    public leave(): void { this.busy = false; }
}

export const submitInFlight: InFlightGuard = new InFlightGuard();
