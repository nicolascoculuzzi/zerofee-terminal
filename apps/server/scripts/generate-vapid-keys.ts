#!/usr/bin/env bun
/**
 * Generates a Web Push VAPID key pair (P-256) and prints the .env lines.
 *
 *   bun run --cwd apps/server vapid-keys
 *
 * Put the output in your local .env (gitignored), never in the repository. The public key is served to
 * browsers (GET /api/push/vapid-public-key); the private key signs every push request. Changing the
 * pair invalidates every existing browser subscription (the push services answer 403 and the server
 * deletes them), so generate it once per deployment and keep it.
 */
import { generateVapidKeys } from "../src/alerts/push";

const { publicKey, privateKey } = generateVapidKeys();
console.log("# Web Push (VAPID). Keep VAPID_PRIVATE_KEY secret.");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("# Contact for the push services: mailto: address or https: URL");
console.log("VAPID_SUBJECT=mailto:ops@your-domain.example");
