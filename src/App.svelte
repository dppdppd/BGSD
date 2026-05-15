<script lang="ts">
  import { onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import {
    project,
    updateLineRaw,
    replaceLine,
    deleteLine,
    deleteBlock,
    duplicateBlock,
    updateGlobal,
    updateGlobalWithDefault,
    materializeGlobal,
    updateKv,
    updateComment,
    updateVariable,
    materializeKv,
    insertLine,
    spliceLines,
    updateSceneName,
    addScene,
    duplicateScene,
    formatKvValue,
    presets,
    knownConstants,
    knownConstantsStore,
    constantLabels,
    type Line,
  } from "./lib/stores/project";
  import { generateScad, generateScadWithSourceMap } from "./lib/scad";
  import { startAutosave, onSaveStatus, setFilePath, getFilePath, setNeedsBackup, setReadOnly, getReadOnly, onReadOnlyEdit, onExternalFileChange, saveNowDetailed, suppressNextAutosave, setFileState, getFileState, isSaveInFlight, markExternalFileChange, clearExternalFileChange } from "./lib/autosave";
  import { startHistory, clearHistory, undo, redo, restoreProjectFromHistory, canUndo, canRedo } from "./lib/stores/history";
  import { getSchema } from "./lib/schema";
  import tooltips from "./lib/tooltips/en.json";
  import PreferencesModal from "./lib/components/PreferencesModal.svelte";
  import FileHistoryModal from "./lib/components/FileHistoryModal.svelte";
  import WelcomeScreen from "./lib/components/WelcomeScreen.svelte";
  import ScadPreview from "./lib/components/ScadPreview.svelte";

  let intentText = $state("");
  let showIntent = $state(false);
  let statusMsg = $state("No file open");
  // Injected at build time by Vite (see vite.config.mjs)
  declare const __APP_VERSION__: string;
  const bgsdVersion = __APP_VERSION__;

  // Static lib versions fetched via IPC on mount (preload can't require()
  // arbitrary files in sandboxed mode). Always shown in the status bar
  // regardless of which (or whether any) project is loaded.
  let libVersions = $state<Record<string, { name: string; major: number | null }>>({});
  let libDisplay = $derived([
    { id: "bit", label: "BIT", major: libVersions.bit?.major ?? null },
    { id: "ctd", label: "CTD", major: libVersions.ctd?.major ?? null },
  ]);

  // Filled by the on-mount checkUpdates probe; null while pending or on
  // network failure (kept silent — no error UI).
  let updateInfo = $state<{
    bgsd: { current: string; latest: string | null; hasUpdate: boolean; releaseUrl: string };
    libs: Record<string, { name: string; hasUpdate: boolean; localVersion: string | null; remoteVersion: string | null }>;
  } | null>(null);
  function libVersionString(profileId: string, fallbackMajor: number | null): string {
    const probed = updateInfo?.libs?.[profileId]?.localVersion;
    if (probed) return probed;
    return fallbackMajor !== null ? String(fallbackMajor) : "";
  }
  let bgsdUpdateAvailable = $derived(!!updateInfo?.bgsd?.hasUpdate);
  function libUpdateAvailable(profileId: string): boolean {
    return !!updateInfo?.libs?.[profileId]?.hasUpdate;
  }
  function bgsdVersionTooltip(): string {
    if (!updateInfo) return "Checking for updates…";
    const b = updateInfo.bgsd;
    if (b.hasUpdate && b.latest) return `Newer BGSD available: v${b.latest}`;
    if (b.latest) return `BGSD up to date (latest: v${b.latest})`;
    return "BGSD update check failed (offline or repo unreachable)";
  }
  function libVersionTooltip(profileId: string, label: string): string {
    if (!updateInfo) return "Checking for updates…";
    const l = updateInfo.libs?.[profileId];
    if (!l) return `${label} update check skipped (no working directory)`;
    const errored = l.files?.some((f: any) => f.error);
    if (errored && !l.hasUpdate) return `${label} update check failed (offline?)`;
    if (l.hasUpdate) {
      if (l.localVersion && l.remoteVersion && l.localVersion !== l.remoteVersion) {
        return `${label} lib: ${l.localVersion} → ${l.remoteVersion} (click ↑ to update)`;
      }
      return `${label} lib has updates upstream — click ↑ to refresh`;
    }
    if (l.localVersion) return `${label} lib ${l.localVersion} — current with upstream`;
    return `${label} lib current with upstream`;
  }

  function openReleasePage() {
    const url = updateInfo?.bgsd?.releaseUrl;
    if (url) (window as any).bgsd?.openExternal?.(url);
  }

  let selfUpdating = $state(false);
  async function runSelfUpdate() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.selfUpdate) { openReleasePage(); return; }
    if (selfUpdating) return;
    selfUpdating = true;
    statusMsg = "Downloading BGSD update...";
    try {
      const res = await bgsd.selfUpdate();
      if (!res?.ok) {
        statusMsg = `Update failed: ${res?.error || "unknown"} — opening release page`;
        setTimeout(() => openReleasePage(), 800);
      } else if (res.restarting) {
        statusMsg = `Updated to ${res.version} — restarting...`;
      } else if (res.staged) {
        statusMsg = `Downloaded ${res.version} — finish install in the file manager`;
      }
    } catch (err: any) {
      statusMsg = `Update failed: ${err?.message || "unknown"} — opening release page`;
      setTimeout(() => openReleasePage(), 800);
    }
    selfUpdating = false;
  }
  let defaultsMode = $state<"all" | "favorites" | "none">("favorites");
  let favoriteKeys = $state<Set<string>>(new Set());
  const FAVORITE_KEYS_VERSION = 10;
  const FAVORITE_KEYS_ADDED_IN_V2 = ["LID_TYPE", "LID_SLIDE_SIDE", "LID_FRAME_WIDTH"];
  const FAVORITE_KEYS_ADDED_IN_V3 = [
    "FTR_DIVIDERS", "DIV_AXIS", "DIV_OUTPUT_ONLY_B",
  ];
  const FAVORITE_KEYS_ADDED_IN_V4 = [
    "DIV_LAYOUT_BAYS", "DIV_LAYOUT_BAY_SIZE", "DIV_RAIL_SIZE_XYZ", "DIV_NO_RAILS_B",
  ];
  const FAVORITE_KEYS_ADDED_IN_V5 = ["FTR_SHAPE_AXIS"];
  const FAVORITE_KEYS_ADDED_IN_V8 = ["FEATURE_GROUP"];
  const FAVORITE_KEYS_ADDED_IN_V9 = ["FEATURE_COPY", "FEATURE_REFERENCE"];
  const FAVORITE_KEYS_ADDED_IN_V10 = ["G_PRINT_GROUP"];
  function collectFavoriteSchemaKeys(): Set<string> {
    const keys = new Set<string>();
    for (const profile of ["bit", "ctd"]) {
      const profileSchema = getSchema(profile);
      for (const ctx of Object.values((profileSchema as any).contexts || {})) {
        for (const key of Object.keys((ctx as any).keys || {})) keys.add(key);
      }
      for (const key of Object.keys((profileSchema as any).globals || {})) keys.add(key);
    }
    return keys;
  }
  const FAVORITE_SCHEMA_KEYS = collectFavoriteSchemaKeys();
  // Pull stale or noisy keys out of every user's favorites. Keys that are
  // no longer in any loaded schema are pruned below as part of migration.
  const REMOVED_FAVORITE_KEYS = [
    "DIV_NUM_DIVIDERS", "DIV_SLOT_DEPTH", "DIV_RAILS_B", "FTR_SHAPE_ROTATED_B",
    "G_PRINT_DIVIDERS", "G_PRINT_DIVIDERS_ONLY_B", "G_VALIDATE_PHYSICAL_B", "BOX_GROUP",
  ];
  // Default favorites based on frequency data from docs/guidance/BIT-PARAMETERS.md (3+ uses)
  // and docs/guidance/CTD-PARAMETERS.md (3+ designs). Seeded on first run.
  const DEFAULT_FAVORITE_KEYS = [
    "NAME", "BOX_SIZE_XYZ", "FEATURE_GROUP", "FEATURE_COPY", "FEATURE_REFERENCE", "ENABLED_B",
    "FTR_COMPARTMENT_SIZE_XYZ", "FTR_NUM_COMPARTMENTS_XY", "FTR_SHAPE",
    "FTR_SHAPE_VERTICAL_B", "FTR_SHAPE_AXIS",
    "FTR_PADDING_XY", "FTR_PADDING_HEIGHT_ADJUST_XY",
    "FTR_CUTOUT_SIDES_4B", "POSITION_XY", "ROTATION",
    "FTR_DIVIDERS", "DIV_LAYOUT_BAYS", "DIV_LAYOUT_BAY_SIZE", "DIV_AXIS",
    "DIV_RAIL_SIZE_XYZ", "DIV_NO_RAILS_B",
    "LID_SOLID_B", "LID_TYPE", "LID_SLIDE_SIDE", "LID_FRAME_WIDTH",
    "LBL_TEXT", "LBL_SIZE", "LBL_PLACEMENT",
    "G_PRINT_GROUP", "G_VALIDATE_KEYS_B",
    "G_DIMENSIONS_XY", "G_FLOOR_THICKNESS_N", "G_MIN_PADDING_XY", "G_FRAME_STYLE_N",
    "COUNTER_SIZE_XYZ", "COUNTER_MARGINS_POST_LENGTH_FRACTION_N",
    "PRINT_COUNT_N", "ROWS_N", "COUNTER_SHAPE",
  ];
  let showScad = $state(false);
  let showWelcome = $state(true);
  let scadWidth = $state(500);
  // Working directory state
  let workingDir = $state("");
  let workingDirSet = $state(false);
  let setupBusy = $state(false);
  let setupStatus = $state("");
  let setupLog = $state<string[]>([]);

  // Library browser state
  let libraryTreeRaw = $state<string>("{}");
  let libraryTree = $derived(JSON.parse(libraryTreeRaw) as Record<string, any>);
  let libMenu = $state<{x: number, y: number, path: string, isRepo: boolean} | null>(null);
  let sortMode = $state<"dir" | "date">("dir");

  // Preferences modal state
  let showPrefs = $state(false);
  let prefsWorkingDir = $state("");
  let prefsOpenScadPath = $state("");
  let prefsAutoOpen = $state(true);
  let prefsProxy = $state("");
  // Theme: "light" (gruvbox light hard) | "dark" (gruvbox dark hard).
  // Applied to <html data-theme="..."> on mount and on change.
  let prefsTheme = $state<"light" | "dark">("light");
  $effect(() => {
    // Dark mode is disabled for now — force the data-theme attribute to
    // "light" regardless of prefsTheme value. Stored preference is
    // preserved so users who picked dark earlier will keep it when
    // dark is re-enabled.
    document.documentElement.dataset.theme = "light";
    void prefsTheme;  // touch so Svelte still tracks the dependency
  });
  let showFileHistory = $state(false);
  let currentFilePath = $state<string | null>(null);
  let currentReadOnly = $state(false);
  let versionSaveInFlight = false;
  let showFileMenu = $state(false);
  let showViewMenu = $state(false);
  let recentFiles = $state<string[]>([]);
  let toastText = $state("");
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let externalFileChange = $state<any | null>(null);
  let externalResolveBusy = $state(false);
  let externalCheckInFlight = false;

  let generatedScad = $derived(generateScadWithSourceMap($project));
  let scadOutput = $derived(generatedScad.text);
  let scadSourceMap = $derived(generatedScad.sourceMap);

  type OpenScadIssue = {
    severity: "error" | "warning" | "info";
    message: string;
    line: number | null;
    targetLines: number[];
    targetKeys: string[];
    file: string | null;
    code?: string;
    key?: string;
    keys?: string;
    context?: string;
    raw?: string;
  };
  type DiagnosticsStatus = "idle" | "stale" | "checking" | "valid" | "issues" | "unavailable";
  const DIAGNOSTICS_DEBOUNCE_MS = 1200;
  let diagnosticsStatus = $state<DiagnosticsStatus>("idle");
  let diagnosticsIssues = $state<OpenScadIssue[]>([]);
  let diagnosticsOpen = $state(false);
  // BIT structured validation switch — when off, the toolbar's validation
  // pill grays out to signal BIT checks are disabled. BIT 4.6.1+ folds
  // physical warnings into G_VALIDATE_KEYS_B.
  let bitValidationOn = $derived.by(() => {
    for (const line of $project.lines) {
      if ((line as any).kvKey === "G_VALIDATE_KEYS_B" ||
          (line as any).globalKey === "G_VALIDATE_KEYS_B") {
        return (line as any).kvValue !== false && (line as any).globalValue !== false;
      }
    }
    return true;
  });
  // Keys highlighted on the current diagnostic-marker hover. Empty when
  // not hovering. Rows whose kvKey appears here get a .diag-highlight
  // outline so the user can see which fields the diagnostic is about.
  let hoveredDiagKeys = $state(new Set<string>());
  // Axes (x / y / z) implicated by the hovered diagnostic, parsed out
  // of the BIT-PHYSICAL footprint coords. Combined with .diag-highlight
  // on the row, this targets just the offending subfield input.
  let hoveredDiagAxes = $state(new Set<string>());
  let diagnosticsMessage = $state("OpenSCAD check has not run.");
  let diagnosticsLastCheckedScad = "";
  let diagnosticsLastObservedScad = "";
  let diagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticsInFlight = $state(false);
  let diagnosticsQueued = false;
  let diagnosticsRequestId = 0;
  let diagnosticsErrorCount = $derived(diagnosticsIssues.filter((issue) => issue.severity === "error").length);
  let diagnosticsWarningCount = $derived(diagnosticsIssues.filter((issue) => issue.severity === "warning").length);
  let diagnosticsProblemCount = $derived(diagnosticsErrorCount + diagnosticsWarningCount);
  let diagnosticsLabel = $derived.by(() => {
    if (diagnosticsStatus === "valid") return "Valid";
    if (diagnosticsStatus === "issues") {
      if (diagnosticsErrorCount > 0) return `${diagnosticsErrorCount} error${diagnosticsErrorCount === 1 ? "" : "s"}`;
      return `${diagnosticsWarningCount} warning${diagnosticsWarningCount === 1 ? "" : "s"}`;
    }
    if (diagnosticsStatus === "checking") return "Checking";
    if (diagnosticsStatus === "stale") return "Evaluating...";
    if (diagnosticsStatus === "unavailable") return "Check failed";
    return "OpenSCAD";
  });

  function rememberFilePath(path: string | null) {
    setFilePath(path || "");
    currentFilePath = path;
  }

  function rememberReadOnly(val: boolean) {
    setReadOnly(val);
    currentReadOnly = val;
  }

  function sameLocalPath(a: string | null | undefined, b: string | null | undefined): boolean {
    const left = String(a || "").replace(/\\/g, "/");
    const right = String(b || "").replace(/\\/g, "/");
    if (!left || !right) return false;
    return (window as any).bgsd?.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  onSaveStatus((msg: string) => { statusMsg = msg; });

  function commitActiveInput() {
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function basename(filePath: string): string {
    return filePath.replace(/.*[/\\]/, "");
  }

  function showToast(message: string) {
    toastText = message;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastText = "";
      toastTimer = null;
    }, 2600);
  }

  function parseIssueNumberList(value: any): number[] {
    return String(value ?? "")
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v > 0);
  }

  function parseIssueStringList(value: any): string[] {
    return String(value ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }

  function uniqueStrings(values: string[]): string[] {
    return [...new Set(values)];
  }

  function uniqueNumbers(values: number[]): number[] {
    return [...new Set(values)];
  }

  function normalizeOpenScadIssue(issue: any): OpenScadIssue {
    const severity = issue?.severity === "warning" || issue?.severity === "info" ? issue.severity : "error";
    const numericLine = Number(issue?.line);
    const line = Number.isFinite(numericLine) && numericLine > 0 ? numericLine : null;
    const targetLines = uniqueNumbers([...(line ? [line] : []), ...parseIssueNumberList(issue?.lines)]);
    const targetKeys = uniqueStrings([...parseIssueStringList(issue?.key), ...parseIssueStringList(issue?.keys)]);
    return {
      severity,
      message: String(issue?.message || issue?.raw || "OpenSCAD reported an issue."),
      line,
      targetLines,
      targetKeys,
      file: typeof issue?.file === "string" && issue.file.trim() ? issue.file.trim() : null,
      code: typeof issue?.code === "string" && issue.code.trim() ? issue.code.trim() : undefined,
      key: typeof issue?.key === "string" && issue.key.trim() ? issue.key.trim() : undefined,
      keys: typeof issue?.keys === "string" && issue.keys.trim() ? issue.keys.trim() : undefined,
      context: typeof issue?.context === "string" && issue.context.trim() ? issue.context.trim() : undefined,
      raw: issue?.raw ? String(issue.raw) : undefined,
    };
  }

  function clearDiagnosticsTimer() {
    if (!diagnosticsTimer) return;
    clearTimeout(diagnosticsTimer);
    diagnosticsTimer = null;
  }

  function canRunOpenScadDiagnostics(): boolean {
    return !showWelcome && !!scadOutput.trim();
  }

  function setDiagnosticsIdle() {
    clearDiagnosticsTimer();
    diagnosticsStatus = "idle";
    diagnosticsIssues = [];
    diagnosticsMessage = "OpenSCAD check has not run.";
    diagnosticsLastCheckedScad = "";
    diagnosticsLastObservedScad = scadOutput;
  }

  function scheduleOpenScadDiagnostics(delay = DIAGNOSTICS_DEBOUNCE_MS) {
    if (!canRunOpenScadDiagnostics()) return;
    clearDiagnosticsTimer();
    diagnosticsTimer = setTimeout(() => {
      diagnosticsTimer = null;
      void runOpenScadDiagnostics();
    }, delay);
  }

  function markOpenScadDiagnosticsStale() {
    if (!canRunOpenScadDiagnostics()) {
      setDiagnosticsIdle();
      return;
    }
    if (scadOutput === diagnosticsLastCheckedScad && diagnosticsStatus !== "checking") return;
    diagnosticsStatus = "stale";
    diagnosticsMessage = diagnosticsInFlight
      ? "OpenSCAD is evaluating current changes; another check is finishing."
      : "OpenSCAD is evaluating current changes.";
    scheduleOpenScadDiagnostics();
  }

  function markOpenScadDiagnosticsEditing() {
    if (!canRunOpenScadDiagnostics()) return;
    diagnosticsStatus = "stale";
    diagnosticsMessage = "OpenSCAD is evaluating current changes.";
    scheduleOpenScadDiagnostics(DIAGNOSTICS_DEBOUNCE_MS + 500);
  }

  async function runOpenScadDiagnostics() {
    if (!canRunOpenScadDiagnostics()) {
      setDiagnosticsIdle();
      return;
    }
    if (diagnosticsInFlight) {
      diagnosticsQueued = true;
      return;
    }

    const bgsd = (window as any).bgsd;
    if (!bgsd?.checkOpenScad) {
      diagnosticsStatus = "unavailable";
      diagnosticsIssues = [{ severity: "error", message: "OpenSCAD check API is unavailable.", line: null, file: null }];
      diagnosticsMessage = "OpenSCAD check API is unavailable.";
      return;
    }

    const textAtStart = scadOutput;
    const requestId = ++diagnosticsRequestId;
    diagnosticsInFlight = true;
    diagnosticsStatus = "checking";
    diagnosticsMessage = "Checking with OpenSCAD...";

    try {
      const result = await bgsd.checkOpenScad({
        scadText: textAtStart,
        filePath: currentFilePath || getFilePath(),
        requestId,
      });
      if (result?.requestId !== requestId) return;
      if (scadOutput !== textAtStart) {
        diagnosticsStatus = "stale";
        diagnosticsMessage = "OpenSCAD is evaluating current changes.";
        return;
      }

      diagnosticsLastCheckedScad = textAtStart;
      const issues = Array.isArray(result?.issues) ? result.issues.map(normalizeOpenScadIssue) : [];
      diagnosticsIssues = issues;

      if (result?.error === "not-found") {
        diagnosticsStatus = "unavailable";
        diagnosticsMessage = "OpenSCAD executable was not found.";
      } else if (result?.ok === false && issues.length === 0) {
        diagnosticsStatus = "unavailable";
        diagnosticsIssues = [{ severity: "error", message: String(result?.error || "OpenSCAD check failed."), line: null, file: null }];
        diagnosticsMessage = "OpenSCAD check failed.";
      } else if (issues.some((issue) => issue.severity === "error" || issue.severity === "warning")) {
        const problemCount = issues.filter((issue) => issue.severity === "error" || issue.severity === "warning").length;
        diagnosticsStatus = "issues";
        diagnosticsMessage = `OpenSCAD found ${problemCount} issue${problemCount === 1 ? "" : "s"}.`;
      } else {
        diagnosticsStatus = "valid";
        diagnosticsMessage = "OpenSCAD check passed.";
      }
    } catch (err: any) {
      if (scadOutput !== textAtStart) {
        diagnosticsStatus = "stale";
        diagnosticsMessage = "OpenSCAD is evaluating current changes.";
      } else {
        diagnosticsStatus = "unavailable";
        diagnosticsIssues = [{ severity: "error", message: err?.message || "OpenSCAD check failed.", line: null, file: null }];
        diagnosticsMessage = "OpenSCAD check failed.";
      }
    } finally {
      diagnosticsInFlight = false;
      if (diagnosticsQueued || (canRunOpenScadDiagnostics() && scadOutput !== diagnosticsLastCheckedScad)) {
        diagnosticsQueued = false;
        markOpenScadDiagnosticsStale();
      }
    }
  }

  function toggleDiagnosticsPanel() {
    diagnosticsOpen = !diagnosticsOpen;
    showFileMenu = false;
    showViewMenu = false;
  }

  function diagnosticsEmptyText(): string {
    if (diagnosticsStatus === "valid") return "OpenSCAD reported no issues.";
    if (diagnosticsStatus === "checking") return "Checking with OpenSCAD...";
    if (diagnosticsStatus === "stale") return "OpenSCAD is evaluating current changes.";
    if (diagnosticsStatus === "idle") return "OpenSCAD check has not run.";
    return "No OpenSCAD issue details are available.";
  }

  function addIssueToLineMap(map: Map<number, OpenScadIssue[]>, lineIndex: number | null | undefined, issue: OpenScadIssue) {
    if (lineIndex == null || lineIndex < 0 || lineIndex >= $project.lines.length) return;
    const existing = map.get(lineIndex) ?? [];
    if (!existing.includes(issue)) existing.push(issue);
    map.set(lineIndex, existing);
  }

  function lineMatchesDiagnosticKey(line: Line, key: string): boolean {
    return (line.kind === "kv" && line.kvKey === key) || (line.kind === "global" && line.globalKey === key);
  }

  function diagnosticBoxName(issue: OpenScadIssue): string {
    const contextMatch = issue.context?.match(/(?:^|\/)box[:=]([^/]+)/i);
    if (contextMatch) return contextMatch[1].replace(/_/g, " ");
    const messageMatch = issue.message.match(/\bbox\s+"([^"]+)"/i);
    return messageMatch?.[1] ?? "";
  }

  function findAncestorOpenMatching(lineIndex: number, predicate: (line: Line, index: number) => boolean): number {
    let balance = 0;
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = $project.lines[i];
      if (line.kind === "close") {
        balance += line.mergedClose ? 2 : 1;
      } else if (line.kind === "open") {
        const openCount = line.mergedOpen ? 2 : 1;
        if (balance > 0) {
          balance -= openCount;
        } else if (predicate(line, i)) {
          return i;
        }
      }
    }
    return -1;
  }

  function lineBelongsToBox(lineIndex: number, boxName: string): boolean {
    if (!boxName) return true;
    return findAncestorOpenMatching(
      lineIndex,
      (line, index) => line.role === "object" && line.label === "OBJECT_BOX" && findChildName(index) === boxName,
    ) >= 0;
  }

  /** Translate dense BIT-PHYSICAL messages into a one-line summary
   *  that names the offending axis (X / Y / both) so the user knows
   *  which field to edit. Falls back to the raw message otherwise. */
  function humanizeMessage(issue: OpenScadIssue): string {
    const msg = issue.message || "";
    const m = msg.match(
      /^physical validation: box "([^"]+)" > component\[(\d+)\] footprint \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] to \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] exceeds usable interior \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] to \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] in box "[^"]+"\.?$/
    );
    if (m) {
      const [, box, n, fx1s, fy1s, fx2s, fy2s, ix1s, iy1s, ix2s, iy2s] = m;
      const fx1 = +fx1s, fy1 = +fy1s, fx2 = +fx2s, fy2 = +fy2s;
      const ix1 = +ix1s, iy1 = +iy1s, ix2 = +ix2s, iy2 = +iy2s;
      const xOver = fx1 < ix1 || fx2 > ix2;
      const yOver = fy1 < iy1 || fy2 > iy2;
      const axis = xOver && yOver ? "X and Y" : xOver ? "X" : yOver ? "Y" : "footprint";
      const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
      const fw = fmt(fx2 - fx1), fh = fmt(fy2 - fy1);
      const iw = fmt(ix2 - ix1), ih = fmt(iy2 - iy1);
      return `Component #${n} in "${box}": ${axis} too big — ${fw}×${fh} mm exceeds the ${iw}×${ih} mm usable interior.`;
    }
    return msg;
  }

  /** Parse the BIT-PHYSICAL footprint pattern to figure out which
   *  axes (X, Y, Z — Z reserved for height variants) actually overflow,
   *  so the hover can highlight only the implicated subfield input. */
  function collectIssueAxes(issues: OpenScadIssue[]): Set<string> {
    const out = new Set<string>();
    const re = /footprint \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] to \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] exceeds usable interior \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\] to \[(-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\]/;
    for (const issue of issues) {
      const m = (issue.message || "").match(re);
      if (!m) continue;
      const fx1=+m[1], fy1=+m[2], fx2=+m[3], fy2=+m[4];
      const ix1=+m[5], iy1=+m[6], ix2=+m[7], iy2=+m[8];
      if (fx1 < ix1 || fx2 > ix2) out.add("x");
      if (fy1 < iy1 || fy2 > iy2) out.add("y");
    }
    return out;
  }

  /** Collect the kv-keys to highlight on diagnostic hover. Prefer the
   *  curated `inferredDiagnosticKeys` set when available — that's the
   *  narrow list of fields the user can act on. Fall back to the raw
   *  `issue.keys` list only when we have no curated answer, so we
   *  never overwhelm the highlight with every key the validator
   *  inspected. `issue.key` (specific) is always included. */
  function collectIssueKeys(issues: OpenScadIssue[]): Set<string> {
    const out = new Set<string>();
    for (const issue of issues) {
      if (issue.key) out.add(issue.key);
      const inferred = inferredDiagnosticKeys(issue);
      if (inferred.length) {
        for (const k of inferred) out.add(k);
      } else if (issue.keys) {
        for (const k of issue.keys.split(/\s*,\s*/)) {
          const trimmed = k.trim();
          if (trimmed) out.add(trimmed);
        }
      }
    }
    return out;
  }

  /** Truncate a long comma-separated key list for the meta line.  */
  function shortKeysLabel(keys: string | null | undefined): string | null {
    if (!keys) return null;
    const list = keys.split(/\s*,\s*/).filter(Boolean);
    if (list.length <= 3) return `keys ${list.join(", ")}`;
    return `keys ${list.slice(0, 3).join(", ")} (+${list.length - 3} more)`;
  }

  function inferredDiagnosticKeys(issue: OpenScadIssue): string[] {
    if (issue.targetKeys.length) return issue.targetKeys;
    const code = issue.code?.toUpperCase();
    const message = issue.message.toLowerCase();
    // BIT-PHYSICAL "exceeds usable interior": the direct causes the user
    // can edit. The diagnostic's `keys` field also lists secondary
    // inputs (rotation, shear, wall thickness…) that affect the
    // computation but aren't the obvious dials to turn — those would
    // overwhelm the highlight, so we ignore them in favour of this
    // narrower set.
    if (code === "BIT-PHYSICAL" && /exceeds usable interior|footprint/.test(message)) {
      return ["FTR_COMPARTMENT_SIZE_XYZ", "FTR_NUM_COMPARTMENTS_XY", "POSITION_XY", "BOX_SIZE_XYZ"];
    }
    if (code === "BIT-PHYSICAL" && /too tall/.test(message)) {
      return ["FTR_COMPARTMENT_SIZE_XYZ", "BOX_SIZE_XYZ"];
    }
    return [];
  }

  let diagnosticsByLineIndex = $derived.by(() => {
    const map = new Map<number, OpenScadIssue[]>();
    if (diagnosticsStatus !== "issues" || scadOutput !== diagnosticsLastCheckedScad) return map;

    for (const issue of diagnosticsIssues) {
      for (const lineNumber of issue.targetLines) {
        addIssueToLineMap(map, scadSourceMap[lineNumber - 1], issue);
      }

      const boxName = diagnosticBoxName(issue);
      // Match by inferred (curated) keys when available; otherwise fall
      // back to issue.key (specific) plus issue.keys (broad). Schema /
      // key validations land here too — they have issue.key set but no
      // inferred narrowing — so they get triangles + highlights on the
      // exact field they flagged.
      const inferred = inferredDiagnosticKeys(issue);
      const matchKeys = new Set<string>();
      if (inferred.length) {
        for (const k of inferred) matchKeys.add(k);
      } else {
        if (issue.key) matchKeys.add(issue.key);
        if (issue.keys) for (const k of issue.keys.split(/\s*,\s*/)) {
          const trimmed = k.trim();
          if (trimmed) matchKeys.add(trimmed);
        }
      }
      for (const key of matchKeys) {
        for (let i = 0; i < $project.lines.length; i++) {
          if (!lineMatchesDiagnosticKey($project.lines[i], key)) continue;
          if (!lineBelongsToBox(i, boxName)) continue;
          addIssueToLineMap(map, i, issue);
        }
      }
    }

    return map;
  });

  function diagnosticsForLine(lineIndex: number | null | undefined): OpenScadIssue[] {
    if (lineIndex == null) return [];
    return diagnosticsByLineIndex.get(lineIndex) ?? [];
  }

  function lineDiagnosticSeverity(lineIndex: number | null | undefined): "error" | "warning" | "info" | null {
    const issues = diagnosticsForLine(lineIndex);
    if (issues.some((issue) => issue.severity === "error")) return "error";
    if (issues.some((issue) => issue.severity === "warning")) return "warning";
    if (issues.length) return "info";
    return null;
  }

  function lineDiagnosticTitle(lineIndex: number | null | undefined): string {
    const issues = diagnosticsForLine(lineIndex);
    if (!issues.length) return "";
    return issues.map((issue) => `${issue.severity}: ${issue.message}`).join("\n");
  }

  function openDiagnosticsFromLine(event: MouseEvent) {
    event.stopPropagation();
    diagnosticsOpen = true;
  }

  $effect(() => {
    const text = scadOutput;
    const editorVisible = !showWelcome;
    if (!editorVisible) {
      setDiagnosticsIdle();
      return;
    }
    if (text === diagnosticsLastObservedScad && text === diagnosticsLastCheckedScad) return;
    diagnosticsLastObservedScad = text;
    markOpenScadDiagnosticsStale();
  });

  function showExternalFileChange(result: any) {
    const fp = currentFilePath || getFilePath();
    if (!fp) return;
    if (result?.filePath && result.filePath !== fp) return;
    const next = { ...result, filePath: fp, externalChange: true };
    externalFileChange = next;
    markExternalFileChange(next);
    statusMsg = next.deleted ? "File deleted outside BGSD" : "File changed outside BGSD";
    showToast(statusMsg);
  }

  async function checkExternalFileChange() {
    if (externalCheckInFlight || externalFileChange || currentReadOnly || getReadOnly() || isSaveInFlight()) return;
    const fp = currentFilePath || getFilePath();
    const knownState = getFileState();
    if (!fp || !knownState) return;
    const bgsd = (window as any).bgsd;
    if (!bgsd?.checkFileState) return;

    externalCheckInFlight = true;
    try {
      const result = await bgsd.checkFileState(fp, knownState);
      if (isSaveInFlight() || knownState !== getFileState()) return;
      if (result?.ok && result.changed) showExternalFileChange(result);
    } catch (_) {
      // Polling should stay quiet unless the main process can confirm a conflict.
    } finally {
      externalCheckInFlight = false;
    }
  }

  async function reloadExternalFile() {
    const fp = externalFileChange?.filePath;
    if (!fp) return;
    const bgsd = (window as any).bgsd;
    if (!bgsd?.loadFilePath) return;
    externalResolveBusy = true;
    try {
      const loaded = await bgsd.loadFilePath(fp);
      if (loaded?.ok) {
        externalFileChange = null;
        clearExternalFileChange();
        await handleLoad(loaded);
        statusMsg = `Reloaded ${basename(fp)}`;
        showToast(`Reloaded from disk: ${basename(fp)}`);
      } else {
        statusMsg = `Reload failed: ${loaded?.error || "unknown"}`;
      }
    } finally {
      externalResolveBusy = false;
    }
  }

  async function overwriteExternalFile() {
    externalResolveBusy = true;
    try {
      commitActiveInput();
      await tick();
      const result = await saveNowDetailed({ allowOverwriteExternal: true, forceNewRevision: true });
      if (result.ok) {
        if (result.fileState) setFileState(result.fileState);
        clearExternalFileChange();
        externalFileChange = null;
        const name = basename(result.filePath || currentFilePath || getFilePath() || "");
        statusMsg = name ? `Saved ${name}` : "Saved";
        showToast(name ? `Saved ${name}` : "Saved");
      } else if (result.error) {
        statusMsg = `Save failed: ${result.error}`;
      }
    } finally {
      externalResolveBusy = false;
    }
  }

  async function saveExternalFileAs() {
    externalResolveBusy = true;
    try {
      await saveFileAs();
    } finally {
      externalResolveBusy = false;
    }
  }

  async function refreshRecentFiles() {
    const bgsd = (window as any).bgsd;
    const files = await bgsd?.getRecentFiles?.();
    recentFiles = Array.isArray(files) ? files : [];
  }

  async function toggleFileMenu() {
    showFileMenu = !showFileMenu;
    if (showFileMenu) showViewMenu = false;
    if (showFileMenu) await refreshRecentFiles();
  }

  function toggleViewMenu() {
    showViewMenu = !showViewMenu;
    if (showViewMenu) showFileMenu = false;
  }

  function setDefaultsMode(mode: "all" | "favorites" | "none") {
    defaultsMode = mode;
  }

  async function openRecentFile(filePath: string) {
    const bgsd = (window as any).bgsd;
    showFileMenu = false;
    const loaded = await bgsd?.loadFilePath?.(filePath);
    if (loaded?.ok) {
      await handleLoad(loaded);
    } else {
      statusMsg = `Open failed: ${loaded?.error || "unknown"}`;
    }
  }

  function updateTitle(filePath: string) {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.setTitle) return;
    if (!filePath) {
      bgsd.setTitle("BGSD — New File");
    } else {
      const name = filePath.replace(/.*[/\\]/, "");
      bgsd.setTitle(`${name} — ${filePath}`);
    }
  }

  let fileLoaded = false;

  async function handleLoad(payload: any) {
    const { data, filePath, fileState, libraryEnsures } = payload;
    suppressNextAutosave();
    project.set(data);
    clearHistory();
    externalFileChange = null;
    clearExternalFileChange();
    updateTitle(filePath);
    fileLoaded = true;
    showWelcome = false;
    collapsed = new Set();
    editorPadBottom = 0;

    // Check if this is a repo-tracked library file (read-only)
    const bgsd = (window as any).bgsd;
    const repoCheck = await bgsd?.checkRepoFile?.(filePath);
    if (repoCheck?.repoFile) {
      rememberFilePath(filePath);
      rememberReadOnly(true);
      const name = filePath.replace(/.*[/\\]/, "");
      statusMsg = `${name} (library example — Save As to edit)`;
    } else {
      rememberFilePath(filePath);
      rememberReadOnly(false);
      setNeedsBackup(!data.hasMarker);
      const name = filePath.replace(/.*[/\\]/, "");
      statusMsg = data.hasMarker ? name : `${name} (will backup .bak on first save)`;
    }
    setFileState(fileState || null);

    const libDownloads = (libraryEnsures || []).filter((r: any) => r?.downloaded?.length > 0);
    const libFailures = (libraryEnsures || []).filter((r: any) => r?.ok === false);
    if (libDownloads.length > 0) {
      const names = libDownloads.map((r: any) => r.filename || r.includeFile).filter(Boolean).join(", ");
      statusMsg = `Downloaded library: ${names}`;
    } else if (libFailures.length > 0) {
      const names = libFailures.map((r: any) => r.includeFile || r.filename || "library").join(", ");
      statusMsg = `Library download failed: ${names}`;
    }

    // Load presets for CTD projects
    if (data.libraryProfile === "ctd") {
      try {
        const presetMap = await bgsd?.getPresets?.(data.publisherConstantsFile || null);
        if (presetMap && typeof presetMap === "object") {
          presets.set(presetMap);
          knownConstants.clear();
          const labels: Record<string, string> = {};
          for (const entries of Object.values(presetMap) as any[]) {
            for (const e of entries) {
              knownConstants.add(e.name);
              if (!labels[e.name]) labels[e.name] = e.label;
            }
          }
          knownConstantsStore.set(new Set(knownConstants));
          constantLabels.set(labels);
        }
      } catch (_) {}
    } else {
      presets.set({});
      knownConstants.clear();
      knownConstantsStore.set(new Set());
      constantLabels.set({});
    }

    // Auto-launch OpenSCAD after every load
    launchOpenScad(filePath, data.libraryProfile);
  }

  onMount(async () => {
    showIntent = !!(window as any).bgsd?.harness;
    // Defer one tick so the initial render doesn't trigger slide transitions
    // on every row at mount time.
    queueMicrotask(() => { mounted = true; });
    // Apply saved theme before any visible paint (the $effect already
    // mirrors prefsTheme to <html data-theme>; this just hydrates it).
    try {
      const prefs = await (window as any).bgsd?.getPreferences?.();
      // Dark mode is disabled for now — even if the user previously
      // saved "dark", don't apply it until the toolbar palette and the
      // rest of the UI are dark-aware. The stored pref is preserved.
      // if (prefs?.theme === "dark") prefsTheme = "dark";
    } catch { /* fall through to default light */ }
    startAutosave();
    startHistory();
    onExternalFileChange(showExternalFileChange);
    setInterval(() => { void checkExternalFileChange(); }, 2000);

    // When a read-only library file is edited, prompt Save As
    onReadOnlyEdit(async () => {
      if (!getReadOnly()) return;
      statusMsg = "Library example — saving a copy...";
      await saveFileAs();
      if (getFilePath()) {
        rememberReadOnly(false);
        currentFilePath = getFilePath();
        const name = (getFilePath() || "").replace(/.*[/\\]/, "");
        statusMsg = `Saved ${name}`;
      } else {
        statusMsg = `${(getFilePath() || "").replace(/.*[/\\]/, "")} (library example — Save As to edit)`;
      }
    });

    // After 1 s of input inactivity, commit the focused control so autosave picks it up.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener("input", () => {
      markOpenScadDiagnosticsEditing();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const el = document.activeElement;
        if (!el || el.classList.contains("comment-input")) return;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, 1000);
    });

    const bgsd = (window as any).bgsd;
    if (bgsd?.onMenuNew) bgsd.onMenuNew((_event: any, profile: string) => newProject(profile || "bit"));
    if (bgsd?.onMenuOpen) bgsd.onMenuOpen(handleLoad);
    if (bgsd?.onMenuSave) bgsd.onMenuSave(() => saveVersion());
    if (bgsd?.onMenuSaveAs) bgsd.onMenuSaveAs(saveFileAs);
    if (bgsd?.onMenuFileHistory) bgsd.onMenuFileHistory(openFileHistory);
    if (bgsd?.onMenuOpenInOpenScad) bgsd.onMenuOpenInOpenScad(openInOpenScad);
    if (bgsd?.onMenuPreferences) bgsd.onMenuPreferences(openPreferencesModal);
    if (bgsd?.onMenuUndo) bgsd.onMenuUndo(() => undo());
    if (bgsd?.onMenuRedo) bgsd.onMenuRedo(() => redo());
    if (bgsd?.onMenuDefaultsMode) bgsd.onMenuDefaultsMode((mode: string) => { defaultsMode = mode as "all" | "favorites" | "none"; });
    if (bgsd?.onMenuToggleShowScad) bgsd.onMenuToggleShowScad((checked: boolean) => { showScad = checked; });

    document.addEventListener("keydown", (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      void saveVersion();
    });

    // Load favorite keys from preferences (seed defaults on first run)
    const prefs = await bgsd?.getPreferences?.();
    if (prefs?.favoriteKeys && Array.isArray(prefs.favoriteKeys)) {
      const migrated = new Set(prefs.favoriteKeys);
      const favoriteVersion = Number(prefs.favoriteKeysVersion || 1);
      let changedFavorites = favoriteVersion !== FAVORITE_KEYS_VERSION;
      if (favoriteVersion < 2) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V2) migrated.add(key);
      }
      if (favoriteVersion < 3) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V3) migrated.add(key);
      }
      if (favoriteVersion < 4) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V4) migrated.add(key);
      }
      if (favoriteVersion < 5) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V5) migrated.add(key);
      }
      if (favoriteVersion < 8) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V8) migrated.add(key);
      }
      if (favoriteVersion < 9) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V9) migrated.add(key);
      }
      if (favoriteVersion < 10) {
        for (const key of FAVORITE_KEYS_ADDED_IN_V10) migrated.add(key);
      }
      for (const key of REMOVED_FAVORITE_KEYS) {
        if (migrated.delete(key)) changedFavorites = true;
      }
      for (const key of [...migrated]) {
        if (!FAVORITE_SCHEMA_KEYS.has(key)) {
          migrated.delete(key);
          changedFavorites = true;
        }
      }
      if (changedFavorites) {
        await bgsd?.setPreferences?.({ favoriteKeys: [...migrated], favoriteKeysVersion: FAVORITE_KEYS_VERSION });
      }
      favoriteKeys = migrated;
    } else {
      favoriteKeys = new Set(DEFAULT_FAVORITE_KEYS);
      await bgsd?.setPreferences?.({ favoriteKeys: [...DEFAULT_FAVORITE_KEYS], favoriteKeysVersion: FAVORITE_KEYS_VERSION });
    }

    // Load working directory status
    const wdStatus = await bgsd?.getWorkingDirStatus?.();
    if (wdStatus?.set) {
      workingDir = wdStatus.path;
      workingDirSet = true;
      loadLibraryTree();
    }

    // Static lib versions (always-shown chips). Silent on failure.
    bgsd?.getLibVersions?.().then((v: any) => { if (v) libVersions = v; }).catch(() => {});

    // Background check for newer BGSD or lib versions. Silent on failure.
    bgsd?.checkUpdates?.().then((info: any) => { if (info) updateInfo = info; }).catch(() => {});

    // Self-update download progress (status bar)
    bgsd?.onSelfUpdateProgress?.((data: { received: number; total: number; name: string }) => {
      const pct = data.total > 0 ? Math.floor((data.received / data.total) * 100) : 0;
      const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
      statusMsg = data.total > 0
        ? `Downloading ${data.name}: ${pct}% (${mb(data.received)} / ${mb(data.total)} MB)`
        : `Downloading ${data.name}: ${mb(data.received)} MB`;
    });

    // Listen for working dir progress messages
    bgsd?.onWorkingDirProgress?.((msg: string) => {
      setupStatus = msg;
      setupLog = [...setupLog, msg];
    });

    bgsd?.onStartupLibrariesUpdated?.((result: { ok: boolean; messages?: string[]; error?: string }) => {
      if (!result?.ok) return;
      loadLibraryTree();
      bgsd?.checkUpdates?.().then((info: any) => { if (info) updateInfo = info; }).catch(() => {});
    });

    // Check for pending auto-load (CLI arg / env var)
    for (let i = 0; i < 50; i++) {
      if (fileLoaded) break; // already loaded via menu during polling
      const pending = await (window as any).bgsd?.getPendingLoad?.();
      if (pending) { handleLoad(pending); break; }
      await new Promise(r => setTimeout(r, 200));
    }
    // If nothing was loaded by any path, show welcome screen
    // (showWelcome is already true by default)
  });

  async function newProject(profile: string = "bit") {
    const bgsd = (window as any).bgsd;
    let includeFile = profile === "ctd"
      ? "../lib/counter_tray_designer_lib.1.scad"
      : "../lib/boardgame_insert_toolkit_lib.4.scad";
    if (profile === "bit" && bgsd?.ensureLatestLibrary) {
      const latest = await bgsd.ensureLatestLibrary("bit");
      if (latest?.ok && latest.include) includeFile = latest.include;
      else if (latest?.error) statusMsg = `BIT latest check failed: ${latest.error}`;
    }

    // Always show Save As dialog so the user can choose a filename
    let templateProject: any;
    if (profile === "ctd") {
      templateProject = { version: 1, lines: [
        { raw: "// BGSD", kind: "marker", depth: 0 },
        { raw: `include <${includeFile}>;`, kind: "include", depth: 0 },
        { raw: "scene_1 = [", kind: "open", depth: 0, role: "data", label: "scene_1", varName: "scene_1" },
        { raw: "    [ TRAY,", kind: "open", depth: 1, role: "object", label: "TRAY" },
        { raw: "        [ COUNTER_SET,", kind: "open", depth: 2, role: "counter_set", label: "COUNTER_SET" },
        { raw: "            [ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],", kind: "kv", depth: 3, kvKey: "COUNTER_SIZE_XYZ", kvValue: [13.3, 13.3, 3] },
        { raw: "        ],", kind: "close", depth: 2, role: "counter_set", label: "COUNTER_SET" },
        { raw: "    ],", kind: "close", depth: 1, role: "object", label: "TRAY" },
        { raw: "    [ LID,", kind: "open", depth: 1, role: "object", label: "LID" },
        { raw: "    ],", kind: "close", depth: 1, role: "object", label: "LID" },
        { raw: "];", kind: "close", depth: 0, role: "data", label: "scene_1", varName: "scene_1" },
        { raw: "Make(scene_1);", kind: "makeall", depth: 0, varName: "scene_1" },
      ], hasMarker: true, libraryProfile: "ctd", libraryInclude: includeFile.replace(/.*[/\\]/, "") };
    } else {
      templateProject = { version: 1, lines: [
        { raw: "// BGSD", kind: "marker", depth: 0 },
        { raw: `include <${includeFile}>;`, kind: "include", depth: 0 },
        { raw: "data = [", kind: "open", depth: 0, role: "data", label: "data", varName: "data" },
        { raw: "    [ OBJECT_BOX,", kind: "open", depth: 1, role: "object", label: "OBJECT_BOX" },
        { raw: '        [ NAME, "box 1" ],', kind: "kv", depth: 2, kvKey: "NAME", kvValue: "box 1" },
        { raw: "        [ BOX_SIZE_XYZ, [50, 50, 20] ],", kind: "kv", depth: 2, kvKey: "BOX_SIZE_XYZ", kvValue: [50, 50, 20] },
        { raw: "    ],", kind: "close", depth: 1, role: "object", label: "OBJECT_BOX" },
        { raw: "];", kind: "close", depth: 0, role: "data", label: "data", varName: "data" },
        { raw: "Make(data);", kind: "makeall", depth: 0, varName: "data" },
      ], hasMarker: true, libraryProfile: "bit", libraryInclude: includeFile.replace(/.*[/\\]/, "") };
    }

    suppressNextAutosave();
    project.set(templateProject);
    clearHistory();
    const scadText = generateScad(templateProject);

    if (!bgsd?.saveFileAs) return;
    const res = await bgsd.saveFileAs(scadText, templateProject.libraryProfile);
    if (!res.ok) {
      project.set({ version: 1, lines: [], hasMarker: false });
      clearHistory();
      rememberFilePath(null);
      rememberReadOnly(false);
      showWelcome = true;
      statusMsg = "No file open";
      return;
    }

    if (bgsd?.loadFilePath) {
      const loaded = await bgsd.loadFilePath(res.filePath);
      if (loaded.ok) {
        handleLoad(loaded);
        return;
      }
    }

    rememberFilePath(res.filePath);
    rememberReadOnly(false);
    setFileState(res.fileState || null);
    setNeedsBackup(false);
    updateTitle(res.filePath);
    fileLoaded = true;
    showWelcome = false;
    statusMsg = `Saved ${res.filePath.replace(/.*[/\\]/, "")}`;
    launchOpenScad(res.filePath, templateProject.libraryProfile);
  }

  async function openFile() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.openFile) return;
    const res = await bgsd.openFile();
    if (!res.ok) { if (res.error) statusMsg = `Open failed: ${res.error}`; return; }
    handleLoad(res);
  }

  async function saveFileAs(): Promise<boolean> {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.saveFileAs) return false;
    commitActiveInput();
    await tick();
    const res = await bgsd.saveFileAs(scadOutput, $project.libraryProfile, currentFilePath || getFilePath());
    if (!res.ok) {
      if (res.error) statusMsg = `Save As failed: ${res.error}`;
      return false;
    }
    rememberFilePath(res.filePath);
    rememberReadOnly(false);
    setFileState(res.fileState || null);
    clearExternalFileChange();
    externalFileChange = null;
    updateTitle(res.filePath);
    statusMsg = `Saved ${res.filePath.replace(/.*[/\\]/, "")}`;
    // Keep OpenSCAD in sync with the new file
    launchOpenScad(res.filePath);
    return true;
  }

  async function saveVersion() {
    if (versionSaveInFlight) return;
    versionSaveInFlight = true;
    try {
      commitActiveInput();
      await tick();
      if (!currentFilePath && !getFilePath()) {
        await saveFileAs();
        return;
      }
      if (currentReadOnly || getReadOnly()) {
        await saveFileAs();
        return;
      }
      const saveResult = await saveNowDetailed({ forceNewRevision: true });
      if (saveResult.ok) {
        if (saveResult.filePath) {
          rememberFilePath(saveResult.filePath);
          updateTitle(saveResult.filePath);
        }
        const name = (saveResult.filePath || currentFilePath || getFilePath() || "").replace(/.*[/\\]/, "");
        statusMsg = name ? `Version saved for ${name}` : "Version saved";
        showToast(name ? `Version saved: ${name}` : "Version saved");
      } else if (saveResult.error) {
        statusMsg = `Save failed: ${saveResult.error}`;
      }
    } finally {
      versionSaveInFlight = false;
    }
  }

  async function newProjectFromWelcome(profile: string = "bit") {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.newProjectToPath) {
      await newProject(profile);
      return;
    }
    const res = await bgsd.newProjectToPath(profile);
    if (!res?.ok) {
      statusMsg = `New project failed: ${res?.error || "unknown"}`;
    }
  }

  async function launchOpenScad(filePath: string, profile?: string) {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.openInOpenScad) return;
    if (!filePath) return;
    if (bgsd.harness) return;

    // Check preferences for auto-open
    const prefs = await bgsd.getPreferences?.() || { autoOpenInOpenScad: true };
    if (!prefs.autoOpenInOpenScad) return;

    const res = await bgsd.openInOpenScad(filePath, profile || $project.libraryProfile);
    if (res && !res.ok && res.error === "not-found") {
      statusMsg = "OpenSCAD not found";
      // Prompt user to locate OpenSCAD
      const browse = await bgsd.browseOpenScad?.();
      if (browse?.ok && browse.path) {
        await bgsd.setPreferences?.({ openScadPath: browse.path });
        // Retry launch
        const retry = await bgsd.openInOpenScad(filePath, profile || $project.libraryProfile);
        if (retry?.ok) {
          statusMsg = filePath.replace(/.*[/\\]/, "");
        } else if (retry && !retry.ok) {
          statusMsg = `OpenSCAD: ${retry.error}`;
        }
      } else {
        statusMsg = "OpenSCAD not found — set in File > Preferences";
      }
    } else if (res && !res.ok) {
      statusMsg = `OpenSCAD: ${res.error}`;
    }
  }

  async function copyScadPath() {
    const fp = currentFilePath || getFilePath();
    if (!fp) { statusMsg = "No file open"; return; }
    try {
      await navigator.clipboard.writeText(fp);
      statusMsg = "Path copied to clipboard";
      setTimeout(() => { if (statusMsg === "Path copied to clipboard") statusMsg = fp.replace(/.*[/\\]/, ""); }, 2000);
    } catch (err: any) {
      statusMsg = `Copy failed: ${err?.message || "unknown"}`;
    }
  }

  function openFileHistory() {
    const fp = currentFilePath || getFilePath();
    if (!fp) { statusMsg = "No file open"; return; }
    if (currentReadOnly || getReadOnly()) {
      statusMsg = "Library example — use Save As before Version History";
      return;
    }
    showFileHistory = true;
  }

  async function restoreFileHistoryRevision(payload: any) {
    restoreProjectFromHistory(payload.data);
    collapsed = new Set();
    editorPadBottom = 0;
    setNeedsBackup(false);
    await tick();
    const saveResult = await saveNowDetailed();
    if (!saveResult.ok) {
      statusMsg = `Restore applied in memory; save failed: ${saveResult.error || "unknown"}`;
      return;
    }
    const id = String(payload.revision?.id || "").replace(/-/g, "").slice(0, 8);
    statusMsg = id ? `Restored version ${id}` : "Restored version";
  }

  async function openInOpenScad() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.openInOpenScad) return;

    let fp = currentFilePath || getFilePath();
    if (!fp) {
      // No file yet — prompt save-as first
      await saveFileAs();
      fp = currentFilePath || getFilePath();
      if (!fp) return;
    }

    const saveResult = await saveNowDetailed();
    if (saveResult.externalChange) return;
    const openPath = saveResult.ok ? (saveResult.filePath || fp) : fp;

    // For manual launch (Tools menu), bypass auto-open pref check
    const res = await bgsd.openInOpenScad(openPath, $project.libraryProfile);
    if (res && !res.ok && res.error === "not-found") {
      statusMsg = "OpenSCAD not found";
      const browse = await bgsd.browseOpenScad?.();
      if (browse?.ok && browse.path) {
        await bgsd.setPreferences?.({ openScadPath: browse.path });
        const retry = await bgsd.openInOpenScad(openPath, $project.libraryProfile);
        if (retry?.ok) {
          statusMsg = openPath.replace(/.*[/\\]/, "");
        } else if (retry && !retry.ok) {
          statusMsg = `OpenSCAD: ${retry.error}`;
        }
      } else {
        statusMsg = "OpenSCAD not found — set in File > Preferences";
      }
    } else if (res && !res.ok) {
      statusMsg = `OpenSCAD: ${res.error}`;
    }
  }

  async function openPreferencesModal() {
    const bgsd = (window as any).bgsd;
    const prefs = await bgsd?.getPreferences?.() || { openScadPath: "", autoOpenInOpenScad: true };
    prefsWorkingDir = workingDir || "";
    prefsOpenScadPath = prefs.openScadPath || "";
    prefsAutoOpen = prefs.autoOpenInOpenScad !== false;
    prefsProxy = prefs.proxy || "";
    prefsTheme = prefs.theme === "dark" ? "dark" : "light";
    showPrefs = true;
  }

  async function savePreferences() {
    const bgsd = (window as any).bgsd;
    await bgsd?.setPreferences?.({ openScadPath: prefsOpenScadPath, autoOpenInOpenScad: prefsAutoOpen, proxy: prefsProxy, theme: prefsTheme });
    // Handle working directory change
    if (prefsWorkingDir && prefsWorkingDir !== workingDir && bgsd?.initWorkingDir) {
      const res = await bgsd.initWorkingDir(prefsWorkingDir);
      if (res.ok) {
        workingDir = prefsWorkingDir;
        workingDirSet = true;
        loadLibraryTree();
      }
    }
    showPrefs = false;
  }

  async function browseOpenScadPath() {
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.browseOpenScad?.();
    if (result?.ok && result.path) {
      prefsOpenScadPath = result.path;
    }
  }

  async function browseWorkingDirPref() {
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.browseWorkingDir?.();
    if (result?.ok && result.path) {
      prefsWorkingDir = result.path;
    }
  }

  // --- Working directory functions ---

  async function chooseAndInitWorkingDir() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.browseWorkingDir) return;
    const result = await bgsd.browseWorkingDir();
    if (!result?.ok || !result.path) return;

    setupBusy = true;
    setupLog = [];
    setupStatus = "Initializing...";
    try {
      const res = await bgsd.initWorkingDir(result.path);
      if (res.ok) {
        workingDir = result.path;
        workingDirSet = true;
        setupStatus = "";
        setupLog = [];
        loadLibraryTree();
      } else {
        setupStatus = `Setup failed: ${res.error}`;
      }
    } catch (err: any) {
      setupStatus = `Setup failed: ${err.message}`;
    }
    setupBusy = false;
  }

  async function updateLibs() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.updateLibraries) return;
    setupBusy = true;
    setupLog = [];
    setupStatus = "Updating libraries...";
    statusMsg = "Updating libraries...";
    try {
      const res = await bgsd.updateLibraries();
      if (res.ok) {
        setupStatus = "Libraries updated.";
        statusMsg = "Libraries updated";
        setTimeout(() => { setupStatus = ""; setupLog = []; }, 3000);
        setTimeout(() => { if (statusMsg === "Libraries updated") statusMsg = ""; }, 3000);
        loadLibraryTree();
        // Re-probe so the lib update chip clears when there's nothing more
        bgsd?.checkUpdates?.().then((info: any) => { if (info) updateInfo = info; }).catch(() => {});
      } else {
        setupStatus = `Update failed: ${res.error}`;
        statusMsg = `Update failed: ${res.error}`;
        setTimeout(() => { setupStatus = ""; setupLog = []; }, 5000);
      }
    } catch (err: any) {
      setupStatus = `Update failed: ${err.message}`;
      statusMsg = `Update failed: ${err.message}`;
      setTimeout(() => { setupStatus = ""; setupLog = []; }, 5000);
    }
    setupBusy = false;
  }

  // --- Library browser helpers ---

  async function loadLibraryTree() {
    const bgsd = (window as any).bgsd;
    const res = await bgsd?.getLibraryTree?.();
    if (res?.ok) {
      libraryTreeRaw = JSON.stringify(res.tree || {});
    }
  }

  async function openLibraryFile(filePath: string) {
    const bgsd = (window as any).bgsd;
    // Copy the template to a user-chosen location, then open the copy
    const copy = await bgsd?.copyTemplate?.(filePath);
    if (!copy?.ok) return; // user cancelled or error
    const loaded = await bgsd?.loadFilePath?.(copy.filePath);
    if (loaded?.ok) handleLoad(loaded);
    else statusMsg = `Failed to open: ${loaded?.error || "unknown"}`;
  }

  async function editFile(filePath: string) {
    libMenu = null;
    const bgsd = (window as any).bgsd;
    const loaded = await bgsd?.loadFilePath?.(filePath);
    if (loaded?.ok) handleLoad(loaded);
    else statusMsg = `Failed to open: ${loaded?.error || "unknown"}`;
  }

  async function deleteLibraryFile(filePath: string) {
    libMenu = null;
    const name = filePath.replace(/.*[/\\]/, "");
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.deleteFile?.(filePath);
    if (!result) { statusMsg = "Delete unavailable"; return; }
    if (result.ok) {
      if (sameLocalPath(filePath, currentFilePath) || sameLocalPath(filePath, getFilePath())) {
        externalFileChange = null;
        clearExternalFileChange();
        rememberFilePath(null);
        rememberReadOnly(false);
        setFileState(null);
        setNeedsBackup(false);
        updateTitle("");
        fileLoaded = false;
      }
      statusMsg = "Deleted";
      setTimeout(() => { statusMsg = ""; }, 2000);
      loadLibraryTree();
    } else {
      statusMsg = `Delete failed: ${result.error}`;
    }
  }

  async function renameLibraryFile(filePath: string, newName: string) {
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.renameFile?.(filePath, newName);
    if (!result) { statusMsg = "Rename unavailable"; return; }
    if (result.ok) {
      statusMsg = "Renamed";
      setTimeout(() => { statusMsg = ""; }, 2000);
      loadLibraryTree();
    } else {
      statusMsg = `Rename failed: ${result.error}`;
    }
  }

  async function duplicateLibraryFile(filePath: string) {
    libMenu = null;
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.duplicateFile?.(filePath);
    if (!result) { statusMsg = "Duplicate unavailable"; return; }
    if (result.ok) {
      const name = (result.filePath || "").replace(/.*[/\\]/, "");
      statusMsg = `Duplicated → ${name}`;
      setTimeout(() => { if (statusMsg.startsWith("Duplicated → ")) statusMsg = ""; }, 2500);
      loadLibraryTree();
    } else {
      statusMsg = `Duplicate failed: ${result.error}`;
    }
  }

  async function exportStl(filePath: string) {
    libMenu = null;
    statusMsg = "Exporting STL...";
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.exportStl?.(filePath);
    if (!result) { statusMsg = "Export unavailable"; return; }
    if (result.ok) {
      const count = Array.isArray(result.files) ? result.files.length : 1;
      statusMsg = count > 1 ? `Exported ${count} STL files` : `Exported: ${result.filePath}`;
    }
    else if (result.error === "not-found") statusMsg = "OpenSCAD not found — set its path in Preferences";
    else if (result.error) statusMsg = `Export failed: ${result.error}`;
    else statusMsg = "Export cancelled";
  }

  // --- Schema lookup (reactive based on active profile) ---
  let activeSchema = $derived(getSchema($project.libraryProfile || "bit"));
  type ParameterRow = {
    key: string;
    def: any;
    lineIndex: number | null;
    value: any;
    isReal: boolean;
    depth?: number;
  };
  type ParameterGroup = {
    id: string;
    label: string;
    rows: ParameterRow[];
    changedCount: number;
    depth: number;
  };

  let ALL_KEYS = $derived.by(() => {
    const s = new Set<string>();
    for (const ctx of Object.values((activeSchema as any).contexts || {})) {
      for (const k of Object.keys((ctx as any).keys || {})) s.add(k);
    }
    for (const k of Object.keys((activeSchema as any).globals || {})) s.add(k);
    return s;
  });

  let KEY_TYPE_MAP = $derived.by(() => {
    const m: Record<string, string> = {};
    for (const ctx of Object.values((activeSchema as any).contexts || {})) {
      for (const [k, def] of Object.entries((ctx as any).keys || {})) m[k] = (def as any).type;
    }
    for (const [k, def] of Object.entries((activeSchema as any).globals || {})) m[k] = (def as any).type;
    return m;
  });

  let KEY_SCHEMA_MAP = $derived.by(() => {
    const m: Record<string, any> = {};
    for (const ctx of Object.values((activeSchema as any).contexts || {})) {
      for (const [k, def] of Object.entries((ctx as any).keys || {})) m[k] = def;
    }
    for (const [k, def] of Object.entries((activeSchema as any).globals || {})) m[k] = def;
    return m;
  });

  const KNOWN_CONSTANTS: Record<string, any> = {
    BOX:"BOX",DIVIDERS:"DIVIDERS",SPACER:"SPACER",
    OBJECT_BOX:"OBJECT_BOX",OBJECT_DIVIDERS:"OBJECT_DIVIDERS",OBJECT_SPACER:"OBJECT_SPACER",
    SQUARE:"SQUARE",
    HEX:"HEX",HEX2:"HEX2",OCT:"OCT",OCT2:"OCT2",ROUND:"ROUND",FILLET:"FILLET",
    INTERIOR:"INTERIOR",EXTERIOR:"EXTERIOR",BOTH:"BOTH",
    FRONT:"FRONT",BACK:"BACK",LEFT:"LEFT",RIGHT:"RIGHT",
    FRONT_WALL:"FRONT_WALL",BACK_WALL:"BACK_WALL",LEFT_WALL:"LEFT_WALL",RIGHT_WALL:"RIGHT_WALL",
    X:"X",Y:"Y",
    CENTER:"CENTER",BOTTOM:"BOTTOM",AUTO:"AUTO",MAX:"MAX",
    SHAPE_SQUARE:"SHAPE_SQUARE",SHAPE_CIRCLE:"SHAPE_CIRCLE",
    SHAPE_TRIANGLE:"SHAPE_TRIANGLE",SHAPE_HEX:"SHAPE_HEX",
    COUNTER_SET:"COUNTER_SET",
    true:true,false:false,t:true,f:false,
  };

  function parseSimpleValue(text: string): { value: any; ok: boolean } {
    const t = text.trim();
    if (t === "true" || t === "t") return { value: true, ok: true };
    if (t === "false" || t === "f") return { value: false, ok: true };
    if (t in KNOWN_CONSTANTS) return { value: KNOWN_CONSTANTS[t], ok: true };
    const sm = t.match(/^"([^"]*)"$/);
    if (sm) return { value: sm[1], ok: true };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { value: parseFloat(t), ok: true };
    const am = t.match(/^\[(.+)\]$/);
    if (am) {
      const inner = am[1];
      if (inner.includes("[")) return { ok: false, value: null };
      const parts = inner.split(",").map((s: string) => s.trim());
      const vals: any[] = []; let hasExpr = false;
      for (const part of parts) {
        const sub = parseSimpleValue(part);
        if (!sub.ok) { vals.push(part); hasExpr = true; }
        else { vals.push(hasExpr ? String(sub.value) : sub.value); }
      }
      if (hasExpr) return { value: vals.map(String), ok: true };
      return { value: vals, ok: true };
    }
    // Bare identifier (variable reference, including $-prefixed OpenSCAD vars)
    if (/^[a-zA-Z_$]\w*$/.test(t)) return { value: t, ok: true };
    return { ok: false, value: null };
  }

  function parseNumberOrFalse(text: string): number | false {
    const t = text.trim().toLowerCase();
    if (t === "false" || t === "f") return false;
    return parseNum(text);
  }

  function parseXyzOrFalse(text: string): any {
    const t = text.trim().toLowerCase();
    if (t === "false" || t === "f") return false;
    const parsed = parseSimpleValue(text);
    return parsed.ok ? parsed.value : text.trim();
  }

  function parseFlexibleValue(text: string): any {
    const parsed = parseSimpleValue(text);
    return parsed.ok ? parsed.value : text.trim();
  }

  const KV_RE = /^\s*\[\s*([_A-Z][A-Z0-9_]*)\s*,\s*(.*?)\s*\]\s*,?\s*(?:\/\/.*)?$/;

  let GLOBAL_NAMES = $derived(new Set(Object.keys((activeSchema as any).globals || {})));

  function classifyLocal(raw: string, depth: number = 0): Line {
    // v3 file-scope globals: g_tolerance = 0.1; → convert key to G_TOLERANCE
    const bm = raw.match(/^\s*(g_\w+)\s*=\s*(true|false|t|f|0|1)\s*;\s*(?:\/\/.*)?$/i);
    if (bm) { const gk = bm[1].toUpperCase(); if (GLOBAL_NAMES.has(gk)) { const v = bm[2].toLowerCase(); return { raw, kind: "global", depth, globalKey: gk, globalValue: v === "true" || v === "t" || v === "1" }; } }
    const nm = raw.match(/^\s*(g_\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*(?:\/\/.*)?$/i);
    if (nm) { const gk = nm[1].toUpperCase(); if (GLOBAL_NAMES.has(gk)) return { raw, kind: "global", depth, globalKey: gk, globalValue: parseFloat(nm[2]) }; }
    const sm = raw.match(/^\s*(g_\w+)\s*=\s*"([^"]*)"\s*;\s*(?:\/\/.*)?$/i);
    if (sm) { const gk = sm[1].toUpperCase(); if (GLOBAL_NAMES.has(gk)) return { raw, kind: "global", depth, globalKey: gk, globalValue: sm[2] }; }
    const gm = raw.match(/^\s*(g_\w+)\s*=\s*(.+?)\s*;\s*(?:\/\/.*)?$/i);
    if (gm) {
      const gk = gm[1].toUpperCase();
      if (GLOBAL_NAMES.has(gk)) {
        const parsed = parseSimpleValue(gm[2]);
        if (parsed.ok) return { raw, kind: "global", depth, globalKey: gk, globalValue: parsed.value };
      }
    }
    if (/^\s*include\s*<\s*(?:\.\.\/lib\/)?boardgame_insert_toolkit_lib\.\d+(?:\.\d+){0,2}\.scad\s*>\s*;?\s*(?:\/\/.*)?$/i.test(raw)) return { raw, kind: "include", depth };
    if (/^\s*include\s*<\s*(?:\.\.\/lib\/)?counter_tray_designer_lib\.\d+\.scad\s*>\s*;?\s*(?:\/\/.*)?$/i.test(raw)) return { raw, kind: "include", depth };
    if (/^\s*\/\/\s*(?:BGSD|BITGUI)\b/i.test(raw)) return { raw, kind: "marker", depth };
    const makeM = raw.match(/^\s*Make\s*\(\s*(\w+)\s*\)\s*;\s*(?:\/\/.*)?$/);
    if (/^\s*MakeAll\s*\(\s*\)\s*;\s*(?:\/\/.*)?$/.test(raw) || makeM) return { raw, kind: "makeall", depth, varName: makeM?.[1] || "data" };
    // Standalone comment (but not BGSD/BITGUI markers, already handled above)
    const cm = raw.match(/^\s*\/\/(.*)$/);
    if (cm && !/^\s*\/\/\s*(?:BGSD|BITGUI)\b/i.test(raw)) return { raw, kind: "comment", depth, comment: cm[1].trim() };
    // Variable assignment (skip g_* names handled by globals)
    const vm = raw.match(/^\s*([A-Za-z_$]\w*)\s*=\s*(.+?)\s*;\s*(?:\/\/.*)?$/);
    if (vm && !/^g_/i.test(vm[1])) return { raw, kind: "variable", depth, varName: vm[1], varValue: vm[2].trim() };
    // KV line
    const kv = raw.match(KV_RE);
    // v4 inline globals: [ G_TOLERANCE, 0.1 ] → kind: "global" (BIT only; CTD treats all scene KVs as regular params)
    if (kv && $project.libraryProfile !== "ctd" && GLOBAL_NAMES.has(kv[1])) { const p = parseSimpleValue(kv[2]); if (p.ok) return { raw, kind: "global", depth, globalKey: kv[1], globalValue: p.value, inlineGlobal: true }; }
    if (kv && ALL_KEYS.has(kv[1])) { const p = parseSimpleValue(kv[2]); if (p.ok) return { raw, kind: "kv", depth, kvKey: kv[1], kvValue: p.value }; }
    // Brackets are never produced by classifyLocal — they only come from the importer's stack-based parsing.
    return { raw, kind: "raw", depth };
  }

  function handleLineEdit(i: number, newRaw: string) { replaceLine(i, classifyLocal(newRaw, $project.lines[i]?.depth ?? 0)); }
  function getKeyType(k: string) { return KEY_TYPE_MAP[k] || "unknown"; }
  function getKeySchema(k: string) { return KEY_SCHEMA_MAP[k] || null; }
  function getStep(k: string): string { return KEY_SCHEMA_MAP[k]?.step != null ? String(KEY_SCHEMA_MAP[k].step) : "any"; }
  function parseNum(s: string) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
  function smartParseNum(s: string) { const t = s.trim(); return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : t; }
  function updateKvIdx(li: number, arr: any[], j: number, val: any) { const c = [...arr]; c[j] = val; updateKv(li, c); }
  function canParse(raw: string) { return classifyLocal(raw).kind !== "raw"; }
  function handleStandaloneCommentEdit(i: number, text: string) {
    const indent = $project.lines[i].raw.match(/^(\s*)/)?.[0] || "";
    updateLineRaw(i, text.trim() ? `${indent}// ${text.trim()}` : `${indent}//`);
    project.update(p => { p.lines[i].comment = text.trim(); return { ...p }; });
  }
  const i18n = tooltips as Record<string, { label?: string; tooltip?: string }>;
  function tip(key: string): string { return i18n[key]?.tooltip || ""; }
  function label(key: string): string { return i18n[key]?.label || key; }
  function unitForSchema(key: string, def: any): string {
    const explicit = typeof def?.unit === "string" ? def.unit : typeof def?.units === "string" ? def.units : "";
    if (explicit.trim()) return explicit.trim();
    const upperKey = key.toUpperCase();
    const metadata = `${def?.help || ""} ${tip(key)}`.toLowerCase();
    if (upperKey.includes("_PCT") || metadata.includes("%") || /\bpercent\b/.test(metadata)) return "%";
    if (/\bdegrees?\b/.test(metadata)) return "deg";
    if (/\bmm\b|\d\s*mm\b|millimet(?:er|re)/.test(metadata)) return "mm";
    return "";
  }
  function unitForField(key: string, def: any): string {
    if (!["number", "number_or_false", "xyz_or_false", "xy", "xyz", "position_xy", "4num"].includes(def?.type)) return "";
    return unitForSchema(key, def);
  }
  function toRaw(i: number) {
    const l = $project.lines[i];
    if (!l || l.kind === "open" || l.kind === "close") return; // brackets are never raw
    replaceLine(i, { raw: l.raw, kind: "raw", depth: l.depth });
  }
  function toParsed(i: number) { const l = $project.lines[i]; if (!l) return; const c = classifyLocal(l.raw, l.depth); if (c.kind !== "raw") replaceLine(i, c); }

  /** Which preset dropdown is currently open (field key like "COUNTER_SIZE_XYZ"), or null. */
  let presetOpen = $state<string | null>(null);

  /** Close preset dropdown when clicking outside. */
  $effect(() => {
    if (!presetOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".preset-wrap")) presetOpen = null;
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  });

  $effect(() => {
    if (!showFileMenu && !showViewMenu) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".file-menu-wrap")) showFileMenu = false;
      if (!target.closest(".view-menu-wrap")) showViewMenu = false;
    }
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        showFileMenu = false;
        showViewMenu = false;
      }
    }
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeydown, true);
    };
  });

  $effect(() => {
    if (!diagnosticsOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".diagnostics-wrap")) diagnosticsOpen = false;
    }
    function handleKeydown(e: KeyboardEvent) {
      if (e.key === "Escape") diagnosticsOpen = false;
    }
    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeydown, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeydown, true);
    };
  });

  /** Look up a preset's display value by constant name. */
  function resolvePresetValue(name: string): string {
    for (const entries of Object.values($presets)) {
      const found = entries.find((e: any) => e.name === name);
      if (found) return found.value;
    }
    return name;
  }

  /** Derive the per-component preset field for axis j of a schema key.
   *  e.g. componentPresetField("COUNTER_SIZE_XYZ", 0) → "COUNTER_SIZE_X" */
  function componentPresetField(key: string, j: number): string | null {
    const axes = ["X", "Y", "Z"];
    const base = key.replace(/_(XYZ|XY)$/, "");
    if (base === key) return null; // no suffix to strip
    const field = `${base}_${axes[j]}`;
    return ($presets[field]?.length) ? field : null;
  }

  /** Check if a key is in the user's favorites. */
  function isFavorite(key: string): boolean {
    return favoriteKeys.has(key);
  }

  /** Keys currently fading out after being unfavorited in "favorites" mode. */
  let fadingOutKeys = $state(new Set<string>());

  /** Toggle a key's favorite status and immediately persist to preferences. */
  async function toggleFavorite(key: string) {
    const removing = favoriteKeys.has(key);
    const next = new Set(favoriteKeys);
    if (removing) next.delete(key); else next.add(key);
    favoriteKeys = next;
    // Fade out if unfavoriting while in favorites-only mode
    if (removing && defaultsMode === "favorites") {
      fadingOutKeys = new Set([...fadingOutKeys, key]);
      setTimeout(() => {
        fadingOutKeys = new Set([...fadingOutKeys].filter(k => k !== key));
      }, 300);
    }
    const bgsd = (window as any).bgsd;
    await bgsd?.setPreferences?.({ favoriteKeys: [...next] });
  }

  /** Set of line indices currently in raw-value editing mode (text input for value only). */
  let rawValueEditing = $state(new Set<number>());

  /** Toggle a line's value between structured controls and a raw text input. */
  function toggleRawValueEdit(index: number) {
    const next = new Set(rawValueEditing);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    rawValueEditing = next;
  }

  /** Materialize a virtual KV row and enter raw value editing mode. */
  function materializeAndEditRawValue(closeIndex: number, key: string, def: any, depth: number) {
    materializeKv(closeIndex, key, def.default, depth);
    rawValueEditing = new Set([...rawValueEditing, closeIndex]);
  }

  /** Materialize a virtual global and enter raw value editing mode. */
  function materializeGlobalAndEditRawValue(key: string, def: any) {
    const idx = findGlobalInsertIndex();
    materializeGlobal(idx, key, def.default);
    rawValueEditing = new Set([...rawValueEditing, idx]);
  }

  /** Handle blur on a raw value text input: parse and update. */
  function handleRawValueBlur(index: number, text: string, schemaDefault?: any, isGlobal: boolean = false) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const parsed = parseSimpleValue(trimmed);
    if (parsed.ok) {
      if (isGlobal) {
        updateGlobalWithDefault(index, parsed.value, schemaDefault);
      } else {
        updateKv(index, parsed.value, schemaDefault);
      }
    }
  }

  /**
   * For each line index, rawGroupStart[i] is:
   *  - i itself if line i is "raw" and is the first in a contiguous run of raw lines
   *  - -1 if line i is "raw" but NOT the first in its group (skip rendering)
   *  - undefined if line i is not "raw"
   * rawGroupEnd[i] = last index (exclusive) of the raw group starting at i.
   */
  let rawGroups = $derived.by(() => {
    const lines = $project.lines;
    const startOf: Record<number, number> = {}; // startIndex → count
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind === "raw") {
        const start = i;
        while (i < lines.length && lines[i].kind === "raw") i++;
        startOf[start] = i - start;
      } else {
        i++;
      }
    }
    return startOf;
  });

  /** True if this close line is the last block of its kind in a sibling series. */
  function isLastOfKind(i: number): boolean {
    const line = $project.lines[i];
    if (!line || line.kind !== "close") return false;
    for (let j = i + 1; j < $project.lines.length; j++) {
      const next = $project.lines[j];
      if (next.kind === "blank" || next.kind === "comment") continue;
      return !(next.kind === "open" && next.label === line.label);
    }
    return true;
  }

  function isRawGroupStart(i: number): boolean {
    return i in rawGroups;
  }
  function isRawGroupMember(i: number): boolean {
    // Check if this index is inside a group but not the start
    const lines = $project.lines;
    return lines[i]?.kind === "raw" && !(i in rawGroups);
  }
  function rawGroupText(startIndex: number): string {
    const count = rawGroups[startIndex] || 1;
    return $project.lines.slice(startIndex, startIndex + count).map(l => l.raw).join("\n");
  }
  function rawGroupLineCount(startIndex: number): number {
    return rawGroups[startIndex] || 1;
  }

  /** When a raw group textarea is edited, re-split into raw lines (no re-classification). */
  function handleRawGroupEdit(startIndex: number, newText: string) {
    const oldCount = rawGroups[startIndex] || 1;
    const oldText = rawGroupText(startIndex);
    // If nothing changed, do nothing.
    if (newText === oldText) return;
    // If all whitespace, delete the block entirely.
    if (newText.trim() === "") {
      spliceLines(startIndex, oldCount, []);
      return;
    }
    const depth = $project.lines[startIndex]?.depth ?? 0;
    const newRawLines = newText.split("\n");
    // Keep as raw — don't re-classify. The user can use the full reimport
    // (via the importer) if they want to convert to structured.
    const newLines: Line[] = newRawLines
      .filter(r => r.trim() !== "")
      .map(r => ({ raw: r, kind: "raw" as const, depth }));
    if (newLines.length === 0) {
      newLines.push({ raw: "    ".repeat(depth), kind: "raw", depth });
    }
    spliceLines(startIndex, oldCount, newLines);
  }

  // --- Debug highlight toggle (on object/feature open brackets) ---
  function getDebugState(openIdx: number): { active: boolean; kvIndex: number | null } {
    const closeIdx = findMatchingClose(openIdx);
    for (let j = openIdx + 1; j < closeIdx; j++) {
      const l = $project.lines[j];
      if (l.kind === "kv" && l.kvKey === "DEBUG_B") {
        return { active: l.kvValue === true, kvIndex: j };
      }
    }
    return { active: false, kvIndex: null };
  }

  function toggleDebug(openIdx: number) {
    const { active, kvIndex } = getDebugState(openIdx);
    if (active && kvIndex !== null) {
      deleteLine(kvIndex);
    } else {
      const depth = ($project.lines[openIdx].depth ?? 0) + 1;
      materializeKv(openIdx + 1, "DEBUG_B", true, depth);
    }
  }

  const DEPTH_PX = 24;
  // GUTTER_PX reserves space at every row's left edge for the diagnostic
  // marker. With this gutter, the warning triangle lives in its own strip
  // fully to the left of the line content at every depth.
  const GUTTER_PX = 22;
  function pad(line: Line) { return `padding-left: ${GUTTER_PX + (line.depth ?? 0) * DEPTH_PX}px`; }
  function padDepth(d: number) { return `padding-left: ${GUTTER_PX + d * DEPTH_PX}px`; }

  // Hierarchy is rendered in CSS via a single cold-monochrome ramp keyed off
  // --depth (each level brighter than the one above). Inline style only carries
  // the depth and indent; CSS computes the slate ramp colors.
  function bracketStyle(depth: number): string {
    const d = depth ?? 0;
    const indent = Math.max(0, d * DEPTH_PX);
    return `--depth: ${d}; --indent: ${indent}px`;
  }

  // --- Collapse/expand ---
  let collapsed = $state(new Set<number>());
  let collapsedVirtual = $state(new Set<string>());
  let editorPadBottom = $state(0);

  // Slide animation is gated by two flags. `mounted` keeps the initial
  // render from sliding every row in. `collapseAnimating` confines the
  // slide to a ~220ms window opened by toggleCollapse(Virtual) so that
  // virtualise / materialise side-effects elsewhere stay snappy.
  let mounted = $state(false);
  let collapseAnimating = $state(false);
  const slideDur = $derived(mounted && collapseAnimating ? 200 : 0);

  async function toggleCollapse(i: number) {
    collapseAnimating = true;
    setTimeout(() => { collapseAnimating = false; }, 220);
    const container = document.querySelector('[data-testid="content-area"]') as HTMLElement | null;
    const scrollBefore = container?.scrollTop ?? 0;
    const heightBefore = container?.scrollHeight ?? 0;

    const next = new Set(collapsed);
    const isCollapsing = !next.has(i);
    if (isCollapsing) next.add(i); else next.delete(i);
    collapsed = next;

    if (container) {
      await tick();
      const heightAfter = container.scrollHeight;
      const shrink = heightBefore - heightAfter;
      if (isCollapsing && shrink > 0) {
        // Add padding so content above the collapsed block doesn't shift
        editorPadBottom = Math.max(0, editorPadBottom + shrink);
      } else if (!isCollapsing && editorPadBottom > 0) {
        // Remove padding when expanding, but don't go negative
        const grow = heightAfter - heightBefore;
        editorPadBottom = Math.max(0, editorPadBottom - grow);
      }
      await tick(); // Wait for padding update to reach DOM
      container.scrollTop = scrollBefore;
    }
  }

  async function toggleCollapseVirtual(key: string) {
    collapseAnimating = true;
    setTimeout(() => { collapseAnimating = false; }, 220);
    const container = document.querySelector('[data-testid="content-area"]') as HTMLElement | null;
    const scrollBefore = container?.scrollTop ?? 0;
    const heightBefore = container?.scrollHeight ?? 0;

    const next = new Set(collapsedVirtual);
    const isCollapsing = !next.has(key);
    if (isCollapsing) next.add(key); else next.delete(key);
    collapsedVirtual = next;

    if (container) {
      await tick();
      const heightAfter = container.scrollHeight;
      const shrink = heightBefore - heightAfter;
      if (isCollapsing && shrink > 0) {
        editorPadBottom = Math.max(0, editorPadBottom + shrink);
      } else if (!isCollapsing && editorPadBottom > 0) {
        const grow = heightAfter - heightBefore;
        editorPadBottom = Math.max(0, editorPadBottom - grow);
      }
      await tick();
      container.scrollTop = scrollBefore;
    }
  }

  /** Find the matching close bracket index for an open at `openIdx`. */
  function findMatchingClose(openIdx: number): number {
    let depth = 0;
    for (let j = openIdx; j < $project.lines.length; j++) {
      if ($project.lines[j].kind === "open") depth += ($project.lines[j] as any).mergedOpen ? 2 : 1;
      if ($project.lines[j].kind === "close") {
        depth -= ($project.lines[j] as any).mergedClose ? 2 : 1;
        if (depth <= 0) return j;
      }
    }
    return -1;
  }

  /** Find the parent open bracket for a line at `lineIndex`. */
  function findParentOpen(lineIndex: number): number {
    let bd = 0;
    for (let j = lineIndex - 1; j >= 0; j--) {
      const l = $project.lines[j];
      if (l.kind === "close") bd += (l as any).mergedClose ? 2 : 1;
      if (l.kind === "open") {
        bd -= (l as any).mergedOpen ? 2 : 1;
        if (bd < 0) return j;
      }
    }
    return -1;
  }

  /**
   * Check if line at index `i` should be hidden because a parent open bracket is collapsed.
   * We need to check all open brackets above this line.
   */
  let hiddenLines = $derived.by(() => {
    const hidden = new Set<number>();
    const lines = $project.lines;
    for (const openIdx of collapsed) {
      if (openIdx >= lines.length || lines[openIdx].kind !== "open") continue;
      const closeIdx = findMatchingClose(openIdx);
      if (closeIdx < 0) continue;
      // Hide everything between open and close (exclusive of both)
      // Also hide the close bracket itself — we'll show "]" inline on the open line
      for (let j = openIdx + 1; j <= closeIdx; j++) {
        hidden.add(j);
      }
    }
    return hidden;
  });

  // Map role → schema context for virtual defaults
  const ROLE_TO_CONTEXT: Record<string, string> = {
    params: "element",
    feature: "feature",
    feature_list: "feature",
    box_group: "group",
    group_params: "group",
    feature_copy: "copy",
    copy_params: "copy",
    feature_divider_params: "feature_divider",
    visualization: "visualization",
    visualization_params: "visualization",
    label_params: "label",
    lid_params: "lid",
    counter_set_params: "counter_set",
  };

  // For merged closes, map outer role → inner role
  const MERGED_INNER_ROLE: Record<string, string> = {
    object: "params",
    feature_list: "feature",
    box_group: "group_params",
    feature_copy: "copy_params",
    feature_dividers: "feature_divider_params",
    visualization: "visualization_params",
    label: "label_params",
    lid: "lid_params",
    counter_set: "counter_set_params",
  };

  /** Find the object label for a close bracket (to resolve element vs divider context). */
  function findObjectLabel(closeIndex: number): string {
    let bd = 0;
    for (let i = closeIndex; i >= 0; i--) {
      if ($project.lines[i].kind === "close") bd += ($project.lines[i] as any).mergedClose ? 2 : 1;
      if ($project.lines[i].kind === "open") {
        bd -= ($project.lines[i] as any).mergedOpen ? 2 : 1;
        if (bd <= 0) return $project.lines[i].label || "";
      }
    }
    return "";
  }

  /** Get schema context for a close line, handling both normal and merged closes. */
  function getCloseContext(line: Line, closeIndex?: number): string | undefined {
    const role = line.role || "";
    let ctx: string | undefined;
    if (ROLE_TO_CONTEXT[role]) {
      ctx = ROLE_TO_CONTEXT[role];
    } else if (line.mergedClose) {
      const innerRole = MERGED_INNER_ROLE[role];
      if (innerRole) ctx = ROLE_TO_CONTEXT[innerRole];
    } else if (role === "object" && !line.mergedClose) {
      // Non-merged object close: children are direct (like params)
      if ($project.libraryProfile === "ctd") {
        const label = closeIndex != null ? findObjectLabel(closeIndex) : "";
        ctx = label === "LID" ? "lid" : "tray";
      } else {
        ctx = "element";
      }
    } else if (role === "counter_set" && !line.mergedClose) {
      // Non-merged counter_set close: children are direct (like counter_set_params)
      ctx = "counter_set";
    } else if (role === "lid" && !line.mergedClose) {
      // Non-merged BOX_LID close (flat format from addLid or single-bracket import):
      // children are direct kv pairs at depth+1, like lid_params
      ctx = "lid";
    } else if (role === "feature_dividers" && !line.mergedClose) {
      // Non-merged FTR_DIVIDERS close: children are direct kv pairs
      ctx = "feature_divider";
    } else if (role === "box_group" && !line.mergedClose) {
      // Non-merged FEATURE_GROUP close: children are direct kv pairs / child blocks
      ctx = "group";
    } else if (role === "feature_copy" && !line.mergedClose) {
      // Non-merged FEATURE_COPY close: children are direct kv pairs
      ctx = "copy";
    } else if (role === "visualization" && !line.mergedClose) {
      // Non-merged BOX_VISUALIZATION close: children are direct kv pairs
      ctx = "visualization";
    } else if (role === "label" && !line.mergedClose) {
      // Non-merged LABEL close (flat format from addLabel): children are direct kv pairs
      ctx = "label";
    }
    // If we resolved to "element", check if this is actually a divider
    if (ctx === "element" && closeIndex != null) {
      const label = findObjectLabel(closeIndex);
      if (label === "OBJECT_DIVIDERS") return "divider";
    }
    return ctx;
  }

  // Get all scalar schema keys for a context (skip table/table_list)
  function getScalarKeysForContext(ctx: string): { key: string; def: any }[] {
    const ctxDef = (activeSchema as any).contexts?.[ctx];
    if (!ctxDef) return [];
    return Object.entries(ctxDef.keys || {})
      .filter(([_, d]: [string, any]) => d.type !== "table" && d.type !== "table_list")
      .map(([k, d]) => ({ key: k, def: d }));
  }

  /**
   * For a close bracket, compute a unified sorted list of all schema keys:
   * both real (existing kv lines) and virtual (missing, shown with defaults).
   * Returns { key, def, lineIndex?, value, isReal, depth }[] sorted alphabetically.
   */
  function getSortedSchemaRows(closeIndex: number): {
    key: string; def: any; lineIndex: number | null; value: any; isReal: boolean; depth: number;
  }[] {
    const closeLine = $project.lines[closeIndex];
    if (!closeLine || closeLine.kind !== "close") return [];
    const ctx = getCloseContext(closeLine, closeIndex);
    // For CTD data close brackets, use globals schema for virtual defaults
    const isCTDData = !ctx && closeLine.role === "data" && $project.libraryProfile === "ctd";
    if (!ctx && !isCTDData) return [];

    // Find matching open bracket (merged brackets count as 2)
    let bd = 0;
    let openIdx = -1;
    for (let i = closeIndex; i >= 0; i--) {
      if ($project.lines[i].kind === "close") bd += ($project.lines[i] as any).mergedClose ? 2 : 1;
      if ($project.lines[i].kind === "open") {
        bd -= ($project.lines[i] as any).mergedOpen ? 2 : 1;
        if (bd <= 0) { openIdx = i; break; }
      }
    }
    if (openIdx < 0) return [];

    const childDepth = (closeLine.depth ?? 0) + 1;

    // Collect existing kv lines
    const existingMap = new Map<string, { lineIndex: number; value: any }>();
    for (let i = openIdx + 1; i < closeIndex; i++) {
      const l = $project.lines[i];
      if (l.kind === "kv" && l.kvKey && l.depth === childDepth) {
        existingMap.set(l.kvKey, { lineIndex: i, value: l.kvValue });
      }
    }

    const scalars = isCTDData
      ? Object.entries(GLOBAL_SCHEMA)
          .filter(([_, d]: [string, any]) => d.type !== "table" && d.type !== "table_list")
          .map(([k, d]) => ({ key: k, def: d }))
      : getScalarKeysForContext(ctx!);
    const rows = scalars.map(({ key, def }) => {
      const existing = existingMap.get(key);
      if (existing) {
        return { key, def, lineIndex: existing.lineIndex, value: existing.value, isReal: true, depth: childDepth };
      }
      return { key, def, lineIndex: null, value: def.default, isReal: false, depth: childDepth };
    });

    // Sort alphabetically
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows;
  }

  /** Get sorted schema rows for an open bracket (delegates to its matching close). */
  function getSortedSchemaRowsForOpen(openIndex: number): {
    key: string; def: any; lineIndex: number | null; value: any; isReal: boolean; depth: number;
  }[] {
    const closeIdx = findMatchingClose(openIndex);
    if (closeIdx < 0) return [];
    return getSortedSchemaRows(closeIdx);
  }

  /**
   * Set of line indices that are kv lines rendered inside a sorted schema block.
   * These should be skipped in the main line loop.
   */
  let kvRenderedInBlock = $derived.by(() => {
    const set = new Set<number>();
    const lines = $project.lines;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].kind !== "close") continue;
      const rows = getSortedSchemaRows(i);
      for (const r of rows) {
        if (r.lineIndex !== null) set.add(r.lineIndex);
      }
    }
    return set;
  });

  /** When a virtual default is changed from its default value, materialize it. */
  function onVirtualChange(closeIndex: number, key: string, def: any, newValue: any) {
    if (JSON.stringify(newValue) === JSON.stringify(def.default)) return;
    const depth = (($project.lines[closeIndex]?.depth ?? 0)) + 1;
    materializeKv(closeIndex, key, newValue, depth);
  }

  /** Delete a real kv line (dematerialize back to virtual default).
   *  If this empties a parent lid block, remove the block too. */
  function dematerializeKv(lineIndex: number) {
    const parentOpenIdx = findParentOpen(lineIndex);
    const isLidParent = parentOpenIdx >= 0 && $project.lines[parentOpenIdx].role === "lid";
    deleteLine(lineIndex);
    if (isLidParent) {
      const closeIdx = findMatchingClose(parentOpenIdx);
      if (closeIdx > parentOpenIdx) {
        let hasContent = false;
        for (let j = parentOpenIdx + 1; j < closeIdx; j++) {
          if ($project.lines[j].kind !== "close") { hasContent = true; break; }
        }
        if (!hasContent) deleteBlock(parentOpenIdx);
      }
    }
  }

  // --- Virtual globals ---

  let GLOBAL_SCHEMA = $derived((activeSchema as any).globals || {} as Record<string, any>);

  function getGlobalRows(): { key: string; def: any; lineIndex: number | null; value: any; isReal: boolean }[] {
    const lines = $project.lines;
    // Collect existing global lines
    const existingMap = new Map<string, { lineIndex: number; value: any }>();
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind === "global" && l.globalKey) {
        existingMap.set(l.globalKey, { lineIndex: i, value: l.globalValue });
      }
    }
    // Merge with schema globals
    const rows: { key: string; def: any; lineIndex: number | null; value: any; isReal: boolean }[] = [];
    for (const [key, def] of Object.entries(GLOBAL_SCHEMA)) {
      const existing = existingMap.get(key);
      if (existing) {
        rows.push({ key, def, lineIndex: existing.lineIndex, value: existing.value, isReal: true });
      } else {
        rows.push({ key, def, lineIndex: null, value: def.default, isReal: false });
      }
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return rows;
  }

  /** Set of line indices for global lines rendered in the virtual globals block. */
  let globalRenderedInBlock = $derived.by(() => {
    const set = new Set<number>();
    const rows = getGlobalRows();
    for (const r of rows) {
      if (r.lineIndex !== null) set.add(r.lineIndex);
    }
    return set;
  });

  /** Find where to insert a new global line: after the `data = [` open bracket. */
  function findGlobalInsertIndex(): number {
    const lines = $project.lines;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].kind === "open" && lines[i].role === "data") return i + 1;
    }
    return 0;
  }

  /** When a virtual global is changed, materialize it before data = [ */
  function onVirtualGlobalChange(key: string, def: any, newValue: any) {
    if (JSON.stringify(newValue) === JSON.stringify(def.default)) return;
    const idx = findGlobalInsertIndex();
    materializeGlobal(idx, key, newValue);
  }

  function isDefault(key: string, value: any): boolean {
    const def = KEY_SCHEMA_MAP[key];
    if (!def || def.default === undefined) return false;
    return JSON.stringify(value) === JSON.stringify(def.default);
  }

  function getSchemaDefault(key: string): any {
    return KEY_SCHEMA_MAP[key]?.default;
  }

  function getCategoryConfig(scope: string): { label: string; keys: string[] }[] {
    const categories = (activeSchema as any).categories || {};
    const raw = scope === "globals"
      ? categories.globals
      : categories.contexts?.[scope];
    if (!Array.isArray(raw)) return [];
    return raw
      .map((cat: any) => ({
        label: String(cat?.label || "Other"),
        keys: Array.isArray(cat?.keys) ? cat.keys.map(String) : [],
      }))
      .filter((cat: { label: string; keys: string[] }) => cat.keys.length > 0);
  }

  function categoryId(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
  }

  function parameterRowChanged(row: ParameterRow): boolean {
    return row.isReal && JSON.stringify(row.value) !== JSON.stringify(row.def?.default);
  }

  function shouldShowParameterRow(row: ParameterRow): boolean {
    if (row.isReal) return true;
    if (defaultsMode === "all") return true;
    if (defaultsMode === "favorites") return isFavorite(row.key) || fadingOutKeys.has(row.key);
    return false;
  }

  function groupRowsForDisplay(rows: ParameterRow[], scope: string, fallbackDepth: number = 0): ParameterGroup[] {
    const visibleRows = rows.filter(shouldShowParameterRow);
    if (!visibleRows.length) return [];

    const visibleByKey = new Map(visibleRows.map((row) => [row.key, row]));
    const used = new Set<string>();
    const groups: ParameterGroup[] = [];

    if (defaultsMode === "all") {
      const favoriteRows = visibleRows.filter((row) => isFavorite(row.key));
      if (favoriteRows.length) {
        for (const row of favoriteRows) used.add(row.key);
        groups.push({
          id: "favorites",
          label: "Favorites",
          rows: favoriteRows,
          changedCount: favoriteRows.filter(parameterRowChanged).length,
          depth: favoriteRows[0]?.depth ?? fallbackDepth,
        });
      }
    }

    for (const cat of getCategoryConfig(scope)) {
      const categoryRows = cat.keys
        .map((key) => visibleByKey.get(key))
        .filter((row): row is ParameterRow => !!row && !used.has(row.key));
      if (!categoryRows.length) continue;
      for (const row of categoryRows) used.add(row.key);
      groups.push({
        id: categoryId(cat.label),
        label: cat.label,
        rows: categoryRows,
        changedCount: categoryRows.filter(parameterRowChanged).length,
        depth: categoryRows[0]?.depth ?? fallbackDepth,
      });
    }

    const otherRows = visibleRows
      .filter((row) => !used.has(row.key))
      .sort((a, b) => a.key.localeCompare(b.key));
    if (otherRows.length) {
      groups.push({
        id: "other",
        label: "Other",
        rows: otherRows,
        changedCount: otherRows.filter(parameterRowChanged).length,
        depth: otherRows[0]?.depth ?? fallbackDepth,
      });
    }

    return groups;
  }

  function getSchemaScopeForOpen(openIndex: number): string {
    const closeIdx = findMatchingClose(openIndex);
    if (closeIdx < 0) return "";
    const closeLine = $project.lines[closeIdx];
    const ctx = getCloseContext(closeLine, closeIdx);
    if (ctx) return ctx;
    if (closeLine?.role === "data" && $project.libraryProfile === "ctd") return "globals";
    return "";
  }

  function groupScalarDefaultsForDisplay(rows: { key: string; def: any }[], scope: string, depth: number): ParameterGroup[] {
    return groupRowsForDisplay(rows.map((row) => ({
      key: row.key,
      def: row.def,
      lineIndex: null,
      value: row.def.default,
      isReal: false,
      depth,
    })), scope, depth);
  }

  /** Find the NAME kv value among immediate children of an open bracket. */
  function findChildName(openIdx: number): string {
    const closeIdx = findMatchingClose(openIdx);
    if (closeIdx < 0) return "";
    const childDepth = ($project.lines[openIdx].depth ?? 0) + 1;
    for (let j = openIdx + 1; j < closeIdx; j++) {
      const l = $project.lines[j];
      if (l.kind === "kv" && l.kvKey === "NAME" && l.depth === childDepth) return String(l.kvValue ?? "");
    }
    return "";
  }

  /** Append (" name") suffix if a NAME child exists. */
  function nameSuffix(lineIndex: number | undefined): string {
    if (lineIndex == null) return "";
    const name = findChildName(lineIndex);
    return name ? ` ("${name}")` : "";
  }

  // Structural label for open/close brackets.
  // Returns { text, inferred } where inferred=true means the label is our interpretation, not from the file.
  function structLabel(line: Line, lineIndex?: number): { text: string; inferred: boolean } {
    if (line.role === "data") return { text: line.varName || "data", inferred: false };
    if (line.role === "data_list") return { text: "data list", inferred: true };
    if (line.role === "object") {
      const rawLabel = line.label || "";
      if (rawLabel.startsWith("OBJECT_") || rawLabel === "TRAY" || rawLabel === "LID") {
        return { text: `${label(rawLabel)}${nameSuffix(lineIndex)}`, inferred: false };
      }
      return { text: `object "${rawLabel}"`, inferred: false };
    }
    if (line.role === "params") return { text: "object params", inferred: true };
    if (line.role === "feature_list") return { text: label(line.label || "BOX_FEATURE") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "feature") return { text: "feature list", inferred: true };
    if (line.role === "box_group") return { text: label(line.label || "FEATURE_GROUP") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "group_params") return { text: "group params", inferred: true };
    if (line.role === "feature_copy") return { text: label(line.label || "FEATURE_COPY") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "copy_params") return { text: "copy params", inferred: true };
    if (line.role === "feature_dividers") return { text: label(line.label || "FTR_DIVIDERS") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "feature_divider_params") return { text: "feature divider params", inferred: true };
    if (line.role === "visualization") return { text: label(line.label || "BOX_VISUALIZATION") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "visualization_params") return { text: "visualization params", inferred: true };
    if (line.role === "label") return { text: label(line.label || "LABEL") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "label_params") return { text: "label params", inferred: true };
    if (line.role === "lid") return { text: label(line.label || "BOX_LID") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "lid_params") return { text: "lid params", inferred: true };
    if (line.role === "counter_set") return { text: label("COUNTER_SET"), inferred: false };
    if (line.role === "counter_set_params") return { text: "counter_set params", inferred: true };
    if (line.role === "list") return { text: "list", inferred: true };
    return { text: label(line.label || "block") + nameSuffix(lineIndex), inferred: true };
  }

  // --- Scene names ---

  let sceneNames = $derived($project.lines
    .filter(l => l.kind === "open" && l.role === "data")
    .map(l => l.varName || "data"));

  function nextSceneName(): string {
    const existing = new Set($project.lines
      .filter(l => l.kind === "open" && l.role === "data")
      .map(l => l.varName));
    for (let n = 1; ; n++) {
      const name = `scene_${n}`;
      if (!existing.has(name)) return name;
    }
  }

  function handleSceneNameBlur(openIdx: number, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || !/^[A-Za-z_]\w*$/.test(trimmed)) {
      // Invalid or empty — auto-name
      updateSceneName(openIdx, nextSceneName());
    } else {
      updateSceneName(openIdx, trimmed);
    }
  }

  function handleMakeVarChange(lineIdx: number, newVarName: string) {
    project.update((p) => {
      const line = p.lines[lineIdx];
      if (!line || line.kind !== "makeall") return p;
      line.varName = newVarName;
      line.raw = `Make(${newVarName});`;
      return { ...p };
    });
  }

  function handleAddScene(afterIdx: number) {
    // Insert right after the previous scene's close. The single shared Make(...)
    // line stays at the bottom of the file — its scene-selector dropdown picks up
    // the new scene automatically.
    addScene(afterIdx, nextSceneName());
  }

  function handleDuplicateScene(openIdx: number) {
    const orig = $project.lines[openIdx]?.varName || "data";
    const existing = new Set(sceneNames);
    let candidate = `${orig}_copy`;
    let n = 2;
    while (existing.has(candidate)) candidate = `${orig}_copy_${n++}`;
    duplicateScene(openIdx, candidate);
  }

  // --- Comment editing ---
  let editingComment = $state<number | null>(null);

  function toggleCommentEdit(i: number) {
    editingComment = editingComment === i ? null : i;
  }

  /** Finalize a comment edit. If the comment is empty/whitespace and the value
   *  matches its schema default, dematerialize the line back to virtual. */
  function finalizeComment(i: number, comment: string) {
    const trimmed = comment.trim();
    const line = $project.lines[i];
    if (!line) { editingComment = null; return; }

    if (!trimmed) {
      if (line.kind === "kv" && line.kvKey) {
        const def = KEY_SCHEMA_MAP[line.kvKey];
        if (def?.default !== undefined && JSON.stringify(line.kvValue) === JSON.stringify(def.default)) {
          deleteLine(i); editingComment = null; return;
        }
      } else if (line.kind === "global" && line.globalKey) {
        const def = GLOBAL_SCHEMA[line.globalKey];
        if (def?.default !== undefined && JSON.stringify(line.globalValue) === JSON.stringify(def.default)) {
          deleteLine(i); editingComment = null; return;
        }
      }
    }

    updateComment(i, trimmed);
    editingComment = null;
  }

  /** Materialize a virtual kv at its default value and open comment editor. */
  function materializeVirtualKvWithComment(closeIndex: number, key: string, def: any, depth: number) {
    materializeKv(closeIndex, key, def.default, depth);
    // After insert, the new line is at closeIndex
    editingComment = closeIndex;
  }

  /** Materialize a virtual global at its default value and open comment editor. */
  function materializeVirtualGlobalWithComment(key: string, def: any) {
    const idx = findGlobalInsertIndex();
    materializeGlobal(idx, key, def.default);
    editingComment = idx;
  }

  /** Materialize a virtual lid setting: creates the BOX_LID block and inserts the changed KV. */
  function materializeVirtualLidSetting(objectCloseIndex: number, key: string, def: any, value: any) {
    if (JSON.stringify(value) === JSON.stringify(def.default)) return;
    const lidDepth = ($project.lines[objectCloseIndex]?.depth ?? 0) + 1;
    const lidChildDepth = lidDepth + 1;
    addLid(objectCloseIndex, lidDepth);
    // Lid close is now at objectCloseIndex + 1
    materializeKv(objectCloseIndex + 1, key, value, lidChildDepth);
  }

  /** Materialize a virtual lid KV at default value and open comment editor. */
  function materializeVirtualLidKvWithComment(objectCloseIndex: number, key: string, def: any, depth: number) {
    const lidDepth = ($project.lines[objectCloseIndex]?.depth ?? 0) + 1;
    addLid(objectCloseIndex, lidDepth);
    materializeKv(objectCloseIndex + 1, key, def.default, depth);
    editingComment = objectCloseIndex + 1;
  }

  /** Insert a full object skeleton before a close bracket at `closeIndex`. */
  function addObject(closeIndex: number, depth: number) {
    const d = depth + 1; // inside the data array
    const ind = (n: number) => "    ".repeat(n);
    const count = $project.lines.filter(l => l.kind === "open" && l.role === "object").length;
    const name = `box ${count + 1}`;
    const label = "OBJECT_BOX";
    const lines: Line[] = [
      { raw: `${ind(d)}[ OBJECT_BOX,`, kind: "open", depth: d, role: "object", label },
      { raw: `${ind(d+1)}[ NAME, "${name}" ],`, kind: "kv", depth: d + 1, kvKey: "NAME", kvValue: name },
      { raw: `${ind(d+1)}[ BOX_SIZE_XYZ, [50, 50, 20] ],`, kind: "kv", depth: d + 1, kvKey: "BOX_SIZE_XYZ", kvValue: [50, 50, 20] },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "object", label },
    ];
    // Insert all lines before the close bracket
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a feature skeleton inside a feature_list before `closeIndex`. */
  function addComponent(closeIndex: number, depth: number) {
    const d = depth + 1;
    const ind = (n: number) => "    ".repeat(n);
    const name = "comp";
    const lines: Line[] = [
      { raw: `${ind(d)}[ "${name}", [`, kind: "open", depth: d, role: "object", label: name, mergedOpen: true },
      { raw: `${ind(d+1)}[ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],`, kind: "kv", depth: d + 1, kvKey: "FTR_COMPARTMENT_SIZE_XYZ", kvValue: [40, 40, 15] },
      { raw: `${ind(d)}]],`, kind: "close", depth: d, role: "object", label: name, mergedClose: true },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a BOX_FEATURE block before `closeIndex` (inside an element params close). */
  function addFeatureList(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ BOX_FEATURE,`, kind: "open", depth: d, role: "feature_list", label: "BOX_FEATURE" },
      { raw: `${ind(d+1)}[ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],`, kind: "kv", depth: d + 1, kvKey: "FTR_COMPARTMENT_SIZE_XYZ", kvValue: [40, 40, 15] },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "feature_list", label: "BOX_FEATURE" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a FEATURE_GROUP block before `closeIndex` with one starter child feature. */
  function addGroup(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const count = $project.lines.filter(l => l.kind === "open" && l.role === "box_group").length;
    const name = `group ${count + 1}`;
    const lines: Line[] = [
      { raw: `${ind(d)}[ FEATURE_GROUP,`, kind: "open", depth: d, role: "box_group", label: "FEATURE_GROUP" },
      { raw: `${ind(d+1)}[ NAME, "${name}" ],`, kind: "kv", depth: d + 1, kvKey: "NAME", kvValue: name },
      { raw: `${ind(d+1)}[ POSITION_XY, [0, 0] ],`, kind: "kv", depth: d + 1, kvKey: "POSITION_XY", kvValue: [0, 0] },
      { raw: `${ind(d+1)}[ BOX_FEATURE,`, kind: "open", depth: d + 1, role: "feature_list", label: "BOX_FEATURE" },
      { raw: `${ind(d+2)}[ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],`, kind: "kv", depth: d + 2, kvKey: "FTR_COMPARTMENT_SIZE_XYZ", kvValue: [40, 40, 15] },
      { raw: `${ind(d+1)}],`, kind: "close", depth: d + 1, role: "feature_list", label: "BOX_FEATURE" },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "box_group", label: "FEATURE_GROUP" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a FEATURE_COPY block before `closeIndex`. */
  function addCopy(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const count = $project.lines.filter(l => l.kind === "open" && l.role === "feature_copy").length;
    const name = `copy ${count + 1}`;
    const lines: Line[] = [
      { raw: `${ind(d)}[ FEATURE_COPY,`, kind: "open", depth: d, role: "feature_copy", label: "FEATURE_COPY" },
      { raw: `${ind(d+1)}[ NAME, "${name}" ],`, kind: "kv", depth: d + 1, kvKey: "NAME", kvValue: name },
      { raw: `${ind(d+1)}[ FEATURE_REFERENCE, "" ],`, kind: "kv", depth: d + 1, kvKey: "FEATURE_REFERENCE", kvValue: "" },
      { raw: `${ind(d+1)}[ POSITION_XY, [0, 0] ],`, kind: "kv", depth: d + 1, kvKey: "POSITION_XY", kvValue: [0, 0] },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "feature_copy", label: "FEATURE_COPY" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a BOX_VISUALIZATION block before `closeIndex`. */
  function addVisualization(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ BOX_VISUALIZATION,`, kind: "open", depth: d, role: "visualization", label: "BOX_VISUALIZATION" },
      { raw: `${ind(d+1)}[ POSITION_XY, [0, 0] ],`, kind: "kv", depth: d + 1, kvKey: "POSITION_XY", kvValue: [0, 0] },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "visualization", label: "BOX_VISUALIZATION" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert an FTR_DIVIDERS block before `closeIndex` (inside a BOX_FEATURE close). */
  function addFeatureDividers(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ FTR_DIVIDERS,`, kind: "open", depth: d, role: "feature_dividers", label: "FTR_DIVIDERS" },
      { raw: `${ind(d+1)}[ DIV_LAYOUT_BAYS, 2 ],`, kind: "kv", depth: d + 1, kvKey: "DIV_LAYOUT_BAYS", kvValue: 2 },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "feature_dividers", label: "FTR_DIVIDERS" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a BOX_LID block before `closeIndex` (flat format). */
  function addLid(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ BOX_LID,`, kind: "open", depth: d, role: "lid", label: "BOX_LID" },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "lid", label: "BOX_LID" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Check if a block (by close index) has a direct child block with the given role. */
  function hasChildBlock(closeIndex: number, role: string): boolean {
    const closeLine = $project.lines[closeIndex];
    if (!closeLine || closeLine.kind !== "close") return false;
    let bd = 0;
    let openIdx = -1;
    for (let i = closeIndex; i >= 0; i--) {
      if ($project.lines[i].kind === "close") bd += ($project.lines[i] as any).mergedClose ? 2 : 1;
      if ($project.lines[i].kind === "open") {
        bd -= ($project.lines[i] as any).mergedOpen ? 2 : 1;
        if (bd <= 0) { openIdx = i; break; }
      }
    }
    if (openIdx < 0) return false;
    for (let j = openIdx + 1; j < closeIndex; j++) {
      if ($project.lines[j].kind === "open" && $project.lines[j].role === role) return true;
    }
    return false;
  }

  /** Check if a block (by close index) has a BOX_LID child. */
  function hasLidChild(closeIndex: number): boolean {
    return hasChildBlock(closeIndex, "lid");
  }

  /** Check if a feature block (by close index) already has an FTR_DIVIDERS child. */
  function hasFeatureDividersChild(closeIndex: number): boolean {
    return hasChildBlock(closeIndex, "feature_dividers");
  }

  /** Check if this close bracket's parent object supports lids (OBJECT_BOX only). */
  function supportsLid(closeIndex: number): boolean {
    const closeLine = $project.lines[closeIndex];
    if (!closeLine || closeLine.kind !== "close") return false;
    const role = closeLine.role || "";
    // For object close (merged or not), check label directly
    if (role === "object") {
      return closeLine.label === "OBJECT_BOX";
    }
    // For params close, find parent object
    if (role === "params") {
      const label = findObjectLabel(closeIndex);
      return label === "OBJECT_BOX";
    }
    return false;
  }

  /** Insert a LABEL block before `closeIndex` (flat format, no inner bracket). */
  function addLabel(closeIndex: number, depth: number) {
    const d = depth;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ LABEL,`, kind: "open", depth: d, role: "label", label: "LABEL" },
      { raw: `${ind(d+1)}[ LBL_TEXT, "" ],`, kind: "kv", depth: d + 1, kvKey: "LBL_TEXT", kvValue: "" },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "label", label: "LABEL" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a TRAY block before `closeIndex` (CTD profile). */
  function addTray(closeIndex: number, depth: number) {
    const d = depth + 1;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ TRAY,`, kind: "open", depth: d, role: "object", label: "TRAY" },
      { raw: `${ind(d+1)}[ COUNTER_SET,`, kind: "open", depth: d + 1, role: "counter_set", label: "COUNTER_SET" },
      { raw: `${ind(d+2)}[ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],`, kind: "kv", depth: d + 2, kvKey: "COUNTER_SIZE_XYZ", kvValue: [13.3, 13.3, 3] },
      { raw: `${ind(d+1)}],`, kind: "close", depth: d + 1, role: "counter_set", label: "COUNTER_SET" },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "object", label: "TRAY" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a LID block before `closeIndex` (CTD profile). */
  function addCtdLid(closeIndex: number, depth: number) {
    const d = depth + 1;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ LID,`, kind: "open", depth: d, role: "object", label: "LID" },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "object", label: "LID" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }

  /** Insert a COUNTER_SET block before `closeIndex` (CTD profile). */
  function addCounterSet(closeIndex: number, depth: number) {
    const d = depth + 1;
    const ind = (n: number) => "    ".repeat(n);
    const lines: Line[] = [
      { raw: `${ind(d)}[ COUNTER_SET,`, kind: "open", depth: d, role: "counter_set", label: "COUNTER_SET" },
      { raw: `${ind(d+1)}[ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],`, kind: "kv", depth: d + 1, kvKey: "COUNTER_SIZE_XYZ", kvValue: [13.3, 13.3, 3] },
      { raw: `${ind(d)}],`, kind: "close", depth: d, role: "counter_set", label: "COUNTER_SET" },
    ];
    project.update((p) => {
      p.lines.splice(closeIndex, 0, ...lines);
      return { ...p };
    });
  }
</script>

{#snippet commentBtn(line, i)}
  {#if line.comment || editingComment === i}
    <span class="comment-area">
      <span class="comment-slash">//</span>
      <input class="comment-input" type="text" value={line.comment ?? ""}
        onblur={(e) => finalizeComment(i, e.currentTarget.value)}
        onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") finalizeComment(i, line.comment ?? ""); }}
      />
    </span>
  {:else}
    <button class="comment-btn" title="Add comment" onclick={() => toggleCommentEdit(i)}>//</button>
  {/if}
{/snippet}

{#snippet diagnosticSlot(lineIndex)}
  {@const severity = lineDiagnosticSeverity(lineIndex)}
  <span class="line-diagnostic-slot">
    {#if severity}
      {@const issues = diagnosticsForLine(lineIndex)}
      <button
        class="line-diagnostic-marker {severity}"
        data-testid="diagnostic-line-{lineIndex}"
        title={lineDiagnosticTitle(lineIndex)}
        aria-label="OpenSCAD {severity} on this line"
        onmouseenter={() => { hoveredDiagKeys = collectIssueKeys(issues); hoveredDiagAxes = collectIssueAxes(issues); }}
        onmouseleave={() => { hoveredDiagKeys = new Set(); hoveredDiagAxes = new Set(); }}
        onfocus={() => { hoveredDiagKeys = collectIssueKeys(issues); hoveredDiagAxes = collectIssueAxes(issues); }}
        onblur={() => { hoveredDiagKeys = new Set(); hoveredDiagAxes = new Set(); }}
        onclick={openDiagnosticsFromLine}
      >!</button>
    {/if}
  </span>
{/snippet}

{#snippet unitSuffix(key, def)}
  {@const unit = unitForField(key, def)}
  {#if unit}
    <span class="unit-suffix" title="Unit: {unit}">{unit}</span>
  {/if}
{/snippet}

{#snippet presetBtn(key, onChange, id)}
  {#if $presets[key]?.length}
    <span class="preset-wrap">
      <button class="preset-btn" title="Choose preset" data-testid="preset-{id}"
        onclick={(e) => { e.stopPropagation(); presetOpen = presetOpen === id ? null : id; }}>&#9662;</button>
      {#if presetOpen === id}
        <div class="preset-menu">
          {#each $presets[key] as p}
            <button class="preset-item" title={p.value}
              onclick={() => { onChange(p.name); presetOpen = null; }}>{p.label}</button>
          {/each}
        </div>
      {/if}
    </span>
  {/if}
{/snippet}

<main data-testid="app-root">
  {#if !showWelcome}
  <nav class="toolbar" data-testid="toolbar">
    <button class="toolbar-home" title="Welcome page" onclick={() => { showWelcome = true; loadLibraryTree(); }}>&#8962;</button>
    <div class="toolbar-sep"></div>
    <div class="file-menu-wrap">
      <button class="toolbar-btn file-menu-button" title="File actions" data-testid="file-menu-button" aria-haspopup="menu" aria-expanded={showFileMenu}
        onclick={(e) => { e.stopPropagation(); void toggleFileMenu(); }}>File ▾</button>
      {#if showFileMenu}
        <div class="file-menu" data-testid="file-menu" role="menu">
          <button class="file-menu-item" data-testid="menu-save-version" role="menuitem" disabled={!currentFilePath || currentReadOnly}
            onclick={() => { showFileMenu = false; void saveVersion(); }}>
            <span>Save Version</span><kbd>Ctrl+S</kbd>
          </button>
          <button class="file-menu-item" data-testid="menu-save-as" role="menuitem"
            onclick={() => { showFileMenu = false; void saveFileAs(); }}>
            <span>Save As...</span><kbd>Ctrl+Shift+S</kbd>
          </button>
          <button class="file-menu-item" data-testid="menu-copy-path" role="menuitem" disabled={!currentFilePath}
            onclick={() => { showFileMenu = false; void copyScadPath(); }}>
            <span>Copy Path</span>
          </button>
          <button class="file-menu-item" data-testid="file-history-button" role="menuitem" disabled={!currentFilePath || currentReadOnly}
            onclick={() => { showFileMenu = false; openFileHistory(); }}>
            <span>Version History</span>
          </button>
          <div class="file-menu-sep"></div>
          <div class="file-menu-item file-menu-recent" role="menuitem" aria-haspopup="menu" tabindex="0" data-testid="menu-recent-files">
            <span>Recent Files</span><span class="file-menu-arrow">›</span>
            <div class="recent-flyout" role="menu" data-testid="recent-files-flyout">
              {#if recentFiles.length === 0}
                <div class="recent-empty">No Recent Files</div>
              {:else}
                {#each recentFiles as recentFile (recentFile)}
                  <button class="recent-item" role="menuitem" title={recentFile}
                    onclick={() => openRecentFile(recentFile)}>
                    <span class="recent-name">{basename(recentFile)}</span>
                    <span class="recent-path">{recentFile}</span>
                  </button>
                {/each}
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
    <div class="toolbar-sep"></div>
    <div class="view-menu-wrap">
      <button class="toolbar-btn view-menu-button" title="View options" data-testid="view-menu-button" aria-haspopup="menu" aria-expanded={showViewMenu}
        onclick={(e) => { e.stopPropagation(); toggleViewMenu(); }}>View ▾</button>
      {#if showViewMenu}
        <div class="view-menu" data-testid="view-menu" role="menu">
          <div class="view-menu-group-label">Show Default State Parameters</div>
          <button class="file-menu-item radio-menu-item" data-testid="view-defaults-all" role="menuitemradio" aria-checked={defaultsMode === "all"}
            onclick={() => setDefaultsMode("all")}>
            <span><span class="radio-dot" class:checked={defaultsMode === "all"}></span>All</span>
          </button>
          <button class="file-menu-item radio-menu-item" data-testid="view-defaults-favorites" role="menuitemradio" aria-checked={defaultsMode === "favorites"}
            onclick={() => setDefaultsMode("favorites")}>
            <span><span class="radio-dot" class:checked={defaultsMode === "favorites"}></span>Favorites</span>
          </button>
          <button class="file-menu-item radio-menu-item" data-testid="view-defaults-none" role="menuitemradio" aria-checked={defaultsMode === "none"}
            onclick={() => setDefaultsMode("none")}>
            <span><span class="radio-dot" class:checked={defaultsMode === "none"}></span>None</span>
          </button>
          <div class="file-menu-sep"></div>
          <button class="file-menu-item" data-testid="view-show-scad" role="menuitemcheckbox" aria-checked={showScad}
            onclick={() => { showScad = !showScad; }}>
            <span><span class="check-mark">{showScad ? "✓" : ""}</span>Show SCAD</span><kbd>Ctrl+U</kbd>
          </button>
        </div>
      {/if}
    </div>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group">
      <button class="toolbar-icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" data-testid="toolbar-undo-button" disabled={!$canUndo} onclick={() => undo()}>&#8630;</button>
      <button class="toolbar-icon-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" data-testid="toolbar-redo-button" disabled={!$canRedo} onclick={() => redo()}>&#8631;</button>
    </div>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group">
      <div class="diagnostics-wrap">
        <button
          class="diagnostics-chip {diagnosticsStatus}"
          class:phys-off={!bitValidationOn}
          title={bitValidationOn ? diagnosticsMessage : "BIT validation is OFF (G_VALIDATE_KEYS_B). Turn it on to enable structured BIT checks."}
          aria-haspopup="dialog"
          aria-expanded={diagnosticsOpen}
          data-testid="openscad-check-chip"
          onclick={toggleDiagnosticsPanel}
        >
          <span class="diagnostics-dot"></span>
          <span>{diagnosticsLabel}</span>
        </button>
        {#if diagnosticsOpen}
          <div class="diagnostics-panel" data-testid="openscad-issues-panel" role="dialog" aria-label="OpenSCAD issues">
            <div class="diagnostics-panel-head">
              <span class="diagnostics-title">OpenSCAD Check</span>
              <button class="diagnostics-refresh" title="Run OpenSCAD check now" disabled={diagnosticsInFlight} onclick={() => runOpenScadDiagnostics()}>↻</button>
            </div>
            <div class="diagnostics-summary" class:problem={diagnosticsProblemCount > 0}>{diagnosticsMessage}</div>
            {#if diagnosticsIssues.length === 0}
              <div class="diagnostics-empty">{diagnosticsEmptyText()}</div>
            {:else}
              <div class="diagnostics-list">
                {#each diagnosticsIssues as issue, idx}
                  <div class="diagnostics-issue {issue.severity}" data-testid="openscad-issue-{idx}">
                    <span class="issue-severity">{issue.severity}</span>
                    <span class="issue-message">{humanizeMessage(issue)}</span>
                    {#if issue.line}
                      <span class="issue-location">line {issue.line}</span>
                    {/if}
                    {#if issue.file}
                      <span class="issue-file">{basename(issue.file)}</span>
                    {/if}
                    {#if issue.code || issue.key || issue.context}
                      <span class="issue-meta">{[issue.code, issue.key ? `key ${issue.key}` : null, issue.context ? `context ${issue.context}` : null].filter(Boolean).join(" · ")}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <button class="toolbar-btn" title="Open in OpenSCAD (Ctrl+E)" onclick={() => openInOpenScad()}>OpenSCAD</button>
      <button class="toolbar-btn toolbar-gear" title="Preferences... (Ctrl+,)" onclick={() => openPreferencesModal()}>&#x2699;</button>
    </div>
  </nav>
  {/if}
  <section class="content" data-testid="content-area">
    {#if showWelcome}
      <WelcomeScreen
        {workingDirSet}
        {workingDir}
        {setupBusy}
        {setupStatus}
        {setupLog}
        bind:sortMode
        libraryTree={libraryTree}
        bind:libMenu
        onchooseworkingdir={chooseAndInitWorkingDir}
        onopenpreferences={openPreferencesModal}
        onupdatelibs={updateLibs}
        onnewproject={newProjectFromWelcome}
        onopenlibraryfile={openLibraryFile}
        oneditfile={editFile}
        ondeletefile={deleteLibraryFile}
        onrenamefile={renameLibraryFile}
        onduplicatefile={duplicateLibraryFile}
        onexportstl={exportStl}
      />
    {:else}
    <div class="editor-split" class:split-active={showScad}>
    <div class="editor-left" style={editorPadBottom ? `padding-bottom: ${editorPadBottom}px` : ''}>
    {#each $project.lines as line, i (i)}

      {#if hiddenLines.has(i)}
        <!-- Hidden by collapsed parent -->

      {:else if kvRenderedInBlock.has(i)}
        <!-- This kv line is rendered in the sorted schema block before its close bracket -->

      {:else if globalRenderedInBlock.has(i)}
        <!-- This global line is rendered in the virtual globals block above -->

      {:else if line.kind === "open"}
        {@const collapsible = !["params", "label_params", "lid_params", "feature", "group_params", "copy_params", "feature_divider_params", "visualization_params", "counter_set_params"].includes(line.role || "")}
        {@const deletable = line.role === "data" ? sceneNames.length > 1 : !["data_list", "params", "label_params", "lid_params", "feature", "group_params", "copy_params", "feature_divider_params", "visualization_params", "counter_set_params"].includes(line.role || "")}
        <div class="line-row struct open" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          {#if collapsible}
            <button class="collapse-btn" title={collapsed.has(i) ? "Expand" : "Collapse"}
              aria-expanded={!collapsed.has(i)} aria-label="{structLabel(line, i).text} section"
              onclick={() => toggleCollapse(i)}>{collapsed.has(i) ? "▶" : "▼"}</button>
          {/if}
          {#if line.role === "data"}
            <input class="scene-name-input" type="text" value={line.varName || "data"}
              size={Math.max(4, (line.varName || "data").length + 1)}
              onblur={(e) => handleSceneNameBlur(i, e.currentTarget.value)}
              oninput={(e) => { e.currentTarget.size = Math.max(4, e.currentTarget.value.length + 1); }}
              onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
            <span class="struct-bracket">=</span>
          {:else}
            <span class={structLabel(line, i).inferred ? "struct-label inferred" : "struct-label"}>{structLabel(line, i).text}</span>
          {/if}
          <span class="struct-bracket">{collapsed.has(i) ? "[ ... ]" : "["}</span>
          {#if line.role === "object" || line.role === "feature_list" || line.role === "box_group" || line.role === "feature_copy" || line.role === "feature_dividers" || line.role === "lid" || line.role === "counter_set"}
            {@const dbg = getDebugState(i)}
            <button class="debug-toggle" class:active={dbg.active} title="Highlight in OpenSCAD (#)"
              aria-pressed={dbg.active} aria-label="Toggle debug highlight"
              onclick={() => toggleDebug(i)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          {/if}
          {@render commentBtn(line, i)}
          <span class="spacer"></span>
          {#if line.role === "data"}
            <button class="dup-btn" title="Duplicate scene" onclick={() => handleDuplicateScene(i)}>⧉</button>
          {:else if deletable}
            <button class="dup-btn" title="Duplicate block" onclick={() => duplicateBlock(i)}>⧉</button>
          {/if}
          {#if deletable}
            <button class="delete-btn" title="Delete block" onclick={() => deleteBlock(i)}>✕</button>
          {/if}
        </div>
        {#if !collapsed.has(i)}
        <div class="block-body" transition:slide|global={{ duration: slideDur }}>
        <!-- Virtual globals block inside data = [ (BIT only; CTD uses per-scene KVs) -->
        {#if line.role === "data" && $project.libraryProfile !== "ctd"}
          {#each groupRowsForDisplay(getGlobalRows(), "globals", 1) as group (group.id)}
            <div class="line-row kv-category" style="{padDepth(group.depth)}; {bracketStyle(group.depth)}" data-testid="category-globals-{group.id}">
              <span class="category-label">{group.label}</span>
              {#if group.changedCount > 0}
                <span class="category-count">{group.changedCount} changed</span>
              {/if}
            </div>
            {#each group.rows as row (row.key)}
            {@const gDef = row.def}
            {@const gVal = row.value}
            {@const gOnChange = row.isReal
              ? (v: any) => updateGlobalWithDefault(row.lineIndex!, v, gDef.default)
              : (v: any) => onVirtualGlobalChange(row.key, gDef, v)}
            <div class="line-row kv" class:virtual={!row.isReal} class:fading-out={fadingOutKeys.has(row.key)} class:has-diagnostic={lineDiagnosticSeverity(row.lineIndex) != null} class:diagnostic-error={lineDiagnosticSeverity(row.lineIndex) === "error"} class:diagnostic-warning={lineDiagnosticSeverity(row.lineIndex) === "warning"} class:diag-highlight={hoveredDiagKeys.has(row.key)} class:diag-x={hoveredDiagAxes.has("x")} class:diag-y={hoveredDiagAxes.has("y")} class:diag-z={hoveredDiagAxes.has("z")} style="{padDepth(1)}; {bracketStyle(1)}" data-testid={row.isReal ? `line-${row.lineIndex}` : `virtual-${row.key}`}>
              <span class="kv-key" class:virtual-key={!row.isReal} title={tip(row.key)}>{label(row.key)}</span>
              {@render diagnosticSlot(row.lineIndex)}
              <span class="kv-control">
                {#if row.isReal && rawValueEditing.has(row.lineIndex!)}
                  <input class="kv-raw-value" type="text" spellcheck="false"
                    value={formatKvValue(gVal)}
                    onblur={(e) => handleRawValueBlur(row.lineIndex!, e.currentTarget.value, gDef.default, true)}
                    onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                {:else if gDef.type === "bool"}
                  <input type="checkbox" checked={gVal === true} onchange={(e) => gOnChange(e.currentTarget.checked)} />
                {:else if gDef.type === "enum"}
                  <select value={gVal} onchange={(e) => gOnChange(e.currentTarget.value)}>
                    {#each gDef.values || [] as v}<option value={v}>{v}</option>{/each}
                  </select>
                {:else if gDef.type === "number"}
                  <input class="kv-num" type="number" step={getStep(row.key)} value={gVal} onchange={(e) => gOnChange(parseNum(e.currentTarget.value))} />
                {:else if gDef.type === "number_or_false"}
                  <input class="kv-str" type="text" value={formatKvValue(gVal)} onchange={(e) => gOnChange(parseNumberOrFalse(e.currentTarget.value))} />
                {:else if gDef.type === "xyz_or_false"}
                  <input class="kv-str" type="text" value={formatKvValue(gVal)} onchange={(e) => gOnChange(parseXyzOrFalse(e.currentTarget.value))} />
                {:else if gDef.type === "bool_string_list"}
                  <input class="kv-str" type="text" value={formatKvValue(gVal)} onchange={(e) => gOnChange(parseFlexibleValue(e.currentTarget.value))} />
                {:else if gDef.type === "xy"}
                  {#if typeof gVal === "string" && $knownConstantsStore.has(gVal)}
                    <span class="preset-pill" title={gVal + " → " + resolvePresetValue(gVal)}>{$constantLabels[gVal] || gVal}</span>
                    <button class="preset-clear" title="Clear preset" onclick={() => gOnChange(gDef.default)}>✕</button>
                  {:else if Array.isArray(gVal)}
                    {#each [0,1] as j}
                      {#if typeof gVal[j] === "string" && $knownConstantsStore.has(gVal[j])}
                        <span class="preset-pill sm" title={gVal[j] + " → " + resolvePresetValue(gVal[j])}>{$constantLabels[gVal[j]] || gVal[j]}</span>
                        <button class="preset-clear" title="Clear" onclick={() => { const c = [...gVal]; c[j] = gDef.default?.[j] ?? 0; gOnChange(c); }}>✕</button>
                      {:else}
                        <input class="kv-str sm" type="text" value={gVal[j] ?? 0}
                          onchange={(e) => { const c = [...gVal]; c[j] = smartParseNum(e.currentTarget.value); gOnChange(c); }} />
                      {/if}
                      {@const cpf = componentPresetField(row.key, j)}
                      {#if cpf}
                        {@render presetBtn(cpf, (v) => { const c = Array.isArray(gVal) ? [...gVal] : [...(gDef.default || [0,0])]; c[j] = v; gOnChange(c); }, `comp-g-${row.key}-${j}`)}
                      {/if}
                    {/each}
                  {/if}
                {:else}
                  <input class="kv-str" type="text" value={gVal ?? ""} onchange={(e) => gOnChange(e.currentTarget.value)} />
                {/if}
                {@render unitSuffix(row.key, gDef)}
              </span>
              {@render presetBtn(row.key, gOnChange, `global-${row.key}`)}
              {#if row.isReal && row.lineIndex !== null}
                {@render commentBtn($project.lines[row.lineIndex], row.lineIndex)}
                <span class="spacer"></span>
                <button class="toggle-btn" class:active={rawValueEditing.has(row.lineIndex!)} title="Edit value as raw text" onclick={() => toggleRawValueEdit(row.lineIndex!)}>{"{}"}</button>
                <button class="delete-btn" title="Reset to default" onclick={() => deleteLine(row.lineIndex!)}>✕</button>
              {:else}
                <button class="comment-btn" title="Add comment" onclick={() => materializeVirtualGlobalWithComment(row.key, row.def)}>//</button>
                <span class="spacer"></span>
                <button class="toggle-btn" title="Edit value as raw text" onclick={() => materializeGlobalAndEditRawValue(row.key, row.def)}>{"{}"}</button>
              {/if}
              <button class="fav-btn" class:active={isFavorite(row.key)} title={isFavorite(row.key) ? "Remove from favorites" : "Add to favorites"} onclick={() => toggleFavorite(row.key)}>{isFavorite(row.key) ? "★" : "☆"}</button>
            </div>
            {/each}
          {/each}
        {/if}
        <!-- Sorted schema rows (real + virtual) after open bracket -->
        {#each groupRowsForDisplay(getSortedSchemaRowsForOpen(i), getSchemaScopeForOpen(i), (line.depth ?? 0) + 1) as group (group.id)}
          <div class="line-row kv-category" style="{padDepth(group.depth)}; {bracketStyle(group.depth)}" data-testid="category-{group.id}">
            <span class="category-label">{group.label}</span>
            {#if group.changedCount > 0}
              <span class="category-count">{group.changedCount} changed</span>
            {/if}
          </div>
          {#each group.rows as row (row.key)}
          {@const rkt = getKeyType(row.key)}
          {@const rks = getKeySchema(row.key)}
          {@const closeIdx = findMatchingClose(i)}
          {@const onChange = row.isReal
            ? (v) => updateKv(row.lineIndex, v, row.def.default)
            : (v) => onVirtualChange(closeIdx, row.key, row.def, v)}
          {@const val = row.value}
          <div class="line-row kv" class:virtual={!row.isReal} class:fading-out={fadingOutKeys.has(row.key)} class:has-diagnostic={lineDiagnosticSeverity(row.lineIndex) != null} class:diagnostic-error={lineDiagnosticSeverity(row.lineIndex) === "error"} class:diagnostic-warning={lineDiagnosticSeverity(row.lineIndex) === "warning"} class:diag-highlight={hoveredDiagKeys.has(row.key)} class:diag-x={hoveredDiagAxes.has("x")} class:diag-y={hoveredDiagAxes.has("y")} class:diag-z={hoveredDiagAxes.has("z")} style="{padDepth(row.depth)}; {bracketStyle(row.depth)}" data-testid={row.isReal ? `line-${row.lineIndex}` : `virtual-${row.key}`}>
            <span class="kv-key" class:virtual-key={!row.isReal} title={tip(row.key)}>{label(row.key)}</span>
            {@render diagnosticSlot(row.lineIndex)}
            <span class="kv-control">
              {#if row.isReal && rawValueEditing.has(row.lineIndex!)}
                <input class="kv-raw-value" type="text" spellcheck="false"
                  value={formatKvValue(val)}
                  onblur={(e) => handleRawValueBlur(row.lineIndex!, e.currentTarget.value, row.def.default)}
                  onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
              {:else if rkt === "bool"}
                <input type="checkbox" checked={val === true} onchange={(e) => onChange(e.currentTarget.checked)} />
              {:else if rkt === "enum"}
                <select value={val} onchange={(e) => onChange(e.currentTarget.value)}>
                  {#each rks?.values || [] as v}<option value={v}>{v}</option>{/each}
                </select>
              {:else if rkt === "number"}
                <input class="kv-num" type="number" step={getStep(row.key)} value={val} onchange={(e) => onChange(parseNum(e.currentTarget.value))} />
              {:else if rkt === "number_or_false"}
                <input class="kv-str" type="text" value={formatKvValue(val)} onchange={(e) => onChange(parseNumberOrFalse(e.currentTarget.value))} />
              {:else if rkt === "xyz_or_false"}
                <input class="kv-str" type="text" value={formatKvValue(val)} onchange={(e) => onChange(parseXyzOrFalse(e.currentTarget.value))} />
              {:else if rkt === "bool_string_list"}
                <input class="kv-str" type="text" value={formatKvValue(val)} onchange={(e) => onChange(parseFlexibleValue(e.currentTarget.value))} />
              {:else if rkt === "string"}
                <input class="kv-str" type="text" value={val ?? ""} onchange={(e) => onChange(e.currentTarget.value)} />
              {:else if rkt === "xyz"}
                {#if typeof val === "string" && $knownConstantsStore.has(val)}
                  <span class="preset-pill" title={val + " → " + resolvePresetValue(val)}>{$constantLabels[val] || val}</span>
                  <button class="preset-clear" title="Clear preset" onclick={() => onChange(row.def.default)}>✕</button>
                {:else if Array.isArray(val)}
                  {#each [0,1,2] as j}
                    {#if typeof val[j] === "string" && $knownConstantsStore.has(val[j])}
                      <span class="preset-pill sm" title={val[j] + " → " + resolvePresetValue(val[j])}>{$constantLabels[val[j]] || val[j]}</span>
                      <button class="preset-clear" title="Clear" onclick={() => { const c = [...val]; c[j] = row.def.default?.[j] ?? 0; onChange(c); }}>✕</button>
                    {:else}
                      <input class="kv-str sm" type="text" value={val[j] ?? 0} data-axis={["x","y","z"][j]}
                        onchange={(e) => { const c = [...val]; c[j] = smartParseNum(e.currentTarget.value); onChange(c); }} />
                    {/if}
                    {@const cpf = componentPresetField(row.key, j)}
                    {#if cpf}
                      {@render presetBtn(cpf, (v) => { const c = Array.isArray(val) ? [...val] : [...(row.def.default || [0,0,0])]; c[j] = v; onChange(c); }, `comp-${i}-${row.key}-${j}`)}
                    {/if}
                  {/each}
                {/if}
              {:else if rkt === "xy"}
                {#if typeof val === "string" && $knownConstantsStore.has(val)}
                  <span class="preset-pill" title={val + " → " + resolvePresetValue(val)}>{$constantLabels[val] || val}</span>
                  <button class="preset-clear" title="Clear preset" onclick={() => onChange(row.def.default)}>✕</button>
                {:else if Array.isArray(val)}
                  {#each [0,1] as j}
                    {#if typeof val[j] === "string" && $knownConstantsStore.has(val[j])}
                      <span class="preset-pill sm" title={val[j] + " → " + resolvePresetValue(val[j])}>{$constantLabels[val[j]] || val[j]}</span>
                      <button class="preset-clear" title="Clear" onclick={() => { const c = [...val]; c[j] = row.def.default?.[j] ?? 0; onChange(c); }}>✕</button>
                    {:else}
                      <input class="kv-str sm" type="text" value={val[j] ?? 0} data-axis={["x","y","z"][j]}
                        onchange={(e) => { const c = [...val]; c[j] = smartParseNum(e.currentTarget.value); onChange(c); }} />
                    {/if}
                    {@const cpf = componentPresetField(row.key, j)}
                    {#if cpf}
                      {@render presetBtn(cpf, (v) => { const c = Array.isArray(val) ? [...val] : [...(row.def.default || [0,0])]; c[j] = v; onChange(c); }, `comp-${i}-${row.key}-${j}`)}
                    {/if}
                  {/each}
                {/if}
              {:else if rkt === "position_xy" && Array.isArray(val)}
                {#each [0,1] as j}
                  <input class="kv-str sm" type="text" value={val[j] ?? ""} data-axis={["x","y","z"][j]}
                    onchange={(e) => { const c = [...val]; const r = e.currentTarget.value.trim(); c[j] = (r==="CENTER"||r==="MAX") ? r : smartParseNum(r); onChange(c); }} />
                {/each}
              {:else if rkt === "4bool" && Array.isArray(val)}
                {#each ["F","B","L","R"] as lb, j}
                  <label class="side-label"><span class="side-tag">{lb}</span>
                    <input type="checkbox" checked={val[j] ?? false}
                      onchange={(e) => { const c = [...val]; c[j] = e.currentTarget.checked; onChange(c); }} />
                  </label>
                {/each}
              {:else if rkt === "4num" && Array.isArray(val)}
                {#each ["F","B","L","R"] as lb, j}
                  <label class="side-label"><span class="side-tag">{lb}</span>
                    <input class="kv-num xs" type="number" step={getStep(row.key)} value={val[j] ?? 0}
                      onchange={(e) => { const c = [...val]; c[j] = parseNum(e.currentTarget.value); onChange(c); }} />
                  </label>
                {/each}
              {:else}
                <span class="kv-fallback">{JSON.stringify(val)}</span>
              {/if}
              {@render unitSuffix(row.key, row.def)}
            </span>
            {@render presetBtn(row.key, onChange, `schema-${i}-${row.key}`)}
            {#if row.isReal && row.lineIndex !== null}
              {@render commentBtn($project.lines[row.lineIndex], row.lineIndex)}
              <span class="spacer"></span>
              <button class="toggle-btn" class:active={rawValueEditing.has(row.lineIndex!)} title="Edit value as raw text" onclick={() => toggleRawValueEdit(row.lineIndex!)}>{"{}"}</button>
              <button class="delete-btn" title="Reset to default" onclick={() => dematerializeKv(row.lineIndex)}>✕</button>
            {:else}
              <button class="comment-btn" title="Add comment" onclick={() => materializeVirtualKvWithComment(closeIdx, row.key, row.def, row.depth)}>//</button>
              <span class="spacer"></span>
              <button class="toggle-btn" title="Edit value as raw text" onclick={() => materializeAndEditRawValue(closeIdx, row.key, row.def, row.depth)}>{"{}"}</button>
            {/if}
            <button class="fav-btn" class:active={isFavorite(row.key)} title={isFavorite(row.key) ? "Remove from favorites" : "Add to favorites"} onclick={() => toggleFavorite(row.key)}>{isFavorite(row.key) ? "★" : "☆"}</button>
          </div>
          {/each}
        {/each}
        </div>
        {/if}

      {:else if line.kind === "close"}
        <!-- Virtual BOX_LID block for OBJECT_BOX without a lid (BIT only) -->
        {@const _lidScalarsAll = [...getScalarKeysForContext("lid")].sort((a, b) => a.key.localeCompare(b.key))}
        {@const _showVirtualLid = defaultsMode !== "none" && $project.libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i) && (defaultsMode === "all" || _lidScalarsAll.some(s => isFavorite(s.key)))}
        <div class="block-tail" transition:slide|global={{ duration: slideDur }}>
        {#if _showVirtualLid}
          {@const lidDepth = (line.depth ?? 0) + 1}
          {@const lidChildDepth = lidDepth + 1}
          {@const lidScalars = _lidScalarsAll}
          {@const vLidKey = `virtual-lid-${i}`}
          {@const vLidCollapsed = collapsedVirtual.has(vLidKey)}
          <div class="line-row struct open virtual" style="{padDepth(lidDepth)}; {bracketStyle(lidDepth)}" data-testid="virtual-lid">
            <button class="collapse-btn" title={vLidCollapsed ? "Expand" : "Collapse"}
              aria-expanded={!vLidCollapsed} aria-label="Lid section"
              onclick={() => toggleCollapseVirtual(vLidKey)}>{vLidCollapsed ? "▶" : "▼"}</button>
            <span class="struct-label inferred">{label("BOX_LID")}</span>
            <span class="struct-bracket">{vLidCollapsed ? "[ ... ]" : "["}</span>
          </div>
          {#if !vLidCollapsed}
          {#each groupScalarDefaultsForDisplay(lidScalars, "lid", lidChildDepth) as group (group.id)}
            <div class="line-row kv-category" style="{padDepth(group.depth)}; {bracketStyle(group.depth)}" data-testid="category-virtual-lid-{group.id}">
              <span class="category-label">{group.label}</span>
              {#if group.changedCount > 0}
                <span class="category-count">{group.changedCount} changed</span>
              {/if}
            </div>
            {#each group.rows as srow (srow.key)}
            {@const rkt = srow.def.type}
            {@const val = srow.value}
            {@const onChange = (v: any) => materializeVirtualLidSetting(i, srow.key, srow.def, v)}
            <div class="line-row kv virtual" class:fading-out={fadingOutKeys.has(srow.key)} style="{padDepth(lidChildDepth)}; {bracketStyle(lidChildDepth)}" data-testid="virtual-lid-{srow.key}">
              <span class="kv-key virtual-key" title={tip(srow.key)}>{label(srow.key)}</span>
              <span class="kv-control">
                {#if rkt === "bool"}
                  <input type="checkbox" checked={val === true} onchange={(e) => onChange(e.currentTarget.checked)} />
                {:else if rkt === "enum"}
                  <select value={val} onchange={(e) => onChange(e.currentTarget.value)}>
                    {#each srow.def.values || [] as v}<option value={v}>{v}</option>{/each}
                  </select>
                {:else if rkt === "number"}
                  <input class="kv-num" type="number" step={getStep(srow.key)} value={val} onchange={(e) => onChange(parseNum(e.currentTarget.value))} />
                {:else if rkt === "string"}
                  <input class="kv-str" type="text" value={val ?? ""} onchange={(e) => onChange(e.currentTarget.value)} />
                {:else if rkt === "4bool" && Array.isArray(val)}
                  {#each ["F","B","L","R"] as lb, j}
                    <label class="side-label"><span class="side-tag">{lb}</span>
                      <input type="checkbox" checked={val[j] ?? false}
                        onchange={(e) => { const c = [...val]; c[j] = e.currentTarget.checked; onChange(c); }} />
                    </label>
                  {/each}
                {:else}
                  <span class="kv-fallback">{JSON.stringify(val)}</span>
                {/if}
                {@render unitSuffix(srow.key, srow.def)}
              </span>
              <button class="comment-btn" title="Add comment" onclick={() => materializeVirtualLidKvWithComment(i, srow.key, srow.def, lidChildDepth)}>//</button>
              <span class="spacer"></span>
              <button class="fav-btn" class:active={isFavorite(srow.key)} title={isFavorite(srow.key) ? "Remove from favorites" : "Add to favorites"} onclick={() => toggleFavorite(srow.key)}>{isFavorite(srow.key) ? "★" : "☆"}</button>
            </div>
            {/each}
          {/each}
          <div class="line-row add-row virtual" style="{padDepth(lidChildDepth)}; {bracketStyle(lidChildDepth)}">
            <button class="add-btn" title="Add LABEL block inside lid" onclick={() => { addLid(i, lidDepth); addLabel(i + 2, lidChildDepth); }}>+ Label</button>
          </div>
          <div class="line-row struct close virtual" style="{padDepth(lidDepth)}; {bracketStyle(lidDepth)}">
            <span class="struct-bracket">],</span>
          </div>
          {/if}
        {/if}
        <!-- Add buttons on their own line, indented inside the block -->
        {#if line.role === "data" || (line.role === "params" && $project.libraryProfile !== "ctd") || (line.role === "object" && $project.libraryProfile !== "ctd") || (line.role === "feature_list" && $project.libraryProfile !== "ctd") || ((line.role === "box_group" || line.role === "group_params") && $project.libraryProfile !== "ctd") || ((line.role === "lid" || line.role === "lid_params") && $project.libraryProfile !== "ctd")}
          {@const addDepth = (line.depth ?? 0) + 1}
          <div class="line-row add-row virtual" style="{padDepth(addDepth)}; {bracketStyle(addDepth)}" data-testid="add-{i}">
            {#if line.role === "data"}
              {#if $project.libraryProfile === "ctd"}
                <button class="add-btn" title="Add tray" onclick={() => addTray(i, line.depth ?? 0)}>+ Tray</button>
                <button class="add-btn" title="Add lid" onclick={() => addCtdLid(i, line.depth ?? 0)}>+ Lid</button>
              {:else}
                <button class="add-btn" title="Add object" onclick={() => addObject(i, line.depth ?? 0)}>+ Object</button>
              {/if}
            {:else if line.role === "params"}
              <button class="add-btn" title="Add LABEL block" onclick={() => addLabel(i, (line.depth ?? 0) + 1)}>+ Label</button>
              <button class="add-btn" title="Add BOX_FEATURE block" onclick={() => addFeatureList(i, (line.depth ?? 0) + 1)}>+ Feature</button>
              <button class="add-btn" title="Add FEATURE_GROUP block" onclick={() => addGroup(i, (line.depth ?? 0) + 1)}>+ Group</button>
              <button class="add-btn" title="Add FEATURE_COPY block" onclick={() => addCopy(i, (line.depth ?? 0) + 1)}>+ Copy</button>
              {#if !hasChildBlock(i, "visualization")}
                <button class="add-btn" title="Add BOX_VISUALIZATION block" onclick={() => addVisualization(i, (line.depth ?? 0) + 1)}>+ Visualization</button>
              {/if}
            {:else if line.role === "object"}
              {@const childDepth = (line.depth ?? 0) + 1}
              <button class="add-btn" title="Add LABEL block" onclick={() => addLabel(i, childDepth)}>+ Label</button>
              <button class="add-btn" title="Add BOX_FEATURE block" onclick={() => addFeatureList(i, childDepth)}>+ Feature</button>
              <button class="add-btn" title="Add FEATURE_GROUP block" onclick={() => addGroup(i, childDepth)}>+ Group</button>
              <button class="add-btn" title="Add FEATURE_COPY block" onclick={() => addCopy(i, childDepth)}>+ Copy</button>
              {#if !hasChildBlock(i, "visualization")}
                <button class="add-btn" title="Add BOX_VISUALIZATION block" onclick={() => addVisualization(i, childDepth)}>+ Visualization</button>
              {/if}
            {:else if line.role === "feature_list"}
              {@const featureChildDepth = (line.depth ?? 0) + 1}
              <button class="add-btn" title="Add LABEL block inside feature" onclick={() => addLabel(i, featureChildDepth)}>+ Label</button>
              {#if !hasFeatureDividersChild(i)}
                <button class="add-btn" title="Add FTR_DIVIDERS block" onclick={() => addFeatureDividers(i, featureChildDepth)}>+ Dividers</button>
              {/if}
              <button class="add-btn" title="Add nested BOX_FEATURE block" onclick={() => addFeatureList(i, featureChildDepth)}>+ Feature</button>
              <button class="add-btn" title="Add nested FEATURE_GROUP block" onclick={() => addGroup(i, featureChildDepth)}>+ Group</button>
              <button class="add-btn" title="Add FEATURE_COPY block inside feature" onclick={() => addCopy(i, featureChildDepth)}>+ Copy</button>
            {:else if line.role === "box_group" || line.role === "group_params"}
              {@const groupChildDepth = (line.depth ?? 0) + 1}
              <button class="add-btn" title="Add BOX_FEATURE block inside group" onclick={() => addFeatureList(i, groupChildDepth)}>+ Feature</button>
              <button class="add-btn" title="Add nested FEATURE_GROUP block" onclick={() => addGroup(i, groupChildDepth)}>+ Group</button>
              <button class="add-btn" title="Add FEATURE_COPY block inside group" onclick={() => addCopy(i, groupChildDepth)}>+ Copy</button>
            {:else if line.role === "lid" || line.role === "lid_params"}
              {@const lidChildDepth = (line.depth ?? 0) + 1}
              <button class="add-btn" title="Add LABEL block inside lid" onclick={() => addLabel(i, lidChildDepth)}>+ Label</button>
            {/if}
          </div>
        {/if}
        <!-- Close bracket(s) — split merged ]] into separate lines -->
        {#if line.mergedClose}
          {@const hasVirtualLid = defaultsMode !== "none" && $project.libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i) && (defaultsMode === "all" || getScalarKeysForContext("lid").some(s => isFavorite(s.key)))}
          {#if !hasVirtualLid}
            <div class="line-row struct close" style="{padDepth((line.depth ?? 0) + 1)}; {bracketStyle((line.depth ?? 0) + 1)}" data-testid="line-{i}-inner">
              <span class="struct-bracket">],</span>
            </div>
          {/if}
          <div class="line-row struct close" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
            <span class="struct-bracket">],</span>
          </div>
        {:else}
          <div class="line-row struct close" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
            <span class="struct-bracket">{line.raw.trim()}</span>
          </div>
        {/if}
        <!-- Buttons that appear AFTER a close bracket (outside the block) -->
        {#if line.role === "counter_set" && $project.libraryProfile === "ctd" && isLastOfKind(i)}
          <div class="line-row add-row virtual" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="add-counter-set-{i}">
            <button class="add-btn" title="Add counter set" onclick={() => addCounterSet(i + 1, (line.depth ?? 1) - 1)}>+ Counter Set</button>
          </div>
        {/if}
        {#if line.role === "data"}
          <div class="line-row add-scene-row" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="add-scene-{i}">
            <button class="add-btn" title="Add another scene" onclick={() => handleAddScene(i)}>+ Scene</button>
          </div>
        {/if}
        </div>

      {:else if line.kind === "kv" && line.kvKey}
        {@const kt = getKeyType(line.kvKey)}
        {@const ks = getKeySchema(line.kvKey)}
        {@const sd = getSchemaDefault(line.kvKey)}
        <div class="line-row kv" class:is-default={isDefault(line.kvKey, line.kvValue)} class:has-diagnostic={lineDiagnosticSeverity(i) != null} class:diagnostic-error={lineDiagnosticSeverity(i) === "error"} class:diagnostic-warning={lineDiagnosticSeverity(i) === "warning"} class:diag-highlight={hoveredDiagKeys.has(line.kvKey || "")} class:diag-x={hoveredDiagAxes.has("x")} class:diag-y={hoveredDiagAxes.has("y")} class:diag-z={hoveredDiagAxes.has("z")} style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <span class="kv-key" title={tip(line.kvKey || "")}>{label(line.kvKey || "")}</span>
          {@render diagnosticSlot(i)}
          <span class="kv-control">
            {#if rawValueEditing.has(i)}
              <input class="kv-raw-value" type="text" spellcheck="false"
                value={formatKvValue(line.kvValue)}
                onblur={(e) => handleRawValueBlur(i, e.currentTarget.value, sd)}
                onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
            {:else if kt === "bool"}
              <input type="checkbox" checked={line.kvValue === true}
                onchange={(e) => updateKv(i, e.currentTarget.checked, sd)} />
            {:else if kt === "enum"}
              <select value={line.kvValue} onchange={(e) => updateKv(i, e.currentTarget.value, sd)}>
                {#each ks?.values || [] as v}<option value={v}>{v}</option>{/each}
              </select>
            {:else if kt === "number"}
              <input class="kv-num" type="number" step={getStep(line.kvKey)} value={line.kvValue}
                onchange={(e) => updateKv(i, parseNum(e.currentTarget.value), sd)} />
            {:else if kt === "number_or_false"}
              <input class="kv-str" type="text" value={formatKvValue(line.kvValue)}
                onchange={(e) => updateKv(i, parseNumberOrFalse(e.currentTarget.value), sd)} />
            {:else if kt === "xyz_or_false"}
              <input class="kv-str" type="text" value={formatKvValue(line.kvValue)}
                onchange={(e) => updateKv(i, parseXyzOrFalse(e.currentTarget.value), sd)} />
            {:else if kt === "bool_string_list"}
              <input class="kv-str" type="text" value={formatKvValue(line.kvValue)}
                onchange={(e) => updateKv(i, parseFlexibleValue(e.currentTarget.value), sd)} />
            {:else if kt === "string"}
              <input class="kv-str" type="text" value={line.kvValue ?? ""}
                onchange={(e) => updateKv(i, e.currentTarget.value, sd)} />
            {:else if kt === "xyz"}
              {#if typeof line.kvValue === "string" && $knownConstantsStore.has(line.kvValue)}
                <span class="preset-pill" title={line.kvValue + " → " + resolvePresetValue(line.kvValue)}>{$constantLabels[line.kvValue] || line.kvValue}</span>
                <button class="preset-clear" title="Clear preset" onclick={() => updateKv(i, sd ?? [0,0,0])}>✕</button>
              {:else if Array.isArray(line.kvValue)}
                {#each [0,1,2] as j}
                  {#if typeof line.kvValue[j] === "string" && $knownConstantsStore.has(line.kvValue[j])}
                    <span class="preset-pill sm" title={line.kvValue[j] + " → " + resolvePresetValue(line.kvValue[j])}>{$constantLabels[line.kvValue[j]] || line.kvValue[j]}</span>
                    <button class="preset-clear" title="Clear" onclick={() => updateKvIdx(i, line.kvValue, j, sd?.[j] ?? 0)}>✕</button>
                  {:else}
                    <input class="kv-str sm" type="text" value={line.kvValue[j] ?? 0}
                      onchange={(e) => updateKvIdx(i, line.kvValue, j, smartParseNum(e.currentTarget.value))} />
                  {/if}
                  {@const cpf = componentPresetField(line.kvKey, j)}
                  {#if cpf}
                    {@render presetBtn(cpf, (v) => updateKvIdx(i, line.kvValue, j, v), `comp-kv-${i}-${j}`)}
                  {/if}
                {/each}
              {/if}
            {:else if kt === "xy"}
              {#if typeof line.kvValue === "string" && $knownConstantsStore.has(line.kvValue)}
                <span class="preset-pill" title={line.kvValue + " → " + resolvePresetValue(line.kvValue)}>{$constantLabels[line.kvValue] || line.kvValue}</span>
                <button class="preset-clear" title="Clear preset" onclick={() => updateKv(i, sd ?? [0,0])}>✕</button>
              {:else if Array.isArray(line.kvValue)}
                {#each [0,1] as j}
                  {#if typeof line.kvValue[j] === "string" && $knownConstantsStore.has(line.kvValue[j])}
                    <span class="preset-pill sm" title={line.kvValue[j] + " → " + resolvePresetValue(line.kvValue[j])}>{$constantLabels[line.kvValue[j]] || line.kvValue[j]}</span>
                    <button class="preset-clear" title="Clear" onclick={() => updateKvIdx(i, line.kvValue, j, sd?.[j] ?? 0)}>✕</button>
                  {:else}
                    <input class="kv-str sm" type="text" value={line.kvValue[j] ?? 0}
                      onchange={(e) => updateKvIdx(i, line.kvValue, j, smartParseNum(e.currentTarget.value))} />
                  {/if}
                  {@const cpf = componentPresetField(line.kvKey, j)}
                  {#if cpf}
                    {@render presetBtn(cpf, (v) => updateKvIdx(i, line.kvValue, j, v), `comp-kv-${i}-${j}`)}
                  {/if}
                {/each}
              {/if}
            {:else if kt === "position_xy" && Array.isArray(line.kvValue)}
              {#each [0,1] as j}
                <input class="kv-str sm" type="text" value={line.kvValue[j] ?? ""}
                  onchange={(e) => { const r = e.currentTarget.value.trim(); updateKvIdx(i, line.kvValue, j, (r==="CENTER"||r==="MAX") ? r : smartParseNum(r)); }} />
              {/each}
            {:else if kt === "4bool" && Array.isArray(line.kvValue)}
              {#each ["F","B","L","R"] as lb, j}
                <label class="side-label"><span class="side-tag">{lb}</span>
                  <input type="checkbox" checked={line.kvValue[j] ?? false}
                    onchange={(e) => updateKvIdx(i, line.kvValue, j, e.currentTarget.checked)} />
                </label>
              {/each}
            {:else if kt === "4num" && Array.isArray(line.kvValue)}
              {#each ["F","B","L","R"] as lb, j}
                <label class="side-label"><span class="side-tag">{lb}</span>
                  <input class="kv-num xs" type="number" step={getStep(line.kvKey)} value={line.kvValue[j] ?? 0}
                    onchange={(e) => updateKvIdx(i, line.kvValue, j, parseNum(e.currentTarget.value))} />
                </label>
              {/each}
            {:else}
              <span class="kv-fallback">{JSON.stringify(line.kvValue)}</span>
            {/if}
            {@render unitSuffix(line.kvKey, ks)}
          </span>
          {@render presetBtn(line.kvKey, (v: any) => updateKv(i, v, sd), `kv-${i}-${line.kvKey}`)}
          {@render commentBtn(line, i)}
          <span class="spacer"></span>
          <button class="toggle-btn" class:active={rawValueEditing.has(i)} title="Edit value as raw text" onclick={() => toggleRawValueEdit(i)}>{"{}"}</button>
          <button class="fav-btn" class:active={isFavorite(line.kvKey)} title={isFavorite(line.kvKey) ? "Remove from favorites" : "Add to favorites"} onclick={() => toggleFavorite(line.kvKey)}>{isFavorite(line.kvKey) ? "★" : "☆"}</button>
        </div>

      {:else if line.kind === "makeall"}
        <div class="line-row make-row" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <span class="make-text">Make(</span>
          <select class="make-select" value={line.varName || "data"}
            onchange={(e) => handleMakeVarChange(i, e.currentTarget.value)}>
            {#each sceneNames as name}
              <option value={name}>{name}</option>
            {/each}
          </select>
          <span class="make-text">);</span>
        </div>

      {:else if line.kind === "blank"}
        <div class="line-row blank" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>&nbsp;</div>

      {:else if line.kind === "include" || line.kind === "marker"}
        <div class="line-row muted" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <span class="line-text">{line.raw}</span>
          <span class="line-badge">{line.kind}</span>
        </div>

      {:else if line.kind === "variable"}
        <div class="line-row variable" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <span class="var-name">{line.varName}</span>
          <span class="var-eq">=</span>
          <input class="var-value" type="text" spellcheck="false" value={line.varValue ?? ""}
            onblur={(e) => updateVariable(i, e.currentTarget.value)}
            onchange={(e) => updateVariable(i, e.currentTarget.value)} />
          {@render commentBtn(line, i)}
          <span class="spacer"></span>
          <button class="toggle-btn" title="Edit as raw text" onclick={() => toRaw(i)}>{"{}"}</button>
          <button class="delete-btn" title="Delete" onclick={() => deleteLine(i)}>✕</button>
        </div>

      {:else if line.kind === "comment"}
        <div class="line-row comment-line" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <span class="comment-slash">//</span>
          <input class="comment-standalone" type="text" spellcheck="false" value={line.comment ?? ""}
            onblur={(e) => handleStandaloneCommentEdit(i, e.currentTarget.value)}
            onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          <span class="spacer"></span>
          <button class="delete-btn" title="Delete" onclick={() => deleteLine(i)}>✕</button>
        </div>

      {:else if line.kind === "raw" && isRawGroupStart(i)}
        <div class="raw-block" style={bracketStyle(line.depth)} data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <textarea class="raw-textarea" spellcheck="false"
            rows={rawGroupLineCount(i)}
            value={rawGroupText(i)}
            onblur={(e) => handleRawGroupEdit(i, e.currentTarget.value)}
            onchange={(e) => handleRawGroupEdit(i, e.currentTarget.value)}
          ></textarea>
          {#if rawGroupLineCount(i) === 1}
            {@const parsable = canParse(line.raw)}
            <button class="toggle-btn raw-parse-btn" title={parsable ? "Parse as structured" : "Cannot parse this line"} disabled={!parsable} onclick={() => toParsed(i)}>{"{}"}</button>
          {/if}
        </div>

      {:else if line.kind === "raw" && isRawGroupMember(i)}
        <!-- Skip: this raw line is rendered as part of a group above -->

      {:else}
        <!-- Fallback for any other unhandled kind -->
        <div class="line-row raw" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}" transition:slide|global={{ duration: slideDur }}>
          <input class="raw-input" type="text" spellcheck="false" value={line.raw}
            onchange={(e) => handleLineEdit(i, e.currentTarget.value)} />
          {#if canParse(line.raw)}
            <button class="toggle-btn" title="Parse as structured" onclick={() => toParsed(i)}>{"{}"}</button>
          {/if}
        </div>
      {/if}

    {/each}
    </div>
    {#if showScad}
    <ScadPreview
      lines={$project.lines}
      libraryProfile={$project.libraryProfile}
      {hiddenLines}
      {kvRenderedInBlock}
      {globalRenderedInBlock}
      {collapsed}
      {defaultsMode}
      {isFavorite}
      bind:scadWidth
      {getGlobalRows}
      {getSortedSchemaRowsForOpen}
      {supportsLid}
      {hasLidChild}
      {getScalarKeysForContext}
      {isLastOfKind}
      {isRawGroupStart}
      {rawGroupText}
      {isRawGroupMember}
    />
    {/if}
    </div>
    {/if}
  </section>

  <footer class="status-bar" class:status-error={statusMsg.startsWith("Library:") || statusMsg.startsWith("OpenSCAD") || statusMsg.startsWith("File changed") || statusMsg.startsWith("File deleted")} data-testid="status-bar">
    <span data-testid="save-status">{statusMsg}</span>
    <span class="status-versions" data-testid="status-versions">
      <span class="status-version-app" title={bgsdVersionTooltip()}>BGSD {bgsdVersion}</span>
      {#if bgsdUpdateAvailable}
        <button class="status-update-chip" data-testid="status-update-bgsd" title="New BGSD version {updateInfo!.bgsd.latest} — click to download and install" disabled={selfUpdating} onclick={runSelfUpdate}>↑ {updateInfo!.bgsd.latest}</button>
      {/if}
      {#each libDisplay as lib (lib.id)}
        {#if lib.major !== null}
          {@const versionString = libVersionString(lib.id, lib.major)}
          <span class="status-version-sep">·</span>
          <span class="status-version-lib" class:status-version-active={$project.libraryProfile === lib.id} data-testid="status-version-{lib.id}" title={libVersionTooltip(lib.id, lib.label)}>{lib.label} {versionString}</span>
          {#if libUpdateAvailable(lib.id)}
            <button class="status-update-chip" data-testid="status-update-{lib.id}" title="{lib.label} lib has updates — click to update now" disabled={setupBusy} onclick={updateLibs}>↑ update</button>
          {/if}
        {/if}
      {/each}
    </span>
  </footer>

  {#if toastText}
    <div class="toast" data-testid="save-toast" role="status" aria-live="polite">{toastText}</div>
  {/if}

  {#if externalFileChange}
    <div class="prefs-overlay" role="presentation" data-testid="external-change-modal">
      <div class="external-change-modal" role="dialog" aria-modal="true" aria-labelledby="external-change-title">
        <h2 id="external-change-title" class="external-change-title">
          {externalFileChange.deleted ? "File deleted outside BGSD" : "File changed outside BGSD"}
        </h2>
        <p class="external-change-text">
          {externalFileChange.deleted
            ? "The file on disk is gone. BGSD has paused autosave for this design."
            : "The file on disk was modified by another program. BGSD has paused autosave to avoid overwriting those changes."}
        </p>
        <p class="external-change-path" title={externalFileChange.filePath}>{externalFileChange.filePath}</p>
        <div class="external-change-actions">
          <button class="prefs-btn" data-testid="external-change-reload" disabled={externalResolveBusy || externalFileChange.deleted} onclick={reloadExternalFile}>Reload from Disk</button>
          <button class="prefs-btn" data-testid="external-change-save-as" disabled={externalResolveBusy} onclick={saveExternalFileAs}>Save As...</button>
          <button class="prefs-btn primary" data-testid="external-change-overwrite" disabled={externalResolveBusy} onclick={overwriteExternalFile}>Overwrite File</button>
        </div>
      </div>
    </div>
  {/if}

  <PreferencesModal
    bind:show={showPrefs}
    bind:workingDir={prefsWorkingDir}
    bind:openScadPath={prefsOpenScadPath}
    bind:autoOpen={prefsAutoOpen}
    bind:proxy={prefsProxy}
    bind:theme={prefsTheme}
    onsave={savePreferences}
    onbrowseworkingdir={browseWorkingDirPref}
    onbrowseopenscad={browseOpenScadPath}
  />

  <FileHistoryModal
    bind:show={showFileHistory}
    filePath={currentFilePath}
    onrestore={restoreFileHistoryRevision}
  />

  {#if showIntent}
    <div class="intent-pane" data-testid="intent-pane">
      <input data-testid="intent-text" type="text" bind:value={intentText}
        placeholder="Describe what you expect to happen..." />
    </div>
    <div data-testid="scad-output" style="display:none">{scadOutput}</div>
  {/if}
</main>

<style>
  /* ── Cold-monochrome design tokens ────────────────────────────────
     Read priority (rendered three different ways, in order):
       1) Keys + values  — the only true black-cool ink in the editor.
       2) Hierarchy      — a single slate hue ramped by --depth so the
                          deepest level is brightest, the shallowest darkest.
       3) Default vs.    — italic + medium weight + ink-mute tint, plus a
          virtualized      slightly paler row bg. Stronger than a thin italic. */
  :root {
    /* ── Gruvbox Softened (eye-comfort variant) ────────────────────
       The canonical gruvbox-light-hard yellow bg is high-impact but
       fatigues eyes during long editor sessions. This variant shifts
       the cream toward a warm off-white (less yellow chroma) and uses
       the FADED accent set (#b57614, #9d0006, #79740e) instead of the
       saturated one. Same gruvbox character; lower retina dose. */
    --paper:        #faf5e6;  /* warm off-white, lighter than before */
    --paper-soft:   #f0eadb;
    --paper-deep:   #e3dcc6;

    --input-bg:     #ffffff;  /* editable inputs sit on pure white */

    --rule:         #c5bba5;
    --rule-soft:    #d6ccb5;

    --ink:          #3c3836;  /* gruvbox fg1 */
    --ink-soft:     #504945;
    --ink-mute:     #665c54;
    --ink-faint:    #7c6f64;

    /* Hierarchy ramp — fg1 → bg4 (gruvbox). */
    --sepia-deep:   #3c3836;
    --sepia-warm:   #665c54;
    --sepia-soft:   #a89984;
    --sepia-tint:   #e3dac4;  /* desaturated bg1 — chrome bar wash */
    --sepia-glow:   #ece4d0;

    /* Faded accents — gruvbox's "bright" (in the ANSI 9-14 slots), but
       in light themes these read as the deeper, more grounded variants. */
    --accent:       #b57614;  /* faded yellow */
    --accent-soft:  #e3dac4;
    --accent-deep:  #79740e;  /* faded green-yellow */

    --warn:         #b57614;
    --error:        #9d0006;  /* faded red */
    --comment:      #79740e;  /* faded green */
  }

  /* ── Gruvbox Dark Hard Contrast (terminalcolors.com) ────────────
     bg0_h dark is #1d2021. fg1 (#e3dac4) — the warm cream — is the
     foreground. The bright accent set replaces the regular one for
     dark mode so colors pop against the dark canvas. */
  :root[data-theme="dark"] {
    --paper:        #1d2021;  /* bg0_h dark — hard near-black */
    --paper-soft:   #282828;  /* bg0 dark */
    --paper-deep:   #32302f;  /* bg0_s dark */

    --input-bg:     #282828;  /* inputs sit on bg0 in dark mode */

    --rule:         #504945;  /* bg2 */
    --rule-soft:    #3c3836;  /* bg1 */

    --ink:          #e3dac4;  /* fg1 — warm cream foreground */
    --ink-soft:     #d6ccb5;  /* fg2 */
    --ink-mute:     #c5bba5;  /* fg3 */
    --ink-faint:    #a89984;  /* fg4 */

    /* Hierarchy ramp inverted: fg1 (cream) at depth 0 → bg3 (mid grey)
       at deepest. Brighter at the top, recedes into the dark canvas. */
    --sepia-deep:   #e3dac4;  /* fg1 — depth 0 strongest */
    --sepia-warm:   #c5bba5;  /* fg3 */
    --sepia-soft:   #665c54;  /* bg3 */
    --sepia-tint:   #3c3836;  /* bg1 — chrome bar wash */
    --sepia-glow:   #32302f;  /* bg0_s */

    --accent:       #fabd2f;  /* bright yellow */
    --accent-soft:  #3c3836;  /* bg1 */
    --accent-deep:  #b57614;

    --warn:         #fabd2f;  /* bright yellow */
    --error:        #fb4934;  /* bright red */
    --comment:      #b8bb26;  /* bright green */
  }
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; color: var(--ink); background: var(--paper-soft);
  }
  main { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .toolbar {
    display: flex; align-items: center; flex-wrap: wrap; gap: 2px;
    padding: 3px 8px; background: #e3dac4; border-bottom: 1px solid #c5bba5;
    flex-shrink: 0; font-size: 12px; overflow: visible; row-gap: 4px;
  }
  .toolbar-home {
    background: none; border: none; cursor: pointer; font-size: 18px; line-height: 1;
    padding: 1px 4px; color: #3c3836; border-radius: 3px;
  }
  .toolbar-home:hover { background: #c5bba5; color: #3c3836; }
  .toolbar-group { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .file-menu-wrap,
  .view-menu-wrap { position: relative; flex-shrink: 0; }
  .file-menu-button,
  .view-menu-button { min-width: 58px; }
  .file-menu,
  .view-menu {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 80;
    min-width: 220px; padding: 5px; border: 1px solid #c5bba5; border-radius: 4px;
    background: #ffffff; box-shadow: 0 10px 28px rgba(20, 35, 50, 0.18);
  }
  .view-menu { min-width: 250px; }
  .file-menu-item,
  .recent-item {
    width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 14px;
    border: none; border-radius: 3px; background: transparent; color: #3c3836;
    cursor: pointer; font-size: 12px; text-align: left; padding: 6px 8px;
  }
  .file-menu-item:hover,
  .file-menu-item:focus,
  .recent-item:hover,
  .recent-item:focus {
    background: #ebe4d2;
    outline: none;
  }
  .file-menu-item:disabled {
    opacity: 0.45; cursor: default; background: transparent;
  }
  .file-menu-item kbd {
    font-family: inherit; font-size: 11px; color: #665c54; background: transparent;
  }
  .file-menu-sep { height: 1px; background: #c5bba5; margin: 5px 2px; }
  .view-menu-group-label {
    padding: 6px 8px 4px; color: #3c3836; font-size: 11px; font-weight: 700;
    text-transform: uppercase;
  }
  .radio-menu-item span,
  .file-menu-item span {
    display: inline-flex; align-items: center; gap: 7px;
  }
  .radio-dot {
    width: 10px; height: 10px; border: 1px solid #a89984; border-radius: 50%;
    box-sizing: border-box; background: #ffffff;
  }
  .radio-dot.checked {
    border: 3px solid #b57614;
  }
  .check-mark {
    width: 12px; display: inline-block; color: #b57614; font-weight: 700;
  }
  .file-menu-recent { position: relative; }
  .file-menu-arrow { color: #665c54; font-size: 16px; line-height: 1; }
  .recent-flyout {
    display: none; position: absolute; top: -5px; left: 100%;
    min-width: 310px; max-width: min(520px, calc(100vw - 280px)); max-height: 360px; overflow: auto;
    padding: 5px; border: 1px solid #c5bba5; border-radius: 4px;
    background: #ffffff; box-shadow: 0 10px 28px rgba(20, 35, 50, 0.18);
  }
  .file-menu-recent:hover .recent-flyout,
  .file-menu-recent:focus-within .recent-flyout {
    display: block;
  }
  .recent-item {
    display: block; white-space: nowrap;
  }
  .recent-name {
    display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis;
  }
  .recent-path {
    display: block; margin-top: 2px; max-width: 470px;
    font-family: "Courier New", monospace; font-size: 11px; color: #665c54;
    overflow: hidden; text-overflow: ellipsis;
  }
  .recent-empty { padding: 8px; color: #665c54; font-size: 12px; white-space: nowrap; }
  .toolbar-btn {
    padding: 3px 8px; border: 1px solid #c5bba5; border-radius: 3px;
    background: #e3dac4; cursor: pointer; font-size: 12px; color: #3c3836;
  }
  .toolbar-icon-btn {
    width: 28px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #c5bba5; border-radius: 3px; background: #e3dac4;
    cursor: pointer; font-size: 17px; line-height: 1; color: #3c3836;
  }
  .toolbar-btn:hover { background: #fff; border-color: #a89984; }
  .toolbar-btn:active { background: #c5bba5; }
  .toolbar-icon-btn:hover { background: #fff; border-color: #a89984; }
  .toolbar-icon-btn:active { background: #c5bba5; }
  .toolbar-btn:disabled,
  .toolbar-icon-btn:disabled {
    opacity: 0.48; cursor: default; background: #c5bba5; color: #665c54;
  }
  .toolbar-btn:disabled:hover,
  .toolbar-icon-btn:disabled:hover {
    border-color: #c5bba5; background: #c5bba5;
  }
  .diagnostics-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .diagnostics-chip {
    display: inline-flex; align-items: center; gap: 6px;
    min-width: 82px; height: 24px; box-sizing: border-box;
    padding: 3px 8px; border: 1px solid #c5bba5; border-radius: 12px;
    background: #e3dac4; color: #3c3836; cursor: pointer;
    font-size: 12px; font-weight: 700;
  }
  .diagnostics-chip:hover { background: #fff; border-color: #a89984; }
  .diagnostics-chip.valid { background: #e7f5eb; border-color: #7db58a; color: #2f6b3f; }
  .diagnostics-chip.issues { background: #fff1d7; border-color: #d69a45; color: #7a4b08; }
  .diagnostics-chip.unavailable { background: #fdecea; border-color: #d99b92; color: #9b2f25; }
  .diagnostics-chip.stale { background: #f7f1df; border-color: #d1bd7a; color: #715c16; }
  .diagnostics-chip.checking { background: #ebe4d2; border-color: #a89984; color: #b57614; }
  /* Physical validation is turned off — gray the pill regardless of
     status, signalling that BIT-PHYSICAL checks aren't running. */
  .diagnostics-chip.phys-off,
  .diagnostics-chip.phys-off.valid,
  .diagnostics-chip.phys-off.issues,
  .diagnostics-chip.phys-off.stale {
    background: var(--paper-soft);
    border-color: var(--rule);
    color: var(--ink-mute);
  }
  .diagnostics-chip.phys-off .diagnostics-dot { background: var(--ink-faint); }
  .diagnostics-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #a89984; flex-shrink: 0;
  }
  .diagnostics-chip.valid .diagnostics-dot { background: #3d914e; }
  .diagnostics-chip.issues .diagnostics-dot { background: #d4800e; }
  .diagnostics-chip.unavailable .diagnostics-dot { background: #c0392b; }
  .diagnostics-chip.stale .diagnostics-dot { background: #b58d18; }
  .diagnostics-chip.checking .diagnostics-dot { background: #b57614; animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
  .diagnostics-panel {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 90;
    width: min(520px, calc(100vw - 24px)); max-height: 360px; overflow: hidden;
    display: flex; flex-direction: column;
    border: 1px solid #c5bba5; border-radius: 5px;
    background: #ffffff; box-shadow: 0 10px 28px rgba(20, 35, 50, 0.18);
  }
  .diagnostics-panel-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid #c5bba5; background: #ebe4d2;
  }
  .diagnostics-title { font-size: 13px; font-weight: 700; color: #3c3836; }
  .diagnostics-refresh {
    width: 24px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid #c5bba5; border-radius: 3px; background: #ffffff;
    color: #3c3836; cursor: pointer; font-size: 14px; line-height: 1;
  }
  .diagnostics-refresh:hover:not(:disabled) { background: #ebe4d2; border-color: #a89984; }
  .diagnostics-refresh:disabled { opacity: 0.5; cursor: default; }
  .diagnostics-summary {
    padding: 7px 10px; border-bottom: 1px solid #c5bba5;
    color: #3c3836; font-size: 12px; line-height: 1.35;
  }
  .diagnostics-summary.problem { color: #7a4b08; font-weight: 700; }
  .diagnostics-empty {
    padding: 12px 10px; color: #665c54; font-size: 12px;
  }
  .diagnostics-list {
    overflow: auto;
    max-height: 260px;
  }
  .diagnostics-issue {
    display: grid; grid-template-columns: auto 1fr auto; gap: 7px;
    align-items: start; padding: 8px 10px; border-bottom: 1px solid #c5bba5;
    font-size: 12px; color: #3c3836;
  }
  .diagnostics-issue:last-child { border-bottom: none; }
  .issue-severity {
    padding: 1px 5px; border-radius: 3px; text-transform: uppercase;
    font-size: 10px; font-weight: 700; line-height: 1.4;
    background: #c5bba5; color: #3c3836;
  }
  .diagnostics-issue.error .issue-severity { background: #fdecea; color: #c0392b; }
  .diagnostics-issue.warning .issue-severity { background: #fff1d7; color: #8a5a0a; }
  .issue-message { min-width: 0; line-height: 1.35; word-break: break-word; }
  .issue-location,
  .issue-file,
  .issue-meta {
    grid-column: 2 / 4; color: #665c54; font-family: "Courier New", monospace;
    font-size: 11px;
  }
  .toolbar-sep { width: 1px; height: 18px; background: #c5bba5; margin: 0 6px; }
  .content { flex: 1; overflow-y: auto; padding: 4px 0; display: flex; flex-direction: column; min-height: 0; }
  .toast {
    position: fixed; top: 48px; right: 14px; z-index: 100;
    max-width: min(360px, calc(100vw - 28px));
    background: #3c3836; color: #ffffff; border: 1px solid #b57614;
    border-radius: 5px; box-shadow: 0 10px 28px rgba(20, 35, 50, 0.22);
    padding: 9px 12px; font-size: 13px; font-weight: 600;
  }

  /* Split layout: editor left + SCAD pane right */
  .editor-split { display: flex; flex-direction: row; }
  .editor-left { flex: 1 1 auto; min-width: 560px; overflow-x: hidden; }
  :global(.editor-right) {
    width: 500px; flex-shrink: 0;
    background: #fff;
    overflow-x: hidden;
  }
  :global(.split-handle) {
    width: 6px; flex-shrink: 0;
    background: #c5bba5;
    cursor: col-resize;
  }
  :global(.split-handle:hover) { background: #c5bba5; }
  :global(.scad-line) {
    font-family: "Courier New", monospace; font-size: 13px;
    min-height: 24px;
    padding: 1px 8px;
    white-space: pre;
    color: #000;
    border-bottom: 1px solid #f0f0f0;
    display: flex; align-items: center;
  }
  :global(.scad-line.scad-virtual) { min-height: 24px; background: #eee; }
  :global(.scad-raw-group) {
    font-family: "Courier New", monospace; font-size: 13px;
    line-height: 22px;
    padding: 1px 8px;
    white-space: pre;
    color: #000;
    border-bottom: 1px solid #f0f0f0;
    overflow: hidden;
  }

  /* Styles for extracted components (WelcomeScreen, PreferencesModal) — must be global */
  :global(.welcome) {
    position: relative;
    display: flex; flex-direction: column; align-items: center;
    flex: 1; min-height: 0; gap: 8px; padding-top: 60px; overflow: hidden;
  }
  :global(:global(.welcome-title)) {
    margin: 0; font-size: 36px; font-weight: 700; color: #b57614;
  }
  :global(.welcome-subtitle) {
    margin: 0; font-size: 16px; color: #888;
  }
  :global(.welcome-actions) {
    display: flex; flex-direction: column; gap: 12px; width: 360px;
  }
  :global(.welcome-sort-bar) {
    display: flex; gap: 4px; justify-content: center; margin-bottom: 12px;
  }
  :global(.welcome-workdir) {
    width: min(760px, calc(100vw - 48px));
    margin: -2px 0 16px;
    color: #6b7d8e; font-size: 12px;
    font-family: "Courier New", monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    direction: rtl; text-align: center;
  }
  :global(.welcome-sort-btn) {
    padding: 4px 12px; font-size: 12px; font-weight: 500;
    border: 1px solid #ddd; border-radius: 4px;
    background: #fff; color: #888; cursor: pointer;
  }
  :global(.welcome-sort-btn.active) { background: #b57614; color: #fff; border-color: #b57614; }
  :global(.welcome-sort-btn:hover:not(.active)) { background: #ebe4d2; color: #b57614; border-color: #b57614; }
  :global(.welcome-icon-bar) {
    position: absolute; top: 12px; right: 16px;
    display: flex; gap: 6px;
  }
  :global(.welcome-icon-btn) {
    width: 32px; height: 32px; font-size: 18px; line-height: 1;
    border: 1px solid #ddd; border-radius: 6px;
    background: #fff; color: #666; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  :global(.welcome-icon-btn:hover:not(:disabled)) { background: #ebe4d2; color: #b57614; border-color: #b57614; }
  :global(.welcome-icon-btn:disabled) { opacity: 0.4; cursor: default; }
  :global(.spinning) { display: inline-block; animation: spin 0.8s linear infinite; }
  :global(.update-btn-wrap) { position: relative; }
  :global(.update-toast) {
    position: absolute; top: 100%; right: 0; margin-top: 6px;
    width: calc(100vw - 48px); max-width: 700px; max-height: 140px; overflow-y: auto;
    background: #fff; border: 1px solid #cbd5e1; border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.12);
    padding: 8px 10px; box-sizing: border-box;
    display: flex; gap: 8px; align-items: flex-start;
    z-index: 100;
  }
  :global(.update-toast-lines) {
    flex: 1; min-width: 0;
    font-family: "Courier New", monospace; font-size: 11px; color: #555;
    line-height: 1.5;
  }
  :global(.update-toast-line) {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    direction: rtl; text-align: left;
  }
  :global(.welcome-btn) {
    padding: 12px 24px; font-size: 16px; font-weight: 600;
    border: 1px solid #bbb; border-radius: 6px;
    background: white; color: #3c3836; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  :global(.welcome-btn:hover:not(:disabled)) {
    background: #ebe4d2; border-color: #b57614;
  }
  :global(.welcome-btn:disabled) {
    opacity: 0.5; cursor: default;
  }
  :global(.welcome-btn-primary) {
    background: #b57614; color: white; border-color: #b57614;
  }
  :global(.welcome-btn-primary:hover:not(:disabled)) {
    background: #3a6d91; border-color: #3a6d91;
  }
  :global(.welcome-btn-secondary) {
    font-size: 14px; padding: 8px 16px; color: #666; border-color: #ddd;
  }
  :global(.welcome-hint) {
    text-align: center; color: #888; font-size: 14px; margin: 0; line-height: 1.5;
  }
  :global(.welcome-status) {
    text-align: center; color: #b57614; font-size: 13px; margin: 0;
    max-width: 260px; word-break: break-word; align-self: center;
  }
  :global(.welcome-progress) {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin: 8px 0 4px; align-self: center;
  }
  :global(.welcome-progress-msg) {
    color: #b57614; font-size: 12px; font-weight: 500;
  }
  :global(.welcome-spinner) {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid #c8d9e6; border-top-color: #b57614;
    border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  :global(.welcome-columns) { display: flex; gap: 24px; justify-content: center; width: 100%; align-items: stretch; flex: 1; min-height: 0; }
  :global(.welcome-col) {
    width: 350px; flex: 0 0 350px;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #ddd; border-radius: 8px; background: #fff; padding: 16px;
  }
  :global(.welcome-col-right-align) { text-align: right; }
  :global(.welcome-col-right-align .welcome-new-file) { text-align: right; }
  :global(.welcome-col-right-align .welcome-library-game) { text-align: right; }
  :global(.welcome-col-right-align .welcome-library-empty-folder) { text-align: right; }
  :global(.welcome-library-title) { font-size: 18px; font-weight: 600; color: #3c3836; margin: 0 0 4px; }
  :global(.welcome-library-desc) { font-size: 12px; color: #999; margin: 0 0 12px; line-height: 1.4; }
  :global(.welcome-library-scroll) { overflow-y: auto; flex: 1; padding-right: 8px; }
  :global(.welcome-library-publisher) { margin-bottom: 14px; }
  :global(.welcome-new-file) {
    display: block; width: 100%; text-align: left;
    padding: 5px 10px; font-size: 14px; font-weight: 600;
    border: 1px dashed #c5bba5; border-radius: 4px;
    background: transparent; color: #b57614; cursor: pointer;
  }
  :global(.welcome-new-file:hover) { background: #ebe4d2; }
  :global(.welcome-library-empty-folder) { color: #bbb; font-size: 13px; font-style: italic; margin: 0; padding: 2px 10px; }
  :global(.welcome-library-publisher-name) { font-size: 12px; font-weight: 600; color: #b57614; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 4px; }
  :global(.welcome-library-game) {
    display: block; width: 100%; text-align: left;
    padding: 5px 10px; border: none; border-radius: 4px;
    background: transparent; color: #3c3836; font-size: 14px; cursor: pointer;
  }
  :global(.welcome-library-game:hover) { background: #ebe4d2; color: #b57614; }
  :global(.welcome-library-game.user-file) { font-weight: 600; }
  :global(.welcome-library-game.user-file::before) { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #d4800e; margin-right: 6px; flex-shrink: 0; vertical-align: middle; }
  :global(.welcome-library-game:not(.user-file)::before) { content: ""; display: inline-block; width: 7px; height: 9px; border: 1.5px solid #c5bba5; border-left: 2.5px solid #c5bba5; border-radius: 0 1px 1px 0; margin-right: 5px; flex-shrink: 0; vertical-align: middle; }
  :global(.welcome-library-rename) {
    display: block; width: 100%; box-sizing: border-box;
    padding: 5px 10px; font-size: 14px; font-weight: 600;
    color: #3c3836; background: #fff;
    border: 1px solid #b57614; border-radius: 4px; outline: none;
    font-family: inherit;
  }
  :global(.lib-context-backdrop) {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 999;
  }
  :global(.lib-context-menu) {
    position: fixed; z-index: 1000;
    background: #fff; border: 1px solid #ddd; border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15); min-width: 160px;
    padding: 4px 0; display: flex; flex-direction: column;
  }
  :global(.lib-context-item) {
    display: block; width: 100%; text-align: left;
    padding: 8px 16px; border: none; background: transparent;
    font-size: 14px; color: #3c3836; cursor: pointer;
  }
  :global(.lib-context-item:hover) { background: #ebe4d2; color: #b57614; }
  /* ── Editor rows ──────────────────────────────────────────────────
     Hierarchy ramp keyed off --depth: warm sepia from sepia-deep (depth 0)
     to sepia-soft (deepest). 20% per step gives a glance-readable level
     delta across the 0–5 range that covers virtually every BGSD document.
     The cold ink keys/values still win first read on a paper bg; sepia
     carries the second read on the card frames + labels. */
  .line-row, .raw-block {
    --bracket-color: color-mix(in oklch, var(--sepia-deep), var(--sepia-soft) calc(var(--depth, 0) * 20%));
    /* Editable rows sit on near-paper so keys + values read first; only
     a whisper of sepia (2% per shallow depth) keeps any depth tint.
     The card chrome (struct.open/close) keeps the strong sepia bar. */
    --row-tint:      color-mix(in srgb, var(--paper), var(--sepia-tint) calc(max(0, 5 - var(--depth, 0)) * 2%));
    --bracket-bg:    var(--row-tint);
  }
  /* Slide wrappers: a single container around the open's collapsible
     body and around the close branch. The wrapper carries
     transition:slide so the whole block slides as a unit (the visible
     portion clips from the bottom as height shrinks). Inner rows have
     no transition of their own — they just sit there and get clipped. */
  .block-body, .block-tail { display: block; }

  .line-row {
    position: relative;
    display: flex; align-items: center; gap: 6px;
    /* Fixed row height keeps checkbox clicks (and italic↔upright
       restyles on materialise) from shifting layout. Slide reads
       computed height at start of transition, so 24px → 0 still
       works for collapse animations. */
    height: 24px; box-sizing: border-box;
    padding: 3px 8px;
    line-height: 18px;
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    /* No row-bottom border — the row is no longer the visual unit;
       the block (the card framed by struct.open + content +
       struct.close) is. Rows merge cleanly into the card body. */
    background: linear-gradient(to right, transparent var(--indent, 0px), var(--bracket-bg) var(--indent, 0px));
  }

  /* Dot leader — drawn INSIDE kv-key's fixed-width column, after the
     label text. The label takes natural width; the ::after pseudo
     flex-grows within kv-key to fill the rest. kv-control's position
     never shifts because kv-key's outer width stays pinned to 180px. */
  /* Indent column: one vertical rail per ancestor depth, drawn as a
     repeating gradient in the indent area. Sepia rails keep the
     palette unified — no warring cold/warm layers. */
  .line-row::before {
    content: ""; position: absolute;
    left: 0; top: 0; bottom: 0;
    width: var(--indent, 0px);
    background-image: repeating-linear-gradient(
      to right,
      transparent 0,
      transparent 23px,
      var(--sepia-deep) 23px,
      var(--sepia-deep) 24px
    );
    opacity: 0.22;
    pointer-events: none; z-index: 1;
  }

  /* Card top + bottom edges. struct.open carries the card's top edge;
     struct.close carries the bottom. Both span only x=indent → right
     edge, so the edge starts where the card actually starts (not in
     the indent area). Color is the card's own --bracket-color, so each
     level's frame is visibly its own depth on the slate ramp. */
  .line-row.struct.open::after,
  .line-row.struct.close::after {
    content: "";
    position: absolute;
    left: var(--indent, 0px);
    right: 0;
    height: 1px;
    background: var(--bracket-color);
    pointer-events: none; z-index: 2;
  }
  .line-row.struct.open::after  { top: 0; }
  .line-row.struct.close::after { bottom: 0; }
  /* Depth-0 cards are the page's section anchors — give them a 2px
     frame so they read as primary structure, not just a deeper nest. */
  .line-row.struct.open[style*="--depth: 0;"]::after,
  .line-row.struct.close[style*="--depth: 0;"]::after {
    height: 2px;
  }

  /* Two row backgrounds in the editor — only two:
       - Paper (kv body): pure --row-tint, nearly white.
       - Sepia (chrome bars + add-row shelves): paper + 65% sepia-tint.
     Header bars, footer bars, and the + button rows all share the
     sepia shade so the eye sees a single "frame layer" rather than a
     palette of three or four tints. */
  .line-row.struct.open,
  .line-row.struct.close,
  .line-row.add-row,
  .line-row.add-scene-row {
    --bracket-bg: color-mix(in srgb, var(--paper), var(--sepia-tint) 65%);
  }
  /* Content rows: pure paper. Hierarchy is conveyed by the surrounding
     card, not by tinting every row. Keys win first read. */
  .line-row.kv {
    --bracket-bg: var(--paper);
  }
  .line-row.kv-category {
    --bracket-bg: color-mix(in srgb, var(--paper), var(--sepia-tint) 42%);
    height: 22px;
    padding-top: 2px;
    padding-bottom: 2px;
    margin-top: 6px;
    gap: 8px;
    color: var(--ink-mute);
  }
  .line-row.kv-category + .line-row.kv-category { margin-top: 0; }
  .line-row.kv-category:first-child { margin-top: 0; }
  .category-label {
    font-size: 12px;
    font-weight: 700;
    color: var(--bracket-color);
  }
  .category-count {
    font-size: 11px;
    color: var(--ink-faint);
  }
  /* close rows are just `]` — keep them slim so they read as a footer
     line, not another data row. No min-height (would clamp the slide). */
  .line-row.struct.close { padding-top: 1px; padding-bottom: 1px; line-height: 16px; }

  /* Block gaps: separate every card from its surroundings. */
  .line-row.struct.open  { margin-top: 18px; }
  .line-row.struct.close { margin-bottom: 18px; }

  .line-row.muted { opacity: 0.35; font-style: italic; }

  /* Read 3 — default vs virtualized.
     Bold italic at weight 700 (Courier New only ships 400/700, so anything
     between renders as wispy 400). Italic carries the "ghost" feel; the
     color step to --ink-mute keeps the key recessive vs. real-non-default
     keys at --ink. The row bg is pulled toward white so an entire ghost
     row reads as "preview, not committed". */
  /* Virtual KV rows share the same row bg as their real-default
     siblings — the ghost cue is carried by italic + ink-mute on the
     key, not by a separate background wash. (The user explicitly asked
     for defaults and virtualized to read on the same surface.) */
  .line-row.kv.virtual .kv-key {
    font-style: italic;
    font-weight: 700;
    color: var(--ink-mute);
  }
  .line-row.kv.virtual .kv-num,
  .line-row.kv.virtual .kv-str,
  .line-row.kv.virtual .kv-control select {
    color: var(--ink-mute);
  }
  .line-row.struct.virtual .struct-label,
  .line-row.struct.virtual .struct-bracket {
    font-style: italic;
  }

  /* Real-but-default keys: stays upright weight 700 so the column does
     not reflow as a ghost materialises, but faded deeper than before so
     "default" reads as recessive at a glance. */
  .line-row.kv.is-default .kv-key { color: var(--ink-mute); }

  .virtual-key { }

  .collapse-btn {
    /* Absolute-positioned in the per-depth gutter, sharing the same
       column as the diagnostic slot — between the hierarchy rail and
       the row's label. Pulled OUT of flex flow so the struct-label
       aligns with the kv-key column of same-depth siblings. */
    position: absolute;
    left: calc(4px + var(--indent, 0px));
    top: 0; bottom: 0;
    width: 16px;
    background: none; border: none; cursor: pointer; padding: 0; margin: 0;
    font-size: 12px; color: var(--ink-mute);
    text-align: center;
    font-family: "Courier New", monospace;
    display: flex; align-items: center; justify-content: center;
    z-index: 2;
  }
  .collapse-btn:hover { color: var(--ink); }

  /* Read 2 — hierarchy.
     Struct labels and bracket characters share the slate ramp. At depth 0
     this is the darkest slate (a true section anchor); each deeper level
     fades toward slate-soft. */
  .struct-label { font-weight: 700; color: var(--bracket-color); }
  .struct-label.inferred { font-weight: 400; opacity: 0.6; }
  .struct-bracket { color: var(--bracket-color); font-weight: 700; }
  .debug-toggle {
    background: none; border: none; cursor: pointer;
    margin-left: 4px; padding: 0 2px;
    color: #999; opacity: 0.4; line-height: 1;
    display: inline-flex; align-items: center;
  }
  .debug-toggle:hover { opacity: 0.8; }
  .debug-toggle.active { opacity: 0.9; color: #e67e22; }
  .spacer { flex: 1; }

  .line-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .line-badge { font-size: 11px; color: #999; background: #eee; padding: 1px 5px; border-radius: 2px; font-weight: 500; }

  /* Read 1 — keys + values.
     The kv-key is the only weight-700 ink-darkest text in the editor; it
     wins the eye on every row regardless of depth. */
  .kv-key {
    font-weight: 700; color: var(--ink);
    min-width: 180px; flex-shrink: 0;
    /* Flex container so the dot-leader pseudo can flex-grow inside the
       180px column, between the label text and the right edge — without
       affecting the kv-control's position outside. */
    display: inline-flex; align-items: center;
  }
  /* Dot leader from end-of-label to end-of-key-column. The diagnostic
     slot beside the key collapses to 0 width when empty (see
     .line-diagnostic-slot:empty below) so the dots run right up to
     the kv-control. When a diagnostic IS present, the marker
     interrupts the leader — drawing attention to the problem. */
  .kv-key::after {
    content: "";
    flex: 1;
    align-self: end;
    margin: 0 0 5px 6px;
    border-bottom: 2px dotted var(--ink-faint);
    opacity: 0.35;
  }
  .line-row.has-diagnostic { box-shadow: inset 3px 0 0 var(--warn); }
  .line-row.diagnostic-error { box-shadow: inset 3px 0 0 var(--error); }
  /* Diagnostic-related field highlight — only the editable inputs in
     a flagged row get a red ring, not the row itself. Uses box-shadow
     instead of outline so the bottom edge isn't clipped by the next
     row pressing against the 24px row height. When the diagnostic
     parses an axis, non-matching subfields on multi-axis inputs drop
     the ring so the user's eye lands on the value that needs to change. */
  .line-row.diag-highlight .kv-control input,
  .line-row.diag-highlight .kv-control select {
    box-shadow: 0 0 0 2px var(--error);
    border-color: var(--error);
    position: relative;
    z-index: 1;
  }
  .line-row.diag-highlight.diag-x .kv-control input[data-axis]:not([data-axis="x"]),
  .line-row.diag-highlight.diag-y .kv-control input[data-axis]:not([data-axis="y"]),
  .line-row.diag-highlight.diag-z .kv-control input[data-axis]:not([data-axis="z"]) {
    box-shadow: none;
    border-color: var(--rule);
  }
  /* Diagnostic slot + collapse-btn share the same per-depth gutter:
     just to the right of the hierarchy rail (at the indent boundary)
     and just to the left of the row's label/content. For struct.open
     rows the collapse arrow lives here; for kv rows a diagnostic
     marker (if any) lives here. When a struct row also has a
     diagnostic, the marker (z-index 3) overlays the arrow (z-index 2). */
  .line-diagnostic-slot {
    position: absolute;
    left: calc(4px + var(--indent, 0px));
    top: 0; bottom: 0;
    width: 16px;
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
    z-index: 3;
  }
  .line-diagnostic-slot:not(:empty) { pointer-events: auto; }
  .line-diagnostic-marker {
    width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
    border: none; border-radius: 0; clip-path: polygon(50% 4%, 98% 96%, 2% 96%);
    /* Hazard triangles are red — kept distinct from the yellow accent
       used by checkboxes/stars so the alarm reads unambiguously. */
    background: var(--error); color: var(--paper); cursor: pointer;
    font-family: Arial, sans-serif; font-size: 11px; font-weight: 800; line-height: 1;
    padding-top: 3px;
    /* Optically centre the triangle in the row — clip-path top vertex
       leaves visual weight at the bottom, so nudge up 2px. */
    transform: translateY(-2px);
  }
  .line-diagnostic-marker.error { background: var(--error); color: var(--paper); }
  .line-diagnostic-marker.info  { background: var(--accent); color: var(--paper); }
  .line-diagnostic-marker:hover { filter: brightness(0.97); }
  .kv-control { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .kv-num { font-family: "Courier New", monospace; font-size: 15px; font-weight: 400; padding: 1px 4px; border: 1px solid var(--rule); border-radius: 2px; width: 56px; background: var(--input-bg); color: var(--ink); }
  .kv-num.xs { width: 44px; }
  .kv-str { font-family: "Courier New", monospace; font-size: 15px; font-weight: 400; padding: 1px 4px; border: 1px solid var(--rule); border-radius: 2px; width: 160px; background: var(--input-bg); color: var(--ink); }
  .kv-str.sm { width: 56px; }
  .kv-control select { font-family: "Courier New", monospace; font-size: 15px; font-weight: 400; padding: 1px 4px; border: 1px solid var(--rule); border-radius: 2px; background: var(--input-bg); color: var(--ink); }
  /* Smaller checkboxes — they were dominating the row visually. */
  .kv-control input[type="checkbox"] { width: 13px; height: 13px; accent-color: var(--accent); }
  .kv-fallback { color: var(--ink-faint); font-size: 13px; }
  .unit-suffix { align-self: center; min-width: 20px; color: var(--ink-mute); font-size: 11px; font-weight: 700; line-height: 1; white-space: nowrap; }
  .side-label { display: inline-flex; align-items: center; gap: 2px; font-size: 13px; }
  .side-tag { color: var(--ink-faint); font-size: 11px; font-weight: 600; width: 12px; text-align: center; }

  /* Raw tier: unparsed text blocks */
  .raw-block {
    position: relative;
    width: 100%;
    border-bottom: 1px solid var(--rule-soft);
    background: linear-gradient(to right, transparent var(--indent, 0px), var(--bracket-bg) var(--indent, 0px));
  }
  .raw-block::before {
    content: ""; position: absolute;
    left: calc(8px + var(--indent, 0px) - 1px);
    top: 0; bottom: 0;
    width: 1px;
    background: var(--bracket-color);
    opacity: 0.45;
    pointer-events: none; z-index: 1;
  }
  .raw-block[style*="--depth: 0;"]::before { content: none; }
  .raw-textarea {
    display: block;
    width: 100%; box-sizing: border-box;
    resize: none; overflow: hidden;
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    line-height: 22px;
    padding: 1px 8px;
    border: none;
    background: transparent; color: #1a1a1a;
    outline: none;
  }
  .raw-textarea:focus { background: #edf2f7; }
  .raw-input {
    flex: 1; min-width: 0;
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    padding: 1px 4px; border: 1px solid var(--rule); border-radius: 2px;
    background: var(--input-bg); color: var(--ink);
  }
  .toggle-btn {
    background: none; border: 1px solid #c5bba5; color: #a89984;
    cursor: pointer; font-size: 11px; font-weight: 700;
    padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
    font-family: "Courier New", monospace;
    opacity: 0; transition: opacity 0.1s;
  }
  .line-row:hover .toggle-btn { opacity: 1; }
  .toggle-btn:hover:not(:disabled) { border-color: #b57614; color: #b57614; }
  .toggle-btn:disabled { opacity: 0.3; cursor: default; }
  .toggle-btn.active { opacity: 1; background: #b57614; color: white; border-color: #b57614; }
  .kv-raw-value {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    padding: 1px 4px; border: 1px solid var(--accent); border-radius: 2px;
    width: 280px; background: var(--input-bg); color: var(--ink);
  }
  .add-btn {
    background: none; border: 1px dashed #c5bba5; color: #546e7a;
    padding: 0 8px; border-radius: 3px; cursor: pointer;
    font-size: 14px; font-weight: 700; line-height: 1.4;
  }
  .add-btn:hover { border-color: #b57614; color: #b57614; }
  .add-scene-row { border-bottom: none; }
  .comment-btn {
    background: none; border: none; color: #ccc; cursor: pointer;
    font-family: "Courier New", monospace; font-size: 13px; font-weight: 700;
    padding: 0 3px; flex-shrink: 0;
    opacity: 0; transition: opacity 0.15s;
  }
  .line-row:hover .comment-btn { opacity: 1; }
  .comment-btn:hover { color: #4a9960; }
  .comment-area {
    display: inline-flex; align-items: center; gap: 2px; flex-shrink: 0;
  }
  .comment-slash {
    color: #4a9960; font-family: "Courier New", monospace; font-size: 13px; font-weight: 700;
  }
  .comment-input {
    font-family: "Courier New", monospace; font-size: 13px; font-weight: 400;
    color: #4a9960; font-style: italic;
    border: none; background: transparent;
    padding: 0 4px; width: 180px; outline: none;
  }
  .comment-input:focus { border-bottom: 1px solid #4a9960; }
  .delete-btn, .dup-btn { background: none; border: none; color: #ccc; cursor: pointer; font-size: 16px; padding: 0 4px; opacity: 0; transition: opacity 0.1s; }
  .line-row:hover .delete-btn, .line-row:hover .dup-btn { opacity: 1; }
  .delete-btn:hover { color: #e74c3c; }
  .dup-btn:hover { color: #546e7a; }
  .fav-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 0 2px; color: #ccc; opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
  .line-row:hover .fav-btn { opacity: 1; }
  .fav-btn.active { color: #f0c040; opacity: 1; }
  .fav-btn:hover { color: #e6a800; }
  .line-row.fading-out { animation: fadeOut 0.3s ease forwards; }
  @keyframes fadeOut { from { opacity: 1; max-height: 30px; } to { opacity: 0; max-height: 0; overflow: hidden; } }
  .scene-name-input {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 700;
    color: #3c3836; background: transparent; border: none;
    border-bottom: 1px dashed #b0bec5; padding: 0 4px; outline: none;
    width: auto; min-width: 60px;
  }
  .scene-name-input:focus { border-bottom: 1px solid #546e7a; background: #f0f4f8; }
  .make-text {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 700; color: #3c3836;
  }
  .make-select {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 700;
    color: #3c3836; background: white; border: 1px solid #c5bba5;
    border-radius: 2px; padding: 1px 4px;
  }

  /* Variable lines */
  .var-name { font-weight: 700; color: #3c3836; }
  .var-eq { color: #999; font-weight: 700; margin: 0 4px; }
  .var-value {
    font-family: "Courier New", monospace; font-size: 15px;
    border: none; border-bottom: 1px dashed #ccc; background: transparent;
    padding: 0 4px; outline: none; flex: 1; min-width: 80px;
  }
  .var-value:focus { border-bottom: 1px solid #546e7a; }

  /* Standalone comment lines */
  .comment-standalone {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    color: #4a9960; font-style: italic;
    border: none; background: transparent;
    padding: 0 4px; flex: 1; outline: none;
  }
  .comment-standalone:focus { border-bottom: 1px solid #4a9960; }

  /* Add row */
  /* No min-height on add-row — would clamp the slide animation. */

  /* Preset button + dropdown */
  .preset-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
  .preset-btn {
    background: none; border: 1px solid #c5bba5; color: #a89984;
    cursor: pointer; font-size: 10px; padding: 1px 4px; border-radius: 3px;
    opacity: 0; transition: opacity 0.1s; flex-shrink: 0;
  }
  .line-row:hover .preset-btn { opacity: 1; }
  .preset-btn:hover { border-color: #b57614; color: #b57614; }
  .preset-menu {
    position: absolute; top: 100%; left: 0; z-index: 50;
    background: white; border: 1px solid #c8d1da; border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15); min-width: 180px;
    padding: 2px 0; margin-top: 2px;
  }
  .preset-item {
    display: block; width: 100%; text-align: left;
    padding: 4px 10px; border: none; background: none;
    cursor: pointer; font-size: 13px; color: #3c3836;
    white-space: nowrap;
  }
  .preset-item:hover { background: #e8f0fe; }
  .preset-pill {
    display: inline-flex; align-items: center;
    padding: 1px 8px; border-radius: 10px;
    background: #e0ecf5; color: #b57614;
    font-family: "Courier New", monospace; font-size: 13px; font-weight: 600;
    white-space: nowrap;
  }
  .preset-pill.sm {
    padding: 0 5px; font-size: 11px; border-radius: 7px;
  }
  .preset-clear {
    background: none; border: none; color: #999; cursor: pointer;
    font-size: 14px; padding: 0 3px; flex-shrink: 0;
  }
  .preset-clear:hover { color: #e74c3c; }

  /* Raw parse-back button */
  .raw-parse-btn {
    position: absolute; right: 8px; top: 2px;
    opacity: 0; transition: opacity 0.1s;
  }
  .raw-block { position: relative; }
  .raw-block:hover .raw-parse-btn { opacity: 1; }

  .status-bar { display: flex; justify-content: space-between; align-items: center; padding: 3px 12px; background: #e4eaf0; border-top: 1px solid #c5bba5; font-size: 13px; color: #546e7a; }
  .status-bar.status-error { background: #fdecea; color: #c0392b; font-weight: 700; }
  .status-versions { display: inline-flex; align-items: center; gap: 6px; font-family: "Courier New", monospace; font-size: 12px; color: #6b7d8e; }
  .status-bar.status-error .status-versions { color: #c0392b; }
  .status-version-sep { color: #c5bba5; }
  .status-version-active { color: #b57614; font-weight: 600; }
  .status-update-chip {
    font-family: inherit; font-size: 11px; line-height: 1; cursor: pointer;
    padding: 2px 6px; border-radius: 9px;
    background: #fff5d8; color: #8a6d2c; border: 1px solid #e6cf90;
  }
  .status-update-chip:hover { background: #ffe9b3; border-color: #d4b265; color: #6e521d; }
  .intent-pane { background: #1a1a2e; padding: 6px 12px; border-top: 2px solid #e74c3c; }
  .intent-pane input { width: 100%; box-sizing: border-box; background: #16213e; border: 1px solid #444; color: #e0e0e0; padding: 4px 8px; font-family: "Courier New", monospace; font-size: 13px; border-radius: 2px; }

  /* Preferences modal */
  :global(.prefs-overlay) {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  :global(.prefs-modal) {
    background: white; border-radius: 8px; padding: 24px 28px;
    min-width: 520px; max-width: 680px; width: 680px; box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  }
  :global(.prefs-title) { margin: 0 0 16px; font-size: 18px; color: #3c3836; }
  :global(.prefs-row) { margin-bottom: 14px; }
  :global(.prefs-label) { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 4px; }
  :global(.prefs-input-row) { display: flex; gap: 6px; }
  :global(.prefs-input) {
    flex: 1; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px;
    font-family: "Courier New", monospace; font-size: 13px;
  }
  :global(.prefs-browse) {
    padding: 6px 12px; border: 1px solid #bbb; border-radius: 4px;
    background: #ebe4d2; cursor: pointer; font-size: 13px;
  }
  :global(.prefs-browse:hover) { background: #eee; border-color: #999; }
  :global(.prefs-check-label) {
    display: flex; align-items: center; gap: 8px;
    font-size: 14px; color: #333; cursor: pointer;
  }
  :global(.prefs-check-label input[type="checkbox"]) { width: 16px; height: 16px; }
  :global(.prefs-buttons) { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  :global(.prefs-btn) {
    padding: 8px 18px; border: 1px solid #bbb; border-radius: 4px;
    background: white; cursor: pointer; font-size: 14px;
  }
  :global(.prefs-btn:hover) { background: #ebe4d2; }
  :global(.prefs-btn.primary) { background: #b57614; color: white; border-color: #b57614; }
  :global(.prefs-btn.primary:hover) { background: #1e3f5a; }
  :global(.prefs-theme-toggle) {
    display: inline-flex; gap: 8px; margin-top: 6px;
  }
  :global(.prefs-theme-btn) {
    padding: 6px 14px; border: 1px solid var(--rule); border-radius: 4px;
    background: var(--paper); color: var(--ink); cursor: pointer; font-size: 13px;
  }
  :global(.prefs-theme-btn.active) {
    background: var(--accent); border-color: var(--accent-deep);
    color: var(--paper);
  }
  :global(.prefs-theme-btn:hover:not(.active)) {
    background: var(--sepia-tint);
  }
  .external-change-modal {
    background: white; border-radius: 8px; padding: 22px 26px;
    width: min(620px, calc(100vw - 40px)); box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  }
  .external-change-title {
    margin: 0 0 10px; font-size: 18px; color: #8a3d10;
  }
  .external-change-text {
    margin: 0 0 12px; color: #3c3836; line-height: 1.45;
  }
  .external-change-path {
    margin: 0; padding: 8px 10px; border: 1px solid #d7dee6; border-radius: 4px;
    background: #ebe4d2; color: #3c3836; font-family: "Courier New", monospace;
    font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .external-change-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap;
  }
  :global(.prefs-divider) { border-top: 1px solid #e0e0e0; margin: 16px 0 12px; }
  :global(.prefs-about) { text-align: center; }
  :global(.prefs-links) { display: flex; justify-content: center; gap: 6px; font-size: 13px; flex-wrap: wrap; }
  :global(.prefs-links a) { color: #b57614; text-decoration: none; }
  :global(.prefs-links a:hover) { text-decoration: underline; }
  :global(.prefs-link-sep) { color: #bbb; }
  :global(.prefs-submit-designs) { text-align: left; margin: 12px 0 8px; padding: 10px 12px; background: #ebe4d2; border-radius: 6px; border: 1px solid #e0e8ef; }
  :global(.prefs-submit-title) { font-size: 13px; font-weight: 600; color: #b57614; margin: 0 0 4px; }
  :global(.prefs-submit-help) { font-size: 12px; color: #555; margin: 4px 0; line-height: 1.6; }
  :global(.prefs-submit-help a) { color: #b57614; text-decoration: none; }
  :global(.prefs-submit-help a:hover) { text-decoration: underline; }
  :global(.prefs-copyright) { font-size: 11px; color: #999; margin: 8px 0 0; }
  .toolbar-gear { font-size: 18px; line-height: 1; }
</style>
