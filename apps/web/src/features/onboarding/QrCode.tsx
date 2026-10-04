import { useMemo } from "react";
import { encodeQr, qrPath } from "./qr";

const BORDER = 4;

/**
 * A QR code on a white plate with a 4 px radius (DESIGN.md 4.19): black on white in both themes,
 * because scanners need the contrast; the plate is the only white in the dark UI. Scan-tested
 * with Apple's CoreImage and Vision decoders (see qr.ts).
 */
export function QrCode({ value, size = 160, label }: { value: string; size?: number; label: string }) {
  const code = useMemo(() => {
    try {
      return encodeQr(value, "M");
    } catch {
      return null;
    }
  }, [value]);
  if (!code) return null;
  const n = code.size + BORDER * 2;
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-sm" style={{ width: size, height: size }}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges">
        <rect width={n} height={n} fill="#ffffff" />
        <path d={qrPath(code, BORDER)} fill="#000000" />
      </svg>
    </span>
  );
}
