/** Runs async critical sections one at a time, in call order. A failing task does not block later ones. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
