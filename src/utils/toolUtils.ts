export function sleep(ms: number, isCancelled?: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (isCancelled && isCancelled()) {
            reject(new Error("Operation cancelled."));
            return;
        }
        let cancellationTimer: NodeJS.Timer | undefined;
        const timeout: NodeJS.Timer = setTimeout(() => {
            if (cancellationTimer) {
                clearInterval(cancellationTimer);
            }
            resolve();
        }, ms);
        if (isCancelled) {
            cancellationTimer = setInterval(() => {
                if (isCancelled()) {
                    clearTimeout(timeout);
                    clearInterval(cancellationTimer!);
                    reject(new Error("Operation cancelled."));
                }
            }, Math.min(50, Math.max(10, ms)));
        }
    });
}

export function parseQuery(query: string): { [key: string]: string } {
    const queryObject: { [key: string]: string } = {};

    if (!query) {
        return queryObject;
    }

    const keyValuePairs = query.split("&");
    keyValuePairs.forEach((pair) => {
        const firstEqualsIndex = pair.indexOf("=");
        if (firstEqualsIndex !== -1) {
            const key = pair.substring(0, firstEqualsIndex);
            const value = pair.substring(firstEqualsIndex + 1);
            queryObject[decodeURIComponent(key)] = decodeURIComponent(value);
        } else {
            // If no equals sign is found, treat the whole string as key with empty value
            queryObject[decodeURIComponent(pair)] = "";
        }
    });

    return queryObject;
}
