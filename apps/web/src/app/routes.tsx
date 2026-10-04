import { Component, lazy, type ReactNode, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { RouteError } from "./RouteError";
import { Shell } from "./Shell";

const PulsePage = lazy(() => import("../features/pulse/PulsePage"));
const TokenPage = lazy(() => import("../features/token/TokenPage"));
const DiscoverPage = lazy(() => import("../features/discover/DiscoverPage"));
const TrackersPage = lazy(() => import("../features/trackers/TrackersPage"));
const PortfolioPage = lazy(() => import("../features/portfolio/PortfolioPage"));
const OrdersPage = lazy(() => import("../features/orders/OrdersPage"));
const OnboardingPage = lazy(() => import("../features/onboarding/OnboardingPage"));

/**
 * While a route chunk loads (usually well under a second): an empty, busy page area. No spinner, shimmer or
 * placeholder copy (DESIGN.md 4.18); each page draws its own skeleton once its chunk is in.
 */
function PageFallback() {
  return <div aria-busy="true" className="min-h-0 flex-1" />;
}

function page(node: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>;
}

/**
 * Catches a view that could not render (or whose chunk failed to load) and shows RouteError in its place.
 * A new path (`resetKey`) clears the error, so navigating elsewhere starts over.
 */
class RouteBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error("Something went wrong") };
  }

  override componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    return this.state.error ? <RouteError error={this.state.error} /> : this.props.children;
  }
}

/**
 * Declarative routes (BrowserRouter in App.tsx). The data router (createBrowserRouter) brought ~17 KB gzip of
 * loader / action / SSR machinery the app does not use onto the first screen's critical path.
 */
export function AppRoutes() {
  const { pathname } = useLocation();
  return (
    <RouteBoundary resetKey={pathname}>
      <Routes>
        <Route path="/" element={<Shell />}>
          <Route index element={<Navigate to="/pulse" replace />} />
          <Route path="pulse" element={page(<PulsePage />)} />
          <Route path="discover" element={page(<DiscoverPage />)} />
          <Route path="t/:mint" element={page(<TokenPage />)} />
          <Route path="trackers" element={page(<TrackersPage />)} />
          <Route path="portfolio" element={page(<PortfolioPage />)} />
          <Route path="orders" element={page(<OrdersPage />)} />
          <Route path="*" element={<Navigate to="/pulse" replace />} />
        </Route>
        <Route path="/onboarding" element={page(<OnboardingPage />)} />
      </Routes>
    </RouteBoundary>
  );
}
