const { app, net, session } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const profiles = require("./profiles.json");

// --- Proxy support ---

let proxyUrl = "";

function setProxy(url) {
  proxyUrl = url || "";
  if (proxyUrl) {
    session.defaultSession.setProxy({ proxyRules: proxyUrl });
  } else {
    session.defaultSession.setProxy({ proxyRules: "" });
  }
}

function getProxy() {
  return proxyUrl;
}

// --- HTTP via Electron's net.fetch (Chromium stack, respects proxy) ---

async function fetchText(url) {
  // Cache-bust to bypass Chromium HTTP cache and GitHub CDN
  const sep = url.includes("?") ? "&" : "?";
  const resp = await net.fetch(`${url}${sep}_t=${Date.now()}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return await resp.text();
}

function fetchRaw(repo, branch, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  return fetchText(url);
}

function compareVersions(a, b) {
  const pa = String(a || "").split(".").map((p) => parseInt(p, 10) || 0);
  const pb = String(b || "").split(".").map((p) => parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function filenameVersion(filename) {
  const match = String(filename || "").match(/_lib\.([0-9]+(?:\.[0-9]+){0,2})\.scad$/i);
  return match ? match[1] : null;
}

function versionedFilenameForVersion(filename, version) {
  if (!version) return filename;
  return String(filename || "").replace(/(?:\.[0-9]+(?:\.[0-9]+)*)?(\.scad)$/i, `.${version}$1`);
}

function profileIncludeForFilename(profile, filename) {
  if (profile.includeTemplate) return profile.includeTemplate.replace("{filename}", filename);
  const baseInclude = profile.include || filename;
  return baseInclude.replace(/[^/\\]+$/, filename);
}

function profileLibRepoPath(profile, filename) {
  const libDir = profile.libDir || "release/lib";
  return `${libDir.replace(/\/$/, "")}/${filename}`;
}

function includeBasename(includeFile) {
  return String(includeFile || "").replace(/.*[/\\]/, "");
}

function matchesProfileInclude(profile, includeFile) {
  if (!profile?.includePattern) return false;
  return new RegExp(profile.includePattern, "i").test(includeFile || "");
}

// --- Library cache ---

function getLibCacheDir(profileId) {
  return path.join(app.getPath("userData"), "lib-cache", profileId);
}

function getCachedFilePath(profileId, filename) {
  return path.join(getLibCacheDir(profileId), filename);
}

function resolveCachedLatestLibraryFile(profileId) {
  const profile = profiles[profileId];
  if (!profile) return null;
  const cacheDir = getLibCacheDir(profileId);
  if (!fs.existsSync(cacheDir)) return null;
  let latest = null;
  for (const name of fs.readdirSync(cacheDir)) {
    if (!matchesProfileInclude(profile, name)) continue;
    const filePath = path.join(cacheDir, name);
    let content = null;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { /* ignore */ }
    const version = bestLibVersion(name, content);
    if (!version) continue;

    let effectiveName = name;
    let repoPath = profileLibRepoPath(profile, name);
    const nameVersion = filenameVersion(name);
    if (content && nameVersion && compareVersions(version, nameVersion) > 0) {
      effectiveName = versionedFilenameForVersion(name, version);
      repoPath = profileLibRepoPath(profile, name);
      const effectivePath = path.join(cacheDir, effectiveName);
      if (effectiveName !== name && !fs.existsSync(effectivePath)) {
        writeReadOnly(effectivePath, content);
      }
    }

    if (!latest || compareVersions(version, latest.version) > 0) {
      latest = {
        repoPath,
        filename: effectiveName,
        version,
        synthesized: effectiveName !== name,
      };
    }
  }
  return latest ? { ...latest, include: profileIncludeForFilename(profile, latest.filename) } : null;
}

async function ensureLibrary(profileId) {
  const profile = profiles[profileId];
  if (!profile) throw new Error(`Unknown library profile: ${profileId}`);

  if (profile.latestFilePattern) {
    await ensureLatestLibrary(profileId);
    return getLibCacheDir(profileId);
  }

  const cacheDir = getLibCacheDir(profileId);
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const file of profile.files) {
    const basename = path.basename(file);
    const cached = path.join(cacheDir, basename);
    if (!fs.existsSync(cached)) {
      console.log(`Fetching ${file} from ${profile.repo}...`);
      const content = await fetchRaw(profile.repo, profile.branch, file);
      fs.writeFileSync(cached, content, "utf-8");
      console.log(`Cached: ${cached}`);
    }
  }

  return cacheDir;
}

function detectProfile(includeFilename) {
  for (const [id, profile] of Object.entries(profiles)) {
    const re = new RegExp(profile.includePattern, "i");
    if (re.test(includeFilename)) return id;
  }
  return null;
}

function getProfile(profileId) {
  return profiles[profileId] || null;
}

// --- Working directory functions ---

function contentHash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/** Check if a file exists and is writable by the user. */
function isWritable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** Write a file and mark it read-only (0o444). */
function writeReadOnly(filePath, content) {
  // Remove read-only flag first if the file already exists
  try { fs.chmodSync(filePath, 0o644); } catch {
    // File may not exist yet or chmod may be unsupported; the write below decides.
  }
  fs.writeFileSync(filePath, content, "utf-8");
  fs.chmodSync(filePath, 0o444);
}

/**
 * Fetch the full repo tree via GitHub API (single request, recursive).
 * Returns array of { path, type } for all files under dirPath.
 */
async function fetchGitHubTree(repo, branch, dirPath, onProgress) {
  const log = onProgress || (() => {});
  const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  log(`Fetching tree from GitHub API...`);
  const text = await fetchText(url);
  const data = JSON.parse(text);
  const prefix = dirPath ? dirPath + "/" : "";
  return (data.tree || [])
    .filter((e) => e.type === "blob" && e.path.startsWith(prefix))
    .map((e) => ({ path: e.path, type: "blob" }));
}

async function resolveLatestLibraryFile(profileId, onProgress) {
  const profile = profiles[profileId];
  if (!profile) throw new Error(`Unknown library profile: ${profileId}`);
  const log = onProgress || (() => {});

  if (!profile.latestFilePattern) {
    const repoPath = profile.files?.[0];
    if (!repoPath) throw new Error(`No library file configured for ${profile.name}`);
    const filename = path.basename(repoPath);
    return {
      repoPath,
      filename,
      version: filenameVersion(filename),
      include: profileIncludeForFilename(profile, filename),
    };
  }

  const libDir = profile.libDir || "release/lib";
  const re = new RegExp(profile.latestFilePattern, "i");
  let candidates = [];
  try {
    const tree = await fetchGitHubTree(profile.repo, profile.branch, libDir, onProgress);
    candidates = tree
      .filter((e) => e.type === "blob" && re.test(e.path))
      .map((e) => {
        const filename = path.basename(e.path);
        return { repoPath: e.path, filename, version: filenameVersion(filename), synthesized: false };
      })
      .filter((e) => e.version);
  } catch (err) {
    log(`Versioned file scan failed: ${err.message}`);
  }

  for (const repoPath of profile.files || []) {
    const filename = path.basename(repoPath);
    if (!matchesProfileInclude(profile, filename)) continue;
    try {
      log(`Checking current ${filename} version...`);
      const content = await fetchRaw(profile.repo, profile.branch, repoPath);
      const version = parseLibVersion(content);
      if (!version) continue;
      const versionedFilename = versionedFilenameForVersion(filename, version);
      candidates.push({
        repoPath,
        filename: versionedFilename,
        version,
        synthesized: versionedFilename !== filename,
      });
    } catch {
      // Versioned release files above still provide the normal happy path.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No versioned library files found for ${profile.name}`);
  }

  candidates.sort((a, b) => {
    const byVersion = compareVersions(b.version, a.version);
    if (byVersion !== 0) return byVersion;
    if (a.synthesized !== b.synthesized) return a.synthesized ? 1 : -1;
    return a.filename.localeCompare(b.filename);
  });
  const latest = candidates[0];
  return {
    ...latest,
    include: profileIncludeForFilename(profile, latest.filename),
  };
}

