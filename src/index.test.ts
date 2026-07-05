import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WARDEN_VERSION } from "./index.js";

describe("scaffold", () => {
  it("exports the version from package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(WARDEN_VERSION).toBe(pkg.version);
  });
});
