import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icons";
import { EmptyState } from "./States";

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  /** Value used for sorting; when omitted the column is not sortable. */
  sortValue?: (row: T) => number | string | null | undefined;
  align?: "left" | "right" | "center";
  width?: number | string;
  wrap?: boolean;
  title?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  onRowClick?: (row: T) => void;
  /** When provided rows get an expander and this renders below the row. */
  renderExpanded?: (row: T) => ReactNode;
  empty?: ReactNode;
  compact?: boolean;
  rowClass?: (row: T) => string | undefined;
  maxHeight?: number;
}

function compare(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const bn = b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (an && bn) return 0;
  if (an) return 1; // nulls last regardless of direction
  if (bn) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Dense, sortable table: sticky header, hairline rows, right-aligned mono numerals, chevron expanders,
 * explicit sort indicators. Sorting is client-side; null values always sort last.
 */
export function DataTable<T>({ rows, columns, rowKey, defaultSort, onRowClick, renderExpanded, empty, compact, rowClass, maxHeight }: DataTableProps<T>) {
  const [sort, setSort] = useState(defaultSort ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const out = rows.map((r, i) => ({ r, i, v: sv(r) }));
    out.sort((x, y) => {
      const nx = x.v === null || x.v === undefined;
      const ny = y.v === null || y.v === undefined;
      if (nx || ny) return compare(x.v, y.v) || x.i - y.i;
      const c = compare(x.v, y.v);
      return (sort.dir === "asc" ? c : -c) || x.i - y.i;
    });
    return out.map((o) => o.r);
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  };
  const toggleExpand = (k: string) => {
    setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  };

  if (rows.length === 0) return <>{empty ?? <EmptyState />}</>;

  const colSpan = columns.length + (renderExpanded ? 1 : 0);
  return (
    <div className="table-wrap" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>
      <table className={`data ${compact ? "compact" : ""}`}>
        <thead>
          <tr>
            {renderExpanded && <th style={{ width: 28 }} aria-label="Expand" />}
            {columns.map((c) => {
              const sortable = Boolean(c.sortValue);
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  className={`${c.align === "right" ? "num" : ""} ${sortable ? "sortable" : ""}`}
                  style={{ width: c.width, textAlign: c.align }}
                  onClick={sortable ? () => toggleSort(c.key) : undefined}
                  onKeyDown={sortable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(c.key); } } : undefined}
                  tabIndex={sortable ? 0 : undefined}
                  aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined}
                  title={c.title}
                >
                  {c.header}
                  {sortable && (
                    <span className="sort-ind" aria-hidden>
                      {active ? (sort?.dir === "asc" ? <Icon.SortUp /> : <Icon.SortDown />) : <Icon.Sort />}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const k = rowKey(row);
            const isOpen = expanded.has(k);
            return (
              <FragmentRow key={k}>
                <tr
                  className={`${onRowClick ? "clickable" : renderExpanded ? "clickable" : ""} ${isOpen ? "expanded" : ""} ${rowClass?.(row) ?? ""}`}
                  onClick={onRowClick ? () => onRowClick(row) : renderExpanded ? () => toggleExpand(k) : undefined}
                >
                  {renderExpanded && (
                    <td>
                      <button className="expander" aria-expanded={isOpen} aria-label={isOpen ? "Collapse row" : "Expand row"} onClick={(e) => { e.stopPropagation(); toggleExpand(k); }}>
                        <Icon.ChevronRight />
                      </button>
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={`${c.align === "right" ? "num" : ""} ${c.wrap ? "wrap" : ""}`} style={{ textAlign: c.align }}>
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
                {renderExpanded && isOpen && (
                  <tr className="expansion"><td colSpan={colSpan}>{renderExpanded(row)}</td></tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
