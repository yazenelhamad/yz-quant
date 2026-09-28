import type { IconName } from "../components/Icons";

export interface NavItem { to: string; label: string; icon: IconName; /** second key of the "g <key>" chord */ key?: string; admin?: boolean }

export const NAV: NavItem[] = [
  { to: "overview", label: "Overview", icon: "Overview", key: "o" },
  { to: "opportunities", label: "Opportunities", icon: "Opportunities", key: "c" },
  { to: "positions", label: "Positions", icon: "Positions", key: "p" },
  { to: "strategies", label: "Strategies", icon: "Strategies", key: "s" },
  { to: "research", label: "Research", icon: "Research", key: "e" },
  { to: "backtests", label: "Backtests", icon: "Backtests", key: "b" },
  { to: "journal", label: "Trade Journal", icon: "Journal", key: "j" },
  { to: "learning", label: "Learning", icon: "Learning", key: "l" },
  { to: "risk", label: "Risk", icon: "Risk", key: "r" },
  { to: "analytics", label: "Analytics", icon: "Analytics", key: "a" },
  { to: "health", label: "System Health", icon: "Health", key: "h" },
  { to: "settings", label: "Settings", icon: "Settings", key: "," },
];
export const ADMIN_NAV: NavItem[] = [
  { to: "admin/comparison", label: "Comparison", icon: "Compare", admin: true },
  { to: "admin/global-risk", label: "Global Risk", icon: "Globe", admin: true },
  { to: "admin/users", label: "Users", icon: "Users", admin: true },
  { to: "admin/models", label: "Models & Agents", icon: "Models", admin: true },
  { to: "admin/audit", label: "Audit", icon: "Audit", admin: true },
  { to: "admin/jobs", label: "Jobs", icon: "Jobs", admin: true },
];

/** Page label for document.title from the path after `/a/:accountId/`. */
export function pageLabel(rest: string): string {
  const seg = rest.replace(/^\/+/, "");
  if (!seg) return "Overview";
  const pos = seg.match(/^positions\/([^/]+)$/);
  if (pos) return decodeURIComponent(pos[1]!);
  if (/^strategies\/[^/]+$/.test(seg)) return "Strategy profile";
  if (/^backtests\/[^/]+$/.test(seg)) return "Backtest";
  const hit = [...NAV, ...ADMIN_NAV].find((n) => n.to === seg);
  return hit?.label ?? "Not found";
}
