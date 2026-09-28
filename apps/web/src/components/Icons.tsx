import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, ...p });

/** Inline SVG icons (no icon library). All 24-grid, stroke-based, 1.75px. */
export const Icon = {
  Overview: (p: P) => <svg {...base(p)}><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="11" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /></svg>,
  Opportunities: (p: P) => <svg {...base(p)}><path d="M3 17l5-6 4 3 5-7 4 4" /><path d="M17 7h4v4" /></svg>,
  Positions: (p: P) => <svg {...base(p)}><path d="M4 19h16" /><path d="M7 16V9" /><path d="M12 16V5" /><path d="M17 16v-6" /></svg>,
  Strategies: (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>,
  Research: (p: P) => <svg {...base(p)}><path d="M9 3h6" /><path d="M10 3v6.5L4.5 19a1.5 1.5 0 001.3 2.3h12.4a1.5 1.5 0 001.3-2.3L14 9.5V3" /><path d="M7 15h10" /></svg>,
  Backtests: (p: P) => <svg {...base(p)}><path d="M3 12a9 9 0 109-9" /><path d="M3 4v5h5" /><path d="M12 7v5l3 2" /></svg>,
  Journal: (p: P) => <svg {...base(p)}><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 00-3 3z" /><path d="M5 4v16a3 3 0 003 3" /><path d="M9 9h6M9 13h4" /></svg>,
  Learning: (p: P) => <svg {...base(p)}><path d="M12 3a6 6 0 00-3.5 10.9c.9.7 1.5 1.6 1.5 2.6V18h4v-1.5c0-1 .6-1.9 1.5-2.6A6 6 0 0012 3z" /><path d="M10 21h4" /></svg>,
  Risk: (p: P) => <svg {...base(p)}><path d="M12 3l9 16H3z" /><path d="M12 10v4" /><path d="M12 17h.01" /></svg>,
  Analytics: (p: P) => <svg {...base(p)}><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-8" /><path d="M22 20H2" /></svg>,
  Health: (p: P) => <svg {...base(p)}><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>,
  Settings: (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 01-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 012.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 012.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>,
  Compare: (p: P) => <svg {...base(p)}><rect x="3" y="5" width="7" height="14" rx="1.5" /><rect x="14" y="5" width="7" height="14" rx="1.5" /></svg>,
  Globe: (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 010 18M12 3a14 14 0 000 18" /></svg>,
  Users: (p: P) => <svg {...base(p)}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0113 0" /><path d="M16 4.5a3.5 3.5 0 010 7" /><path d="M17 13.5a6.5 6.5 0 014.5 6.5" /></svg>,
  Models: (p: P) => <svg {...base(p)}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></svg>,
  Audit: (p: P) => <svg {...base(p)}><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>,
  Help: (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4" /><path d="M12 17h.01" /></svg>,
  Jobs: (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>,
  Search: (p: P) => <svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></svg>,
  Bell: (p: P) => <svg {...base(p)}><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></svg>,
  ChevronDown: (p: P) => <svg {...base(p)}><path d="M6 9l6 6 6-6" /></svg>,
  ChevronRight: (p: P) => <svg {...base(p)}><path d="M9 6l6 6-6 6" /></svg>,
  ChevronsLeft: (p: P) => <svg {...base(p)}><path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" /></svg>,
  ChevronsRight: (p: P) => <svg {...base(p)}><path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" /></svg>,
  Close: (p: P) => <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  Sun: (p: P) => <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  Moon: (p: P) => <svg {...base(p)}><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" /></svg>,
  Monitor: (p: P) => <svg {...base(p)}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>,
  Command: (p: P) => <svg {...base(p)}><path d="M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 103 3z" /></svg>,
  Symbol: (p: P) => <svg {...base(p)}><path d="M4 14l4-4 3 3 5-6 4 4" /><path d="M4 20h16" /></svg>,
  Account: (p: P) => <svg {...base(p)}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18" /><path d="M7 15h3" /></svg>,
  Keyboard: (p: P) => <svg {...base(p)}><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></svg>,
  Check: (p: P) => <svg {...base(p)}><path d="M5 12l4 4L19 6" /></svg>,
  Sort: (p: P) => <svg {...base(p)}><path d="M8 4v16M8 4L5 7M8 4l3 3" /><path d="M16 20V4M16 20l-3-3M16 20l3-3" /></svg>,
  SortUp: (p: P) => <svg {...base(p)}><path d="M12 19V5M12 5l-5 5M12 5l5 5" /></svg>,
  SortDown: (p: P) => <svg {...base(p)}><path d="M12 5v14M12 19l-5-5M12 19l5-5" /></svg>,
  Logout: (p: P) => <svg {...base(p)}><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4" /><path d="M14 8l4 4-4 4" /><path d="M18 12H9" /></svg>,
};
export type IconName = keyof typeof Icon;
