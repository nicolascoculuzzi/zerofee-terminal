/** The subset of the `web-push` package (CommonJS, no bundled types) the server uses. */
declare module "web-push" {
  export interface PushSubscriptionLike {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }
  export interface RequestOptions {
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    topic?: string;
    contentEncoding?: "aes128gcm" | "aesgcm";
    headers?: Record<string, string>;
  }
  export interface RequestDetails {
    method: string;
    headers: Record<string, string | number>;
    body: Uint8Array | null;
    endpoint: string;
  }
  export function generateVAPIDKeys(): VapidKeys;
  export function generateRequestDetails(
    subscription: PushSubscriptionLike,
    payload?: string | null,
    options?: RequestOptions,
  ): RequestDetails;
  const webpush: {
    generateVAPIDKeys: typeof generateVAPIDKeys;
    generateRequestDetails: typeof generateRequestDetails;
  };
  export default webpush;
}
