import { describe, expect, it } from "vitest";
import bitSchema from "../schema/bit.schema.json";

describe("BIT schema", () => {
  it("tracks BIT 4.11.0 print selectors, feature groups/copies, lid, divider, shape-axis, and validation options", () => {
    expect(bitSchema.version).toBe("4.11.0");

    const elementKeys = bitSchema.contexts.element.keys;
    const lidKeys = bitSchema.contexts.lid.keys;
    const featureKeys = bitSchema.contexts.feature.keys;
    const groupKeys = bitSchema.contexts.group.keys;
    const visualizationKeys = bitSchema.contexts.visualization.keys;
    const featureDividerKeys = bitSchema.contexts.feature_divider.keys;
    const dividerKeys = bitSchema.contexts.divider.keys;
    const globals = bitSchema.globals;

    expect(elementKeys.FEATURE_GROUP).toMatchObject({
      type: "table_list",
      child_context: "group",
    });
    expect(elementKeys.FEATURE_COPY).toMatchObject({
      type: "table_list",
      child_context: "copy",
    });
    expect(elementKeys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });
    expect(elementKeys.BOX_GROUP).toBeUndefined();
    expect(elementKeys.BOX_VISUALIZATION).toMatchObject({
      type: "table",
      child_context: "visualization",
    });
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
    expect(lidKeys.LID_DETENT_LOCK_ANGLE).toMatchObject({
      type: "number",
      default: 45,
    });
    expect(lidKeys.LID_FRAME_WIDTH).toMatchObject({
      type: "number",
      default: 2.0,
    });
    expect(lidKeys.ENABLED_B).toMatchObject({
      type: "bool",
      default: true,
    });

    expect(featureKeys.FTR_DIVIDERS).toMatchObject({
      type: "table",
      child_context: "feature_divider",
    });
    expect(featureKeys.BOX_FEATURE).toMatchObject({
      type: "table_list",
      child_context: "feature",
    });
    expect(featureKeys.FEATURE_GROUP).toMatchObject({
      type: "table_list",
      child_context: "group",
    });
    expect(featureKeys.FEATURE_COPY).toMatchObject({
      type: "table_list",
      child_context: "copy",
    });
    expect(featureKeys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });
    expect(featureKeys.BOX_GROUP).toBeUndefined();
    expect(featureKeys.FTR_SHAPE_AXIS).toMatchObject({
      type: "enum",
      values: ["X", "Y"],
      default: "Y",
    });
    expect(featureKeys.FTR_SHAPE_ROTATED_B).toBeUndefined();
    expect(groupKeys.BOX_FEATURE).toMatchObject({
      type: "table_list",
      child_context: "feature",
    });
    expect(groupKeys.FEATURE_GROUP).toMatchObject({
      type: "table_list",
      child_context: "group",
    });
    expect(groupKeys.FEATURE_COPY).toMatchObject({
      type: "table_list",
      child_context: "copy",
    });
    expect(groupKeys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });
    expect(groupKeys.BOX_GROUP).toBeUndefined();
    expect(bitSchema.contexts.copy.keys.FEATURE_REFERENCE).toMatchObject({
      type: "string",
      default: "",
    });
    expect(bitSchema.contexts.copy.keys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });
    expect(groupKeys.POSITION_XY).toMatchObject({
      type: "xy",
      default: [0, 0],
    });
    expect(visualizationKeys.POSITION_XY).toMatchObject({
      type: "xy",
      default: [0, 0],
    });
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
    expect(featureDividerKeys.DIV_OUTPUT_ONLY_B).toBeUndefined();
    expect(featureDividerKeys.DIV_NUM_DIVIDERS).toBeUndefined();
    expect(featureDividerKeys.DIV_SLOT_DEPTH).toBeUndefined();
    expect(featureDividerKeys.DIV_RAILS_B).toBeUndefined();
    expect(featureDividerKeys.DIV_FRAME_SIZE_XY).toBeUndefined();
    expect(dividerKeys.DIV_FRAME_SIZE_XY).toMatchObject({
      type: "xy",
      default: [80, 80],
    });
    expect(dividerKeys.DIV_OUTPUT_ONLY_B).toBeUndefined();
    expect(dividerKeys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });
    expect(lidKeys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });
    expect(bitSchema.contexts.label.keys.PRINT_GROUP).toMatchObject({
      type: "bool_string_list",
      default: "",
    });

    expect(globals.G_PRINT_TYPES).toMatchObject({
      type: "string_list",
      default: [],
    });
    expect(globals.G_PRINT_GROUPS).toMatchObject({
      type: "string_list",
      default: [],
    });
    expect(globals.G_PRINT_BOXES).toMatchObject({
      type: "string_list",
      default: [],
    });
    expect(globals.G_PRINT_LID_B).toBeUndefined();
    expect(globals.G_PRINT_BOX_B).toBeUndefined();
    expect(globals.G_PRINT_GROUP).toBeUndefined();
    expect(globals.G_PRINT_DIVIDERS).toBeUndefined();
    expect(globals.G_PRINT_DIVIDERS_ONLY_B).toBeUndefined();
    expect(globals.G_ISOLATED_PRINT_BOX).toBeUndefined();
    expect(globals.G_VALIDATE_PHYSICAL_B).toBeUndefined();
    expect(globals[["G_PRINT", "MMU", "LAYER"].join("_")]).toBeUndefined();
    expect(globals.G_VALIDATE_KEYS_B.help).toContain("physical");
    expect(globals.G_WALL_THICKNESS).toMatchObject({
      type: "number",
      default: 2.0,
    });
    expect(globals.G_DETENT_THICKNESS).toMatchObject({
      type: "number",
      default: 0.8,
    });
    expect(globals.G_LID_THICKNESS).toMatchObject({
      type: "number_or_false",
      default: false,
    });
  });
});
