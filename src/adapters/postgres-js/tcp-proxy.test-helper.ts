import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";

export type TcpProxy = {
  /** `url` with its host and port pointed at the proxy. */
  readonly url: string;
  /** Resets every client socket, so the client reads ECONNRESET, and drops its server side. */
  readonly resetAll: () => void;
  readonly close: () => Promise<void>;
};

/** Forwards TCP from a free port on localhost to the server `url` names. */
export async function startTcpProxy(url: string): Promise<TcpProxy> {
  const target = new URL(url);
  const pairs = new Set<readonly [Socket, Socket]>();
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    const pair = [client, upstream] as const;
    pairs.add(pair);
    for (const socket of pair) {
      socket.on("error", () => {});
      socket.on("close", () => {
        pairs.delete(pair);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the proxy did not bind a TCP port");
  }
  const proxied = new URL(url);
  proxied.hostname = "127.0.0.1";
  proxied.port = String(address.port);
  return {
    url: proxied.href,
    resetAll() {
      for (const [client, upstream] of pairs) {
        client.resetAndDestroy();
        upstream.destroy();
      }
    },
    async close() {
      server.close();
      for (const [client, upstream] of pairs) {
        client.destroy();
        upstream.destroy();
      }
      await once(server, "close");
    },
  };
}
