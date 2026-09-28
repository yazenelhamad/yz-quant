import type { ReactNode } from "react";

export function Panel({ title, actions, children, flush, foot, className }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; foot?: ReactNode; className?: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <header className="panel-head">
          {typeof title === "string" ? <h2>{title}</h2> : <div>{title}</div>}
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      <div className={`panel-body ${flush ? "flush" : ""}`}>{children}</div>
      {foot && <footer className="panel-foot">{foot}</footer>}
    </section>
  );
}
