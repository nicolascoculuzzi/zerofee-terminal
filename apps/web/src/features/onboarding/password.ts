/**
 * Live passphrase checklist (DESIGN.md 4.19): "12+ characters" and "Not a common password".
 * The keystore's real protection is Argon2id; this only stops the passphrases attackers try first.
 */
export const MIN_PASSPHRASE = 12;

// The most common leaked passwords, plus words a crypto trader is likely to reach for.
const COMMON = new Set([
  "password",
  "passw0rd",
  "qwerty",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "abc",
  "abcdef",
  "admin",
  "letmein",
  "welcome",
  "monkey",
  "dragon",
  "football",
  "baseball",
  "iloveyou",
  "sunshine",
  "princess",
  "master",
  "trustno",
  "shadow",
  "superman",
  "starwars",
  "whatever",
  "freedom",
  "hello",
  "charlie",
  "login",
  "secret",
  "access",
  "changeme",
  "mustang",
  "michael",
  "jordan",
  "batman",
  "pokemon",
  "computer",
  "internet",
  "solana",
  "phantom",
  "solflare",
  "backpack",
  "bitcoin",
  "ethereum",
  "crypto",
  "wallet",
  "zerofee",
  "pumpfun",
  "memecoin",
  "tothemoon",
  "lambo",
  "hodl",
  "satoshi",
  "nakamoto",
]);

const SEQUENCES = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm"];

export function isCommonPassphrase(raw: string): boolean {
  const pw = raw.toLowerCase();
  if (!pw) return false;
  // One character, or a short chunk repeated ("aaaaaaaaaaaa", "abcabcabcabc", "passwordpassword").
  for (let n = 1; n <= pw.length / 2; n++) {
    if (pw.length % n === 0 && pw.slice(0, n).repeat(pw.length / n) === pw) return true;
  }
  // Digits only, or a straight run on the keyboard or alphabet.
  if (/^\d+$/.test(pw)) return true;
  if (SEQUENCES.some((s) => s.includes(pw) || [...s].reverse().join("").includes(pw))) return true;
  // A common word dressed up with digits and symbols ("Password2024!", "solana123").
  const core = pw.replace(/[^a-z]/g, "").replace(/(.)\1+$/, "$1");
  if (COMMON.has(core)) return true;
  return [...COMMON].some((w) => core.startsWith(w) && core.slice(w.length).length <= 2);
}

export interface PassphraseCheck {
  id: "length" | "common";
  label: string;
  met: boolean;
}

export function passphraseChecks(pw: string): PassphraseCheck[] {
  return [
    { id: "length", label: `${MIN_PASSPHRASE}+ characters`, met: pw.length >= MIN_PASSPHRASE },
    { id: "common", label: "Not a common password", met: pw.length > 0 && !isCommonPassphrase(pw) },
  ];
}
