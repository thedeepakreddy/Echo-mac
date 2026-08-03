/**
 * A pushable async iterable: values can be pushed in over time and are yielded
 * to the consumer as they arrive. The Agent SDK consumes one of these as its
 * streaming `prompt`, letting us feed new user turns into a single long-lived
 * `query()` session.
 */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T) {
    if (this.done) return;
    const resolve = this.resolvers.shift();
    if (resolve) resolve({ value, done: false });
    else this.queue.push(value);
  }

  end() {
    this.done = true;
    let resolve;
    while ((resolve = this.resolvers.shift())) {
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false });
        }
        if (this.done) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
