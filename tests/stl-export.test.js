import { describe, expect, it } from "vitest";
import {
  collectPrintGroups,
  createStlExportPlan,
  sanitizeFileSegment,
  scadWithPrintGroup,
} from "../lib/stl-export.js";

const SCAD_WITH_GROUPS = `// BGSD
include <../lib/boardgame_insert_toolkit_lib.4.9.0.scad>;
data = [
    [ G_PRINT_GROUP, "red" ],
    [ OBJECT_BOX,
        [ NAME, "box 1" ],
        [ PRINT_GROUP, ["red", "blue"] ],
        [ BOX_FEATURE,
            [ PRINT_GROUP, "red" ],
            [ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],
        ],
        [ BOX_LID,
            [ PRINT_GROUP, "lid/group" ],
        ],
    ],
];
Make(data);
`;

describe("STL export planning", () => {
  it("collects unique print groups from string and list values", () => {
    expect(collectPrintGroups(SCAD_WITH_GROUPS)).toEqual(["blue", "lid/group", "red"]);
  });

  it("rewrites Make calls with an explicit print group selector", () => {
    expect(scadWithPrintGroup(SCAD_WITH_GROUPS, "red")).toContain('Make(data, print_group = "red");');
    expect(scadWithPrintGroup(SCAD_WITH_GROUPS, false)).toContain("Make(data, print_group = false);");
    expect(scadWithPrintGroup(SCAD_WITH_GROUPS.replace("Make(data);", 'Make(data, print_group = "blue");'), false))
      .toContain("Make(data, print_group = false);");
  });

  it("plans one combined STL plus one STL per print group", () => {
    const plan = createStlExportPlan({
      sourcePath: "/tmp/designs/insert.scad",
      targetFilePath: "/tmp/exports/insert.stl",
      scadText: SCAD_WITH_GROUPS,
      tempToken: "abc123",
    });

    expect(plan.groups).toEqual(["blue", "lid/group", "red"]);
    expect(plan.jobs.map((job) => job.kind)).toEqual(["combined", "group", "group", "group"]);
    expect(plan.jobs.map((job) => job.filePath)).toEqual([
      "/tmp/exports/insert.stl",
      "/tmp/exports/insert - blue.stl",
      "/tmp/exports/insert - lid_group.stl",
      "/tmp/exports/insert - red.stl",
    ]);
    expect(plan.jobs[0].scadText).toContain("Make(data, print_group = false);");
    expect(plan.jobs[1].scadText).toContain('Make(data, print_group = "blue");');
  });

  it("keeps legacy single-file exports when no print groups are present", () => {
    const plan = createStlExportPlan({
      sourcePath: "/tmp/designs/insert.scad",
      targetFilePath: "/tmp/exports/insert.stl",
      scadText: "data = [\n];\nMake(data);\n",
      tempToken: "abc123",
    });

    expect(plan.groups).toEqual([]);
    expect(plan.jobs).toEqual([
      {
        kind: "combined",
        label: "all combined",
        filePath: "/tmp/exports/insert.stl",
        sourcePath: "/tmp/designs/insert.scad",
      },
    ]);
  });

  it("sanitizes group names for sibling STL filenames", () => {
    expect(sanitizeFileSegment('../red:blue*? "mix"')).toBe("red_blue_ _mix");
  });
});
