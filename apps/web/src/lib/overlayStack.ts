/**
 * Stack of open overlays (modals, drawers, popovers). Escape closes the top-most one, so a
 * filter modal opened from a column closes before the page underneath reacts.
 */
type Closer = () => void;
const stack: { id: number; close: Closer }[] = [];
let nextId = 1;

export function pushOverlay(close: Closer): () => void {
  const id = nextId++;
  stack.push({ id, close });
  return () => {
    const idx = stack.findIndex((e) => e.id === id);
    if (idx >= 0) stack.splice(idx, 1);
  };
}

export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function overlayOpen(): boolean {
  return stack.length > 0;
}
