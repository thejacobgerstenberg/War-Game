/**
 * Socket.IO client singleton. Typed with the shared protocol so event names and
 * payloads are checked against the server contract.
 */
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@imperium/shared";

const SERVER_URL: string =
  import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

export type ImperiumSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

let socket: ImperiumSocket | null = null;

/** Lazily create (and reuse) the shared socket connection. */
export function getSocket(): ImperiumSocket {
  if (!socket) {
    socket = io(SERVER_URL, { autoConnect: true });
  }
  return socket;
}
