import { describe, expect, it } from "vitest";
import { recordingsDirectoryFromDataPath } from "./recording-path";

describe("recordings directory", () => {
  it("builds the configured Windows recordings path without damaging Unicode", () => {
    expect(recordingsDirectoryFromDataPath("D:\\Nightingale\\データ\\")).toBe(
      "D:\\Nightingale\\データ\\recordings",
    );
  });

  it("supports forward-slash paths and rejects missing roots", () => {
    expect(recordingsDirectoryFromDataPath("/mnt/nightingale/")).toBe(
      "/mnt/nightingale/recordings",
    );
    expect(recordingsDirectoryFromDataPath("  ")).toBeNull();
    expect(recordingsDirectoryFromDataPath(null)).toBeNull();
  });
});
