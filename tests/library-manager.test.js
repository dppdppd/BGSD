import { describe, expect, it } from "vitest";
import libraryManager from "../lib/library-manager.js";

describe("library manager", () => {
  it("synthesizes a versioned BIT filename from the current major lib name", () => {
    expect(libraryManager.versionedFilenameForVersion("boardgame_insert_toolkit_lib.4.scad", "4.5.0"))
      .toBe("boardgame_insert_toolkit_lib.4.5.0.scad");
  });
});
