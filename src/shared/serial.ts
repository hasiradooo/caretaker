/** Serialize related Discord side effects without blocking unrelated members. */
export class KeyedQueue {
    private readonly pending = new Map<string, Promise<unknown>>();

    async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.pending.set(key, next);
        try {
            return await next;
        } finally {
            if (this.pending.get(key) === next) this.pending.delete(key);
        }
    }

    async drain(): Promise<void> {
        await Promise.allSettled(this.pending.values());
    }
}