function workingDirLibPath(workingDir, profileId, filename) {
  return path.join(workingDir, profileId, "lib", filename);
}

function manifestPathForProfile(workingDir, profileId) {
  return path.join(workingDir, profileId, ".manifest.json");
}

function updateManifestFile(manifestPath, relPath, content) {
  const manifest = loadManifest(manifestPath);
  const updatedManifest = {
    lastUpdated: new Date().toISOString(),
    files: { ...manifest.files, [relPath]: contentHash(content) },
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), "utf-8");
}

function resolveIncludeTarget(sourceFilePath, includeFile) {
  if (!sourceFilePath) return null;
  if (!includeFile || /^(?:https?:)?\/\//i.test(includeFile)) return null;
  if (path.isAbsolute(includeFile)) return includeFile;
  return path.resolve(path.dirname(sourceFilePath), includeFile);
}

async function ensureLibraryFile(profileId, filename, options = {}) {
  const profile = profiles[profileId];
  if (!profile) throw new Error(`Unknown library profile: ${profileId}`);
  if (!filename || !matchesProfileInclude(profile, filename)) {
    throw new Error(`Unsupported library filename for ${profile.name}: ${filename || "(empty)"}`);
  }

  const log = options.onProgress || (() => {});
  let repoPath = options.repoPath || profileLibRepoPath(profile, filename);
  const destinations = new Map();

  const cachePath = getCachedFilePath(profileId, filename);
  destinations.set(cachePath, { manifestRelPath: null });

  if (options.workingDir) {
    destinations.set(workingDirLibPath(options.workingDir, profileId, filename), {
      manifestRelPath: `lib/${filename}`,
      manifestPath: manifestPathForProfile(options.workingDir, profileId),
    });
  }

  const includeTarget = resolveIncludeTarget(options.sourceFilePath, options.includeFile);
  if (includeTarget) {
    const relInfo = options.workingDir && isInsideWorkingDir(includeTarget, options.workingDir)
      ? {
          manifestPath: manifestPathForProfile(options.workingDir, profileId),
          manifestRelPath: path.relative(path.join(options.workingDir, profileId), includeTarget).replace(/\\/g, "/"),
        }
      : { manifestRelPath: null };
    destinations.set(includeTarget, relInfo);
  }

  const missing = [...destinations.keys()].filter((dest) => !fs.existsSync(dest));
  if (missing.length === 0) {
    return { ok: true, filename, repoPath, downloaded: [], version: null };
  }

  log(`[${profile.name}] Downloading ${filename}`);
  let content;
  if (fs.existsSync(cachePath)) {
    content = fs.readFileSync(cachePath, "utf-8");
  } else {
    try {
      content = await fetchRaw(profile.repo, profile.branch, repoPath);
    } catch (err) {
      const requestedVersion = filenameVersion(filename);
      if (!requestedVersion) throw err;
      let fallback = null;
      for (const candidatePath of profile.files || []) {
        try {
          const candidateContent = await fetchRaw(profile.repo, profile.branch, candidatePath);
          const candidateVersion = parseLibVersion(candidateContent);
          if (candidateVersion && compareVersions(candidateVersion, requestedVersion) === 0) {
            fallback = { repoPath: candidatePath, content: candidateContent };
            break;
          }
        } catch {
          // Keep looking for a matching configured library file.
        }
      }
      if (!fallback) throw err;
      repoPath = fallback.repoPath;
      content = fallback.content;
    }
  }
  const downloaded = [];
  for (const destPath of missing) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    writeReadOnly(destPath, content);
    downloaded.push(destPath);
    const info = destinations.get(destPath);
    if (info?.manifestPath && info?.manifestRelPath && !info.manifestRelPath.startsWith("..")) {
      updateManifestFile(info.manifestPath, info.manifestRelPath, content);
    }
  }

  return { ok: true, filename, repoPath, downloaded, version: parseLibVersion(content) };
}

