import { describe, expect, it } from "vitest";
import { WARDEN_VERSION } from "./index.js";

describe("scaffold", () => {
  it("exports the package version", () => {
    expect(WARDEN_VERSION).toBe("0.0.1");
  });
});
