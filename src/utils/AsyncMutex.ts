/**
 * Tiny async mutex to serialize critical sections.
 * Use: const release = await mutex.acquire(); try { ... } finally { release(); }
 */
export class AsyncMutex {
  private _locked = false;
  private _waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }

    await new Promise<void>((resolve) => this._waiters.push(resolve));
    this._locked = true;
    return () => this._release();
  }

  private _release() {
    const next = this._waiters.shift();
    if (next) {
      // Hand off the lock to the next waiter
      next();
      return;
    }
    this._locked = false;
  }
}

export default AsyncMutex;
