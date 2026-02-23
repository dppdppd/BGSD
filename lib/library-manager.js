const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const https = require("https");

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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "BGSD" } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
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
 * Fetch the GitHub tree for a repo/branch (recursive).
 * Returns array of { path, type, sha }.
 */
async function fetchGitHubTree(repo, branch) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const data = await fetchJson(url);
  return (data.tree || []).map((e) => ({ path: e.path, type: e.type, sha: e.sha }));
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

    log(`Fetching ${profile.name} repository tree...`);
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch);
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

    for (const entry of scadFiles) {
      const repoPath = entry.path;
      // Strip "release/" prefix for local path and manifest key
      const localPath = repoPath.slice("release/".length);

      const destPath = path.join(profileDir, localPath);

      // Create parent dir
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      log(`Fetching ${localPath}...`);
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        fs.writeFileSync(destPath, content, "utf-8");
        newFiles[localPath] = entry.sha;
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
    log(`${profile.name} setup complete.`);
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

    log(`Updating ${profile.name}...`);
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch);
    } catch (err) {
      log(`Warning: Could not fetch tree for ${profile.name}: ${err.message}`);
      continue;
    }

    const scadFiles = tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".scad") && e.path.startsWith("release/")
    );
    const newFiles = {};

    for (const entry of scadFiles) {
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

      // Skip if sha unchanged
      if (isTracked && manifest.files[localPath] === entry.sha && fileExists) {
        newFiles[localPath] = entry.sha;
        continue;
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      log(`Updating ${localPath}...`);
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        fs.writeFileSync(destPath, content, "utf-8");
        newFiles[localPath] = entry.sha;
      } catch (err) {
        log(`Warning: Failed to fetch ${localPath}: ${err.message}`);
        // Keep old sha if fetch failed
        if (isTracked) newFiles[localPath] = manifest.files[localPath];
      }
    }

    const updatedManifest = {
      lastUpdated: new Date().toISOString(),
      files: newFiles,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2), "utf-8");
    log(`${profile.name} update complete.`);
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
