import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import libraryManager from "../lib/library-manager.js";

describe("library manager", () => {
  it("synthesizes a versioned BIT filename from the current major lib name", () => {
    expect(libraryManager.versionedFilenameForVersion("boardgame_insert_toolkit_lib.4.scad", "4.5.0"))
      .toBe("boardgame_insert_toolkit_lib.4.5.0.scad");
  });

  it("reports installed full library versions for the status bar", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bgsd-lib-versions-"));
    try {
      const bitLib = path.join(workspace, "bit", "lib");
      const ctdLib = path.join(workspace, "ctd", "lib");
      fs.mkdirSync(bitLib, { recursive: true });
      fs.mkdirSync(ctdLib, { recursive: true });
      fs.writeFileSync(path.join(bitLib, "boardgame_insert_toolkit_lib.4.scad"), "/* Version: 4.0.0 */\n");
      fs.writeFileSync(path.join(bitLib, "boardgame_insert_toolkit_lib.4.11.0.scad"), "/* Version: 4.11.0 */\n");
      fs.writeFileSync(path.join(ctdLib, "counter_tray_designer_lib.1.scad"), 'VERSION = "1.0.3";\n');

      const versions = libraryManager.getInstalledLibraryVersions(workspace);

      expect(versions.bit.version).toBe("4.11.0");
      expect(versions.bit.major).toBe(4);
      expect(versions.ctd.version).toBe("1.0.3");
      expect(versions.ctd.major).toBe(1);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
