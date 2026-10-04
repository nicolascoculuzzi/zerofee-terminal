import { describe, expect, test } from "bun:test";
import { createElement as h } from "react";
import { type Match, matchPath, matchRoutes, Route } from "./router";

/** The app's own table (app/routes.tsx), with strings for elements. */
const table = [
  h(
    Route,
    { key: "shell", path: "/", element: "shell" },
    h(Route, { index: true, element: "index" }),
    h(Route, { path: "pulse", element: "pulse" }),
    h(Route, { path: "t/:mint", element: "token" }),
    h(Route, { path: "*", element: "fallback" }),
  ),
  h(Route, { key: "onboarding", path: "/onboarding", element: "onboarding" }),
];

const chain = (m: Match | null): unknown[] => (m ? [m.element, ...chain(m.outlet)] : []);
const at = (path: string) => matchRoutes(table, path.split("/").filter(Boolean));

describe("router matching", () => {
  test("nested routes, index routes, params", () => {
    expect(chain(at("/"))).toEqual(["shell", "index"]);
    expect(chain(at("/pulse"))).toEqual(["shell", "pulse"]);
    expect(chain(at("/pulse/"))).toEqual(["shell", "pulse"]);
    expect(chain(at("/t/abc"))).toEqual(["shell", "token"]);
    expect(at("/t/So1%2Bx")?.params).toEqual({ mint: "So1+x" });
  });

  test("a specific route beats a catch-all declared before it; unknown paths fall through to it", () => {
    expect(chain(at("/onboarding"))).toEqual(["onboarding"]);
    expect(chain(at("/nope/deeper"))).toEqual(["shell", "fallback"]);
    expect(chain(at("/t/abc/extra"))).toEqual(["shell", "fallback"]);
  });

  test("matchPath", () => {
    expect(matchPath("t/:mint", ["t", "x", "y"])).toEqual({ params: { mint: "x" }, rest: ["y"] });
    expect(matchPath("pulse", ["orders"])).toBeNull();
    expect(matchPath("*", ["a", "b"])).toEqual({ params: { "*": "a/b" }, rest: [] });
  });
});
