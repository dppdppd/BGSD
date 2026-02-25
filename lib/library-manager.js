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
  const resp = await net.fetch(url);
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

/**
 * Scrape a GitHub tree page to extract file/directory items.
 * Uses Chromium network stack via net.fetch — respects proxy settings.
 */
async function fetchPageItems(repo, branch, dirPath) {
  const url = `https://github.com/${repo}/tree/${branch}/${dirPath}`;
  const html = await fetchText(url);
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
 * Walk the GitHub repo tree by scraping web pages.
 * Returns array of { path, type } for all files under dirPath.
 * No API rate limits — uses Chromium net stack with proxy support.
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
        fs.writeFileSync(destPath, content, "utf-8");
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

  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(workingDir, profileId);
    const manifestPath = path.join(profileDir, ".manifest.json");
    const manifest = loadManifest(manifestPath);

    log(`[${profile.name}] Scanning repository...`);
    let tree;
    try {
      tree = await fetchGitHubTree(profile.repo, profile.branch, "release", (msg) => log(`[${profile.name}] ${msg}`));
    } catch (err) {
      log(`[${profile.name}] Error: ${err.message}`);
      continue;
    }

    const scadFiles = tree.filter(
      (e) => e.type === "blob" && e.path.endsWith(".scad") && e.path.startsWith("release/")
    );
    const newFiles = {};
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < scadFiles.length; i++) {
      const repoPath = scadFiles[i].path;
      const localPath = repoPath.slice("release/".length);
      const destPath = path.join(profileDir, localPath);
      const isLib = localPath.startsWith("lib/");
      const isTracked = manifest.files[localPath];
      const fileExists = fs.existsSync(destPath);

      if (!isLib && fileExists && !isTracked) {
        continue;
      }

      log(`[${profile.name}] Checking ${localPath} (${i + 1}/${scadFiles.length})`);
      try {
        const content = await fetchRaw(profile.repo, profile.branch, repoPath);
        const hash = contentHash(content);
        if (isTracked && manifest.files[localPath] === hash && fileExists) {
          newFiles[localPath] = hash;
          skipped++;
          continue;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, content, "utf-8");
        newFiles[localPath] = hash;
        updated++;
      } catch (err) {
        log(`[${profile.name}] Warning: Failed to fetch ${localPath}: ${err.message}`);
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

module.exports = {
  ensureLibrary,
  copyLibToDir,
  detectProfile,
  getProfile,
  profiles,
  initWorkingDir,
  updateLibraries,
  isInsideWorkingDir,
  isRepoFile,
  loadManifest,
  setProxy,
  getProxy,
};