async function ensureLatestLibrary(profileId, options = {}) {
  let latest;
  try {
    latest = await resolveLatestLibraryFile(profileId, options.onProgress);
  } catch (err) {
    latest = resolveCachedLatestLibraryFile(profileId);
    if (!latest) throw err;
  }
  await ensureLibraryFile(profileId, latest.filename, {
    repoPath: latest.repoPath,
    workingDir: options.workingDir,
    includeFile: latest.include,
    sourceFilePath: null,
    onProgress: options.onProgress,
  });
  return latest;
}

async function ensureLibraryForInclude(includeFile, sourceFilePath, options = {}) {
  const filename = includeBasename(includeFile);
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!matchesProfileInclude(profile, filename) && !matchesProfileInclude(profile, includeFile)) continue;
    const result = await ensureLibraryFile(profileId, filename, {
      workingDir: options.workingDir,
      sourceFilePath,
      includeFile,
      onProgress: options.onProgress,
    });
    return { profileId, ...result };
  }
  return null;
}

/**
 * Load a manifest file or return an empty one.
 */
function loadManifest(manifestPath) {
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
  } catch {
    // Bad or unreadable manifests are treated as empty.
  }
  return { lastUpdated: null, files: {} };
}

/**
 * Initialize a working directory: create profile directory structures,
 * fetch lib files and design examples from GitHub.
 * @param {string} workingDir - The root working directory path
 * @param {(msg: string) => void} [onProgress] - Progress callback
 */
