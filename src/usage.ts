import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface UsageSnapshot {
  /** Calendar month (UTC) the count is for, as YYYY-MM. */
  month: string;
  /** Bytes relayed this month, both directions together. */
  bytes: number;
  /** The monthly cap in bytes, or null for no cap. */
  cap: number | null;
  exceeded: boolean;
}

export interface UsageMeterOptions {
  /** Most bytes to relay per UTC month. Omit for no cap (usage is still counted). */
  capBytes?: number | null;
  /** JSON file to keep the count in, so a restart does not reset it. */
  file?: string;
  /** Replace the clock, for tests. */
  now?: () => Date;
  /** Minimum time between writes to `file`. Default 5000 ms. */
  saveIntervalMs?: number;
}

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };

/** Parse "900MB", "1.5 GB" or a plain byte count. Returns null if it is not a size. */
export function parseSize(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?b)?\s*$/i.exec(text);
  if (!m) return null;
  return Math.floor(Number(m[1]) * UNITS[(m[2] ?? 'b').toLowerCase()]!);
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** Counts relayed bytes per UTC month, optionally persists them, and says when the cap is hit. */
export class UsageMeter {
  readonly capBytes: number | null;
  #month: string;
  #bytes = 0;
  #file: string | undefined;
  #now: () => Date;
  #interval: number;
  #lastSave = 0;

  constructor(options: UsageMeterOptions = {}) {
    this.capBytes = options.capBytes ?? null;
    this.#file = options.file;
    this.#now = options.now ?? (() => new Date());
    this.#interval = options.saveIntervalMs ?? 5000;
    this.#month = monthOf(this.#now());
    if (this.#file) {
      try {
        const saved = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<UsageSnapshot>;
        if (saved.month === this.#month && Number.isFinite(saved.bytes) && saved.bytes! >= 0) {
          this.#bytes = saved.bytes!;
        }
      } catch {
        // No usable file yet: start from zero.
      }
    }
  }

  #roll(): void {
    const month = monthOf(this.#now());
    if (month !== this.#month) {
      this.#month = month;
      this.#bytes = 0;
      this.save();
    }
  }

  /** Record relayed bytes. Returns true if the cap has now been reached. */
  add(bytes: number): boolean {
    this.#roll();
    this.#bytes += bytes;
    if (this.#file && this.#now().getTime() - this.#lastSave >= this.#interval) this.save();
    return this.exceeded;
  }

  get exceeded(): boolean {
    this.#roll();
    return this.capBytes !== null && this.#bytes >= this.capBytes;
  }

  snapshot(): UsageSnapshot {
    this.#roll();
    return { month: this.#month, bytes: this.#bytes, cap: this.capBytes, exceeded: this.exceeded };
  }

  /** Write the count to disk now (atomically). Safe to call at shutdown. */
  save(): void {
    if (!this.#file) return;
    this.#lastSave = this.#now().getTime();
    try {
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ month: this.#month, bytes: this.#bytes }));
      renameSync(tmp, this.#file);
    } catch {
      // A failed save must never break proxying; the next one will try again.
    }
  }
}
