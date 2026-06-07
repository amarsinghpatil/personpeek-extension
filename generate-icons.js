// generate-icons.js — Run with: node generate-icons.js
// Creates PNG icon files from SVG using Node.js built-in canvas isn't available,
// so we'll generate minimal valid PNG files programmatically.

const fs = require('fs');
const path = require('path');

/**
 * Create a minimal PNG file with a solid color background and a simple icon.
 * This generates a raw PNG binary using only the required chunks.
 */
function createPNG(width, height) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);   // width
  ihdrData.writeUInt32BE(height, 4);  // height
  ihdrData[8] = 8;    // bit depth
  ihdrData[9] = 2;    // color type (RGB)
  ihdrData[10] = 0;   // compression
  ihdrData[11] = 0;   // filter
  ihdrData[12] = 0;   // interlace

  const ihdrChunk = makeChunk('IHDR', ihdrData);

  // IDAT chunk - image data
  // Create raw pixel data
  const rawData = [];
  const cx = width * 0.42;
  const cy = height * 0.37;
  const magR = height * 0.22;
  const headR = height * 0.12;

  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte (none)
    for (let x = 0; x < width; x++) {
      // Background: #0c0c14
      let r = 12, g = 12, b = 20;

      // Distance from magnifying glass center
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Magnifying glass circle (ring)
      if (Math.abs(dist - magR) < Math.max(2, width * 0.04)) {
        const t = x / width;
        r = Math.round(108 + (0 - 108) * t);
        g = Math.round(99 + (212 - 99) * t);
        b = Math.round(255 + (170 - 255) * t);
      }

      // Person head (filled circle)
      if (dist < headR) {
        const t = x / width;
        r = Math.round(108 + (0 - 108) * t);
        g = Math.round(99 + (212 - 99) * t);
        b = Math.round(255 + (170 - 255) * t);
      }

      // Person body (small ellipse below head)
      const bodyDx = (x - cx) / (headR * 1.5);
      const bodyDy = (y - (cy + headR * 1.2)) / (headR * 0.9);
      if (bodyDx * bodyDx + bodyDy * bodyDy < 1 && y > cy) {
        const t = x / width;
        r = Math.round(108 + (0 - 108) * t);
        g = Math.round(99 + (212 - 99) * t);
        b = Math.round(255 + (170 - 255) * t);
      }

      // Handle line
      const handleX1 = cx + magR * 0.7;
      const handleY1 = cy + magR * 0.7;
      const handleX2 = width * 0.85;
      const handleY2 = height * 0.82;
      const handleLen = Math.sqrt((handleX2 - handleX1) ** 2 + (handleY2 - handleY1) ** 2);
      const t1 = ((x - handleX1) * (handleX2 - handleX1) + (y - handleY1) * (handleY2 - handleY1)) / (handleLen * handleLen);
      if (t1 >= 0 && t1 <= 1) {
        const projX = handleX1 + t1 * (handleX2 - handleX1);
        const projY = handleY1 + t1 * (handleY2 - handleY1);
        const distToLine = Math.sqrt((x - projX) ** 2 + (y - projY) ** 2);
        if (distToLine < Math.max(2, width * 0.04)) {
          const t = x / width;
          r = Math.round(108 + (0 - 108) * t);
          g = Math.round(99 + (212 - 99) * t);
          b = Math.round(255 + (170 - 255) * t);
        }
      }

      rawData.push(r, g, b);
    }
  }

  // Compress with zlib (deflate)
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  // CRC32
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Generate icons
const sizes = [16, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

for (const size of sizes) {
  const png = createPNG(size, size);
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Created: icon${size}.png (${png.length} bytes)`);
}

console.log('Done!');
