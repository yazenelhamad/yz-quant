import { text, timestamp } from "drizzle-orm/pg-core";

export const id = (name = "id") => text(name).primaryKey();
export const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull().defaultNow();
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Columns that every trading-related table must carry. */
export const tenantColumns = () => ({
  userId: text("user_id").notNull(),
  brokerAccountId: text("broker_account_id").notNull(),
});
