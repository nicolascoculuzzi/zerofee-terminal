/**
 * A minimal Yellowstone Geyser gRPC server for tests: plain HTTP/2 (node:http2, works under Bun) with
 * gRPC length-prefixed framing. It records SubscribeRequests and headers, streams the given
 * SubscribeUpdate payloads, and can end the stream to exercise reconnects.
 */
import http2 from "node:http2";
import { SubscribeRequest } from "@triton-one/yellowstone-grpc";

export interface MockGeyser {
  port: number;
  requests: SubscribeRequest[];
  /**
   * Raw request frames. The N-API client re-encodes requests with prost, which writes an empty filter
   * (e.g. blocks_meta {}) as a key-only map entry; ts-proto's decoder drops such entries, prost servers
   * read them as empty filters. Assert on these bytes for map keys with empty values.
   */
  raw: Uint8Array[];
  tokens: (string | undefined)[];
  sessions: number;
  close(): Promise<void>;
}

function frame(msg: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + msg.length);
  out.writeUInt8(0, 0);
  out.writeUInt32BE(msg.length, 1);
  Buffer.from(msg).copy(out, 5);
  return out;
}

/**
 * `sessionUpdates(i)` returns what to stream on the i-th Subscribe call (0-based) and whether to end the
 * stream afterwards.
 */
export async function startMockGeyser(sessionUpdates: (session: number) => { updates: Uint8Array[]; end: boolean }): Promise<MockGeyser> {
  const state: MockGeyser = { port: 0, requests: [], raw: [], tokens: [], sessions: 0, close: async () => {} };
  const server = http2.createServer();
  server.on("stream", (s, headers) => {
    const stream = s as http2.ServerHttp2Stream;
    const path = String(headers[":path"]);
    stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    stream.on("error", () => {});
    if (!path.endsWith("/Subscribe")) {
      stream.end();
      return;
    }
    const session = state.sessions++;
    state.tokens.push(headers["x-token"] as string | undefined);
    let buf = Buffer.alloc(0);
    let started = false;
    stream.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const frameBytes = new Uint8Array(buf.subarray(5, 5 + len));
        const req = SubscribeRequest.decode(frameBytes);
        buf = buf.subarray(5 + len);
        state.requests.push(req);
        state.raw.push(frameBytes);
        // start streaming once the filters arrive (the client first sends an empty request)
        if (!started && Object.keys(req.transactions).length > 0) {
          started = true;
          const plan = sessionUpdates(session);
          for (const u of plan.updates) stream.write(frame(u));
          if (plan.end) setTimeout(() => stream.end(), 20);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.port = (server.address() as { port: number }).port;
  state.close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      setTimeout(r, 200);
    });
  return state;
}
