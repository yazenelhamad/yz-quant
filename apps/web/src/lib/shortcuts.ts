import { useEffect, useRef } from "react";

/** True when the key event originated in a text-editing control (shortcuts must not fire). */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export interface ShortcutMap {
  /** Two-key chords like "g o". Fired when the sequence completes within 900ms. */
  chords?: Record<string, () => void>;
  /** Single plain keys (no modifiers) like "?" or "\\". */
  keys?: Record<string, () => void>;
  /** Modifier combos like "mod+k" (mod = Cmd on macOS, Ctrl elsewhere). */
  combos?: Record<string, () => void>;
}

/**
 * Global keyboard shortcuts. Plain keys and chords are ignored while typing in a field;
 * modifier combos always fire (they are meant to work from anywhere, e.g. ⌘K).
 */
export function useShortcuts(map: ShortcutMap, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  const pending = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const m = ref.current;
      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        const combo = `mod+${e.key.toLowerCase()}`;
        const fn = m.combos?.[combo];
        if (fn) { e.preventDefault(); fn(); }
        return;
      }
      if (e.altKey || isEditable(e.target)) return;
      const key = e.key;
      const now = Date.now();
      const p = pending.current;
      if (p && now - p.at < 900) {
        pending.current = null;
        const fn = m.chords?.[`${p.key} ${key.toLowerCase()}`];
        if (fn) { e.preventDefault(); fn(); return; }
      }
      const chordStarters = new Set(Object.keys(m.chords ?? {}).map((k) => k.split(" ")[0]!));
      if (chordStarters.has(key.toLowerCase()) && !e.shiftKey) { pending.current = { key: key.toLowerCase(), at: now }; return; }
      const single = m.keys?.[key];
      if (single) { e.preventDefault(); single(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";
