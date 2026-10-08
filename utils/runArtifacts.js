'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config.json');

let currentRunDir = '';

function pad(v) {
  return String(v).padStart(2, '0');
}

function formatRunStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function parseRunStamp(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?$/.exec(name);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const ts = new Date(year, month, day, hour, minute, second).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function getRetentionConfig() {
  const keepLastRunFolders = Number(config.keepLastRunFolders || 0);
  const keepRunFoldersForDays = Number(config.keepRunFoldersForDays || 0);
  return {
    keepLastRunFolders: Number.isFinite(keepLastRunFolders) ? Math.max(0, Math.floor(keepLastRunFolders)) : 0,
    keepRunFoldersForDays: Number.isFinite(keepRunFoldersForDays) ? Math.max(0, keepRunFoldersForDays) : 0,
  };
}

function pruneOldRunFolders(rootDir) {
  const { keepLastRunFolders, keepRunFoldersForDays } = getRetentionConfig();
  if (keepLastRunFolders <= 0 && keepRunFoldersForDays <= 0) {
    return;
  }

  let dirents = [];
  try {
    dirents = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_e) {
    return;
  }

  const runs = dirents
    .filter((d) => d.isDirectory())
    .map((d) => {
      const timestamp = parseRunStamp(d.name);
      return timestamp ? { name: d.name, timestamp, fullPath: path.join(rootDir, d.name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);

  if (runs.length === 0) {
    return;
  }

  const deleteSet = new Set();

  if (keepLastRunFolders > 0 && runs.length > keepLastRunFolders) {
    for (let i = keepLastRunFolders; i < runs.length; i++) {
      deleteSet.add(runs[i].fullPath);
    }
  }

  if (keepRunFoldersForDays > 0) {
    const cutoff = Date.now() - Math.floor(keepRunFoldersForDays * 24 * 60 * 60 * 1000);
    for (const run of runs) {
      if (run.timestamp < cutoff) {
        deleteSet.add(run.fullPath);
      }
    }
  }

  for (const fullPath of deleteSet) {
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`${new Date().toISOString()} [ARTIFACTS] Retention removed old run folder: ${fullPath}`);
    } catch (e) {
      console.log(`${new Date().toISOString()} [ARTIFACTS_WARNING] Failed to remove old run folder ${fullPath}: ${e.message}`);
    }
  }
}

function initRunArtifacts(baseDir) {
  const rootDir = baseDir || path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  pruneOldRunFolders(rootDir);

  // Each invocation owns a brand-new folder. mkdirSync without `recursive` fails if the folder
  // already exists, so two runs started in the same second can never share (or overwrite) a folder.
  const baseName = formatRunStamp(new Date());
  let runDir = '';
  for (let n = 1; n <= 100 && !runDir; n++) {
    const candidate = path.join(rootDir, n === 1 ? baseName : `${baseName}-${n}`);
    try {
      fs.mkdirSync(candidate);
      runDir = candidate;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  if (!runDir) {
    throw new Error(`Could not allocate a unique run folder under ${rootDir}`);
  }
  currentRunDir = runDir;
  return runDir;
}

// Creates (once) a named sub-folder inside the CURRENT run folder, e.g. "browserstack".
function ensureRunSubdir(name) {
  const dir = path.join(getRunDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isRunDirInitialized() {
  return Boolean(currentRunDir);
}

function getRunDir() {
  if (!currentRunDir) {
    return path.join(__dirname, '..', 'logs');
  }
  return currentRunDir;
}

function resolveRunPath(fileName) {
  return path.join(getRunDir(), fileName || '');
}

module.exports = {
  initRunArtifacts,
  getRunDir,
  resolveRunPath,
  ensureRunSubdir,
  isRunDirInitialized,
};
