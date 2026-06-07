const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    let srcPath = path.join(src, entry.name);
    let destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!entry.name.endsWith('.ts')) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  copyDir('src', 'dist');
  console.log('[Build] Successfully copied assets to dist/');
} catch (err) {
  console.error('[Build] Error copying assets:', err);
  process.exit(1);
}
