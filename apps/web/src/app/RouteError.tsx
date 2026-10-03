import { isRouteErrorResponse, Link, useRouteError } from "react-router";

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Something went wrong";
  return (
    <div className="flex h-full min-h-screen flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
      <div className="text-heading font-semibold">This view crashed</div>
      <pre className="max-w-xl whitespace-pre-wrap rounded-sm border border-hairline bg-surface-1 p-3 text-left text-label text-sell">
        {message}
      </pre>
      <Link to="/pulse" className="text-data text-fg-1 underline decoration-hairline-strong underline-offset-2">
        Back to Pulse
      </Link>
    </div>
  );
}
