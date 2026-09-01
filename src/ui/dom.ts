// Small DOM helpers shared by the Import and Tokens tabs.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(label: string, className?: string): HTMLButtonElement {
  return el("button", className, label);
}

export function clear(node: HTMLElement): void {
  node.textContent = "";
}

let toastEl: HTMLDivElement | null = null;
let toastTimer = 0;
let toastAction: (() => void) | null = null;

function toastElement(): HTMLDivElement {
  if (toastEl === null) toastEl = document.getElementById("toast") as HTMLDivElement;
  return toastEl;
}

/**
 * The undo surface (UX §9), and the surface for the silent-success rescan summary.
 *
 * `action` gets 10 seconds, matching UX §7's undo window for a delete. After that the way back is
 * *Undo all* on the header chip or a per-token restore from the local-edits list — the toast is a
 * convenience, never the only route.
 */
export function toast(text: string, action?: { label: string; run: () => void }): void {
  const node = toastElement();
  clear(node);
  node.appendChild(el("span", undefined, text));

  toastAction = action ? action.run : null;
  if (action) {
    const undo = el("button", "toast-action", action.label);
    undo.addEventListener("click", () => {
      const run = toastAction;
      toastAction = null;
      node.classList.remove("show");
      window.clearTimeout(toastTimer);
      if (run) run();
    });
    node.appendChild(undo);
  }

  node.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.classList.remove("show");
    toastAction = null;
  }, action ? 10000 : 1800);
}

/**
 * `navigator.clipboard` is not reliably available inside Figma's plugin iframe, so this uses
 * the selected-textarea route, which is.
 */
export function copy(text: string, label: string): void {
  const clipboard = document.getElementById("clipboard") as HTMLTextAreaElement;
  clipboard.value = text;
  clipboard.select();
  try {
    document.execCommand("copy");
    toast(`Copied ${label}`);
  } catch {
    toast("Copy failed — select the JSON manually");
  }
}

// ---------------------------------------------------------------------------
// Popovers
// ---------------------------------------------------------------------------

let openPopover: HTMLElement | null = null;

/**
 * A one-at-a-time popover anchored under a control — the `⋯` row menu and the filter chips.
 *
 * Deliberately not a `<dialog>` or a centred modal: at 460×640 a backdrop-dimmed modal spends a
 * third of the panel on chrome (UX §5.1), and these are menus, not decisions.
 */
export function popover(anchor: HTMLElement, build: (close: () => void) => HTMLElement): void {
  closePopover();

  const node = el("div", "popover");
  const close = (): void => closePopover();
  node.appendChild(build(close));
  document.body.appendChild(node);

  const rect = anchor.getBoundingClientRect();
  const width = node.offsetWidth;
  const left = Math.min(Math.max(6, rect.left), window.innerWidth - width - 6);
  node.style.left = `${left}px`;

  const below = rect.bottom + 4;
  const height = node.offsetHeight;
  node.style.top =
    below + height > window.innerHeight - 6 ? `${Math.max(6, rect.top - height - 4)}px` : `${below}px`;

  openPopover = node;
  // Deferred: this same click is still propagating, and would close the popover it just opened.
  window.setTimeout(() => document.addEventListener("mousedown", onOutside), 0);
}

function onOutside(event: MouseEvent): void {
  if (openPopover !== null && !openPopover.contains(event.target as Node)) closePopover();
}

export function closePopover(): void {
  if (openPopover === null) return;
  openPopover.remove();
  openPopover = null;
  document.removeEventListener("mousedown", onOutside);
}

// ---------------------------------------------------------------------------

/** A colour chip. Transparency is real: the checkerboard sits behind, not beside (UX §4.5). */
export function swatch(color: string, outlined: boolean): HTMLElement {
  const node = el("span", outlined ? "swatch outlined" : "swatch");
  if (!outlined) node.style.background = color;
  return node;
}

export function highlight(text: string, query: string): HTMLElement {
  const node = el("span");
  if (query.length === 0) {
    node.textContent = text;
    return node;
  }
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) node.appendChild(document.createTextNode(text.slice(from, at)));
    node.appendChild(el("mark", undefined, text.slice(at, at + needle.length)));
    from = at + needle.length;
  }
  node.appendChild(document.createTextNode(text.slice(from)));
  return node;
}
