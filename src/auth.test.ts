import { describe, expect, it } from "vitest";
import { isAuthorized, resolveApiKeys } from "./auth.js";

describe("resolveApiKeys", () => {
  it("returns config keys when no env var is set", () => {
    expect(resolveApiKeys(["key-one-longer"], undefined)).toEqual(["key-one-longer"]);
  });

  it("parses comma-separated env keys, trimming whitespace and empties", () => {
    expect(resolveApiKeys(undefined, "env-key-1, env-key-2 ,,")).toEqual([
      "env-key-1",
      "env-key-2",
    ]);
  });

  it("merges config and env keys without duplicates", () => {
    expect(resolveApiKeys(["shared-key-abc"], "shared-key-abc,env-only-key")).toEqual([
      "shared-key-abc",
      "env-only-key",
    ]);
  });

  it("returns empty when nothing is configured", () => {
    expect(resolveApiKeys(undefined, undefined)).toEqual([]);
  });
});

describe("isAuthorized", () => {
  const keys = ["correct-horse-battery", "second-valid-key"];

  it("accepts a matching Bearer token", () => {
    expect(isAuthorized("Bearer correct-horse-battery", keys)).toBe(true);
    expect(isAuthorized("Bearer second-valid-key", keys)).toBe(true);
  });

  it("rejects a wrong key", () => {
    expect(isAuthorized("Bearer wrong-key-entirely", keys)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(isAuthorized(undefined, keys)).toBe(false);
    expect(isAuthorized("", keys)).toBe(false);
    expect(isAuthorized("Bearer ", keys)).toBe(false);
    expect(isAuthorized("Basic correct-horse-battery", keys)).toBe(false);
    expect(isAuthorized("correct-horse-battery", keys)).toBe(false);
  });

  it("rejects everything when no keys are configured", () => {
    expect(isAuthorized("Bearer anything", [])).toBe(false);
  });
});
