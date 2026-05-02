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

// --- Library cache ---

function getLibCacheDir(profileId) {
  return path.join(app.getPath("userData"), "lib-cache", profileId);
}

function getCachedFilePath(profileId, filename) {
  return path.join(getLibCacheDir(profileId), filename);
}

async function ensureLibrary(profileId) {
  const profile = profiles[profileId];
  if (!profile) throw new Error(`Unknown library profile: ${profileId}`);

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
  try { fs.chmodSync(filePath, 0o644); } catch (_) {}
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

/**
 * Load a manifest file or return an empty one.
 */
function loadManifest(manifestPath) {
  try {
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
  } catch (_) {}
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

    // 1. Directly download known lib files — always overwrite, regardless of
    // local modifications. Base lib must stay in sync with the upstream repo.
    // Logging policy: only emit a line for files actually refreshed; everything
    // else (pre-fetch progress, skipped files, summary counts) is silent.
    for (let i = 0; i < profile.files.length; i++) {
      const repoPath = profile.files[i];
      const localPath = repoPath.replace(/^release\//, "");
      const destPath = path.join(profileDir, localPath);

      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        const hash = contentHash(content);
        if (manifest.files[localPath] === hash && fs.existsSync(destPath)) {
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

      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        const hash = contentHash(content);
        if (isTracked && manifest.files[localPath] === hash && fs.existsSync(destPath)) {
          newFiles[localPath] = hash;
          skipped++;
          continue;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        writeReadOnly(destPath, content);
        newFiles[localPath] = hash;
        updated++;
        log(`[${profile.name}] Refreshed ${localPath}`);
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
  for (const [profileId, profile] of Object.entries(profiles)) {
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
    const manifestPath = path.join(profileDir, ".manifest.json");
    const manifest = loadManifest(manifestPath);
    const files = [];
    let hasUpdate = false;
    let localVersion = null;
    let remoteVersion = null;
    for (let idx = 0; idx < profile.files.length; idx++) {
      const repoPath = profile.files[idx];
      const localPath = repoPath.replace(/^release\//, "");
      const destPath = path.join(profileDir, localPath);
      // Read local content for version parsing (first base-lib file only)
      if (idx === 0 && fs.existsSync(destPath)) {
        try { localVersion = parseLibVersion(fs.readFileSync(destPath, "utf-8")); } catch (_) { /* ignore */ }
      }
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        if (idx === 0) remoteVersion = parseLibVersion(content);
        const remoteHash = contentHash(content);
        const localHash = manifest.files[localPath];
        const fileHasUpdate = !localHash || localHash !== remoteHash;
        if (fileHasUpdate) hasUpdate = true;
        files.push({ path: localPath, hasUpdate: fileHasUpdate });
      } catch (_err) {
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
  } catch (_err) {
    return null;
  }
}

module.exports = {
  ensureLibrary,
  detectProfile,
  getProfile,
  profiles,
  initWorkingDir,
  updateLibraries,
  checkLibraryUpdates,
  fetchLatestReleaseTag,
  parseLibVersion,
  isInsideWorkingDir,
  isRepoFile,
  loadManifest,
  setProxy,
  getProxy,
};
