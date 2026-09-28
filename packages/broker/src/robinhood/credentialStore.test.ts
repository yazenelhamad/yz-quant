import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EncryptedCredentialCodec, EncryptedCredentialStore, InMemoryCredentialStore, InMemoryEnvelopeStore, openEnvelope, parseEnvelope, parseMasterKey, rotateEnvelope, scopeAad, sealEnvelope } from "./credentialStore.js";
import { SCOPE_A, SCOPE_B } from "../testing/fixtures.js";

const cred = { client_id: "c1", access_token: "at", refresh_token: "rt", expires_at: 1_700_000_000 };
const k1 = new Uint8Array(randomBytes(32));
const k2 = new Uint8Array(randomBytes(32));

describe("EncryptedCredentialCodec", () => {
  it("round-trips with a versioned v1 envelope", () => {
    const codec = new EncryptedCredentialCodec({ version: "k1", key: k1 });
    const env = codec.encrypt(cred);
    expect(env.startsWith("v1:k1:")).toBe(true);
    expect(env.split(":")).toHaveLength(5);
    expect(env).not.toContain("at");
    expect(codec.decrypt(env)).toEqual(cred);
    const parsed = parseEnvelope(env);
    expect(parsed.iv.byteLength).toBe(12);
    expect(parsed.tag.byteLength).toBe(16);
  });
  it("detects tampering and wrong keys", () => {
    const codec = new EncryptedCredentialCodec({ version: "k1", key: k1 });
    const env = codec.encrypt(cred);
    const parts = env.split(":");
    parts[4] = Buffer.from(Buffer.from(parts[4] as string, "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url");
    expect(() => codec.decrypt(parts.join(":"))).toThrow(/authentication failed/);
    expect(() => new EncryptedCredentialCodec({ version: "k1", key: k2 }).decrypt(env)).toThrow();
    expect(() => new EncryptedCredentialCodec({ version: "k9", key: k1 }).decrypt(env)).toThrow(/no key for envelope key version k1/);
  });
  it("binds envelopes to the tenant scope via AAD", () => {
    const codec = new EncryptedCredentialCodec({ version: "k1", key: k1 });
    const env = codec.encrypt(cred, scopeAad(SCOPE_A));
    expect(codec.decrypt(env, scopeAad(SCOPE_A))).toEqual(cred);
    expect(() => codec.decrypt(env, scopeAad(SCOPE_B))).toThrow(/authentication failed/);
  });
  it("rotates to a new key version and still opens old envelopes with a key ring", () => {
    const oldEnv = sealEnvelope(JSON.stringify(cred), { version: "k1", key: k1 }, "aad");
    const newEnv = rotateEnvelope(oldEnv, { version: "k1", key: k1 }, { version: "k2", key: k2 }, "aad");
    expect(newEnv.startsWith("v1:k2:")).toBe(true);
    expect(JSON.parse(openEnvelope(newEnv, { version: "k2", key: k2 }, "aad"))).toEqual(cred);
    expect(() => openEnvelope(newEnv, { version: "k1", key: k1 }, "aad")).toThrow(/key version/);
    const ring = new EncryptedCredentialCodec({ currentVersion: "k2", keys: { k1, k2 } });
    expect(ring.needsRotation(oldEnv)).toBe(true);
    expect(ring.decrypt(oldEnv, "aad")).toEqual(cred);
    const rotated = ring.rotate(oldEnv, "aad");
    expect(ring.needsRotation(rotated)).toBe(false);
    expect(ring.decrypt(rotated, "aad")).toEqual(cred);
  });
  it("parses master keys and rejects bad sizes", () => {
    expect(parseMasterKey(Buffer.from(k1).toString("base64"))).toEqual(k1);
    expect(parseMasterKey(Buffer.from(k1).toString("hex"))).toEqual(k1);
    expect(() => parseMasterKey("short")).toThrow(/32 bytes/);
    expect(() => parseMasterKey("")).toThrow(/not set/);
    expect(() => new EncryptedCredentialCodec(new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe("credential stores", () => {
  it("EncryptedCredentialStore keeps scopes apart and stores only envelopes", async () => {
    const envelopes = new InMemoryEnvelopeStore();
    const store = new EncryptedCredentialStore(envelopes, new EncryptedCredentialCodec({ version: "k1", key: k1 }));
    await store.save(SCOPE_A, cred);
    expect(await store.load(SCOPE_A)).toEqual(cred);
    expect(await store.load(SCOPE_B)).toBeNull();
    for (const row of envelopes.rows.values()) expect(row).not.toContain("rt");
    // an envelope moved from A's row to B's row cannot be opened under B
    envelopes.rows.set(`${SCOPE_B.userId}\u0000${SCOPE_B.brokerAccountId}`, envelopes.rows.get(`${SCOPE_A.userId}\u0000${SCOPE_A.brokerAccountId}`) as string);
    await expect(store.load(SCOPE_B)).rejects.toThrow(/authentication failed/);
    await store.delete(SCOPE_A);
    expect(await store.load(SCOPE_A)).toBeNull();
  });
  it("InMemoryCredentialStore round-trips (optionally encrypted)", async () => {
    for (const store of [new InMemoryCredentialStore(), new InMemoryCredentialStore(new EncryptedCredentialCodec(k1))]) {
      await store.save(SCOPE_A, cred);
      expect(await store.load(SCOPE_A)).toEqual(cred);
      expect(await store.load(SCOPE_B)).toBeNull();
      await expect(store.save(SCOPE_A, { bogus: true } as never)).rejects.toThrow();
    }
  });
});