async function initWorkingDir(workingDir, onProgress) {
  const log = onProgress || console.log;

  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(workingDir, profileId);
    const libDir = path.join(profileDir, "lib");
    const designsDir = path.join(profileDir, profile.designsDir || "my_designs");
    const manifestPath = path.join(profileDir, ".manifest.json");

    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(designsDir, { recursive: true });

    log(`[${profile.name}] Scanning repository...`);
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch, "release", (msg) => log(`[${profile.name}] ${msg}`));
    } catch (err) {
      log(`[${profile.name}] Error: ${err.message}`);
      continue;
    }

    const manifest = loadManifest(manifestPath);
    const newFiles = {};
    const scadFiles = tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".scad") && e.path.startsWith("release/")
    );

    log(`[${profile.name}] Found ${scadFiles.length} files to download`);

    for (let i = 0; i < scadFiles.length; i++) {
      const repoPath = scadFiles[i].path;
      const localPath = repoPath.slice("release/".length);
      const destPath = path.join(profileDir, localPath);

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      log(`[${profile.name}] Downloading ${localPath} (${i + 1}/${scadFiles.length})`);
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        writeReadOnly(destPath, content);
        newFiles[localPath] = contentHash(content);
      } catch (err) {
        log(`[${profile.name}] Warning: Failed to fetch ${localPath}: ${err.message}`);
      }
    }

    const updatedManifest = {
      lastUpdated: new Date().toISOString(),
      files: { ...manifest.files, ...newFiles },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), "utf-8");
    log(`[${profile.name}] Setup complete — ${scadFiles.length} files installed`);
  }
}

/**
 * Update libraries in the working directory.
 * @param {string} workingDir - The root working directory path
 * @param {(msg: string) => void} [onProgress] - Progress callback
 */
