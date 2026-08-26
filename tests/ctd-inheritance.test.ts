import { describe, expect, it } from "vitest";
import type { Line } from "../src/lib/stores/project";
import { resolveCtdInheritedValue } from "../src/lib/ctd-inheritance";

const lines: Line[] = [
  { raw: "scene_1 = [", kind: "open", depth: 0, role: "data", label: "scene_1" },
  { raw: "    [ G_DIMENSIONS_XY, [120, 90] ],", kind: "kv", depth: 1, kvKey: "G_DIMENSIONS_XY", kvValue: [120, 90] },
  { raw: "    [ COUNTER_SHAPE, SHAPE_HEX ],", kind: "kv", depth: 1, kvKey: "COUNTER_SHAPE", kvValue: "SHAPE_HEX" },
  { raw: "    [ TRAY,", kind: "open", depth: 1, role: "object", label: "TRAY" },
  {
    raw: "        [ COUNTER_SHAPE, SHAPE_CIRCLE ],",
    kind: "kv",
    depth: 2,
    kvKey: "COUNTER_SHAPE",
    kvValue: "SHAPE_CIRCLE",
  },
  { raw: "        [ COUNTER_SET,", kind: "open", depth: 2, role: "counter_set", label: "COUNTER_SET" },
  {
    raw: "            [ COUNTER_SIZE_XYZ, [13, 13, 3] ],",
    kind: "kv",
    depth: 3,
    kvKey: "COUNTER_SIZE_XYZ",
    kvValue: [13, 13, 3],
  },
  { raw: "        ],", kind: "close", depth: 2, role: "counter_set", label: "COUNTER_SET" },
  { raw: "    ],", kind: "close", depth: 1, role: "object", label: "TRAY" },
  { raw: "];", kind: "close", depth: 0, role: "data", label: "scene_1" },
];

describe("CTD inherited parameter values", () => {
  it("uses a scene value as the fallback for a virtual tray parameter", () => {
    expect(resolveCtdInheritedValue(lines, 3, "G_DIMENSIONS_XY", [50, 50])).toEqual({
      value: [120, 90],
      source: "Scene",
    });
  });

  it("uses the nearest tray value before the scene value for a counter set", () => {
    expect(resolveCtdInheritedValue(lines, 5, "COUNTER_SHAPE", "SHAPE_SQUARE")).toEqual({
      value: "SHAPE_CIRCLE",
      source: "Tray",
    });
  });

  it("falls through to the scene value when the tray has no matching value", () => {
    expect(resolveCtdInheritedValue(lines, 5, "G_DIMENSIONS_XY", [50, 50])).toEqual({
      value: [120, 90],
      source: "Scene",
    });
  });

  it("uses the schema default when no ancestor sets the key", () => {
    expect(resolveCtdInheritedValue(lines, 5, "COUNTER_HOLE_FRACTION_N", 0.7)).toEqual({
      value: 0.7,
      source: null,
    });
  });
});
