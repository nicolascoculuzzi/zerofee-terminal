import { lazy, type ReactNode, Suspense } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { RouteError } from "./RouteError";
import { Shell } from "./Shell";

const PulsePage = lazy(() => import("../features/pulse/PulsePage"));
const TokenPage = lazy(() => import("../features/token/TokenPage"));
const DiscoverPage = lazy(() => import("../features/discover/DiscoverPage"));
const TrackersPage = lazy(() => import("../features/trackers/TrackersPage"));
const PortfolioPage = lazy(() => import("../features/portfolio/PortfolioPage"));
const OrdersPage = lazy(() => import("../features/orders/OrdersPage"));
const OnboardingPage = lazy(() => import("../features/onboarding/OnboardingPage"));

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center text-data text-fg-3">
      <span className="zf-live-dot">Loading…</span>
    </div>
  );
}

function page(node: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/pulse" replace /> },
      { path: "pulse", element: page(<PulsePage />) },
      { path: "discover", element: page(<DiscoverPage />) },
      { path: "t/:mint", element: page(<TokenPage />) },
      { path: "trackers", element: page(<TrackersPage />) },
      { path: "portfolio", element: page(<PortfolioPage />) },
      { path: "orders", element: page(<OrdersPage />) },
      { path: "*", element: <Navigate to="/pulse" replace /> },
    ],
  },
  { path: "/onboarding", element: page(<OnboardingPage />), errorElement: <RouteError /> },
]);
