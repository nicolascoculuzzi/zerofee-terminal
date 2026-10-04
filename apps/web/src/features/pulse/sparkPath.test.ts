import { describe, expect, test } from "bun:test";
import { sparkGeometry } from "./sparkPath";

const N = Number.NaN;

describe("sparkGeometry", () => {
  test("nothing known draws nothing", () => {
    expect(sparkGeometry(null, 64, 24, 2, 1.5)).toBeNull();
    expect(sparkGeometry([N, N], 64, 24, 2, 1.5)).toBeNull();
  });
  test("one known minute is a flat line across, not a lone dot", () => {
    const g = sparkGeometry([N, N, 5], 64, 24, 2, 1.5);
    expect(g?.points).toBe("2,12 60.5,12");
    expect(g).toMatchObject({ dotX: 60.5, dotY: 12 });
  });
  test("float noise stays flat in the middle instead of a full-height zigzag", () => {
    const g = sparkGeometry([1, 1.0000001, 0.9999999, 1], 64, 24, 2, 1.5);
    const ys = g?.points.split(" ").map((p) => Number(p.split(",")[1])) ?? [];
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.5);
  });
  test("a real move spans the box; gaps start the line part-way", () => {
    const g = sparkGeometry([N, 1, 2], 64, 24, 2, 1.5);
    const pts = g?.points.split(" ") ?? [];
    expect(pts).toHaveLength(2);
    expect(pts[0]).toBe("31.3,22");
    expect(pts[1]).toBe("60.5,2");
  });
});
