import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "system";
const KEY = "yz.theme";

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "system" ? t : "dark";
  } catch { return "dark"; }
}

/** Theme preference. Dark is the default; the choice is a per-device convenience kept in localStorage. */
export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>(read);
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  }, []);
  const cycle = useCallback(() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark"), [theme, setTheme]);
  return [theme, setTheme, cycle];
}
