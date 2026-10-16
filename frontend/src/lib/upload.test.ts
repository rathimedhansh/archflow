import { describe, expect, it } from "vitest";
import { formatBytes, MAX_UPLOAD_MB, validateFloorPlanFile } from "./upload";

const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe("validateFloorPlanFile", () => {
  it("accepts PNG and JPG", () => {
    expect(validateFloorPlanFile(file("a.png", "image/png"))).toBeNull();
    expect(validateFloorPlanFile(file("a.JPG", "image/jpeg"))).toBeNull();
    expect(validateFloorPlanFile(file("a.jpeg", "image/jpeg"))).toBeNull();
  });

  it("rejects other types", () => {
    expect(validateFloorPlanFile(file("a.pdf", "application/pdf"))).toMatch(/PNG or JPG/);
    expect(validateFloorPlanFile(file("a.gif", "image/gif"))).toMatch(/PNG or JPG/);
  });

  it("rejects a mismatched extension", () => {
    expect(validateFloorPlanFile(file("a.exe", "image/png"))).toMatch(/PNG or JPG/);
  });

  it("rejects empty and oversized files", () => {
    expect(validateFloorPlanFile(file("a.png", "image/png", 0))).toMatch(/empty/);
    const big = (MAX_UPLOAD_MB + 1) * 1024 * 1024;
    expect(validateFloorPlanFile(file("a.png", "image/png", big))).toMatch(/too large/);
  });
});

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
