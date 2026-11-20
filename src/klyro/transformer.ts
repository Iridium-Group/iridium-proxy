import { Worker } from 'node:worker_threads';
import { transformBytes, type TransformKind } from './transform.ts';

export interface TransformerOptions {
  /** Worker threads for large bodies. 0 runs everything inline. */
  workers: number;
  /** Bodies at least this big go to a worker; smaller ones are cheaper to do inline. */
  offloadBytes: number;
}

interface Pending {
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  worker: number;
}

/**
 * Runs HTML and CSS rewriting. Large bodies are parsed on worker threads so a big page does not
 * block the event loop (every other request) and several can be parsed in parallel; small ones
 * run inline. A worker failure falls back to inline, so the result is the same either way.
 */
export class Transformer {
  #workers: Worker[] = [];
  #busy: number[] = [];
  #pending = new Map<number, Pending>();
  #next = 1;
  #opts: TransformerOptions;
  /** Counts for tests and metrics. */
  offloaded = 0;
  inline = 0;

  constructor(options: TransformerOptions) {
    this.#opts = options;
    const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const url = new URL(`./transform-worker.${ext}`, import.meta.url);
    for (let i = 0; i < options.workers; i++) {
      const worker = new Worker(url);
      worker.unref();
      worker.on('message', (m: { id: number; bytes?: ArrayBuffer; error?: string }) => {
        const p = this.#pending.get(m.id);
        if (!p) return;
        this.#pending.delete(m.id);
        this.#busy[p.worker]! -= 1;
        if (m.bytes) p.resolve(new Uint8Array(m.bytes));
        else p.reject(new Error(m.error ?? 'transform failed'));
      });
      worker.on('error', (e) => this.#fail(i, e));
      worker.on('exit', () => this.#fail(i, new Error('transform worker exited')));
      this.#workers.push(worker);
      this.#busy.push(0);
    }
  }

  #fail(index: number, error: Error): void {
    for (const [id, p] of this.#pending) {
      if (p.worker === index) {
        this.#pending.delete(id);
        p.reject(error);
      }
    }
    this.#busy[index] = 0;
  }

  async run(
    kind: TransformKind,
    bytes: Buffer,
    charset: string,
    baseHref: string,
    sid: string,
  ): Promise<Uint8Array> {
    if (this.#workers.length === 0 || bytes.length < this.#opts.offloadBytes) {
      this.inline += 1;
      return transformBytes(kind, bytes, charset, baseHref, sid);
    }
    // Transfer needs an ArrayBuffer that holds exactly this body.
    const own = bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length;
    const copy = own ? null : Uint8Array.from(bytes).buffer;
    const transferable = (own ? bytes.buffer : copy) as ArrayBuffer;
    let best = 0;
    for (let i = 1; i < this.#busy.length; i++) if (this.#busy[i]! < this.#busy[best]!) best = i;
    const id = this.#next++;
    try {
      const out = await new Promise<Uint8Array>((resolve, reject) => {
        this.#pending.set(id, { resolve, reject, worker: best });
        this.#busy[best]! += 1;
        this.#workers[best]!.postMessage(
          { id, kind, bytes: transferable, charset, base: baseHref, sid },
          [transferable],
        );
      });
      this.offloaded += 1;
      return out;
    } catch {
      // The buffer was transferred away, so it cannot be retried inline from `bytes`.
      throw new Error('transform failed');
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.#workers.map((w) => w.terminate()));
    this.#workers = [];
  }
}
