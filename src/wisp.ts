import { connect, type Socket } from 'node:net';
import {
  AddressPolicy,
  CloseReason,
  PacketType,
  StreamType,
  decodePacket,
  encodeClose,
  encodeContinue,
  isTransportError,
} from '@iridium-group/transport';
import type { WebSocket } from 'ws';
import type { Logger } from './logger.ts';

export interface WispOptions {
  policy: AddressPolicy;
  logger: Logger;
  connectTimeoutMs: number;
  /** Packets a client may send on one stream before the server sends CONTINUE. Default 128. */
  bufferSize?: number;
  /** Most streams one client may have open at once. Default 256. */
  maxStreamsPerClient?: number;
}

interface Stream {
  socket: Socket;
  /** DATA packets written since the last CONTINUE. */
  sinceContinue: number;
}

const DATA = PacketType.DATA;
/** Pause TCP reads from targets while this many bytes are waiting to go to the client. */
const HIGH_WATER = 1024 * 1024;

/** Build a DATA frame with one allocation and one copy. */
function dataFrame(id: number, chunk: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + chunk.length);
  frame[0] = DATA;
  frame.writeUInt32LE(id, 1);
  chunk.copy(frame, 5);
  return frame;
}

function closeReason(error: unknown): number {
  if (isTransportError(error)) {
    switch (error.code) {
      case 'BLOCKED_ADDRESS':
      case 'BLOCKED_PORT':
        return CloseReason.BLOCKED;
      case 'CONNECT_REFUSED':
        return CloseReason.UNREACHABLE;
      case 'CONNECT_TIMEOUT':
        return CloseReason.CONNECT_TIMEOUT;
    }
  }
  return CloseReason.NETWORK_ERROR;
}

/** Speak Wisp v1 over one WebSocket, opening TCP connections that the policy allows. */
export function handleWispClient(ws: WebSocket, options: WispOptions): void {
  const { policy, logger } = options;
  const bufferSize = options.bufferSize ?? 128;
  const maxStreams = options.maxStreamsPerClient ?? 256;
  const streams = new Map<number, Stream>();
  // Streams still resolving their host, with any data the client sent in the meantime.
  const pending = new Map<number, Uint8Array[]>();

  const send = (bytes: Uint8Array) => {
    if (ws.readyState === ws.OPEN) ws.send(bytes);
  };

  // Backpressure toward the client: stop reading from targets while the WebSocket is backed up.
  let paused = false;
  const sendData = (id: number, chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
    if (paused) {
      ws.send(dataFrame(id, chunk));
      return;
    }
    if (ws.bufferedAmount < HIGH_WATER) {
      ws.send(dataFrame(id, chunk));
      return;
    }
    paused = true;
    for (const s of streams.values()) s.socket.pause();
    ws.send(dataFrame(id, chunk), () => {
      paused = false;
      for (const s of streams.values()) s.socket.resume();
    });
  };

  // Tell the client it may send more, once the target has taken what it sent so far.
  const acknowledge = (id: number, stream: Stream) => {
    stream.sinceContinue += 1;
    if (stream.sinceContinue < bufferSize) return;
    if (stream.socket.writableNeedDrain) {
      stream.socket.once('drain', () => {
        if (streams.get(id) !== stream) return;
        stream.sinceContinue = 0;
        send(encodeContinue(id, bufferSize));
      });
      // Stop counting more until that drain fires: further DATA still queues in the socket.
      stream.sinceContinue = Number.NEGATIVE_INFINITY;
      return;
    }
    stream.sinceContinue = 0;
    send(encodeContinue(id, bufferSize));
  };
  const end = (id: number, reason: number) => {
    streams.delete(id);
    send(encodeClose(id, reason));
  };

  send(encodeContinue(0, bufferSize));

  ws.on('close', () => {
    for (const stream of streams.values()) stream.socket.destroy();
    streams.clear();
  });
  ws.on('error', (error) => logger.debug('websocket error', { error: error.message }));

  const open = async (id: number, hostname: string, port: number) => {
    pending.set(id, []);
    try {
      const target = await policy.check({ host: hostname, port });
      if (!pending.has(id)) return; // client closed the stream while we resolved
      const socket = connect({
        host: target.address,
        port,
        family: target.family,
        timeout: options.connectTimeoutMs,
      });
      const stream: Stream = { socket, sinceContinue: 0 };
      streams.set(id, stream);
      socket.setNoDelay(true);
      for (const chunk of pending.get(id) ?? []) {
        socket.write(chunk);
        acknowledge(id, stream);
      }
      let connected = false;
      socket.on('connect', () => {
        connected = true;
        socket.setTimeout(0);
        logger.debug('stream open', { id, host: hostname, port });
      });
      socket.on('timeout', () => {
        if (!connected && streams.has(id)) {
          socket.destroy();
          end(id, CloseReason.CONNECT_TIMEOUT);
        }
      });
      socket.on('data', (chunk: Buffer) => sendData(id, chunk));
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (!streams.has(id)) return;
        end(
          id,
          error.code === 'ECONNREFUSED'
            ? CloseReason.CONNECTION_REFUSED
            : CloseReason.NETWORK_ERROR,
        );
      });
      socket.on('end', () => {
        if (streams.has(id)) end(id, CloseReason.VOLUNTARY);
      });
    } catch (error) {
      logger.info('stream refused', { host: hostname, port, reason: (error as Error).message });
      send(encodeClose(id, closeReason(error)));
    } finally {
      pending.delete(id);
    }
  };

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return ws.close(1003);
    // Fast path for the common case: DATA on an open stream, with no decode copy.
    if (data.length >= 5 && data[0] === DATA) {
      const id = data.readUInt32LE(1);
      const open = streams.get(id);
      if (open) {
        open.socket.write(data.subarray(5));
        acknowledge(id, open);
        return;
      }
    }
    let packet;
    try {
      packet = decodePacket(new Uint8Array(data));
    } catch {
      return ws.close(1002);
    }
    if ('unknown' in packet) return;
    switch (packet.type) {
      case PacketType.CONNECT: {
        if (packet.streamType !== StreamType.TCP) {
          return send(encodeClose(packet.streamId, CloseReason.INVALID_INFO));
        }
        if (streams.has(packet.streamId) || pending.has(packet.streamId)) {
          return send(encodeClose(packet.streamId, CloseReason.INVALID_INFO));
        }
        if (streams.size + pending.size >= maxStreams) {
          return send(encodeClose(packet.streamId, CloseReason.THROTTLED));
        }
        void open(packet.streamId, packet.hostname, packet.port);
        return;
      }
      case PacketType.DATA: {
        const queued = pending.get(packet.streamId);
        if (queued) queued.push(packet.payload.slice());
        return;
      }
      case PacketType.CLOSE: {
        pending.delete(packet.streamId);
        const stream = streams.get(packet.streamId);
        if (!stream) return;
        streams.delete(packet.streamId);
        stream.socket.destroy();
        return;
      }
      default:
        return;
    }
  });
}
