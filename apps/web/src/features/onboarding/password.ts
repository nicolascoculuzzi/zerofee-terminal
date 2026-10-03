export interface PasswordStrength {
  /** 0 = too short, 1–4 = weak to strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  /** Risk colour: weak = sell, fair = warn, good/strong = buy. */
  tone: "neutral" | "sell" | "warn" | "buy";
}

const LABELS = { 1: "Weak", 2: "Fair", 3: "Good", 4: "Strong" } as const;

export const MIN_PASSWORD = 8;

/** Simple length + character-variety meter. The keystore's real protection is Argon2id. */
export function passwordStrength(pw: string): PasswordStrength {
  if (!pw) return { score: 0, label: "", tone: "neutral" };
  if (pw.length < MIN_PASSWORD) return { score: 0, label: "Too short", tone: "sell" };
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  let score: 1 | 2 | 3 | 4 = 1;
  if (pw.length >= 12) score = 2;
  if (variety >= 3) score = score === 2 ? 3 : 2;
  if (pw.length >= 16 || (variety === 4 && pw.length >= 12)) score = 4;
  // One repeated character or a plain digit run is weak at any length.
  if (/^(.)\1+$/.test(pw) || /^\d+$/.test(pw)) score = 1;
  return { score, label: LABELS[score], tone: score === 1 ? "sell" : score === 2 ? "warn" : "buy" };
}
