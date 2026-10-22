// Wraps an event listener so that what it throws (a failed assertion)
// rejects the test's promise: thrown in a callback from the core, it is
// lost, and the test waits for an event that never comes.
export function failWith<A extends unknown[]>(
    reject: (reason: unknown) => void,
    listener: (...args: A) => unknown
) {
    return (...args: A) => {
        try {
            const result = listener(...args);
            if (result instanceof Promise) result.catch(reject);
        } catch (e) {
            reject(e);
        }
    };
}
