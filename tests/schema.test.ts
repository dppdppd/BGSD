import { describe, expect, it } from "vitest";
import bitSchema from "../schema/bit.schema.json";

describe("BIT schema", () => {
  it("tracks BIT 4.0.8 lid type and sliding lid options", () => {
    expect(bitSchema.version).toBe("4.0.8");

    const lidKeys = bitSchema.contexts.lid.keys;

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
      default: 1.5,
    });
  });
});
