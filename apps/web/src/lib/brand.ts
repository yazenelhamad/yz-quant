import { useEffect } from "react";

/** Neutral product name shown before sign-in. Never a user's brand. */
export const NEUTRAL_BRAND = "Quant";

/** First letter of the brand, upper-cased ("Elhamad's Quant" → "E"). Falls back to "Q". */
export function monogramLetter(brand: string | null | undefined): string {
  const m = (brand ?? "").trim().match(/[\p{L}\p{N}]/u);
  return (m?.[0] ?? "Q").toUpperCase();
}

/**
 * Inline SVG monogram as a data URL: rounded square in the accent hue with the letter.
 * Used for the favicon and the top-bar mark so the tab and the shell agree.
 */
export function monogramDataUrl(letter: string, opts: { bg?: string; fg?: string } = {}): string {
  const bg = opts.bg ?? "#3987e5";
  const fg = opts.fg ?? "#ffffff";
  const l = letter.slice(0, 1).replace(/[<>&"']/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="32" y="43" text-anchor="middle" font-family="Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" font-size="36" font-weight="700" fill="${fg}">${l}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = href;
}

/** Sets `document.title` to "<brand> — <page>" and the monogram favicon. */
export function useBrandDocument(brand: string, page: string | null) {
  useEffect(() => {
    document.title = page ? `${brand} — ${page}` : brand;
  }, [brand, page]);
  useEffect(() => {
    setFavicon(monogramDataUrl(monogramLetter(brand)));
  }, [brand]);
}
