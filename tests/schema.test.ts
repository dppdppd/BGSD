import { describe, expect, it } from "vitest";
import bitSchema from "../schema/bit.schema.json";

describe("BIT schema", () => {
  it("tracks BIT 4.4.0 lid, divider, shape-axis, and validation options", () => {
    expect(bitSchema.version).toBe("4.4.0");

    const lidKeys = bitSchema.contexts.lid.keys;
    const featureKeys = bitSchema.contexts.feature.keys;
    const featureDividerKeys = bitSchema.contexts.feature_divider.keys;
    const dividerKeys = bitSchema.contexts.divider.keys;
    const globals = bitSchema.globals;

    expect(lidKeys.LID_TYPE).toMatchObject({
      type: "enum",
      values: ["LID_CAP", "LID_INSET", "LID_SLIDING"],
      default: "LID_CAP",
    });
    expect(lidKeys.LID_SLIDE_SIDE).toMatchObject({
      type: "enum",
      values: ["FRONT", "BACK", "LEFT", "RIGHT"],
      default: "FRONT",
    });
    expect(lidKeys.LID_FRAME_WIDTH).toMatchObject({
      type: "number",
      default: 2.0,
    });

    expect(featureKeys.FTR_DIVIDERS).toMatchObject({
      type: "table",
      child_context: "feature_divider",
    });
    expect(featureKeys.FTR_SHAPE_AXIS).toMatchObject({
      type: "enum",
      values: ["X", "Y"],
      default: "Y",
    });
    expect(featureKeys.FTR_SHAPE_ROTATED_B).toBeUndefined();
    expect(featureDividerKeys.DIV_LAYOUT_BAYS).toMatchObject({
      type: "number",
      default: 0,
    });
    expect(featureDividerKeys.DIV_LAYOUT_BAY_SIZE).toMatchObject({
      type: "number",
      default: 0,
    });
    expect(featureDividerKeys.DIV_AXIS).toMatchObject({
      type: "enum",
      values: ["X", "Y"],
      default: "X",
    });
    expect(featureDividerKeys.DIV_RAIL_SIZE_XYZ).toMatchObject({
      type: "xyz_or_false",
      default: false,
    });
    expect(featureDividerKeys.DIV_RAIL_SIZE_XYZ.help).toContain("MAX");
    expect(featureDividerKeys.DIV_NO_RAILS_B).toMatchObject({
      type: "bool",
      default: false,
    });
    expect(featureDividerKeys.DIV_OUTPUT_ONLY_B).toMatchObject({
      type: "bool",
      default: false,
    });
    expect(featureDividerKeys.DIV_NUM_DIVIDERS).toBeUndefined();
    expect(featureDividerKeys.DIV_SLOT_DEPTH).toBeUndefined();
    expect(featureDividerKeys.DIV_RAILS_B).toBeUndefined();
    expect(featureDividerKeys.DIV_FRAME_SIZE_XY).toBeUndefined();
    expect(dividerKeys.DIV_FRAME_SIZE_XY).toMatchObject({
      type: "xy",
      default: [80, 80],
    });
    expect(dividerKeys.DIV_OUTPUT_ONLY_B).toMatchObject({
      type: "bool",
      default: false,
    });

    expect(globals.G_PRINT_DIVIDERS).toMatchObject({
      type: "bool_string_list",
      default: true,
    });
    expect(globals.G_PRINT_DIVIDERS_ONLY_B).toMatchObject({
      type: "bool",
      default: false,
    });
    expect(globals.G_VALIDATE_PHYSICAL_B).toMatchObject({
      type: "bool",
      default: true,
    });
    expect(globals.G_WALL_THICKNESS).toMatchObject({
      type: "number",
      default: 2.0,
    });
    expect(globals.G_LID_THICKNESS).toMatchObject({
      type: "number_or_false",
      default: false,
    });
  });
});
