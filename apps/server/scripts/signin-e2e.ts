#!/usr/bin/env bun
/**
 * End-to-end check of a running server's accounts layer with a throwaway wallet:
 * SIWS sign-in -> session cookie -> /api/me -> settings -> WebSocket user topics -> sign-out.
 *
 *   SERVER_URL=http://127.0.0.1:8787 bun run --cwd apps/server signin-e2e
 *
 * The key pair is generated here (WebCrypto Ed25519, private half non-extractable), never funded,
 * never written anywhere, and gone when the script exits. ORIGIN defaults to SERVER_URL and must be
 * the server's PUBLIC_ORIGIN or one of its ALLOWED_ORIGINS. Nothing here touches any chain.
 */
import { getAddressFromPublicKey } from "@solana/kit";
import { createSignInMessage } from "@zerofee/auth";
import type { MeResponse, NonceResponse, UserSettings } from "@zerofee/protocol";

const SERVER = (process.env.SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = process.env.ORIGIN ?? new URL(SERVER).origin;
let failures = 0;

function check(ok: boolean, what: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  (${detail})` : ""}`);
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function throwaway() {
  const kp = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
  return {
    address: await getAddressFromPublicKey(kp.publicKey),
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
    sign: async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new Uint8Array(m))),
  };
}

async function main(): Promise<void> {
  console.log(`server ${SERVER}, origin ${ORIGIN}`);
  const health = await fetch(`${SERVER}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`server not reachable at ${SERVER}`);

  const wallet = await throwaway();
  console.log(`throwaway wallet ${wallet.address} (never funded)`);

  // 1. nonce + sign
  const nonce = (await (await fetch(`${SERVER}/api/auth/nonce`)).json()) as NonceResponse;
  check(nonce.input.uri === ORIGIN, "nonce input binds the app origin", nonce.input.uri);
  check(/^[0-9a-f]{32}$/.test(nonce.input.nonce), "server nonce is 128 random bits");
  const message = createSignInMessage({ ...nonce.input, address: wallet.address });
  console.log(`\n--- message the wallet signs ---\n${new TextDecoder().decode(message)}\n-------------------------------\n`);
  const body = JSON.stringify({
    account: { address: wallet.address, publicKey: b64(wallet.publicKey) },
    signedMessage: b64(message),
    signature: b64(await wallet.sign(message)),
  });

  // 2. sign-in (the wrong origin first)
  const forged = await fetch(`${SERVER}/api/auth/signin`, { method: "POST", headers: { origin: "https://evil.example" }, body });
  check(forged.status === 403, "sign-in from a foreign origin is refused", String(forged.status));
  const signin = await fetch(`${SERVER}/api/auth/signin`, { method: "POST", headers: { origin: ORIGIN }, body });
  check(signin.status === 200, "sign-in accepted", String(signin.status));
  const setCookie = signin.headers.get("set-cookie") ?? "";
  for (const attr of ["__Host-zf_session=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/"])
    check(setCookie.includes(attr), `cookie has ${attr}`);
  const cookie = setCookie.split(";")[0] ?? "";
  const me = (await signin.json()) as MeResponse;
  check(me.wallet === wallet.address, "session is bound to the wallet");
  const replay = await fetch(`${SERVER}/api/auth/signin`, { method: "POST", headers: { origin: ORIGIN }, body });
  check(replay.status === 401, "replaying the signed message is refused (nonce burned)", String(replay.status));

  // 3. authenticated REST
  const meAgain = await fetch(`${SERVER}/api/me`, { headers: { cookie } });
  check(meAgain.status === 200 && ((await meAgain.json()) as MeResponse).wallet === wallet.address, "GET /api/me with the cookie");
  const csrf = await fetch(`${SERVER}/api/settings`, { method: "PATCH", headers: { cookie }, body: JSON.stringify({ theme: "light" }) });
  check(csrf.status === 403, "cookie-authenticated mutation without Origin is refused (CSRF)", String(csrf.status));
  const patched = await fetch(`${SERVER}/api/settings`, {
    method: "PATCH",
    headers: { cookie, origin: ORIGIN },
    body: JSON.stringify({ theme: "light" }),
  });
  check(patched.status === 200 && ((await patched.json()) as UserSettings).theme === "light", "PATCH /api/settings");
  const trading = await throwaway();
  const tw = await fetch(`${SERVER}/api/trading-wallets`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body: JSON.stringify({ publicKey: trading.address, label: "e2e" }),
  });
  check(tw.status === 200, "register a trading wallet (public key only)", String(tw.status));

  // 4. WebSocket user topics
  const ws = new WebSocket(`${SERVER.replace(/^http/, "ws")}/ws`, { headers: { cookie, origin: ORIGIN } } as unknown as string[]);
  const msgs: { type: string; topic?: string; code?: string; data?: unknown }[] = [];
  let closed: { code: number } | null = null;
  ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
  ws.onclose = (e) => {
    closed = { code: e.code };
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  const waitMsg = async (pred: (m: (typeof msgs)[number]) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const m = msgs.find(pred);
      if (m) return m;
      await Bun.sleep(30);
    }
    return null;
  };
  for (const topic of ["orders", `wallet:${trading.address}`, `wallet:${(await throwaway()).address}`, "chain"])
    ws.send(JSON.stringify({ type: "subscribe", topic }));
  const orders = await waitMsg((m) => m.topic === "orders");
  check(orders?.type === "snapshot", "orders topic: snapshot for the signed-in user", orders?.type);
  const own = await waitMsg((m) => m.topic === `wallet:${trading.address}`);
  check(own?.type === "error" && own.code === "unavailable", "own trading wallet: authorized (balances not published yet)", own?.code);
  const foreign = await waitMsg((m) => m.type === "error" && m.code === "forbidden");
  check(!!foreign, "someone else's wallet topic is forbidden");
  const chain = await waitMsg((m) => m.topic === "chain" && m.type === "snapshot");
  check(!!chain && typeof (chain.data as { halt?: unknown }).halt === "object", "chain snapshot carries the halt state");

  // 5. sign-out ends the session everywhere
  const out = await fetch(`${SERVER}/api/auth/signout`, { method: "POST", headers: { cookie, origin: ORIGIN }, body: "{}" });
  check(out.status === 200 && (out.headers.get("set-cookie") ?? "").includes("Max-Age=0"), "sign-out clears the cookie");
  const after = await fetch(`${SERVER}/api/me`, { headers: { cookie } });
  check(after.status === 401, "the old cookie is dead", String(after.status));
  for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(30);
  check(
    (closed as { code: number } | null)?.code === 4401,
    "the WebSocket was closed with 4401 (session ended)",
    String((closed as { code: number } | null)?.code),
  );

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
