/** Lets non-React code (toasts, hotkeys, feed alerts) navigate through the router. */
type NavigateFn = (to: string) => void;

let navigateFn: NavigateFn | null = null;

export function setNavigator(fn: NavigateFn | null): void {
  navigateFn = fn;
}

export function navigateTo(to: string): void {
  if (navigateFn) navigateFn(to);
  else window.location.assign(to);
}
