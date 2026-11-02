import type { Action } from "@cu/virtual-screen";

const KEYSYM: Record<string, string> = {
  Ctrl: "ctrl",
  Alt: "alt",
  Shift: "shift",
  Meta: "super",
  Enter: "Return",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "BackSpace",
  Space: "space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/**
 * xdotool argument vectors for one action (one process per vector, with a
 * short pause between them). A click hovers first: toolkits such as Blender's
 * only arm a button after it has seen the pointer arrive.
 */
export function xdotool(a: Action): string[][] {
  if (a.kind === "click")
    return [
      ["mousemove", "--sync", String(a.x), String(a.y)],
      ["click", "1"],
    ];
  if (a.kind === "type_text") return [["type", "--delay", "15", "--", a.text]];
  const combo = a.keys.map((k) => KEYSYM[k] ?? k.toLowerCase()).join("+");
  return [["key", "--clearmodifiers", combo]];
}
