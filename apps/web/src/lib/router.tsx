/**
 * A small client-side router with the react-router API surface this app uses (BrowserRouter, Routes /
 * Route with nesting, index routes, `:params` and `*`, Outlet, Link, NavLink, Navigate, useNavigate,
 * useLocation, useParams, useSearchParams). react-router was ~11 KB gzip of the first screen's JavaScript
 * (data routers, SSR helpers, instrumentation) for what amounts to pushState plus a path matcher.
 *
 * Semantics kept: absolute paths, `replace` / `state`, `navigate(-1)`, modifier / middle clicks and
 * `target` left to the browser, NavLink `isActive` (prefix match on segment boundaries, `end` for exact),
 * first matching route wins in declaration order (catch-alls last), and a scroll to top on push navigation.
 */
import {
  type AnchorHTMLAttributes,
  Children,
  createContext,
  forwardRef,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

export interface Location {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
}

export interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export interface NavigateFunction {
  (to: string, options?: NavigateOptions): void;
  (delta: number): void;
}

// ---------------------------------------------------------------------------------------------
// history store
// ---------------------------------------------------------------------------------------------

const listeners = new Set<() => void>();
let current: Location | null = null;
let seq = 0;

function read(): Location {
  const h = (window.history.state ?? {}) as { usr?: unknown; key?: string };
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    state: h.usr ?? null,
    key: h.key ?? "default",
  };
}

function snapshot(): Location {
  current ??= read();
  return current;
}

function emit(): void {
  current = read();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (listeners.size === 1) window.addEventListener("popstate", emit);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) window.removeEventListener("popstate", emit);
  };
}

function navigate(to: string | number, options: NavigateOptions = {}): void {
  if (typeof to === "number") {
    window.history.go(to);
    return;
  }
  const url = new URL(to, window.location.href);
  const target = `${url.pathname}${url.search}${url.hash}`;
  const state = { usr: options.state ?? null, key: (++seq).toString(36) };
  if (options.replace) window.history.replaceState(state, "", target);
  else {
    window.history.pushState(state, "", target);
    window.scrollTo(0, 0);
  }
  emit();
}

const RouterContext = createContext<Location | null>(null);

/** Keeps the tree in step with the address bar (pushState / popstate). */
export function BrowserRouter({ children }: { children: ReactNode }) {
  const location = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <RouterContext.Provider value={location}>{children}</RouterContext.Provider>;
}

export function useLocation(): Location {
  const l = useContext(RouterContext);
  if (!l) throw new Error("useLocation outside <BrowserRouter>");
  return l;
}

export function useNavigate(): NavigateFunction {
  return useCallback(((to: string | number, options?: NavigateOptions) => navigate(to, options)) as NavigateFunction, []);
}

export function useSearchParams(): [URLSearchParams, (next: URLSearchParams | Record<string, string>, options?: NavigateOptions) => void] {
  const { search, pathname, hash } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const set = useCallback(
    (next: URLSearchParams | Record<string, string>, options?: NavigateOptions) => {
      const q = new URLSearchParams(next).toString();
      navigate(`${pathname}${q ? `?${q}` : ""}${hash}`, options);
    },
    [pathname, hash],
  );
  return [params, set];
}

// ---------------------------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------------------------

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

export interface LinkProps extends AnchorProps {
  to: string;
  replace?: boolean;
  state?: unknown;
}

function useLinkClick(
  to: string,
  p: { replace?: boolean; state?: unknown; target?: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void },
) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    p.onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    if (p.target && p.target !== "_self") return;
    e.preventDefault();
    navigate(to, { replace: p.replace, state: p.state });
  };
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, replace, state, onClick, ...rest }, ref) {
  const click = useLinkClick(to, { replace, state, target: rest.target, onClick });
  return <a {...rest} ref={ref} href={to} onClick={click} />;
});

export interface NavLinkProps extends Omit<LinkProps, "className" | "children"> {
  className?: string | ((s: { isActive: boolean }) => string | undefined);
  children?: ReactNode | ((s: { isActive: boolean }) => ReactNode);
  /** Active only on an exact match. */
  end?: boolean;
}

export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink({ className, children, end, ...props }, ref) {
  const { pathname } = useLocation();
  const target = props.to.split(/[?#]/)[0] as string;
  const isActive = pathname === target || (!end && target !== "/" && pathname.startsWith(target.endsWith("/") ? target : `${target}/`));
  return (
    <Link
      {...props}
      ref={ref}
      aria-current={isActive ? "page" : undefined}
      className={typeof className === "function" ? className({ isActive }) : className}
    >
      {typeof children === "function" ? children({ isActive }) : children}
    </Link>
  );
});

/** Navigates once rendered (redirect routes). */
export function Navigate({ to, replace, state }: { to: string; replace?: boolean; state?: unknown }) {
  useEffect(() => navigate(to, { replace, state }), [to, replace, state]);
  return null;
}

// ---------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------

export interface RouteProps {
  path?: string;
  index?: boolean;
  element?: ReactNode;
  children?: ReactNode;
}

/** Declares a route; only meaningful inside <Routes> (it renders nothing by itself). */
export function Route(_props: RouteProps): ReactElement | null {
  return null;
}

export interface Match {
  element: ReactNode;
  params: Record<string, string>;
  outlet: Match | null;
}

const OutletContext = createContext<{ outlet: Match | null; params: Record<string, string> }>({ outlet: null, params: {} });

/** Matches `segments` against a route path; returns the params and the unconsumed rest, or null. */
export function matchPath(path: string, segments: string[]): { params: Record<string, string>; rest: string[] } | null {
  const parts = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p === "*") {
      params["*"] = segments.slice(i).join("/");
      return { params, rest: [] };
    }
    const s = segments[i];
    if (s === undefined) return null;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
    else if (p !== s) return null;
  }
  return { params, rest: segments.slice(parts.length) };
}

function matchIn(children: ReactNode, segments: string[], splat: boolean): Match | null {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<RouteProps>(child)) continue;
    const r = child.props;
    if (r.index) {
      if (segments.length === 0) return { element: r.element, params: {}, outlet: null };
      continue;
    }
    if (!splat && (r.path ?? "").split("/").includes("*")) continue;
    const m = matchPath(r.path ?? "", segments);
    if (!m) continue;
    if (r.children) {
      const inner = matchIn(r.children, m.rest, splat);
      if (inner) return { element: r.element, params: { ...m.params, ...inner.params }, outlet: inner };
      continue;
    }
    if (m.rest.length === 0) return { element: r.element, params: m.params, outlet: null };
  }
  return null;
}

/**
 * The route chain for `segments`, in declaration order, except that catch-all (`*`) routes only match when
 * no specific route does anywhere in the tree (as react-router ranks them: `/onboarding` beats `/` + `*`).
 */
export function matchRoutes(children: ReactNode, segments: string[]): Match | null {
  return matchIn(children, segments, false) ?? matchIn(children, segments, true);
}

/** Renders the first route matching the current path (nested routes render through <Outlet />). */
export function Routes({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const match = useMemo(() => matchRoutes(children, pathname.split("/").filter(Boolean)), [children, pathname]);
  if (!match) return null;
  return <OutletContext.Provider value={{ outlet: match.outlet, params: match.params }}>{match.element}</OutletContext.Provider>;
}

/** The matched child route of the enclosing route. */
export function Outlet() {
  const { outlet, params } = useContext(OutletContext);
  if (!outlet) return null;
  return <OutletContext.Provider value={{ outlet: outlet.outlet, params }}>{outlet.element}</OutletContext.Provider>;
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string | undefined>>(): T {
  return useContext(OutletContext).params as T;
}
