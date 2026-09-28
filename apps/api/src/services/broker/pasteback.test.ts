import { describe, expect, it } from "vitest";
import { loopbackRedirectUri, parsePastedRedirect } from "./pasteback.js";

describe("parsePastedRedirect", () => {
  it("reads code and state from a full loopback URL, a query string, or a bare code", () => {
    expect(parsePastedRedirect("http://127.0.0.1:51337/callback?code=abc123&state=st-1")).toMatchObject({ code: "abc123", state: "st-1", error: null });
    expect(parsePastedRedirect("  code=abc123&state=st-1 ")).toMatchObject({ code: "abc123", state: "st-1" });
    expect(parsePastedRedirect("?code=abc123")).toMatchObject({ code: "abc123", state: null });
    expect(parsePastedRedirect("abcDEF123-_~.xyz")).toMatchObject({ code: "abcDEF123-_~.xyz", state: null });
  });
  it("surfaces provider errors and rejects junk", () => {
    expect(parsePastedRedirect("http://127.0.0.1:51337/callback?error=access_denied&error_description=User%20cancelled")).toMatchObject({ code: null, error: "access_denied", errorDescription: "User cancelled" });
    expect(parsePastedRedirect("")).toMatchObject({ code: null, state: null, error: null });
    expect(parsePastedRedirect("hello world")).toMatchObject({ code: null });
    expect(parsePastedRedirect("https://robinhood.com/oauth/error")).toMatchObject({ code: null, error: null });
  });
  it("builds the loopback redirect", () => {
    expect(loopbackRedirectUri(51337)).toBe("http://127.0.0.1:51337/callback");
  });
});
