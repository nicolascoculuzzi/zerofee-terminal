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
      <div className="text-md font-semibold">This view crashed</div>
      <pre className="max-w-xl whitespace-pre-wrap rounded-md border border-line bg-panel p-3 text-left text-xs text-sell">{message}</pre>
      <Link to="/pulse" className="text-sm text-fg underline decoration-line-strong underline-offset-2">
        Back to Pulse
      </Link>
    </div>
  );
}
