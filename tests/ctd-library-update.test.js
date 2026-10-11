import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import vm from "vm";
import libraryManager from "../lib/library-manager.js";

// The published CTD update moves 1.0.6 to 1.0.7. A second update must still
// report its CTD check when the installed files already match the server.
describe("published CTD library updates", () => {
  it("checks master, installs the update, and reports unchanged checks", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bgsd-ctd-update-"));
    const profile = libraryManager.getProfile("ctd");
    const requested = [];
    const progress = [];
    const nodeRequire = createRequire(import.meta.url);
    const context = {
      module: { exports: {} },
      require(id) {
        if (id === "./profiles.json") return { ctd: profile };
        if (id === "electron") return { net: { fetch: async (url) => {
          requested.push(url);
          // Progress must arrive before the first network request, including
          // requests which later fail or return identical content.
          expect(progress[0]).toBe("[Counter Tray Designer] Checking for updates (master)");
          return { ok: true, text: async () => url.startsWith("https://api.github.com/")
            ? JSON.stringify({ tree: [] })
            : url.includes("counter_tray_designer_lib")
              ? 'VERSION = "1.0.7";\n' : "COUNTER_CONSTANT = 1;\n" };
        } } };
        return nodeRequire(id);
      },
    };
    vm.runInNewContext(fs.readFileSync(new URL("../lib/library-manager.js", import.meta.url), "utf8"), context);
    try {
      const libDir = path.join(workspace, "ctd", "lib");
      fs.mkdirSync(libDir, { recursive: true });
      const installedPath = path.join(libDir, "counter_tray_designer_lib.1.scad");
      fs.writeFileSync(installedPath, 'VERSION = "1.0.6";\n');
      fs.writeFileSync(path.join(libDir, "global_constants.scad"), "COUNTER_CONSTANT = 1;\n");
      expect(profile.branch).toBe("master");
      await context.module.exports.updateLibraries(workspace, (message) => progress.push(message));
      expect(fs.readFileSync(installedPath, "utf8")).toBe('VERSION = "1.0.7";\n');
      expect(progress.some((message) => message.includes("Refreshed lib/counter_tray_designer_lib.1.scad (v1.0.7)"))).toBe(true);
      progress.length = 0;
      await context.module.exports.updateLibraries(workspace, (message) => progress.push(message));
      expect(progress).toEqual(["[Counter Tray Designer] Checking for updates (master)"]);
      expect(requested).toHaveLength(6);
      expect(requested.every((url) => /^\d+$/.test(new URL(url).searchParams.get("_t") || ""))).toBe(true);
      expect(requested.every((url) => url.includes("/master/") || url.includes("/trees/master?"))).toBe(true);
      expect(progress.some((message) => message.includes("Warning") || message.includes("error"))).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
