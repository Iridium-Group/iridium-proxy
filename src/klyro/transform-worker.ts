import { parentPort } from 'node:worker_threads';
import { transformBytes, type TransformKind } from './transform.ts';

interface Job {
  id: number;
  kind: TransformKind;
  bytes: ArrayBuffer;
  charset: string;
  base: string;
  sid: string;
}

parentPort!.on('message', (job: Job) => {
  try {
    const out = transformBytes(job.kind, new Uint8Array(job.bytes), job.charset, job.base, job.sid);
    // Hand the result back without copying it.
    const buffer = out.buffer.byteLength === out.byteLength ? out.buffer : out.slice().buffer;
    parentPort!.postMessage({ id: job.id, bytes: buffer }, [buffer as ArrayBuffer]);
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: (error as Error).message });
  }
});
