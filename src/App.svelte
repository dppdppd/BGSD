<script lang="ts">
  import { onMount } from "svelte";
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
    type Line,
  } from "./lib/stores/project";
  import { generateScad } from "./lib/scad";
  import { startAutosave, onSaveStatus, setFilePath, getFilePath, setNeedsBackup, setReadOnly, getReadOnly, onReadOnlyEdit, saveNow, triggerSave } from "./lib/autosave";
  import { getSchema } from "./lib/schema";
  import tooltips from "./lib/tooltips/en.json";

  let intentText = $state("");
  let showIntent = $state(false);
  let statusMsg = $state("No file open");
  let hideDefaults = $state(false);
  let showScad = $state(false);
  let showWelcome = $state(true);
  let scadWidth = $state(500);
  let dragging = $state(false);

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
  let prefsOpenScadPath = $state("");
  let prefsAutoOpen = $state(true);
  let prefsReuseOpenScad = $state(true);
  let prefsProxy = $state("");

  let scadOutput = $derived(generateScad($project));

  onSaveStatus((msg: string) => { statusMsg = msg; });

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
    const { data, filePath } = payload;
    project.set(data);
    updateTitle(filePath);
    fileLoaded = true;
    showWelcome = false;

    // Check if this is a repo-tracked library file (read-only)
    const bgsd = (window as any).bgsd;
    const repoCheck = await bgsd?.checkRepoFile?.(filePath);
    if (repoCheck?.repoFile) {
      setFilePath(filePath);
      setReadOnly(true);
      const name = filePath.replace(/.*[/\\]/, "");
      statusMsg = `${name} (library example — Save As to edit)`;
    } else {
      setFilePath(filePath);
      setReadOnly(false);
      setNeedsBackup(!data.hasMarker);
      const name = filePath.replace(/.*[/\\]/, "");
      statusMsg = data.hasMarker ? name : `${name} (will backup .bak on first save)`;
    }

    // Auto-launch OpenSCAD after every load
    launchOpenScad(filePath, data.libraryProfile);
  }

  onMount(async () => {
    showIntent = !!(window as any).bgsd?.harness;
    startAutosave();

    // When a read-only library file is edited, prompt Save As
    onReadOnlyEdit(async () => {
      if (!getReadOnly()) return;
      statusMsg = "Library example — saving a copy...";
      await saveFileAs();
      if (getFilePath()) {
        setReadOnly(false);
        const name = (getFilePath() || "").replace(/.*[/\\]/, "");
        statusMsg = `Saved ${name}`;
      } else {
        statusMsg = `${(getFilePath() || "").replace(/.*[/\\]/, "")} (library example — Save As to edit)`;
      }
    });

    // After 1 s of input inactivity, commit the focused control so autosave picks it up.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener("input", () => {
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
    if (bgsd?.onMenuSaveAs) bgsd.onMenuSaveAs(saveFileAs);
    if (bgsd?.onMenuOpenInOpenScad) bgsd.onMenuOpenInOpenScad(openInOpenScad);
    if (bgsd?.onMenuPreferences) bgsd.onMenuPreferences(openPreferencesModal);
    if (bgsd?.onMenuToggleHideDefaults) bgsd.onMenuToggleHideDefaults((checked: boolean) => { hideDefaults = checked; });
    if (bgsd?.onMenuToggleShowScad) bgsd.onMenuToggleShowScad((checked: boolean) => { showScad = checked; });

    // Load working directory status
    const wdStatus = await bgsd?.getWorkingDirStatus?.();
    if (wdStatus?.set) {
      workingDir = wdStatus.path;
      workingDirSet = true;
      loadLibraryTree();
    }

    // Listen for working dir progress messages
    bgsd?.onWorkingDirProgress?.((msg: string) => {
      setupStatus = msg;
      setupLog = [...setupLog, msg];
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

    // If working directory is set, create directly via IPC (no Save As dialog)
    if (workingDirSet && bgsd?.newProjectToPath) {
      const res = await bgsd.newProjectToPath(profile);
      if (!res.ok) {
        statusMsg = `New project failed: ${res.error || "unknown error"}`;
        return;
      }
      // The IPC handler sends menu-open which triggers handleLoad
      return;
    }

    // No working dir — fall back to Save As flow
    let templateProject: any;
    if (profile === "ctd") {
      templateProject = { version: 1, lines: [
        { raw: "scene_1 = [", kind: "open", depth: 0, role: "data", label: "scene_1", varName: "scene_1" },
        { raw: "    [ COUNTER_SET,", kind: "open", depth: 1, role: "counter_set", label: "COUNTER_SET" },
        { raw: "        [ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],", kind: "kv", depth: 2, kvKey: "COUNTER_SIZE_XYZ", kvValue: [13.3, 13.3, 3] },
        { raw: "    ],", kind: "close", depth: 1, role: "counter_set", label: "COUNTER_SET" },
        { raw: "];", kind: "close", depth: 0, role: "data", label: "scene_1", varName: "scene_1" },
        { raw: "Make(scene_1);", kind: "makeall", depth: 0, varName: "scene_1" },
      ], hasMarker: false, libraryProfile: "ctd", libraryInclude: "counter_tray_designer_lib.1.scad" };
    } else {
      templateProject = { version: 1, lines: [
        { raw: "data = [", kind: "open", depth: 0, role: "data", label: "data", varName: "data" },
        { raw: "    [ OBJECT_BOX, [", kind: "open", depth: 1, role: "object", label: "OBJECT_BOX", mergedOpen: true },
        { raw: '        [ NAME, "box 1" ],', kind: "kv", depth: 2, kvKey: "NAME", kvValue: "box 1" },
        { raw: "        [ BOX_SIZE_XYZ, [50, 50, 20] ],", kind: "kv", depth: 2, kvKey: "BOX_SIZE_XYZ", kvValue: [50, 50, 20] },
        { raw: "    ]],", kind: "close", depth: 1, role: "object", label: "OBJECT_BOX", mergedClose: true },
        { raw: "];", kind: "close", depth: 0, role: "data", label: "data", varName: "data" },
        { raw: "Make(data);", kind: "makeall", depth: 0, varName: "data" },
      ], hasMarker: false, libraryProfile: "bit", libraryInclude: "boardgame_insert_toolkit_lib.4.scad" };
    }

    project.set(templateProject);
    const scadText = generateScad(templateProject);

    if (!bgsd?.saveFileAs) return;
    const res = await bgsd.saveFileAs(scadText, templateProject.libraryProfile);
    if (!res.ok) {
      project.set({ version: 1, lines: [], hasMarker: false });
      showWelcome = true;
      statusMsg = "No file open";
      return;
    }

    if (res.libraryError) {
      statusMsg = `Library: ${res.libraryError}`;
    }

    if (bgsd?.loadFilePath) {
      const loaded = await bgsd.loadFilePath(res.filePath);
      if (loaded.ok) {
        handleLoad(loaded);
        return;
      }
    }

    setFilePath(res.filePath);
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
    handleLoad({ data: res.data, filePath: res.filePath });
  }

  async function saveFileAs() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.saveFileAs) return;
    const res = await bgsd.saveFileAs(scadOutput, $project.libraryProfile, getFilePath());
    if (!res.ok) return;
    setFilePath(res.filePath);
    setReadOnly(false);
    updateTitle(res.filePath);
    statusMsg = `Saved ${res.filePath.replace(/.*[/\\]/, "")}`;
    // Keep OpenSCAD in sync with the new file
    launchOpenScad(res.filePath);
  }

  async function launchOpenScad(filePath: string, profile?: string) {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.openInOpenScad) return;
    if (!filePath) return;

    // Check preferences for auto-open
    const prefs = await bgsd.getPreferences?.() || { autoOpenInOpenScad: true };
    if (!prefs.autoOpenInOpenScad) return;

    const res = await bgsd.openInOpenScad(filePath, profile || $project.libraryProfile);
    if (res?.libraryError) {
      statusMsg = `Library: ${res.libraryError}`;
    }
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

  async function openInOpenScad() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.openInOpenScad) return;

    let fp = getFilePath();
    if (!fp) {
      // No file yet — prompt save-as first
      await saveFileAs();
      fp = getFilePath();
      if (!fp) return;
    }

    const savedPath = await saveNow();
    const openPath = savedPath || fp;

    // For manual launch (Tools menu), bypass auto-open pref check
    const res = await bgsd.openInOpenScad(openPath, $project.libraryProfile);
    if (res?.libraryError) {
      statusMsg = `Library: ${res.libraryError}`;
    }
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
    prefsOpenScadPath = prefs.openScadPath || "";
    prefsAutoOpen = prefs.autoOpenInOpenScad !== false;
    prefsReuseOpenScad = prefs.reuseOpenScad !== false;
    prefsProxy = prefs.proxy || "";
    showPrefs = true;
  }

  async function savePreferences() {
    const bgsd = (window as any).bgsd;
    await bgsd?.setPreferences?.({ openScadPath: prefsOpenScadPath, autoOpenInOpenScad: prefsAutoOpen, reuseOpenScad: prefsReuseOpenScad, proxy: prefsProxy });
    showPrefs = false;
  }

  async function browseOpenScadPath() {
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.browseOpenScad?.();
    if (result?.ok && result.path) {
      prefsOpenScadPath = result.path;
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
    try {
      const res = await bgsd.updateLibraries();
      if (res.ok) {
        setupStatus = "Libraries updated.";
        setTimeout(() => { setupStatus = ""; setupLog = []; }, 3000);
        loadLibraryTree();
      } else {
        setupStatus = `Update failed: ${res.error}`;
      }
    } catch (err: any) {
      setupStatus = `Update failed: ${err.message}`;
    }
    setupBusy = false;
  }

  async function changeWorkingDir() {
    const bgsd = (window as any).bgsd;
    if (!bgsd?.browseWorkingDir) return;
    const result = await bgsd.browseWorkingDir();
    if (!result?.ok || !result.path) return;

    setupBusy = true;
    setupLog = [];
    setupStatus = "Initializing new directory...";
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

  // --- Library browser helpers ---

  async function loadLibraryTree() {
    const bgsd = (window as any).bgsd;
    const res = await bgsd?.getLibraryTree?.();
    if (res?.ok) {
      libraryTreeRaw = JSON.stringify(res.tree || {});
    }
  }

  function scrollBottom(node: HTMLElement, _deps: any) {
    node.scrollTop = node.scrollHeight;
    return { update() { node.scrollTop = node.scrollHeight; } };
  }

  function formatPublisher(slug: string): string {
    const allCaps: Record<string, string> = { gmt: "GMT", mmp: "MMP" };
    if (allCaps[slug]) return allCaps[slug];
    return slug.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  function formatGameName(slug: string): string {
    return slug.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  function dateBucket(mtime: number): string {
    const now = Date.now();
    const days = Math.floor((now - mtime) / 86400000);
    if (days < 1) return "Today";
    if (days < 2) return "Yesterday";
    if (days < 7) return "This Week";
    if (days < 30) return "This Month";
    return "Older";
  }

  function filesByDate(pubs: Record<string, any[]>): { bucket: string; files: any[] }[] {
    const all: any[] = [];
    for (const files of Object.values(pubs || {})) {
      for (const f of files) all.push(f);
    }
    all.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const order = ["Today", "Yesterday", "This Week", "This Month", "Older"];
    const groups: Record<string, any[]> = {};
    for (const f of all) {
      const b = dateBucket(f.mtime || 0);
      if (!groups[b]) groups[b] = [];
      groups[b].push(f);
    }
    return order.filter(b => groups[b]).map(b => ({ bucket: b, files: groups[b] }));
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

  function showLibMenu(e: MouseEvent, filePath: string, isRepo: boolean) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const menuW = 180;
    const x = rect.right + menuW > window.innerWidth ? rect.left - menuW - 4 : rect.right + 4;
    libMenu = { x, y: rect.top, path: filePath, isRepo };
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
      statusMsg = "Deleted";
      setTimeout(() => { statusMsg = ""; }, 2000);
      loadLibraryTree();
    } else {
      statusMsg = `Delete failed: ${result.error}`;
    }
  }

  async function exportStl(filePath: string) {
    libMenu = null;
    statusMsg = "Exporting STL...";
    const bgsd = (window as any).bgsd;
    const result = await bgsd?.exportStl?.(filePath);
    if (!result) { statusMsg = "Export unavailable"; return; }
    if (result.ok) statusMsg = `Exported: ${result.filePath}`;
    else if (result.error === "not-found") statusMsg = "OpenSCAD not found — set its path in Preferences";
    else if (result.error) statusMsg = `Export failed: ${result.error}`;
    else statusMsg = "Export cancelled";
  }

  // --- Schema lookup (reactive based on active profile) ---
  let activeSchema = $derived(getSchema($project.libraryProfile || "bit"));

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
    if (/^\s*include\s*<\s*(?:\.\.\/lib\/)?boardgame_insert_toolkit_lib\.\d+\.scad\s*>\s*;?\s*(?:\/\/.*)?$/i.test(raw)) return { raw, kind: "include", depth };
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
  function toRaw(i: number) {
    const l = $project.lines[i];
    if (!l || l.kind === "open" || l.kind === "close") return; // brackets are never raw
    replaceLine(i, { raw: l.raw, kind: "raw", depth: l.depth });
  }
  function toParsed(i: number) { const l = $project.lines[i]; if (!l) return; const c = classifyLocal(l.raw, l.depth); if (c.kind !== "raw") replaceLine(i, c); }

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
      if (l.kind === "kv" && l.kvKey === "_DEBUG_B") {
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
      materializeKv(openIdx + 1, "_DEBUG_B", true, depth);
    }
  }

  const DEPTH_PX = 24;
  function pad(line: Line) { return `padding-left: ${8 + (line.depth ?? 0) * DEPTH_PX}px`; }
  function padDepth(d: number) { return `padding-left: ${8 + d * DEPTH_PX}px`; }

  /** Generate SCAD-style indentation: 4 spaces per depth level */
  function scadIndent(depth: number): string { return "    ".repeat(depth); }

  const BRACKET_COLORS = ["#546e7a","#546e7a","#546e7a","#546e7a","#546e7a","#546e7a"];
  const BRACKET_BGS = ["#f0f4f8","#fdf2f8","#fef9f0","#f0fdf4","#faf5ff","#f0fdfa"];
  function bracketStyle(depth: number): string {
    const i = (depth ?? 0) % BRACKET_COLORS.length;
    const indent = Math.max(0, (depth ?? 0) * DEPTH_PX);
    return `--bracket-color: ${BRACKET_COLORS[i]}; --bracket-bg: ${BRACKET_BGS[i]}; --indent: ${indent}px`;
  }

  // --- Collapse/expand ---
  let collapsed = $state(new Set<number>());

  function toggleCollapse(i: number) {
    const next = new Set(collapsed);
    if (next.has(i)) next.delete(i); else next.add(i);
    collapsed = next;
  }

  function onSplitHandleDown(e: MouseEvent) {
    e.preventDefault();
    dragging = true;
    const onMove = (ev: MouseEvent) => {
      const newWidth = window.innerWidth - ev.clientX;
      scadWidth = Math.max(200, Math.min(newWidth, window.innerWidth * 0.8));
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
    label_params: "label",
    lid_params: "lid",
    counter_set_params: "counter_set",
  };

  // For merged closes, map outer role → inner role
  const MERGED_INNER_ROLE: Record<string, string> = {
    object: "params",
    feature_list: "feature",
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
      ctx = "element";
    } else if (role === "counter_set" && !line.mergedClose) {
      // Non-merged counter_set close: children are direct (like counter_set_params)
      ctx = "counter_set";
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
      if (rawLabel.startsWith("OBJECT_") || rawLabel === "TRAY") {
        return { text: `${label(rawLabel)}${nameSuffix(lineIndex)}`, inferred: false };
      }
      return { text: `object "${rawLabel}"`, inferred: false };
    }
    if (line.role === "params") return { text: "object params", inferred: true };
    if (line.role === "feature_list") return { text: label(line.label || "BOX_FEATURE") + nameSuffix(lineIndex), inferred: false };
    if (line.role === "feature") return { text: "feature list", inferred: true };
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
    // Skip past any makeall line(s) that follow the close bracket
    let insertAfter = afterIdx;
    while (insertAfter + 1 < $project.lines.length && $project.lines[insertAfter + 1].kind === "makeall") {
      insertAfter++;
    }
    addScene(insertAfter, nextSceneName());
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
      { raw: `${ind(d)}[ OBJECT_BOX, [`, kind: "open", depth: d, role: "object", label, mergedOpen: true },
      { raw: `${ind(d+1)}[ NAME, "${name}" ],`, kind: "kv", depth: d + 1, kvKey: "NAME", kvValue: name },
      { raw: `${ind(d+1)}[ BOX_SIZE_XYZ, [50, 50, 20] ],`, kind: "kv", depth: d + 1, kvKey: "BOX_SIZE_XYZ", kvValue: [50, 50, 20] },
      { raw: `${ind(d)}]],`, kind: "close", depth: d, role: "object", label, mergedClose: true },
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
      { raw: `${ind(d)}[ BOX_FEATURE, [`, kind: "open", depth: d, role: "feature_list", label: "BOX_FEATURE", mergedOpen: true },
      { raw: `${ind(d+1)}[ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],`, kind: "kv", depth: d + 1, kvKey: "FTR_COMPARTMENT_SIZE_XYZ", kvValue: [40, 40, 15] },
      { raw: `${ind(d)}]],`, kind: "close", depth: d, role: "feature_list", label: "BOX_FEATURE", mergedClose: true },
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

  /** Check if a block (by close index) has a BOX_LID child. */
  function hasLidChild(closeIndex: number): boolean {
    const closeLine = $project.lines[closeIndex];
    if (!closeLine || closeLine.kind !== "close") return false;
    // Walk backwards to find the matching open
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
      if ($project.lines[j].kind === "open" && $project.lines[j].role === "lid") return true;
    }
    return false;
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

<main data-testid="app-root">
  {#if !showWelcome}
  <nav class="toolbar" data-testid="toolbar">
    <button class="toolbar-home" title="Welcome page" onclick={() => { showWelcome = true; loadLibraryTree(); }}>&#8962;</button>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group">
      <label class="toolbar-check" title="Hide virtual default values">
        <input type="checkbox" bind:checked={hideDefaults} /> Hide Defaults
      </label>
      <label class="toolbar-check" title="Show generated SCAD (Ctrl+U)">
        <input type="checkbox" bind:checked={showScad} /> Show SCAD
      </label>
    </div>
    <div class="toolbar-sep"></div>
    <div class="toolbar-group">
      <button class="toolbar-btn" title="Open in OpenSCAD (Ctrl+E)" onclick={() => openInOpenScad()}>OpenSCAD</button>
      <button class="toolbar-btn" title="Preferences... (Ctrl+,)" onclick={() => openPreferencesModal()}>Preferences</button>
    </div>
  </nav>
  {/if}
  <section class="content" data-testid="content-area">
    {#if showWelcome}
      <div class="welcome" data-testid="welcome-screen">
        <h1 class="welcome-title">BGSD</h1>
        <p class="welcome-subtitle">Board Game Storage Designer</p>

        {#if !workingDirSet}
          <div class="welcome-actions">
            <p class="welcome-hint">Set a working directory where your<br>designs and libraries will be stored.</p>
            <button class="welcome-btn welcome-btn-primary" data-testid="welcome-choose-dir" onclick={() => chooseAndInitWorkingDir()} disabled={setupBusy}>
              {setupBusy ? "Setting up..." : "Choose Folder..."}
            </button>
            {#if setupBusy || setupStatus}
              <div class="welcome-progress">
                {#if setupBusy}<span class="welcome-spinner"></span>{/if}
                <span class="welcome-progress-msg">{setupStatus}</span>
              </div>
              {#if setupLog.length > 1}
                <div class="welcome-log" use:scrollBottom={setupLog}>{#each setupLog as line}<div class="welcome-log-line">{line}</div>{/each}</div>
              {/if}
            {/if}
          </div>
        {:else}
          <div class="welcome-icon-bar">
            <button class="welcome-icon-btn" data-testid="welcome-update-libs" title={setupBusy ? "Updating..." : "Update Libraries"} onclick={() => updateLibs()} disabled={setupBusy}>&#x21BB;</button>
            <button class="welcome-icon-btn" data-testid="welcome-change-dir" title="Change Workspace" onclick={() => changeWorkingDir()}>&#x2699;</button>
          </div>
          {#if setupBusy || setupStatus}
            <div class="welcome-progress">
              {#if setupBusy}<span class="welcome-spinner"></span>{/if}
              <span class="welcome-progress-msg">{setupStatus}</span>
            </div>
            {#if setupLog.length > 1}
              <div class="welcome-log" use:scrollBottom={setupLog}>{#each setupLog as line}<div class="welcome-log-line">{line}</div>{/each}</div>
            {/if}
          {/if}

          <div class="welcome-sort-bar">
            <button class="welcome-sort-btn" class:active={sortMode === "dir"} data-testid="sort-dir" onclick={() => sortMode = "dir"}>Directories</button>
            <button class="welcome-sort-btn" class:active={sortMode === "date"} data-testid="sort-date" onclick={() => sortMode = "date"}>Modified</button>
          </div>

          <div class="welcome-columns" data-testid="welcome-columns">
            {#each [["bit", "Board Game Inserts", "Box inserts with compartments, lids, and dividers"], ["ctd", "Counter Trays", "Counter trays sized for tokens, markers, and chits"]] as [profileId, profileLabel, profileDesc]}
            {@const tree = libraryTree[profileId]}
            {@const pubs = tree?.publishers}
            {@const designsDir = tree?.designsDir || "designs"}
            {@const pubKeys = pubs ? Object.keys(pubs).sort() : []}
            <div class="welcome-col" class:welcome-col-right-align={profileId === "bit" && sortMode === "dir"} data-testid="welcome-col-{profileId}">
              <h2 class="welcome-library-title">{profileLabel}</h2>
              <p class="welcome-library-desc">{profileDesc}</p>
              <div class="welcome-library-scroll">
                {#if sortMode === "dir"}
                  {#if !pubKeys.includes(designsDir)}
                    <div class="welcome-library-publisher">
                      <div class="welcome-publisher-row">
                        <h3 class="welcome-library-publisher-name">{formatPublisher(designsDir)}</h3>
                        <button class="welcome-new-file" data-testid="new-{profileId}" onclick={() => newProject(profileId)}>+ New</button>
                      </div>
                      <p class="welcome-library-empty-folder">No designs yet.</p>
                    </div>
                  {/if}
                  {#each pubKeys as pub}
                    <div class="welcome-library-publisher">
                      {#if pub === designsDir}
                        <div class="welcome-publisher-row">
                          <h3 class="welcome-library-publisher-name">{formatPublisher(pub)}</h3>
                          <button class="welcome-new-file" data-testid="new-{profileId}" onclick={() => newProject(profileId)}>+ New</button>
                        </div>
                      {:else}
                        <h3 class="welcome-library-publisher-name">{formatPublisher(pub)}</h3>
                      {/if}
                      {#each pubs[pub].sort((a: any, b: any) => a.name.localeCompare(b.name)) as game}
                        <button class="welcome-library-game" onclick={(e: MouseEvent) => showLibMenu(e, game.path, game.isRepo)}>{formatGameName(game.name)}</button>
                      {/each}
                    </div>
                  {/each}
                {:else}
                  {#each filesByDate(pubs) as group}
                    <div class="welcome-library-publisher">
                      <h3 class="welcome-library-publisher-name">{group.bucket}</h3>
                      {#each group.files as game}
                        <button class="welcome-library-game" onclick={(e: MouseEvent) => showLibMenu(e, game.path, game.isRepo)}>{formatGameName(game.name)}</button>
                      {/each}
                    </div>
                  {/each}
                  {#if !pubs || Object.keys(pubs).length === 0}
                    <p class="welcome-library-empty-folder">No designs yet.</p>
                  {/if}
                {/if}
              </div>
            </div>
            {/each}
          </div>
        {/if}

        {#if libMenu}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="lib-context-backdrop" onclick={() => libMenu = null} onkeydown={() => {}}></div>
          <div class="lib-context-menu" style="left: {libMenu.x}px; top: {libMenu.y}px;">
            {#if libMenu.isRepo}
              <button class="lib-context-item" data-testid="ctx-edit-copy" onclick={() => { const p = libMenu!.path; libMenu = null; openLibraryFile(p); }}>Edit a Copy</button>
              <button class="lib-context-item" data-testid="ctx-export-stl" onclick={() => exportStl(libMenu!.path)}>Export STL</button>
            {:else}
              <button class="lib-context-item" data-testid="ctx-edit" onclick={() => { const p = libMenu!.path; libMenu = null; editFile(p); }}>Edit</button>
              <button class="lib-context-item" data-testid="ctx-delete" onclick={() => deleteLibraryFile(libMenu!.path)}>Delete</button>
              <button class="lib-context-item" data-testid="ctx-export-stl" onclick={() => exportStl(libMenu!.path)}>Export STL</button>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
    <div class="editor-split" class:split-active={showScad}>
    <div class="editor-left">
    {#each $project.lines as line, i (i)}

      {#if hiddenLines.has(i)}
        <!-- Hidden by collapsed parent -->

      {:else if kvRenderedInBlock.has(i)}
        <!-- This kv line is rendered in the sorted schema block before its close bracket -->

      {:else if globalRenderedInBlock.has(i)}
        <!-- This global line is rendered in the virtual globals block above -->

      {:else if line.kind === "open"}
        {@const collapsible = !["params", "label_params", "lid_params", "feature", "counter_set_params"].includes(line.role || "")}
        {@const deletable = line.role === "data" ? sceneNames.length > 1 : !["data_list", "params", "label_params", "lid_params", "feature", "counter_set_params"].includes(line.role || "")}
        <div class="line-row struct open" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
          {#if collapsible}
            <button class="collapse-btn" title={collapsed.has(i) ? "Expand" : "Collapse"}
              onclick={() => toggleCollapse(i)}>{collapsed.has(i) ? "▶" : "▼"}</button>
          {/if}
          {#if line.role === "data"}
            <input class="scene-name-input" type="text" value={line.varName || "data"}
              onblur={(e) => handleSceneNameBlur(i, e.currentTarget.value)}
              onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
            <span class="struct-bracket">=</span>
          {:else}
            <span class={structLabel(line, i).inferred ? "struct-label inferred" : "struct-label"}>{structLabel(line, i).text}</span>
          {/if}
          <span class="struct-bracket">{collapsed.has(i) ? "[ ... ]" : "["}</span>
          {#if line.role === "object" || line.role === "feature_list" || line.role === "lid" || line.role === "counter_set"}
            {@const dbg = getDebugState(i)}
            <button class="debug-toggle" class:active={dbg.active} title="Highlight in OpenSCAD (#)"
              onclick={() => toggleDebug(i)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          {/if}
          {@render commentBtn(line, i)}
          <span class="spacer"></span>
          {#if deletable}
            <button class="dup-btn" title="Duplicate block" onclick={() => duplicateBlock(i)}>⧉</button>
            <button class="delete-btn" title="Delete block" onclick={() => deleteBlock(i)}>✕</button>
          {/if}
        </div>
        <!-- Virtual globals block inside data = [ (BIT only; CTD uses per-scene KVs) -->
        {#if line.role === "data" && $project.libraryProfile !== "ctd"}
          {#each getGlobalRows() as row (row.key)}
            {#if hideDefaults && !row.isReal}{:else}
            {@const gDef = row.def}
            {@const gVal = row.value}
            {@const gOnChange = row.isReal
              ? (v: any) => updateGlobalWithDefault(row.lineIndex!, v, gDef.default)
              : (v: any) => onVirtualGlobalChange(row.key, gDef, v)}
            <div class="line-row kv" class:virtual={!row.isReal} style="{padDepth(1)}; {bracketStyle(1)}" data-testid={row.isReal ? `line-${row.lineIndex}` : `virtual-${row.key}`}>
              <span class="kv-key" class:virtual-key={!row.isReal} title={tip(row.key)}>{label(row.key)}</span>
              <span class="kv-control">
                {#if gDef.type === "bool"}
                  <input type="checkbox" checked={gVal === true} onchange={(e) => gOnChange(e.currentTarget.checked)} />
                {:else if gDef.type === "enum"}
                  <select value={gVal} onchange={(e) => gOnChange(e.currentTarget.value)}>
                    {#each gDef.values || [] as v}<option value={v}>{v}</option>{/each}
                  </select>
                {:else if gDef.type === "number"}
                  <input class="kv-num" type="number" step="any" value={gVal} onchange={(e) => gOnChange(parseNum(e.currentTarget.value))} />
                {:else if gDef.type === "xy" && Array.isArray(gVal)}
                  {#each [0,1] as j}
                    <input class="kv-str sm" type="text" value={gVal[j] ?? 0}
                      onchange={(e) => { const c = [...gVal]; c[j] = smartParseNum(e.currentTarget.value); gOnChange(c); }} />
                  {/each}
                {:else}
                  <input class="kv-str" type="text" value={gVal ?? ""} onchange={(e) => gOnChange(e.currentTarget.value)} />
                {/if}
              </span>
              {#if row.isReal && row.lineIndex !== null}
                {@render commentBtn($project.lines[row.lineIndex], row.lineIndex)}
                <span class="spacer"></span>
                <button class="toggle-btn" title="Edit as raw text" onclick={() => toRaw(row.lineIndex!)}>{"{}"}</button>
                <button class="delete-btn" title="Reset to default" onclick={() => deleteLine(row.lineIndex!)}>✕</button>
              {:else}
                <span class="spacer"></span>
              {/if}
            </div>
            {/if}
          {/each}
        {/if}

      {:else if line.kind === "close"}
        <!-- Sorted schema rows (real + virtual) before close bracket -->
        {#each getSortedSchemaRows(i) as row (row.key)}
          {#if hideDefaults && !row.isReal}{:else}
          {@const rkt = getKeyType(row.key)}
          {@const rks = getKeySchema(row.key)}
          {@const onChange = row.isReal
            ? (v) => updateKv(row.lineIndex, v, row.def.default)
            : (v) => onVirtualChange(i, row.key, row.def, v)}
          {@const val = row.value}
          <div class="line-row kv" class:virtual={!row.isReal} style="{padDepth(row.depth)}; {bracketStyle(row.depth)}" data-testid={row.isReal ? `line-${row.lineIndex}` : `virtual-${row.key}`}>
            <span class="kv-key" class:virtual-key={!row.isReal} title={tip(row.key)}>{label(row.key)}</span>
            <span class="kv-control">
              {#if rkt === "bool"}
                <input type="checkbox" checked={val === true} onchange={(e) => onChange(e.currentTarget.checked)} />
              {:else if rkt === "enum"}
                <select value={val} onchange={(e) => onChange(e.currentTarget.value)}>
                  {#each rks?.values || [] as v}<option value={v}>{v}</option>{/each}
                </select>
              {:else if rkt === "number"}
                <input class="kv-num" type="number" step="any" value={val} onchange={(e) => onChange(parseNum(e.currentTarget.value))} />
              {:else if rkt === "string"}
                <input class="kv-str" type="text" value={val ?? ""} onchange={(e) => onChange(e.currentTarget.value)} />
              {:else if rkt === "xyz" && Array.isArray(val)}
                {#each [0,1,2] as j}
                  <input class="kv-str sm" type="text" value={val[j] ?? 0}
                    onchange={(e) => { const c = [...val]; c[j] = smartParseNum(e.currentTarget.value); onChange(c); }} />
                {/each}
              {:else if rkt === "xy" && Array.isArray(val)}
                {#each [0,1] as j}
                  <input class="kv-str sm" type="text" value={val[j] ?? 0}
                    onchange={(e) => { const c = [...val]; c[j] = smartParseNum(e.currentTarget.value); onChange(c); }} />
                {/each}
              {:else if rkt === "position_xy" && Array.isArray(val)}
                {#each [0,1] as j}
                  <input class="kv-str sm" type="text" value={val[j] ?? ""}
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
                    <input class="kv-num xs" type="number" step="any" value={val[j] ?? 0}
                      onchange={(e) => { const c = [...val]; c[j] = parseNum(e.currentTarget.value); onChange(c); }} />
                  </label>
                {/each}
              {:else}
                <span class="kv-fallback">{JSON.stringify(val)}</span>
              {/if}
            </span>
            {#if row.isReal && row.lineIndex !== null}
              {@render commentBtn($project.lines[row.lineIndex], row.lineIndex)}
              <span class="spacer"></span>
              <button class="toggle-btn" title="Edit as raw text" onclick={() => toRaw(row.lineIndex!)}>{"{}"}</button>
              <button class="delete-btn" title="Reset to default" onclick={() => dematerializeKv(row.lineIndex)}>✕</button>
            {:else}
              <span class="spacer"></span>
            {/if}
          </div>
          {/if}
        {/each}
        <!-- Virtual BOX_LID block for OBJECT_BOX without a lid (BIT only) -->
        {#if !hideDefaults && $project.libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i)}
          {@const lidDepth = (line.depth ?? 0) + 1}
          {@const lidChildDepth = lidDepth + 1}
          {@const lidScalars = getScalarKeysForContext("lid")}
          <div class="line-row struct open virtual" style="{padDepth(lidDepth)}; {bracketStyle(lidDepth)}" data-testid="virtual-lid">
            <span class="struct-label inferred">{label("BOX_LID")}</span>
            <span class="struct-bracket">[</span>
          </div>
          {#each lidScalars as srow (srow.key)}
            {@const rkt = srow.def.type}
            {@const val = srow.def.default}
            {@const onChange = (v: any) => materializeVirtualLidSetting(i, srow.key, srow.def, v)}
            <div class="line-row kv virtual" style="{padDepth(lidChildDepth)}; {bracketStyle(lidChildDepth)}" data-testid="virtual-lid-{srow.key}">
              <span class="kv-key virtual-key" title={tip(srow.key)}>{label(srow.key)}</span>
              <span class="kv-control">
                {#if rkt === "bool"}
                  <input type="checkbox" checked={val === true} onchange={(e) => onChange(e.currentTarget.checked)} />
                {:else if rkt === "number"}
                  <input class="kv-num" type="number" step="any" value={val} onchange={(e) => onChange(parseNum(e.currentTarget.value))} />
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
              </span>
              <button class="comment-btn" title="Add comment" onclick={() => materializeVirtualLidKvWithComment(i, srow.key, srow.def, lidChildDepth)}>//</button>
              <span class="spacer"></span>
            </div>
          {/each}
          <div class="line-row add-row virtual" style="{padDepth(lidChildDepth)}; {bracketStyle(lidChildDepth)}">
            <button class="add-btn" title="Add LABEL block inside lid" onclick={() => { addLid(i, lidDepth); addLabel(i + 2, lidChildDepth); }}>+ Label</button>
          </div>
          <div class="line-row struct close virtual" style="{padDepth(lidDepth)}; {bracketStyle(lidDepth)}">
            <span class="struct-bracket">],</span>
          </div>
        {/if}
        <!-- Add buttons on their own line, indented inside the block -->
        {#if line.role === "data" || line.role === "params" || line.role === "object" || line.role === "lid" || line.role === "lid_params"}
          {@const addDepth = (line.depth ?? 0) + 1}
          <div class="line-row add-row virtual" style="{padDepth(addDepth)}; {bracketStyle(addDepth)}" data-testid="add-{i}">
            {#if line.role === "data"}
              {#if $project.libraryProfile === "ctd"}
                <button class="add-btn" title="Add counter set" onclick={() => addCounterSet(i, line.depth ?? 0)}>+ Counter Set</button>
              {:else}
                <button class="add-btn" title="Add object" onclick={() => addObject(i, line.depth ?? 0)}>+ Object</button>
              {/if}
            {:else if line.role === "params" && $project.libraryProfile !== "ctd"}
              <button class="add-btn" title="Add LABEL block" onclick={() => addLabel(i, (line.depth ?? 0) + 1)}>+ Label</button>
              <button class="add-btn" title="Add BOX_FEATURE block" onclick={() => addFeatureList(i, (line.depth ?? 0) + 1)}>+ Feature</button>
            {:else if line.role === "object" && $project.libraryProfile !== "ctd"}
              {@const childDepth = (line.depth ?? 0) + 1}
              <button class="add-btn" title="Add LABEL block" onclick={() => addLabel(i, childDepth)}>+ Label</button>
              <button class="add-btn" title="Add BOX_FEATURE block" onclick={() => addFeatureList(i, childDepth)}>+ Feature</button>
            {:else if (line.role === "lid" || line.role === "lid_params") && $project.libraryProfile !== "ctd"}
              {@const lidChildDepth = (line.depth ?? 0) + 1}
              <button class="add-btn" title="Add LABEL block inside lid" onclick={() => addLabel(i, lidChildDepth)}>+ Label</button>
            {/if}
          </div>
        {/if}
        <!-- Close bracket(s) — split merged ]] into separate lines -->
        {#if line.mergedClose}
          {@const hasVirtualLid = !hideDefaults && $project.libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i)}
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
        {#if line.role === "data"}
          <div class="line-row add-scene-row" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="add-scene-{i}">
            <button class="add-btn" title="Add another scene" onclick={() => handleAddScene(i)}>+ Scene</button>
          </div>
        {/if}

      {:else if line.kind === "kv" && line.kvKey}
        {@const kt = getKeyType(line.kvKey)}
        {@const ks = getKeySchema(line.kvKey)}
        {@const sd = getSchemaDefault(line.kvKey)}
        <div class="line-row kv" class:is-default={isDefault(line.kvKey, line.kvValue)} style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
          <span class="kv-key" title={tip(line.kvKey || "")}>{label(line.kvKey || "")}</span>
          <span class="kv-control">
            {#if kt === "bool"}
              <input type="checkbox" checked={line.kvValue === true}
                onchange={(e) => updateKv(i, e.currentTarget.checked, sd)} />
            {:else if kt === "enum"}
              <select value={line.kvValue} onchange={(e) => updateKv(i, e.currentTarget.value, sd)}>
                {#each ks?.values || [] as v}<option value={v}>{v}</option>{/each}
              </select>
            {:else if kt === "number"}
              <input class="kv-num" type="number" step="any" value={line.kvValue}
                onchange={(e) => updateKv(i, parseNum(e.currentTarget.value), sd)} />
            {:else if kt === "string"}
              <input class="kv-str" type="text" value={line.kvValue ?? ""}
                onchange={(e) => updateKv(i, e.currentTarget.value, sd)} />
            {:else if kt === "xyz" && Array.isArray(line.kvValue)}
              {#each [0,1,2] as j}
                <input class="kv-str sm" type="text" value={line.kvValue[j] ?? 0}
                  onchange={(e) => updateKvIdx(i, line.kvValue, j, smartParseNum(e.currentTarget.value))} />
              {/each}
            {:else if kt === "xy" && Array.isArray(line.kvValue)}
              {#each [0,1] as j}
                <input class="kv-str sm" type="text" value={line.kvValue[j] ?? 0}
                  onchange={(e) => updateKvIdx(i, line.kvValue, j, smartParseNum(e.currentTarget.value))} />
              {/each}
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
                  <input class="kv-num xs" type="number" step="any" value={line.kvValue[j] ?? 0}
                    onchange={(e) => updateKvIdx(i, line.kvValue, j, parseNum(e.currentTarget.value))} />
                </label>
              {/each}
            {:else}
              <span class="kv-fallback">{JSON.stringify(line.kvValue)}</span>
            {/if}
          </span>
          {@render commentBtn(line, i)}
          <span class="spacer"></span>
          <button class="toggle-btn" title="Edit as raw text" onclick={() => toRaw(i)}>{"{}"}</button>
        </div>

      {:else if line.kind === "makeall"}
        <div class="line-row make-row" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
          <span class="make-text">Make(</span>
          <select class="make-select" value={line.varName || "data"}
            onchange={(e) => handleMakeVarChange(i, e.currentTarget.value)}>
            {#each sceneNames as name}
              <option value={name}>{name}</option>
            {/each}
          </select>
          <span class="make-text">);</span>
        </div>

      {:else if line.kind === "include" || line.kind === "marker"}
        <div class="line-row muted" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
          <span class="line-text">{line.raw}</span>
          <span class="line-badge">{line.kind}</span>
        </div>

      {:else if line.kind === "variable"}
        <div class="line-row variable" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
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
        <div class="line-row comment-line" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
          <span class="comment-slash">//</span>
          <input class="comment-standalone" type="text" spellcheck="false" value={line.comment ?? ""}
            onblur={(e) => handleStandaloneCommentEdit(i, e.currentTarget.value)}
            onkeydown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          <span class="spacer"></span>
          <button class="delete-btn" title="Delete" onclick={() => deleteLine(i)}>✕</button>
        </div>

      {:else if line.kind === "raw" && isRawGroupStart(i)}
        <div class="raw-block" style={bracketStyle(line.depth)} data-testid="line-{i}">
          <textarea class="raw-textarea" spellcheck="false"
            rows={rawGroupLineCount(i)}
            value={rawGroupText(i)}
            onblur={(e) => handleRawGroupEdit(i, e.currentTarget.value)}
            onchange={(e) => handleRawGroupEdit(i, e.currentTarget.value)}
          ></textarea>
          {#if rawGroupLineCount(i) === 1 && canParse(line.raw)}
            <button class="toggle-btn raw-parse-btn" title="Parse as structured" onclick={() => toParsed(i)}>{"{}"}</button>
          {/if}
        </div>

      {:else if line.kind === "raw" && isRawGroupMember(i)}
        <!-- Skip: this raw line is rendered as part of a group above -->

      {:else}
        <!-- Fallback for any other unhandled kind -->
        <div class="line-row raw" style="{pad(line)}; {bracketStyle(line.depth)}" data-testid="line-{i}">
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
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="split-handle" onmousedown={onSplitHandleDown}></div>
    <div class="editor-right" data-testid="scad-pane" style="width: {scadWidth}px">
    {#each $project.lines as line, i (i)}
      {#if hiddenLines.has(i)}
        <!-- hidden -->
      {:else if kvRenderedInBlock.has(i)}
        <!-- rendered in schema block -->
      {:else if globalRenderedInBlock.has(i)}
        <!-- rendered in globals block -->

      {:else if line.kind === "open"}
        <div class="scad-line">{line.raw}</div>
        {#if line.role === "data" && $project.libraryProfile !== "ctd"}
          {#each getGlobalRows() as row (row.key)}
            {#if hideDefaults && !row.isReal}{:else}
              {#if row.isReal && row.lineIndex !== null}
                <div class="scad-line">{$project.lines[row.lineIndex].raw}</div>
              {:else}
                <div class="scad-line scad-virtual"></div>
              {/if}
            {/if}
          {/each}
        {/if}

      {:else if line.kind === "close"}
        {#each getSortedSchemaRows(i) as row (row.key)}
          {#if hideDefaults && !row.isReal}{:else}
            {#if row.isReal && row.lineIndex !== null}
              <div class="scad-line">{$project.lines[row.lineIndex].raw}</div>
            {:else}
              <div class="scad-line scad-virtual"></div>
            {/if}
          {/if}
        {/each}
        {#if !hideDefaults && $project.libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i)}
          {@const lidScalars = getScalarKeysForContext("lid")}
          <div class="scad-line scad-virtual"></div>
          {#each lidScalars as srow (srow.key)}
            <div class="scad-line scad-virtual"></div>
          {/each}
          <div class="scad-line scad-virtual"></div>
          <div class="scad-line scad-virtual"></div>
        {/if}
        {#if line.role === "data" || line.role === "params" || line.role === "object" || line.role === "lid" || line.role === "lid_params"}
          <div class="scad-line scad-virtual"></div>
        {/if}
        {#if line.mergedClose}
          {@const hasVirtualLid = !hideDefaults && $project.libraryProfile !== "ctd" && supportsLid(i) && !hasLidChild(i)}
          {#if !hasVirtualLid}
            <div class="scad-line">{scadIndent((line.depth ?? 0) + 1)}],</div>
          {/if}
          <div class="scad-line">{scadIndent(line.depth ?? 0)}],</div>
        {:else}
          <div class="scad-line">{line.raw}</div>
        {/if}
        {#if line.role === "data"}
          <div class="scad-line scad-virtual"></div>
        {/if}

      {:else if line.kind === "kv" && line.kvKey}
        <div class="scad-line">{line.raw}</div>

      {:else if line.kind === "makeall"}
        <div class="scad-line">Make({line.varName || "data"});</div>

      {:else if line.kind === "include" || line.kind === "marker"}
        <div class="scad-line">{line.raw}</div>

      {:else if line.kind === "variable"}
        <div class="scad-line">{line.raw}</div>

      {:else if line.kind === "comment"}
        <div class="scad-line">{line.raw}</div>

      {:else if line.kind === "raw" && isRawGroupStart(i)}
        <div class="scad-raw-group">{rawGroupText(i)}</div>

      {:else if line.kind === "raw" && isRawGroupMember(i)}
        <!-- skip -->

      {:else}
        <div class="scad-line">{line.raw}</div>
      {/if}
    {/each}
    </div>
    {/if}
    </div>
    {/if}
  </section>

  <footer class="status-bar" class:status-error={statusMsg.startsWith("Library:") || statusMsg.startsWith("OpenSCAD")} data-testid="status-bar">
    <span data-testid="save-status">{statusMsg}</span>
  </footer>

  {#if showPrefs}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="prefs-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) showPrefs = false; }}>
      <div class="prefs-modal" data-testid="prefs-modal">
        <h2 class="prefs-title">Preferences</h2>
        <div class="prefs-row">
          <label class="prefs-label" for="prefs-openscad-path">OpenSCAD path</label>
          <div class="prefs-input-row">
            <input class="prefs-input" id="prefs-openscad-path" type="text" bind:value={prefsOpenScadPath} placeholder="(auto-detect)" data-testid="prefs-openscad-path" />
            <button class="prefs-browse" onclick={browseOpenScadPath} data-testid="prefs-browse">Browse...</button>
          </div>
        </div>
        <div class="prefs-row">
          <label class="prefs-check-label">
            <input type="checkbox" bind:checked={prefsAutoOpen} data-testid="prefs-auto-open" />
            Auto-open in OpenSCAD on file load
          </label>
        </div>
        <div class="prefs-row">
          <label class="prefs-check-label">
            <input type="checkbox" bind:checked={prefsReuseOpenScad} data-testid="prefs-reuse-openscad" />
            Reuse OpenSCAD window (don't spawn new instances)
          </label>
        </div>
        <div class="prefs-row">
          <label class="prefs-label" for="prefs-proxy">HTTP proxy</label>
          <input class="prefs-input" id="prefs-proxy" type="text" bind:value={prefsProxy} placeholder="e.g. http://proxy:8080" data-testid="prefs-proxy" />
        </div>
        <div class="prefs-buttons">
          <button class="prefs-btn" onclick={() => showPrefs = false}>Cancel</button>
          <button class="prefs-btn primary" onclick={savePreferences} data-testid="prefs-save">Save</button>
        </div>
      </div>
    </div>
  {/if}

  {#if showIntent}
    <div class="intent-pane" data-testid="intent-pane">
      <input data-testid="intent-text" type="text" bind:value={intentText}
        placeholder="Describe what you expect to happen..." />
    </div>
    <div data-testid="scad-output" style="display:none">{scadOutput}</div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px; color: #1a1a1a; background: #f5f5f5;
  }
  main { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .toolbar {
    display: flex; align-items: center; gap: 2px;
    padding: 3px 8px; background: #e8e8e8; border-bottom: 1px solid #ccc;
    flex-shrink: 0; font-size: 12px;
  }
  .toolbar-home {
    background: none; border: none; cursor: pointer; font-size: 18px; line-height: 1;
    padding: 1px 4px; color: #555; border-radius: 3px;
  }
  .toolbar-home:hover { background: #ddd; color: #333; }
  .toolbar-group { display: flex; align-items: center; gap: 4px; }
  .toolbar-btn {
    padding: 3px 8px; border: 1px solid #bbb; border-radius: 3px;
    background: #f8f8f8; cursor: pointer; font-size: 12px; color: #333;
  }
  .toolbar-btn:hover { background: #fff; border-color: #999; }
  .toolbar-btn:active { background: #ddd; }
  .toolbar-check { display: flex; align-items: center; gap: 3px; cursor: pointer; color: #333; font-size: 12px; }
  .toolbar-check input { margin: 0; }
  .toolbar-sep { width: 1px; height: 18px; background: #bbb; margin: 0 6px; }
  .content { flex: 1; overflow-y: auto; padding: 4px 0; }

  /* Split layout: editor left + SCAD pane right */
  .editor-split { display: flex; flex-direction: row; }
  .editor-left { flex: 1; min-width: 0; }
  .editor-right {
    width: 500px; flex-shrink: 0;
    background: #fff;
    overflow-x: hidden;
  }
  .split-handle {
    width: 6px; flex-shrink: 0;
    background: #ddd;
    cursor: col-resize;
  }
  .split-handle:hover { background: #bbb; }
  .scad-line {
    font-family: "Courier New", monospace; font-size: 13px;
    min-height: 24px;
    padding: 1px 8px;
    white-space: pre;
    color: #000;
    border-bottom: 1px solid #f0f0f0;
    display: flex; align-items: center;
  }
  .scad-line.scad-virtual { min-height: 24px; background: #eee; }
  .scad-raw-group {
    font-family: "Courier New", monospace; font-size: 13px;
    line-height: 22px;
    padding: 1px 8px;
    white-space: pre;
    color: #000;
    border-bottom: 1px solid #f0f0f0;
    overflow: hidden;
  }

  .welcome {
    position: relative;
    display: flex; flex-direction: column; align-items: center;
    height: 100%; gap: 8px; padding-top: 60px; overflow-y: auto;
  }
  .welcome-title {
    margin: 0; font-size: 36px; font-weight: 700; color: #6c3483;
  }
  .welcome-subtitle {
    margin: 0 0 24px; font-size: 16px; color: #888;
  }
  .welcome-actions {
    display: flex; flex-direction: column; gap: 12px; width: 360px;
  }
  .welcome-sort-bar {
    display: flex; gap: 4px; justify-content: center; margin-bottom: 12px;
  }
  .welcome-sort-btn {
    padding: 4px 12px; font-size: 12px; font-weight: 500;
    border: 1px solid #ddd; border-radius: 4px;
    background: #fff; color: #888; cursor: pointer;
  }
  .welcome-sort-btn.active { background: #6c3483; color: #fff; border-color: #6c3483; }
  .welcome-sort-btn:hover:not(.active) { background: #f3e5f5; color: #6c3483; border-color: #6c3483; }
  .welcome-icon-bar {
    position: absolute; top: 12px; right: 16px;
    display: flex; gap: 6px;
  }
  .welcome-icon-btn {
    width: 32px; height: 32px; font-size: 18px; line-height: 1;
    border: 1px solid #ddd; border-radius: 6px;
    background: #fff; color: #666; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
  }
  .welcome-icon-btn:hover:not(:disabled) { background: #f3e5f5; color: #6c3483; border-color: #6c3483; }
  .welcome-icon-btn:disabled { opacity: 0.4; cursor: default; }
  .welcome-btn {
    padding: 12px 24px; font-size: 16px; font-weight: 600;
    border: 1px solid #bbb; border-radius: 6px;
    background: white; color: #2c3e50; cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .welcome-btn:hover:not(:disabled) {
    background: #f3e5f5; border-color: #6c3483;
  }
  .welcome-btn:disabled {
    opacity: 0.5; cursor: default;
  }
  .welcome-btn-primary {
    background: #6c3483; color: white; border-color: #6c3483;
  }
  .welcome-btn-primary:hover:not(:disabled) {
    background: #7d3c98; border-color: #7d3c98;
  }
  .welcome-btn-secondary {
    font-size: 14px; padding: 8px 16px; color: #666; border-color: #ddd;
  }
  .welcome-hint {
    text-align: center; color: #888; font-size: 14px; margin: 0; line-height: 1.5;
  }
  .welcome-status {
    text-align: center; color: #6c3483; font-size: 13px; margin: 0;
    max-width: 260px; word-break: break-word; align-self: center;
  }
  .welcome-progress {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin: 8px 0 4px; align-self: center;
  }
  .welcome-progress-msg {
    color: #6c3483; font-size: 12px; font-weight: 500;
  }
  .welcome-spinner {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid #e0cfe8; border-top-color: #6c3483;
    border-radius: 50%; animation: spin 0.8s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .welcome-log {
    align-self: center; max-height: 120px; overflow-y: auto;
    font-family: "Courier New", monospace; font-size: 11px; color: #888;
    background: #f8f8f8; border: 1px solid #eee; border-radius: 4px;
    padding: 6px 10px; margin: 4px 0 8px; width: 420px; max-width: 90%;
  }
  .welcome-log-line {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    line-height: 1.5;
  }
  .welcome-columns { display: flex; gap: 24px; justify-content: center; width: 100%; align-items: flex-start; }
  .welcome-col {
    width: 280px; flex: 0 0 280px; max-height: 500px;
    display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid #ddd; border-radius: 8px; background: #fff; padding: 16px;
  }
  .welcome-col-right-align { text-align: right; }
  .welcome-col-right-align .welcome-publisher-row { flex-direction: row-reverse; }
  .welcome-col-right-align .welcome-library-game { text-align: right; }
  .welcome-col-right-align .welcome-library-empty-folder { text-align: right; }
  .welcome-library-title { font-size: 18px; font-weight: 600; color: #2c3e50; margin: 0 0 4px; }
  .welcome-library-desc { font-size: 12px; color: #999; margin: 0 0 12px; line-height: 1.4; }
  .welcome-library-scroll { overflow-y: auto; flex: 1; padding-right: 8px; }
  .welcome-library-publisher { margin-bottom: 14px; }
  .welcome-publisher-row { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; }
  .welcome-publisher-row .welcome-library-publisher-name { margin: 0; }
  .welcome-new-file {
    padding: 1px 8px; font-size: 11px; font-weight: 600;
    border: 1px dashed #6c3483; border-radius: 3px;
    background: transparent; color: #6c3483; cursor: pointer;
  }
  .welcome-new-file:hover { background: #f3e5f5; }
  .welcome-library-empty-folder { color: #bbb; font-size: 13px; font-style: italic; margin: 0; padding: 2px 10px; }
  .welcome-library-publisher-name { font-size: 12px; font-weight: 600; color: #6c3483; text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 4px; }
  .welcome-library-game {
    display: block; width: 100%; text-align: left;
    padding: 5px 10px; border: none; border-radius: 4px;
    background: transparent; color: #2c3e50; font-size: 14px; cursor: pointer;
  }
  .welcome-library-game:hover { background: #f3e5f5; color: #6c3483; }
  .lib-context-backdrop {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 999;
  }
  .lib-context-menu {
    position: fixed; z-index: 1000;
    background: #fff; border: 1px solid #ddd; border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15); min-width: 160px;
    padding: 4px 0; display: flex; flex-direction: column;
  }
  .lib-context-item {
    display: block; width: 100%; text-align: left;
    padding: 8px 16px; border: none; background: transparent;
    font-size: 14px; color: #2c3e50; cursor: pointer;
  }
  .lib-context-item:hover { background: #f3e5f5; color: #6c3483; }
  .line-row {
    display: flex; align-items: center; gap: 6px;
    padding: 1px 8px; min-height: 24px;
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    border-bottom: 1px solid #f5f5f3;
    background: linear-gradient(to right, transparent var(--indent, 0px), var(--bracket-bg, #fafaf8) var(--indent, 0px));
  }
  .line-row.muted { opacity: 0.35; font-style: italic; }
  /* Virtual tier: defaults at schema value — lower contrast, not italic */
  .line-row.kv.virtual .kv-key { font-weight: 400; }
  .line-row.kv.virtual { color: #b0b8c0; }
  .line-row.struct.virtual { color: #b0b8c0; }
  .virtual-key { }

  .collapse-btn {
    background: none; border: none; cursor: pointer;
    padding: 0 2px; font-size: 12px; color: #888; flex-shrink: 0;
  }
  .collapse-btn:hover { color: #555; }
  .struct-label { font-weight: 700; color: #2c3e50; }
  .struct-label.inferred { font-weight: 400; opacity: 0.6; }
  .struct-bracket { color: #546e7a; font-weight: 700; }
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

  .kv-key { font-weight: 700; color: #2c3e50; min-width: 220px; flex-shrink: 0; }
  .kv-control { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .kv-num { font-family: "Courier New", monospace; font-size: 15px; font-weight: 400; padding: 1px 4px; border: 1px solid #ddd; border-radius: 2px; width: 120px; background: white; }
  .kv-num.sm { width: 80px; }
  .kv-num.xs { width: 60px; }
  .kv-str { font-family: "Courier New", monospace; font-size: 15px; font-weight: 400; padding: 1px 4px; border: 1px solid #ddd; border-radius: 2px; width: 240px; background: white; }
  .kv-str.sm { width: 120px; }
  .kv-control select { font-family: "Courier New", monospace; font-size: 15px; font-weight: 400; padding: 1px 4px; border: 1px solid #ddd; border-radius: 2px; background: white; }
  .kv-control input[type="checkbox"] { width: 18px; height: 18px; accent-color: #333; }
  .kv-fallback { color: #999; font-size: 13px; }
  .side-label { display: inline-flex; align-items: center; gap: 2px; font-size: 13px; }
  .side-tag { color: #999; font-size: 11px; font-weight: 600; width: 12px; text-align: center; }

  /* Raw tier: unparsed text blocks */
  .raw-block {
    position: relative;
    width: 100%;
    border-bottom: 1px solid #f5f5f3;
    background: linear-gradient(to right, transparent var(--indent, 0px), var(--bracket-bg, #fafaf8) var(--indent, 0px));
  }
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
  .raw-textarea:focus { background: #f5f5f0; }
  .raw-input {
    flex: 1; min-width: 0;
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 400;
    padding: 1px 4px; border: 1px solid #ddd; border-radius: 2px; background: white;
  }
  .toggle-btn {
    background: none; border: 1px solid #ccc; color: #888;
    cursor: pointer; font-size: 11px; font-weight: 700;
    padding: 1px 5px; border-radius: 3px; flex-shrink: 0;
    font-family: "Courier New", monospace;
    opacity: 0; transition: opacity 0.1s;
  }
  .line-row:hover .toggle-btn { opacity: 1; }
  .toggle-btn:hover:not(:disabled) { border-color: #3498db; color: #3498db; }
  .toggle-btn:disabled, .toggle-btn.disabled { opacity: 0.3; cursor: default; }
  .add-btn {
    background: none; border: 1px dashed #bbb; color: #7f8c8d;
    padding: 0 8px; border-radius: 3px; cursor: pointer;
    font-size: 14px; font-weight: 700; line-height: 1.4;
  }
  .add-btn:hover { border-color: #3498db; color: #3498db; }
  .add-scene-row { min-height: 24px; border-bottom: none; }
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
  .scene-name-input {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 700;
    color: #2c3e50; background: transparent; border: none;
    border-bottom: 1px dashed #b0bec5; padding: 0 4px; width: 120px; outline: none;
  }
  .scene-name-input:focus { border-bottom: 1px solid #546e7a; background: #f0f4f8; }
  .make-text {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 700; color: #2c3e50;
  }
  .make-select {
    font-family: "Courier New", monospace; font-size: 15px; font-weight: 700;
    color: #2c3e50; background: white; border: 1px solid #cfd8dc;
    border-radius: 2px; padding: 1px 4px;
  }

  /* Variable lines */
  .var-name { font-weight: 700; color: #2c3e50; }
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
  .line-row.add-row { min-height: 20px; }

  /* Raw parse-back button */
  .raw-parse-btn {
    position: absolute; right: 8px; top: 2px;
    opacity: 0; transition: opacity 0.1s;
  }
  .raw-block { position: relative; }
  .raw-block:hover .raw-parse-btn { opacity: 1; }

  .status-bar { display: flex; justify-content: space-between; padding: 3px 12px; background: #ecf0f1; border-top: 1px solid #ddd; font-size: 13px; color: #666; }
  .status-bar.status-error { background: #fdecea; color: #c0392b; font-weight: 700; }
  .intent-pane { background: #1a1a2e; padding: 6px 12px; border-top: 2px solid #e74c3c; }
  .intent-pane input { width: 100%; box-sizing: border-box; background: #16213e; border: 1px solid #444; color: #e0e0e0; padding: 4px 8px; font-family: "Courier New", monospace; font-size: 13px; border-radius: 2px; }

  /* Preferences modal */
  .prefs-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; z-index: 100;
  }
  .prefs-modal {
    background: white; border-radius: 8px; padding: 24px 28px;
    min-width: 420px; max-width: 520px; box-shadow: 0 8px 32px rgba(0,0,0,0.25);
  }
  .prefs-title { margin: 0 0 16px; font-size: 18px; color: #2c3e50; }
  .prefs-row { margin-bottom: 14px; }
  .prefs-label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 4px; }
  .prefs-input-row { display: flex; gap: 6px; }
  .prefs-input {
    flex: 1; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px;
    font-family: "Courier New", monospace; font-size: 13px;
  }
  .prefs-browse {
    padding: 6px 12px; border: 1px solid #bbb; border-radius: 4px;
    background: #f5f5f5; cursor: pointer; font-size: 13px;
  }
  .prefs-browse:hover { background: #eee; border-color: #999; }
  .prefs-check-label {
    display: flex; align-items: center; gap: 8px;
    font-size: 14px; color: #333; cursor: pointer;
  }
  .prefs-check-label input[type="checkbox"] { width: 16px; height: 16px; }
  .prefs-buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .prefs-btn {
    padding: 8px 18px; border: 1px solid #bbb; border-radius: 4px;
    background: white; cursor: pointer; font-size: 14px;
  }
  .prefs-btn:hover { background: #f5f5f5; }
  .prefs-btn.primary { background: #6c3483; color: white; border-color: #6c3483; }
  .prefs-btn.primary:hover { background: #5b2c6f; }
</style>
