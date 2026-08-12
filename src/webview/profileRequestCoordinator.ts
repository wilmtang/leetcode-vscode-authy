export class ProfileRequestCoordinator {
    private generation: number = 0;

    public begin(authRevision: number): { authRevision: number; generation: number } {
        return { authRevision, generation: ++this.generation };
    }

    public isCurrent(owner: { authRevision: number; generation: number }, currentAuthRevision: number | undefined): boolean {
        return owner.generation === this.generation && owner.authRevision === currentAuthRevision;
    }

    public invalidate(): void {
        this.generation++;
    }
}