async function updateLibraries(workingDir, onProgress) {
  const log = onProgress || console.log;
  const allSkippedUserFiles = []; // { profileName, localPath, dir }

  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(workingDir, profileId);
    const libDir = path.join(profileDir, "lib");
    const manifestPath = path.join(profileDir, ".manifest.json");
    const manifest = loadManifest(manifestPath);
    const newFiles = {};
    let updated = 0;
    let skipped = 0;

    fs.mkdirSync(libDir, { recursive: true });

    if (profile.latestFilePattern) {
      try {
        const latest = await ensureLatestLibrary(profileId, {
          workingDir,
          onProgress: (msg) => log(`[${profile.name}] ${msg}`),
        });
        const localPath = `lib/${latest.filename}`;
        const destPath = path.join(profileDir, localPath);
        if (fs.existsSync(destPath)) {
          newFiles[localPath] = contentHash(fs.readFileSync(destPath, "utf-8"));
        }
        log(`[${profile.name}] Latest ${localPath} ready`);
      } catch (err) {
        log(`[${profile.name}] Warning: Failed to resolve latest library: ${err.message}`);
      }
    }

    // 1. Directly download known lib files — always overwrite, regardless of
    // local modifications. Base lib must stay in sync with the upstream repo.
    // Comparison is against the on-disk file's content hash (not the manifest
    // record), so a desynced manifest can never silently mask a stale lib.
    const fixedFiles = profile.latestFilePattern ? [] : profile.files;
    for (let i = 0; i < fixedFiles.length; i++) {
      const repoPath = fixedFiles[i];
      const localPath = repoPath.replace(/^release\//, "");
      const destPath = path.join(profileDir, localPath);

      let localHash = null;
      if (fs.existsSync(destPath)) {
        try { localHash = contentHash(fs.readFileSync(destPath, "utf-8")); } catch (_) { /* missing/unreadable */ }
      }

      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        const hash = contentHash(content);
        if (localHash === hash) {
          newFiles[localPath] = hash;
          skipped++;
        } else {
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          writeReadOnly(destPath, content);
          newFiles[localPath] = hash;
          updated++;
          const v = parseLibVersion(content);
          log(`[${profile.name}] Refreshed ${localPath}${v ? ` (v${v})` : ""}`);
        }
      } catch (err) {
        log(`[${profile.name}] Warning: Failed to fetch ${localPath}: ${err.message}`);
        if (manifest.files[localPath]) newFiles[localPath] = manifest.files[localPath];
      }
    }

    // 2. Scan repo tree for all release files (silent unless an error fires)
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch, "release");
    } catch (err) {
      log(`[${profile.name}] Tree scan error: ${err.message}`);
      tree = [];
    }

    // Files under the user's designs dir (e.g. my_designs/) are starter
    // examples that the user is expected to edit; never touch them on update,
    // and don't surface them via skippedUserFiles either.
    const designsDir = profile.designsDir || "my_designs";
    const isDesignsPath = (p) => p === designsDir || p.startsWith(designsDir + "/");

    const scadFiles = tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".scad") && e.path.startsWith("release/")
    );

    for (let i = 0; i < scadFiles.length; i++) {
      const repoPath = scadFiles[i].path;
      const localPath = repoPath.slice("release/".length);
      if (newFiles[localPath]) continue; // already handled above
      if (isDesignsPath(localPath)) continue; // user's design space — never touch on update
      const destPath = path.join(profileDir, localPath);

      // If local file is writable, it's user-modified — skip silently
      // (the caller surfaces these via the skippedUserFiles return value).
      if (fs.existsSync(destPath) && isWritable(destPath)) {
        allSkippedUserFiles.push({ profileName: profile.name, localPath, dir: path.dirname(destPath) });
        continue;
      }

      const isTracked = manifest.files[localPath];

      let localHash = null;
      if (fs.existsSync(destPath)) {
        try { localHash = contentHash(fs.readFileSync(destPath, "utf-8")); } catch (_) { /* missing/unreadable */ }
      }

      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        const hash = contentHash(content);
        if (localHash === hash) {
          newFiles[localPath] = hash;
          skipped++;
          continue;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        writeReadOnly(destPath, content);
        newFiles[localPath] = hash;
        updated++;
        const v = parseLibVersion(content);
        log(`[${profile.name}] Refreshed ${localPath}${v ? ` (v${v})` : ""}`);
      } catch (err) {
        log(`[${profile.name}] Warning: Failed to fetch ${localPath}: ${err.message}`);
        if (isTracked) newFiles[localPath] = manifest.files[localPath];
      }
    }

    const updatedManifest = {
      lastUpdated: new Date().toISOString(),
      files: { ...manifest.files, ...newFiles },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), "utf-8");
  }

  return { skippedUserFiles: allSkippedUserFiles };
}

