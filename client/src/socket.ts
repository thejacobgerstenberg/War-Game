/**
 * Socket.IO client singleton. Typed with the shared protocol so event names and
 * payloads are checked against the server contract.
 */
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@imperium/shared";

/**
 * Resolve the Socket.IO server URL from the Vite env:
 * - `VITE_SERVER_URL` set (non-empty) → use it verbatim.
 * - Unset in dev → `http://localhost:8080` (split-port `npm run dev` setup).
 * - Unset in a production build → `undefined`, meaning same-origin: the client
 *   connects to whatever origin served it (e.g. the nginx proxy in Docker).
 */
export function resolveServerUrl(env: {
  VITE_SERVER_URL?: string;
  DEV?: boolean;
}): string | undefined {
  if (env.VITE_SERVER_URL) {
    return env.VITE_SERVER_URL;
  }
  return env.DEV ? "http://localhost:8080" : undefined;
}

const SERVER_URL: string | undefined = resolveServerUrl(import.meta.env);

export type ImperiumSocket = Socket<
  ServerToClientEvents,
  ClientToServerEvents
>;

let socket: ImperiumSocket | null = null;

/** Lazily create (and reuse) the shared socket connection. */
export function getSocket(): ImperiumSocket {
  if (!socket) {
    socket =
      SERVER_URL === undefined
        ? io({ autoConnect: true }) // same-origin
        : io(SERVER_URL, { autoConnect: true });
  }
  return socket;
}
