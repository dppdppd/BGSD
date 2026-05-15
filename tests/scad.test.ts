import { describe, it, expect } from "vitest";
import { generateScad, generateScadWithSourceMap } from "../src/lib/scad";
import { importScad } from "../importer.js";
import type { Project } from "../src/lib/stores/project";

function makeProject(lines: any[]): Project {
  return { version: 1, lines };
}

describe("generateScad", () => {
  it("generates output from marker + include + data + make", () => {
    const project = makeProject([
      { raw: "// BGSD", kind: "marker", depth: 0 },
      { raw: "include <boardgame_insert_toolkit_lib.4.scad>;", kind: "include", depth: 0 },
      { raw: "data = [", kind: "open", depth: 0, role: "data" },
      { raw: "];", kind: "close", depth: 0, role: "data" },
      { raw: "Make(data);", kind: "makeall", depth: 0, varName: "data" },
    ]);
    const output = generateScad(project);
    expect(output).toContain("// BGSD");
    expect(output).toContain("include <boardgame_insert_toolkit_lib.4.scad>;");
    expect(output).toContain("Make(data);");
  });

  it("emits makeall with custom variable name", () => {
    const project = makeProject([
      { raw: "Make(scene_1);", kind: "makeall", depth: 0, varName: "scene_1" },
    ]);
    const output = generateScad(project);
    expect(output).toBe("Make(scene_1);");
  });

  it("emits boolean globals", () => {
    const project = makeProject([
      { raw: "    [ G_FIT_TEST_B, true ],", kind: "global", depth: 1, globalKey: "G_FIT_TEST_B", globalValue: true },
    ]);
    const output = generateScad(project);
    expect(output).toContain("G_FIT_TEST_B, true");
  });

  it("emits number globals", () => {
    const project = makeProject([
      { raw: "    [ G_TOLERANCE, 0.15 ],", kind: "global", depth: 1, globalKey: "G_TOLERANCE", globalValue: 0.15 },
    ]);
    const output = generateScad(project);
    expect(output).toContain("G_TOLERANCE, 0.15");
  });

  it("emits array globals", () => {
    const project = makeProject([
      { raw: "    [ G_SOME_XY, [10, 20] ],", kind: "global", depth: 1, globalKey: "G_SOME_XY", globalValue: [10, 20] },
    ]);
    const output = generateScad(project);
    expect(output).toContain("[10, 20]");
  });

  it("emits string array globals with quoted strings", () => {
    const project = makeProject([
      { raw: "    [ G_PRINT_GROUPS, [\"box 1\", \"tray\"] ],", kind: "global", depth: 1, globalKey: "G_PRINT_GROUPS", globalValue: ["box 1", "tray"] },
    ]);
    const output = generateScad(project);
    expect(output).toContain('G_PRINT_GROUPS, ["box 1", "tray"]');
  });

  it("emits string globals with quotes", () => {
    const project = makeProject([
      { raw: '    [ G_DEFAULT_FONT, "Arial" ],', kind: "global", depth: 1, globalKey: "G_DEFAULT_FONT", globalValue: "Arial" },
    ]);
    const output = generateScad(project);
    expect(output).toContain('"Arial"');
  });

  it("emits OpenSCAD constants in string globals without quotes", () => {
    const project = makeProject([
      { raw: '    [ G_PRINT_TYPES, "DIVIDERS" ],', kind: "global", depth: 1, globalKey: "G_PRINT_TYPES", globalValue: "DIVIDERS" },
    ]);
    const output = generateScad(project);
    expect(output).toContain("G_PRINT_TYPES, DIVIDERS");
  });

  it("emits KV lines verbatim", () => {
    const project = makeProject([
      { raw: '        [ NAME, "box 1" ],', kind: "kv", depth: 2, kvKey: "NAME", kvValue: "box 1" },
    ]);
    const output = generateScad(project);
    expect(output).toBe('        [ NAME, "box 1" ],');
  });

  it("emits blank lines as empty strings", () => {
    const project = makeProject([
      { raw: "", kind: "blank", depth: 0 },
    ]);
    const output = generateScad(project);
    expect(output).toBe("");
  });

  it("emits comment lines verbatim", () => {
    const project = makeProject([
      { raw: "// my comment", kind: "comment", depth: 0, comment: "my comment" },
    ]);
    const output = generateScad(project);
    expect(output).toBe("// my comment");
  });

  it("emits variable lines verbatim", () => {
    const project = makeProject([
      { raw: "g_make_filler = 1;", kind: "modulevar", depth: 0 },
    ]);
    const output = generateScad(project);
    expect(output).toBe("g_make_filler = 1;");
  });

  it("preserves indentation from raw for globals", () => {
    const project = makeProject([
      { raw: "      [ G_TOLERANCE, 0.1 ],", kind: "global", depth: 1, globalKey: "G_TOLERANCE", globalValue: 0.2 },
    ]);
    const output = generateScad(project);
    // Should use the original indentation from raw
    expect(output).toMatch(/^\s{6}\[ G_TOLERANCE, 0\.2 \],$/);
  });

  it("maps generated SCAD lines back to project lines", () => {
    const project = makeProject([
      { raw: "// BGSD", kind: "marker", depth: 0 },
      { raw: "data = [", kind: "open", depth: 0, role: "data" },
      { raw: "    [ G_TOLERANCE, 0.1 ],", kind: "global", depth: 1, globalKey: "G_TOLERANCE", globalValue: 0.2 },
      { raw: "];", kind: "close", depth: 0, role: "data" },
      { raw: "Make(data);", kind: "makeall", depth: 0, varName: "data" },
    ]);
    const generated = generateScadWithSourceMap(project);
    expect(generated.text.split("\n")[2]).toBe("    [ G_TOLERANCE, 0.2 ],");
    expect(generated.sourceMap).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not emit merged BIT object param wrappers", () => {
    const project = importScad(`// BGSD
include <../lib/boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ G_LID_THICKNESS, 2 ],
    [ OBJECT_BOX, [
        [ NAME, "box 2" ],
        [ BOX_SIZE_XYZ, [50, 50, 20] ],
        [ BOX_FEATURE,
            [ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],
        ],
    ]],
];
Make(data);`);

    const output = generateScad(project);
    expect(output).toContain("    [ OBJECT_BOX,\n");
    expect(output).not.toContain("[ OBJECT_BOX, [");
    expect(output).not.toContain("]],");
  });
});
