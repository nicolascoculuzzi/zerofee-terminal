export type SignerErrorCode =
  | "NO_VAULT"
  | "VAULT_EXISTS"
  | "LOCKED"
  | "WRONG_PASSWORD"
  | "WEAK_PASSWORD"
  | "WEAK_KDF"
  | "INVALID_VAULT"
  | "STORAGE_CONFLICT"
  | "WALLET_NOT_FOUND"
  | "WALLET_LIMIT"
  | "DUPLICATE_WALLET"
  | "INVALID_SECRET"
  | "INVALID_ARGUMENT"
  | "FIREWALL_REFUSED"
  | "DAILY_CAP_EXCEEDED"
  | "INTERNAL";

/** Error with a stable machine-readable code (it crosses the worker RPC boundary as `{ code, message }`). */
export class SignerError extends Error {
  readonly code: SignerErrorCode;
  readonly violations: readonly string[] | undefined;

  constructor(code: SignerErrorCode, message: string, options: { violations?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SignerError";
    this.code = code;
    this.violations = options.violations;
  }
}

export function isSignerError(e: unknown, code?: SignerErrorCode): e is SignerError {
  return e instanceof SignerError && (code === undefined || e.code === code);
}
