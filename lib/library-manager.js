const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const profiles = require("./profiles.json");

function getLibCacheDir(profileId) {
  return path.join(app.getPath("userData"), "lib-cache", profileId);
}

function getCachedFilePath(profileId, filename) {
  return path.join(getLibCacheDir(profileId), filename);
}

function fetchRaw(repo, branch, filePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (res2) => {
          let data = "";
          res2.on("data", (chunk) => (data += chunk));
          res2.on("end", () => resolve(data));
          res2.on("error", reject);
        }).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Ensure all library files for a profile are cached locally.
 * Fetches from GitHub if missing.
 * Returns the cache directory path.
 */
async function ensureLibrary(profileId) {
  const profile = profiles[profileId];
  if (!profile) throw new Error(`Unknown library profile: ${profileId}`);

  const cacheDir = getLibCacheDir(profileId);
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const file of profile.files) {
    // profile.files may contain paths like "lib/foo.scad" — cache with flat name
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

/**
 * Copy cached library files to a target directory (next to the user's .scad file).
 * Only copies if the file doesn't already exist in the target.
 */
async function copyLibToDir(profileId, targetDir) {
  const profile = profiles[profileId];
  if (!profile) return;

  const cacheDir = await ensureLibrary(profileId);

  for (const file of profile.files) {
    const basename = path.basename(file);
    const src = path.join(cacheDir, basename);
    const dst = path.join(targetDir, basename);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      console.log(`Copied library file: ${dst}`);
    }
  }
}

/**
 * Detect which profile matches an include filename.
 * Returns the profile ID or null.
 */
function detectProfile(includeFilename) {
  for (const [id, profile] of Object.entries(profiles)) {
    const re = new RegExp(profile.includePattern, "i");
    if (re.test(includeFilename)) return id;
  }
  return null;
}

/**
 * Get the profile object by ID.
 */
function getProfile(profileId) {
  return profiles[profileId] || null;
}

// --- Working directory functions ---

/**
 * Fetch a GitHub page and extract embedded tree items.
 */
