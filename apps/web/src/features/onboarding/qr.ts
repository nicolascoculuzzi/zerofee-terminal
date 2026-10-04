/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction L or M, versions 1–10
 * (up to 213 bytes at M), automatic mask choice by the standard penalty rules. Enough for a
 * Solana address (44 bytes fit version 4-M). Follows the structure of Nayuki's reference
 * implementation (MIT). No dependencies.
 */
export type QrEcc = "L" | "M";

export interface QrCode {
  version: number;
  size: number;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

const MAX_VERSION = 10;
// Index 0 unused. Checked against the standard's byte-mode capacities (L: 17…271, M: 14…213).
const ECC_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
};
const NUM_BLOCKS: Record<QrEcc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
};
const FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0 };

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(ver: number, ecc: QrEcc): number {
  return Math.floor(numRawDataModules(ver) / 8) - (ECC_PER_BLOCK[ecc][ver] ?? 0) * (NUM_BLOCKS[ecc][ver] ?? 0);
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ---------------------------------------------------------------------------
// Reed–Solomon over GF(2^8) with the QR polynomial 0x11D
// ---------------------------------------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j] ?? 0, root);
      if (j + 1 < result.length) result[j] = (result[j] ?? 0) ^ (result[j + 1] ?? 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function appendBits(value: number, length: number, out: number[]): void {
  for (let i = length - 1; i >= 0; i--) out.push((value >>> i) & 1);
}

function dataCodewords(bytes: Uint8Array, ver: number, ecc: QrEcc): number[] {
  const capacityBits = numDataCodewords(ver, ecc) * 8;
  const bits: number[] = [];
  appendBits(0x4, 4, bits); // byte mode
  appendBits(bytes.length, ver <= 9 ? 8 : 16, bits);
  for (const b of bytes) appendBits(b, 8, bits);
  appendBits(0, Math.min(4, capacityBits - bits.length), bits);
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bits);
  const out: number[] = new Array(bits.length / 8).fill(0);
  bits.forEach((bit, i) => {
    out[i >>> 3] = (out[i >>> 3] ?? 0) | (bit << (7 - (i & 7)));
  });
  return out;
}

function interleaveWithEcc(data: number[], ver: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_BLOCKS[ecc][ver] ?? 1;
  const blockEccLen = ECC_PER_BLOCK[ecc][ver] ?? 0;
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result: number[] = [];
  const blockLen = blocks[0]?.length ?? 0;
  for (let i = 0; i < blockLen; i++) {
    blocks.forEach((block, j) => {
      // Skip the padding byte of short blocks.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i] ?? 0);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

class Matrix {
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean): void {
    const row = this.modules[y];
    const fn = this.isFunction[y];
    if (!row || !fn) return;
    row[x] = dark;
    fn[x] = true;
  }
  get(x: number, y: number): boolean {
    return this.modules[y]?.[x] ?? false;
  }
}

function drawFinder(m: Matrix, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < m.size && y >= 0 && y < m.size) m.setFunction(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m: Matrix, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) m.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

function drawFormat(m: Matrix, ecc: QrEcc, mask: number): void {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
  m.setFunction(8, 7, bit(6));
  m.setFunction(8, 8, bit(7));
  m.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.setFunction(m.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFunction(8, m.size - 15 + i, bit(i));
  m.setFunction(8, m.size - 8, true); // the dark module
}

function drawVersion(m: Matrix, ver: number): void {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.setFunction(a, b, dark);
    m.setFunction(b, a, dark);
  }
}

function drawFunctionPatterns(m: Matrix, ver: number, ecc: QrEcc): void {
  for (let i = 0; i < m.size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);
  const pos = alignmentPositions(ver, m.size);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0);
      if (!corner) drawAlignment(m, pos[i] ?? 0, pos[j] ?? 0);
    }
  }
  drawFormat(m, ecc, 0); // placeholder; redrawn with the chosen mask
  drawVersion(m, ver);
}

function drawCodewords(m: Matrix, data: number[]): void {
  let i = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (!m.isFunction[y]?.[x] && i < data.length * 8) {
          const row = m.modules[y];
          if (row) row[x] = (((data[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    const row = m.modules[y];
    const fn = m.isFunction[y];
    if (!row || !fn) continue;
    for (let x = 0; x < m.size; x++) if (!fn[x] && maskBit(mask, x, y)) row[x] = !row[x];
  }
}

// Penalty (only used to pick the mask; every mask gives a valid code).
function penalty(m: Matrix): number {
  const size = m.size;
  let result = 0;
  const addHistory = (run: number, history: number[]) => {
    let r = run;
    if (history[0] === 0) r += size; // light border before the first run
    history.pop();
    history.unshift(r);
  };
  const countPatterns = (h: number[]) => {
    const n = h[1] ?? 0;
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && (h[0] ?? 0) >= n * 4 && (h[6] ?? 0) >= n ? 1 : 0) + (core && (h[6] ?? 0) >= n * 4 && (h[0] ?? 0) >= n ? 1 : 0);
  };
  const terminate = (color: boolean, run: number, history: number[]) => {
    let r = run;
    if (color) {
      addHistory(r, history);
      r = 0;
    }
    r += size; // light border after the last run
    addHistory(r, history);
    return countPatterns(history);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let runColor = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const dark = pass === 0 ? m.get(b, a) : m.get(a, b);
        if (dark === runColor) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!runColor) result += countPatterns(history) * 40;
          runColor = dark;
          run = 1;
        }
      }
      result += terminate(runColor, run, history) * 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) result += 3;
    }
  }
  let dark = 0;
  for (const row of m.modules) for (const v of row) if (v) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += k * 10;
  return result;
}

/**
 * Encodes text (UTF-8, byte mode) at the smallest version that fits. Throws when it doesn't fit
 * version 10. `forceMask` (0–7) skips the penalty search; tests use it to cover every mask.
 */
export function encodeQr(text: string, ecc: QrEcc = "M", forceMask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const used = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if (used <= numDataCodewords(v, ecc) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) throw new Error("Text too long for a version 1–10 QR code");
  const size = version * 4 + 17;
  const m = new Matrix(size);
  drawFunctionPatterns(m, version, ecc);
  drawCodewords(m, interleaveWithEcc(dataCodewords(bytes, version, ecc), version, ecc));
  let best = forceMask ?? 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8 && forceMask === undefined; mask++) {
    applyMask(m, mask);
    drawFormat(m, ecc, mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(m, mask); // XOR undoes it
  }
  applyMask(m, best);
  drawFormat(m, ecc, best);
  return { version, size, mask: best, modules: m.modules };
}

/** SVG path for the dark modules, offset by a quiet zone of `border` modules. */
export function qrPath(code: QrCode, border = 4): string {
  let d = "";
  code.modules.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x + border},${y + border}h1v1h-1z`;
    });
  });
  return d;
}
