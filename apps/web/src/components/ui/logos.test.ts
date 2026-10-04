import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHPADS, VENUE_LABEL } from "../../lib/metrics";
import type { Venue } from "../../protocol";
import { LAUNCHPAD_LOGO, PLATFORM_LOGOS, type PlatformLogo, platformLogo, sameBrand, VENUE_LOGO } from "./logos";

const PUBLIC = join(import.meta.dir, "..", "..", "..", "public");

describe("platform logos", () => {
  test("every launchpad the app knows has a logo (except 'other')", () => {
    for (const l of LAUNCHPADS) {
      if (l.id === "other") expect(LAUNCHPAD_LOGO[l.id]).toBeNull();
      else expect(LAUNCHPAD_LOGO[l.id]).not.toBeNull();
    }
  });

  test("every trading venue has a logo (except 'other')", () => {
    for (const v of Object.keys(VENUE_LABEL) as Venue[]) {
      if (v === "other") expect(VENUE_LOGO[v]).toBeNull();
      else expect(VENUE_LOGO[v]).not.toBeNull();
    }
  });

  test("the server's venue ids and route names map too", () => {
    // packages/protocol Launchpad / TradeVenue: "pump" | "pumpswap"
    expect(platformLogo("pump")).toBe("pump");
    expect(platformLogo("pumpswap")).toBe("pumpswap");
    expect(platformLogo("Jupiter")).toBe("jupiter");
    expect(platformLogo("orca")).toBe("orca");
    expect(platformLogo("raydium_cpmm")).toBe("raydium");
    expect(platformLogo("meteora_damm_v2")).toBe("meteora");
    expect(platformLogo("other")).toBeNull();
    expect(platformLogo("unknown-dex")).toBeNull();
    expect(platformLogo(null)).toBeNull();
  });

  test("each logo is a bundled 64 px WebP of a few KB, listed with its source in LOGOS.md", async () => {
    const credits = readFileSync(join(PUBLIC, "venues", "LOGOS.md"), "utf8");
    for (const [id, p] of Object.entries(PLATFORM_LOGOS) as [PlatformLogo, { label: string; src: string }][]) {
      expect(p.src).toBe(`/venues/${id}.webp`);
      const file = join(PUBLIC, p.src);
      expect(existsSync(file)).toBe(true);
      const bytes = new Uint8Array(readFileSync(file));
      expect(bytes.byteLength).toBeLessThan(8 * 1024);
      const meta = await new Bun.Image(bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(Math.max(meta.width, meta.height)).toBe(64);
      expect(credits).toContain(`${id}.webp`);
    }
  });

  test("pump.fun's family shares one mark", () => {
    expect(sameBrand("pump", "pumpswap")).toBe(true);
    expect(sameBrand("mayhem", "pump")).toBe(true);
    expect(sameBrand("raydium", "pump")).toBe(false);
    expect(sameBrand(null, null)).toBe(true);
  });
});
