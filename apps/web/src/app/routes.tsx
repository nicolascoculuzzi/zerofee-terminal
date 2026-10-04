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