function fetchPageItems(repo, branch, dirPath) {
  const urlPath = `/${repo}/tree/${branch}/${dirPath}`;
  return new Promise((resolve, reject) => {
    https.get(`https://github.com${urlPath}`, { headers: { "User-Agent": "BGSD" } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { headers: { "User-Agent": "BGSD" } }, (res2) => {
          let data = "";
          res2.on("data", (c) => (data += c));
          res2.on("end", () => resolve(parsePageItems(data)));
          res2.on("error", reject);
        }).on("error", reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${urlPath}`));
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(parsePageItems(data)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function parsePageItems(html) {
  const m = html.match(/data-target="react-app.embeddedData"[^>]*>(.*?)<\/script>/s);
  if (!m) return [];
  try {
    const json = JSON.parse(m[1]);
    return json?.payload?.tree?.items || [];
  } catch (_) {
    return [];
  }
}

/**
 * Walk the GitHub repo tree by scraping web pages (no API rate limit).
 * Returns array of { path, type } for all files under dirPath.
 */
async function fetchGitHubTree(repo, branch, dirPath, onProgress) {
  const log = onProgress || (() => {});
  const items = await fetchPageItems(repo, branch, dirPath || "");
  const results = [];
  for (const item of items) {
    if (item.contentType === "file") {
      results.push({ path: item.path, type: "blob" });
    } else if (item.contentType === "directory") {
      log(`Scanning ${item.path}...`);
      const sub = await fetchGitHubTree(repo, branch, item.path, onProgress);
      results.push(...sub);
    }
  }
  return results;
}

function contentHash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
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
    const designsDir = path.join(profileDir, profile.designsDir || "designs");
    const manifestPath = path.join(profileDir, ".manifest.json");

    fs.mkdirSync(libDir, { recursive: true });
    fs.mkdirSync(designsDir, { recursive: true });

    log(`[${profile.name}] Scanning repository...`);
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch, "release", log);
    } catch (err) {
      log(`Warning: Could not fetch tree for ${profile.name}: ${err.message}`);
      continue;
    }

    const manifest = loadManifest(manifestPath);
    const newFiles = {};

    // Filter to .scad files under release/ only
    const scadFiles = tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".scad") && e.path.startsWith("release/")
    );

    log(`[${profile.name}] Found ${scadFiles.length} files to download`);

    for (let i = 0; i < scadFiles.length; i++) {
      const entry = scadFiles[i];
      const repoPath = entry.path;
      // Strip "release/" prefix for local path and manifest key
      const localPath = repoPath.slice("release/".length);

      const destPath = path.join(profileDir, localPath);

      // Create parent dir
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      log(`[${profile.name}] Downloading ${localPath} (${i + 1}/${scadFiles.length})`);
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        fs.writeFileSync(destPath, content, "utf-8");
        newFiles[localPath] = contentHash(content);
      } catch (err) {
        log(`Warning: Failed to fetch ${localPath}: ${err.message}`);
      }
    }

    // Write manifest
    const updatedManifest = {
      lastUpdated: new Date().toISOString(),
      files: { ...manifest.files, ...newFiles },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), "utf-8");
    log(`[${profile.name}] Setup complete — ${scadFiles.length} files installed`);
  }
}

/**
 * Update libraries in the working directory: re-fetch lib files (overwrite),
 * re-fetch examples (overwrite repo-tracked files), leave user files alone.
 * @param {string} workingDir - The root working directory path
 * @param {(msg: string) => void} [onProgress] - Progress callback
 */
async function updateLibraries(workingDir, onProgress) {
  const log = onProgress || console.log;

  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(workingDir, profileId);
    const manifestPath = path.join(profileDir, ".manifest.json");
    const manifest = loadManifest(manifestPath);

    log(`[${profile.name}] Scanning repository...`);
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch, "release", log);
    } catch (err) {
      log(`Warning: Could not fetch tree for ${profile.name}: ${err.message}`);
      continue;
    }

    const scadFiles = tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".scad") && e.path.startsWith("release/")
    );
    const newFiles = {};
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < scadFiles.length; i++) {
      const entry = scadFiles[i];
      const repoPath = entry.path;
      // Strip "release/" prefix for local path and manifest key
      const localPath = repoPath.slice("release/".length);

      const destPath = path.join(profileDir, localPath);

      // For lib files: always overwrite
      // For design files: only overwrite if tracked in manifest (repo-sourced)
      const isLib = localPath.startsWith("lib/");
      const isTracked = manifest.files[localPath];
      const fileExists = fs.existsSync(destPath);

      if (!isLib && fileExists && !isTracked) {
        // User-created file at same path — skip
        continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      log(`[${profile.name}] Checking ${localPath} (${i + 1}/${scadFiles.length})`);
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        const hash = contentHash(content);
        if (isTracked && manifest.files[localPath] === hash && fileExists) {
          newFiles[localPath] = hash;
          skipped++;
          continue;
        }
        fs.writeFileSync(destPath, content, "utf-8");
        newFiles[localPath] = hash;
        updated++;
      } catch (err) {
        log(`Warning: Failed to fetch ${localPath}: ${err.message}`);
        // Keep old hash if fetch failed
        if (isTracked) newFiles[localPath] = manifest.files[localPath];
      }
    }
    log(`[${profile.name}] ${updated} updated, ${skipped} unchanged`);

    const updatedManifest = {
      lastUpdated: new Date().toISOString(),
      files: newFiles,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), "utf-8");
    log(`[${profile.name}] Update complete`);
  }
}

/**
 * Check if a file path is inside a working directory's lib/ folder.
 */
function isInsideWorkingDir(filePath, workingDir) {
  if (!workingDir) return false;
  return filePath.startsWith(workingDir + path.sep) || filePath.startsWith(workingDir + "/");
}

/**
 * Check if a file path is a repo-tracked file (from a manifest).
 * These files should not be overwritten — they'll be stomped on library update.
 * Returns the profile ID if tracked, or null.
 */
function isRepoFile(filePath, workingDir) {
  if (!workingDir || !filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(workingDir, profileId).replace(/\\/g, "/");
    if (!norm.startsWith(profileDir + "/")) continue;
    const manifestPath = path.join(workingDir, profileId, ".manifest.json");
    const manifest = loadManifest(manifestPath);
    // The manifest keys are repo-relative paths like "lib/foo.scad" or "designs/bar.scad"
    const relPath = norm.slice(profileDir.length + 1);
    if (manifest.files[relPath]) return profileId;
  }
  return null;
}

module.exports = {
  ensureLibrary,
  copyLibToDir,
  detectProfile,
  getProfile,
  profiles,
  initWorkingDir,
  updateLibraries,
  fetchGitHubTree,
  isInsideWorkingDir,
  isRepoFile,
  loadManifest,
};
