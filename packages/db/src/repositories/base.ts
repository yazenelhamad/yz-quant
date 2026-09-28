import type { Database } from "../connection.js";

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export abstract class Repository {
  constructor(protected readonly db: Database) {}
}
