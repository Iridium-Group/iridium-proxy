/** Token-bucket limiter per key (client address). `perMinute` of 0 disables limiting. */
export class RateLimiter {
  #buckets = new Map<string, { tokens: number; at: number }>();
  #perMinute: number;
  #now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  allow(key: string): boolean {
    if (this.#perMinute <= 0) return true;
    const now = this.#now();
    const b = this.#buckets.get(key) ?? { tokens: this.#perMinute, at: now };
    b.tokens = Math.min(this.#perMinute, b.tokens + ((now - b.at) / 60_000) * this.#perMinute);
    b.at = now;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.#buckets.delete(key);
    this.#buckets.set(key, b);
    if (this.#buckets.size > 10_000) this.#buckets.delete(this.#buckets.keys().next().value!);
    return ok;
  }
}
