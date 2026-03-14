import { describe, it, expect } from "vitest";
import { formatKvValue } from "../src/lib/stores/project";

describe("formatKvValue", () => {
  it("formats true as 'true'", () => {
    expect(formatKvValue(true)).toBe("true");
  });

  it("formats false as 'false'", () => {
    expect(formatKvValue(false)).toBe("false");
  });

  it("formats integers", () => {
    expect(formatKvValue(42)).toBe("42");
  });

  it("formats floats", () => {
    expect(formatKvValue(3.14)).toBe("3.14");
  });

  it("formats zero", () => {
    expect(formatKvValue(0)).toBe("0");
  });

  it("quotes plain strings", () => {
    expect(formatKvValue("hello world")).toBe('"hello world"');
  });

  it("leaves ALL_CAPS identifiers unquoted", () => {
    expect(formatKvValue("SQUARE")).toBe("SQUARE");
    expect(formatKvValue("OBJECT_BOX")).toBe("OBJECT_BOX");
    expect(formatKvValue("HEX2")).toBe("HEX2");
  });

  it("leaves $-prefixed OpenSCAD vars unquoted", () => {
    expect(formatKvValue("$fn")).toBe("$fn");
  });

  it("formats flat arrays with brackets", () => {
    expect(formatKvValue([10, 20, 30])).toBe("[10, 20, 30]");
  });

  it("formats arrays with mixed types", () => {
    expect(formatKvValue([true, false, true, false])).toBe("[true, false, true, false]");
  });

  it("formats nested arrays", () => {
    expect(formatKvValue([[1, 2], [3, 4]])).toBe("[[1, 2], [3, 4]]");
  });

  it("formats string arrays with quotes", () => {
    expect(formatKvValue(["hello", "world"])).toBe('["hello", "world"]');
  });

  it("formats empty string with quotes", () => {
    expect(formatKvValue("")).toBe('""');
  });
});
