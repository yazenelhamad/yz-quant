import { monogramDataUrl, monogramLetter, NEUTRAL_BRAND, useBrandDocument } from "../lib/brand";

/**
 * Wordmark + monogram. Pre-auth pages pass no `name` and get the neutral "Quant" mark;
 * after login the signed-in user's brand name is used (never another user's).
 */
export function BrandMark({ name, tagline, page }: { name?: string | null; tagline?: string; page?: string }) {
  const brand = name?.trim() || NEUTRAL_BRAND;
  useBrandDocument(brand, page ?? null);
  return (
    <div className="brand">
      <img className="monogram" src={monogramDataUrl(monogramLetter(brand))} alt="" width={28} height={28} />
      <span className="wordmark">{brand}</span>
      {tagline && <span className="tagline">{tagline}</span>}
    </div>
  );
}
