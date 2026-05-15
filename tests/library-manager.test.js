import { describe, expect, it } from "vitest";
import path from "path";
import libraryManager from "../lib/library-manager.js";

describe("library manager", () => {
  it("synthesizes a versioned BIT filename from the current major lib name", () => {
    expect(libraryManager.versionedFilenameForVersion("boardgame_insert_toolkit_lib.4.scad", "4.5.0"))
      .toBe("boardgame_insert_toolkit_lib.4.5.0.scad");
  });

  it("reports installed full library versions for the status bar", () => {
    const versions = libraryManager.getInstalledLibraryVersions(path.resolve("tests/workspace"));

    expect(versions.bit.version).toBe("4.9.0");
    expect(versions.bit.major).toBe(4);
    expect(versions.ctd.version).toBe("1.0.3");
    expect(versions.ctd.major).toBe(1);
  });
});
