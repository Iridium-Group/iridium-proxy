import { connect, type Socket } from 'node:net';
import {
  AddressPolicy,
  CloseReason,
  PacketType,
  StreamType,
  decodePacket,
  encodeClose,
  encodeContinue,
  encodeData,
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
  sinceContinue: number;
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
      for (const chunk of pending.get(id) ?? []) socket.write(chunk);
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
      socket.on('data', (chunk: Buffer) => send(encodeData(id, new Uint8Array(chunk))));
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
        if (queued) {
          queued.push(packet.payload.slice());
          return;
        }
        const stream = streams.get(packet.streamId);
        if (!stream) return;
        stream.socket.write(packet.payload.slice());
        stream.sinceContinue += 1;
        if (stream.sinceContinue >= bufferSize) {
          stream.sinceContinue = 0;
          send(encodeContinue(packet.streamId, bufferSize));
        }
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
