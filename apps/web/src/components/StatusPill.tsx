import type { BrokerConnectionStatus, HealthStatus } from "../api/types";
import { fmt } from "../lib/fmt";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export function StatusPill({ tone, children, dot = true, title }: { tone: Tone; children: React.ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={`pill ${tone}`} title={title}>
      {dot && <span className="dot" aria-hidden />}
      {children}
    </span>
  );
}

export function brokerTone(status: BrokerConnectionStatus | null | undefined): Tone {
  switch (status) {
    case "connected": return "ok";
    case "connecting": return "info";
    case "unreliable": case "token_expired": return "warn";
    case "error": case "revoked": return "bad";
    case "not_connected": default: return "neutral";
  }
}

export function brokerText(status: BrokerConnectionStatus | null | undefined, kind?: "robinhood_agentic" | "simulated"): string {
  if (kind === "simulated") return "Simulated — no broker";
  switch (status) {
    case "connected": return "Robinhood: connected";
    case "connecting": return "Robinhood: connecting";
    case "token_expired": return "Robinhood: token expired";
    case "unreliable": return "Robinhood: unreliable";
    case "revoked": return "Robinhood: access revoked";
    case "error": return "Robinhood: error";
    case "not_connected": return "Robinhood: not connected";
    default: return "Robinhood: status unknown";
  }
}

export function healthTone(status: HealthStatus | null | undefined): Tone {
  switch (status) {
    case "healthy": return "ok";
    case "warning": return "warn";
    case "critical": return "bad";
    default: return "neutral";
  }
}

export function freshnessTone(f: string | null | undefined): Tone {
  switch (f) {
    case "fresh": return "ok";
    case "aging": return "warn";
    case "stale": return "bad";
    default: return "neutral";
  }
}

export function HealthPill({ status }: { status: HealthStatus | null | undefined }) {
  return <StatusPill tone={healthTone(status)}>{status ? fmt.label(status) : "Unknown"}</StatusPill>;
}