function isInsideWorkingDir(filePath, workingDir) {
  if (!workingDir) return false;
  return filePath.startsWith(workingDir + path.sep) || filePath.startsWith(workingDir + "/");
}

function isRepoFile(filePath, workingDir) {
  if (!workingDir || !filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  for (const profileId of Object.keys(profiles)) {
    const profileDir = path.join(workingDir, profileId).replace(/\\/g, "/");
    if (!norm.startsWith(profileDir + "/")) continue;
    const manifestPath = path.join(workingDir, profileId, ".manifest.json");
    const manifest = loadManifest(manifestPath);
    const relPath = norm.slice(profileDir.length + 1);
    if (manifest.files[relPath]) return profileId;
  }
  return null;
}

/**
 * Parse an explicit semver-ish version out of a lib file. BIT uses a header
 * comment (`* Version: 4.0.1`); CTD uses a SCAD constant (`VERSION = "1.00"`).
 * Returns the matched string or null if neither pattern is present.
 */
function parseLibVersion(content) {
  if (!content) return null;
  const m1 = content.match(/Version:\s*([\d.]+)/i);
  if (m1) return m1[1];
  const m2 = content.match(/VERSION\s*=\s*"([\d.]+)"/i);
  if (m2) return m2[1];
  return null;
}

function bestLibVersion(filename, content) {
  const fromName = filenameVersion(filename);
  const fromContent = parseLibVersion(content);
  if (fromName && fromContent) return compareVersions(fromContent, fromName) > 0 ? fromContent : fromName;
  return fromName || fromContent || null;
}

function fallbackVersionForProfile(profile) {
  return filenameVersion(includeBasename(profile?.include || ""));
}

function profileMajorVersion(profile) {
  const version = fallbackVersionForProfile(profile);
  const major = version ? parseInt(version.split(".")[0], 10) : NaN;
  return Number.isFinite(major) ? major : null;
}

function findInstalledLibraryVersion(profileId, workingDir) {
  const profile = profiles[profileId];
  if (!profile || !workingDir) return null;
  const profileDir = path.join(workingDir, profileId);
  const libDir = path.join(profileDir, "lib");

  let latest = null;
  const considerFile = (filename, filePath) => {
    let content = null;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { /* ignore unreadable files */ }
    const version = bestLibVersion(filename, content);
    if (!version) return;
    if (!latest || compareVersions(version, latest) > 0) latest = version;
  };

  if (profile.latestFilePattern && fs.existsSync(libDir)) {
    for (const name of fs.readdirSync(libDir)) {
      if (!matchesProfileInclude(profile, name)) continue;
      considerFile(name, path.join(libDir, name));
    }
  }

  if (!latest && Array.isArray(profile.files) && profile.files.length > 0) {
    const localPath = profile.files[0].replace(/^release\//, "");
    const destPath = path.join(profileDir, localPath);
    if (fs.existsSync(destPath)) considerFile(path.basename(destPath), destPath);
  }

  if (!latest && fs.existsSync(libDir)) {
    for (const name of fs.readdirSync(libDir)) {
      if (!matchesProfileInclude(profile, name)) continue;
      considerFile(name, path.join(libDir, name));
    }
  }

  return latest;
}

function getInstalledLibraryVersions(workingDir) {
  const out = {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    const version = findInstalledLibraryVersion(profileId, workingDir) || fallbackVersionForProfile(profile);
    out[profileId] = {
      name: profile.name,
      major: profileMajorVersion(profile),
      version,
    };
  }
  return out;
}

/**
 * Check whether the upstream base lib files differ from the local manifest.
 * Each profile result also includes the parsed `localVersion` (from the on-disk
 * base lib) and `remoteVersion` (from the freshly-fetched upstream copy of the
 * first base lib file) so callers can render a precise version label even when
 * there's no update. Network failures / missing manifests resolve to
 * `hasUpdate: false` for that profile so callers can stay silent on offline.
 */
async function checkLibraryUpdates(workingDir) {
  const result = {};
  if (!workingDir) return result;
  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(workingDir, profileId);
    const files = [];
    let hasUpdate = false;
    let localVersion = null;
    let remoteVersion = null;

    if (profile.latestFilePattern) {
      try {
        const latest = await resolveLatestLibraryFile(profileId);
        remoteVersion = latest.version;
        const libDir = path.join(profileDir, "lib");
        let localLatest = null;
        if (fs.existsSync(libDir)) {
          for (const name of fs.readdirSync(libDir)) {
            if (!matchesProfileInclude(profile, name)) continue;
            let content = null;
            try { content = fs.readFileSync(path.join(libDir, name), "utf-8"); } catch { /* ignore */ }
            const version = bestLibVersion(name, content);
            if (!version) continue;
            if (!localLatest || compareVersions(version, localLatest.version) > 0) {
              localLatest = { filename: name, version, path: path.join(libDir, name) };
            }
          }
        }
        localVersion = localLatest?.version || null;

        let fileHasUpdate = !localLatest || compareVersions(localLatest.version, latest.version) < 0;
        if (!fileHasUpdate && localLatest?.filename === latest.filename) {
          try {
            const localHash = contentHash(fs.readFileSync(localLatest.path, "utf-8"));
            const remoteHash = contentHash(await fetchRaw(profile.repo, profile.branch, latest.repoPath));
            fileHasUpdate = localHash !== remoteHash;
          } catch {
            fileHasUpdate = false;
          }
        }
        hasUpdate = fileHasUpdate;
        files.push({ path: `lib/${latest.filename}`, hasUpdate: fileHasUpdate });
      } catch {
        files.push({ path: profile.include || profile.name, hasUpdate: false, error: true });
      }
      result[profileId] = { name: profile.name, hasUpdate, files, localVersion, remoteVersion };
      continue;
    }

    for (let idx = 0; idx < profile.files.length; idx++) {
      const repoPath = profile.files[idx];
      const localPath = repoPath.replace(/^release\//, "");
      const destPath = path.join(profileDir, localPath);

      // Hash the actual on-disk file (not the manifest record). The manifest
      // can get out of sync with disk after manual edits or older BGSD bugs;
      // the file itself is the source of truth for "is this up to date".
      let localContent = null;
      let localHash = null;
      if (fs.existsSync(destPath)) {
        try {
          localContent = fs.readFileSync(destPath, "utf-8");
          localHash = contentHash(localContent);
        } catch { /* unreadable — treat as missing */ }
      }
      if (idx === 0 && localContent) localVersion = parseLibVersion(localContent);

      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        if (idx === 0) remoteVersion = parseLibVersion(content);
        const remoteHash = contentHash(content);
        const fileHasUpdate = !localHash || localHash !== remoteHash;
        if (fileHasUpdate) hasUpdate = true;
        files.push({ path: localPath, hasUpdate: fileHasUpdate });
      } catch {
        // Network/HTTP failure — treat as "no update detected" for this file.
        files.push({ path: localPath, hasUpdate: false, error: true });
      }
    }
    result[profileId] = { name: profile.name, hasUpdate, files, localVersion, remoteVersion };
  }
  return result;
}

/**
 * Hit GitHub's releases API and return the latest tag for a repo, or null on
 * failure. Used to compare against the running app version on launch.
 */
async function fetchLatestReleaseTag(repo) {
  try {
    const text = await fetchText(`https://api.github.com/repos/${repo}/releases/latest`);
    const data = JSON.parse(text);
    return typeof data?.tag_name === "string" ? data.tag_name : null;
  } catch {
    return null;
  }
}

module.exports = {
  ensureLibrary,
  ensureLatestLibrary,
  ensureLibraryForInclude,
  resolveLatestLibraryFile,
  detectProfile,
  getProfile,
  profiles,
  initWorkingDir,
  updateLibraries,
  checkLibraryUpdates,
  fetchLatestReleaseTag,
  parseLibVersion,
  versionedFilenameForVersion,
  getInstalledLibraryVersions,
  resolveCachedLatestLibraryFile,
  isInsideWorkingDir,
  isRepoFile,
  loadManifest,
  setProxy,
  getProxy,
};
