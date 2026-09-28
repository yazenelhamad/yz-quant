import type { Order } from "../api/types";
import { Badge } from "./Badge";
import { Column, DataTable } from "./DataTable";
import { EmptyState } from "./States";
import { fmt } from "../lib/fmt";

const TERMINAL = new Set(["filled", "cancelled", "partially_filled_rest_cancelled", "rejected", "failed", "voided", "locate_failed"]);

export function OrdersTable({ orders, onCancel }: { orders: Order[]; onCancel?: (o: Order) => void }) {
  const cols: Column<Order>[] = [
    { key: "at", header: "Created", render: (o) => fmt.dateTime(o.createdAt), sortValue: (o) => o.createdAt },
    { key: "symbol", header: "Symbol", render: (o) => <strong>{o.symbol}</strong>, sortValue: (o) => o.symbol },
    { key: "side", header: "Side", render: (o) => <Badge tone={o.side === "buy" ? "accent" : "outline"}>{o.side}</Badge>, sortValue: (o) => o.side },
    { key: "type", header: "Type", render: (o) => fmt.label(o.type) },
    { key: "state", header: "State", render: (o) => <Badge tone={o.state === "filled" ? "pos" : o.state === "rejected" || o.state === "failed" ? "neg" : TERMINAL.has(o.state) ? "default" : "accent"}>{fmt.label(o.state)}</Badge>, sortValue: (o) => o.state },
    { key: "qty", header: "Qty", align: "right", render: (o) => `${fmt.qty(o.cumulativeQuantity)} / ${fmt.qty(o.quantity)}` },
    { key: "limit", header: "Limit", align: "right", render: (o) => fmt.price(o.limitPrice) },
    { key: "avg", header: "Avg fill", align: "right", render: (o) => fmt.price(o.averagePrice) },
    { key: "fees", header: "Fees", align: "right", render: (o) => fmt.money(o.fees) },
    { key: "agent", header: "Placed by", render: (o) => o.placedAgent ?? <span className="muted">—</span> },
    { key: "id", header: "Broker id", render: (o) => <code className="tiny">{o.brokerOrderId}</code> },
  ];
  if (onCancel) cols.push({ key: "actions", header: "", render: (o) => TERMINAL.has(o.state) ? null : <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); onCancel(o); }}>Cancel</button> });
  return <DataTable rows={orders} columns={cols} rowKey={(o) => o.brokerOrderId} defaultSort={{ key: "at", dir: "desc" }} compact empty={<EmptyState title="No orders" />} />;
}
