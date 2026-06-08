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
    } else if (entry.isFile() && !/\.c?m?tsx?$/i.test(entry.name)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

try {
  const srcDir = path.resolve(__dirname, 'src');
  const destDir = path.resolve(__dirname, 'dist');
  copyDir(srcDir, destDir);
  console.log('[Build] Successfully copied assets to dist/');
} catch (err) {
  console.error('[Build] Error copying assets:', err);
  process.exit(1);
}

