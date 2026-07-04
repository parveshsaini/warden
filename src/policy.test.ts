import { describe, expect, it } from "vitest";
import { evaluatePolicy, matchesPattern } from "./policy.js";

describe("matchesPattern", () => {
  it("matches exact names and * wildcards", () => {
    expect(matchesPattern("fs__read_file", "fs__read_file")).toBe(true);
    expect(matchesPattern("fs__*", "fs__read_file")).toBe(true);
    expect(matchesPattern("*__delete_*", "fs__delete_file")).toBe(true);
    expect(matchesPattern("fs__*", "everything__echo")).toBe(false);
  });

  it("treats regex metacharacters in patterns literally", () => {
    expect(matchesPattern("a.b", "a.b")).toBe(true);
    expect(matchesPattern("a.b", "axb")).toBe(false);
  });
});

describe("evaluatePolicy", () => {
  it("falls back to the default action when no rule matches", () => {
    expect(
      evaluatePolicy({ defaultAction: "allow", rules: [] }, { tool: "fs__read_file" }).action,
    ).toBe("allow");
    expect(
      evaluatePolicy({ defaultAction: "deny", rules: [] }, { tool: "fs__read_file" }).action,
    ).toBe("deny");
  });

  it("applies the first matching rule", () => {
    const policy = {
      defaultAction: "deny" as const,
      rules: [
        { action: "allow" as const, tools: ["fs__read_*"] },
        { action: "deny" as const, tools: ["fs__*"] },
      ],
    };
    expect(evaluatePolicy(policy, { tool: "fs__read_file" }).action).toBe("allow");
    expect(evaluatePolicy(policy, { tool: "fs__write_file" }).action).toBe("deny");
    expect(evaluatePolicy(policy, { tool: "everything__echo" }).action).toBe("deny");
  });

  it("only matches client-scoped rules when the client name is known", () => {
    const policy = {
      defaultAction: "allow" as const,
      rules: [{ action: "deny" as const, tools: ["fs__*"], clients: ["cursor*"] }],
    };
    expect(evaluatePolicy(policy, { tool: "fs__read_file", client: "cursor" }).action).toBe("deny");
    expect(evaluatePolicy(policy, { tool: "fs__read_file", client: "claude" }).action).toBe(
      "allow",
    );
    expect(evaluatePolicy(policy, { tool: "fs__read_file" }).action).toBe("allow");
  });
});
