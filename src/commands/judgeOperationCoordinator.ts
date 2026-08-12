export class JudgeOperationCoordinator {
    private operationId: number = 0;
    public begin(): number { return ++this.operationId; }
    public isCurrent(id: number): boolean { return id === this.operationId; }
}

export const judgeOperationCoordinator: JudgeOperationCoordinator = new JudgeOperationCoordinator();
