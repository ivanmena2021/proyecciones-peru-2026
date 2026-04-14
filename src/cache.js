const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

/**
 * Write JSON to public/data/ directory atomically.
 * On Windows, rename can fail if target is open, so we use writeFile with tmp.
 */
function writeJSON(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  const tmpPath = filePath + '.tmp.' + Date.now();
  try {
    const json = JSON.stringify(data);
    fs.writeFileSync(tmpPath, json, 'utf8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      // Rename failed (Windows lock) - fallback to direct write
      fs.writeFileSync(filePath, json, 'utf8');
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch (err) {
    console.error(`[cache] Error writing ${filename}:`, err.message);
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function readJSON(filename) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

module.exports = { writeJSON, readJSON, ensureDataDir };
