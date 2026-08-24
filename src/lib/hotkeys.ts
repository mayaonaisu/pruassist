// Keyboard shortcuts for the live console's suggested-line actions. Kept pure so the mapping — and
// its guards against hijacking a text field or a browser shortcut — can be tested without a DOM.

export type HotkeyAction = "said" | "simpler" | "dismiss";

export type HotkeyInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  // Focus is in a text field or on a control, so native handling should win: don't hijack typing,
  // and let Enter activate a focused button rather than firing the shortcut on top of it.
  inControl?: boolean;
};

// Enter = Said it, R = Say it simpler, Esc = Not now. Returns null for anything that should be left
// to the browser or the field with focus.
export function resolveHotkey(e: HotkeyInput): HotkeyAction | null {
  if (e.inControl) return null;
  // Shift is not blocking (a capital "R" is fine); the others are the browser's, e.g. Ctrl+R reload.
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Enter") return "said";
  if (e.key.toLowerCase() === "r") return "simpler";
  if (e.key === "Escape") return "dismiss";
  return null;
}
