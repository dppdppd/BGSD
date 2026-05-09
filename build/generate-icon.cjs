#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Buffer } = require("buffer");

const OUT_DIR = __dirname;
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

function rgba(hex, alpha = 255) {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
    alpha,
  ];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function point(a, b) {
  return [a, b];
}

function bilinear(p00, p10, p11, p01, u, v) {
  return [
    lerp(lerp(p00[0], p10[0], u), lerp(p01[0], p11[0], u), v),
    lerp(lerp(p00[1], p10[1], u), lerp(p01[1], p11[1], u), v),
  ];
}

function makeCanvas(width, height) {
  return {
    width,
    height,
    data: new Uint8Array(width * height * 4),
  };
}

function blendPixel(canvas, x, y, color) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const idx = (y * canvas.width + x) * 4;
  const srcA = color[3] / 255;
  const dstA = canvas.data[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  for (let i = 0; i < 3; i++) {
    const src = color[i] / 255;
    const dst = canvas.data[idx + i] / 255;
    canvas.data[idx + i] = Math.round(((src * srcA) + (dst * dstA * (1 - srcA))) / outA * 255);
  }
  canvas.data[idx + 3] = Math.round(outA * 255);
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0], yi = points[i][1];
    const xj = points[j][0], yj = points[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function fillPolygon(canvas, points, color) {
  const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0]))));
  const maxX = Math.min(canvas.width - 1, Math.ceil(Math.max(...points.map((p) => p[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
  const maxY = Math.min(canvas.height - 1, Math.ceil(Math.max(...points.map((p) => p[1]))));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (insidePolygon(x + 0.5, y + 0.5, points)) blendPixel(canvas, x, y, color);
    }
  }
}

function fillCircle(canvas, cx, cy, r, color) {
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(canvas.width - 1, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(canvas.height - 1, Math.ceil(cy + r));
  const rr = r * r;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= rr) blendPixel(canvas, x, y, color);
    }
  }
}

function fillRoundedRect(canvas, x, y, w, h, r, color) {
  const minX = Math.max(0, Math.floor(x));
  const maxX = Math.min(canvas.width - 1, Math.ceil(x + w));
  const minY = Math.max(0, Math.floor(y));
  const maxY = Math.min(canvas.height - 1, Math.ceil(y + h));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = Math.max(x + r, Math.min(px + 0.5, x + w - r));
      const cy = Math.max(y + r, Math.min(py + 0.5, y + h - r));
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) blendPixel(canvas, px, py, color);
    }
  }
}

function strokeLine(canvas, a, b, width, color) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const nx = -dy / len * width / 2;
  const ny = dx / len * width / 2;
  fillPolygon(canvas, [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ], color);
  fillCircle(canvas, a[0], a[1], width / 2, color);
  fillCircle(canvas, b[0], b[1], width / 2, color);
}

function strokePolygon(canvas, points, width, color) {
  for (let i = 0; i < points.length; i++) {
    strokeLine(canvas, points[i], points[(i + 1) % points.length], width, color);
  }
}

function starPoints(cx, cy, outer, inner, count = 5) {
  const points = [];
  for (let i = 0; i < count * 2; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / count;
    const r = i % 2 === 0 ? outer : inner;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return points;
}

function drawBackground(canvas) {
  const s = canvas.width;
  const u = (x) => x * s;
  const p = (x, y) => point(u(x), u(y));

  const bgTop = rgba("#2f5367");
  const bgBottom = rgba("#172638");
  for (let y = 0; y < s; y++) {
    const t = y / Math.max(1, s - 1);
    fillPolygon(canvas, [[0, y], [s, y], [s, y + 1], [0, y + 1]], mix(bgTop, bgBottom, t));
  }
  fillRoundedRect(canvas, u(0.07), u(0.07), u(0.86), u(0.86), u(0.185), rgba("#24384a", 232));
  fillPolygon(canvas, [p(0.18, 0.30), p(0.55, 0.12), p(0.91, 0.42), p(0.69, 0.27), p(0.51, 0.21), p(0.24, 0.44)], rgba("#4a7e8d", 55));
}

function drawLargeIcon(canvas) {
  const s = canvas.width;
  const u = (x) => x * s;
  const p = (x, y) => point(u(x), u(y));

  drawBackground(canvas);

  const p00 = p(0.25, 0.36);
  const p10 = p(0.58, 0.24);
  const p11 = p(0.78, 0.40);
  const p01 = p(0.44, 0.58);
  const down = [0, u(0.16)];
  const q00 = [p00[0] + down[0], p00[1] + down[1]];
  const q10 = [p10[0] + down[0], p10[1] + down[1]];
  const q11 = [p11[0] + down[0], p11[1] + down[1]];
  const q01 = [p01[0] + down[0], p01[1] + down[1]];

  fillPolygon(canvas, [p(0.24, 0.50), p(0.82, 0.36), p(0.78, 0.68), p(0.41, 0.82)], rgba("#071423", 72));
  fillPolygon(canvas, [p00, p01, q01, q00], rgba("#469ba4"));
  fillPolygon(canvas, [p01, p11, q11, q01], rgba("#2f7f91"));
  fillPolygon(canvas, [q00, q01, q11, q10], rgba("#1f5d75"));

  fillPolygon(canvas, [p00, p10, p11, p01], rgba("#e8f7f0"));
  fillPolygon(canvas, [p(0.30, 0.38), p(0.58, 0.28), p(0.73, 0.40), p(0.45, 0.53)], rgba("#f4fff9", 105));

  strokePolygon(canvas, [p00, p10, p11, p01], u(0.032), rgba("#15364b"));
  strokePolygon(canvas, [p00, p10, p11, p01], u(0.012), rgba("#d7f4ea"));

  const gridColor = rgba("#2d6c7a");
  for (const v of [0.45, 0.72]) {
    strokeLine(canvas, bilinear(p00, p10, p11, p01, 0.02, v), bilinear(p00, p10, p11, p01, 0.98, v), u(0.024), gridColor);
  }
  for (const x of [0.36, 0.68]) {
    strokeLine(canvas, bilinear(p00, p10, p11, p01, x, 0.02), bilinear(p00, p10, p11, p01, x, 0.98), u(0.024), gridColor);
  }

  const token = bilinear(p00, p10, p11, p01, 0.31, 0.40);
  fillCircle(canvas, token[0], token[1], u(0.043), rgba("#15364b"));
  fillCircle(canvas, token[0], token[1], u(0.030), rgba("#f2b84b"));

  const chip = bilinear(p00, p10, p11, p01, 0.68, 0.43);
  const chipSize = u(0.042);
  fillRoundedRect(canvas, chip[0] - chipSize, chip[1] - chipSize, chipSize * 2, chipSize * 2, u(0.011), rgba("#15364b"));
  fillRoundedRect(canvas, chip[0] - chipSize * 0.72, chip[1] - chipSize * 0.72, chipSize * 1.44, chipSize * 1.44, u(0.010), rgba("#f08a4b"));

  const star = starPoints(u(0.73), u(0.27), u(0.083), u(0.038));
  strokePolygon(canvas, star, u(0.018), rgba("#15364b"));
  fillPolygon(canvas, star, rgba("#ffc857"));
}

function drawSmallIcon(canvas) {
  const s = canvas.width;
  const u = (x) => x * s;
  const p = (x, y) => point(u(x), u(y));

  drawBackground(canvas);

  const p00 = p(0.17, 0.35);
  const p10 = p(0.58, 0.19);
  const p11 = p(0.86, 0.42);
  const p01 = p(0.40, 0.66);
  const down = [0, u(0.17)];
  const q00 = [p00[0], p00[1] + down[1]];
  const q11 = [p11[0], p11[1] + down[1]];
  const q01 = [p01[0], p01[1] + down[1]];

  fillPolygon(canvas, [p(0.22, 0.55), p(0.88, 0.43), p(0.82, 0.74), p(0.41, 0.88)], rgba("#071423", 92));
  fillPolygon(canvas, [p00, p01, q01, q00], rgba("#43a1a8"));
  fillPolygon(canvas, [p01, p11, q11, q01], rgba("#2e788d"));
  fillPolygon(canvas, [q00, q01, q11], rgba("#1f5d75"));

  fillPolygon(canvas, [p00, p10, p11, p01], rgba("#f4fff9"));
  strokePolygon(canvas, [p00, p10, p11, p01], u(0.065), rgba("#102f43"));
  strokePolygon(canvas, [p00, p10, p11, p01], u(0.026), rgba("#e8fff7"));

  const grid = rgba("#2a6f7c");
  strokeLine(canvas, bilinear(p00, p10, p11, p01, 0.50, 0.06), bilinear(p00, p10, p11, p01, 0.50, 0.96), u(0.052), grid);
  strokeLine(canvas, bilinear(p00, p10, p11, p01, 0.06, 0.52), bilinear(p00, p10, p11, p01, 0.96, 0.52), u(0.052), grid);

  const token = bilinear(p00, p10, p11, p01, 0.32, 0.38);
  fillCircle(canvas, token[0], token[1], u(0.105), rgba("#102f43"));
  fillCircle(canvas, token[0], token[1], u(0.070), rgba("#ffc857"));

  const marker = bilinear(p00, p10, p11, p01, 0.72, 0.35);
  fillRoundedRect(canvas, marker[0] - u(0.060), marker[1] - u(0.060), u(0.12), u(0.12), u(0.018), rgba("#102f43"));
  fillRoundedRect(canvas, marker[0] - u(0.039), marker[1] - u(0.039), u(0.078), u(0.078), u(0.014), rgba("#f08a4b"));
}

function downsample(canvas, targetSize, sample) {
  const out = makeCanvas(targetSize, targetSize);
  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < sample; sy++) {
        for (let sx = 0; sx < sample; sx++) {
          const idx = (((y * sample + sy) * canvas.width) + (x * sample + sx)) * 4;
          for (let i = 0; i < 4; i++) acc[i] += canvas.data[idx + i];
        }
      }
      const outIdx = (y * targetSize + x) * 4;
      const denom = sample * sample;
      for (let i = 0; i < 4; i++) out.data[outIdx + i] = Math.round(acc[i] / denom);
    }
  }
  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(canvas) {
  const raw = Buffer.alloc((canvas.width * 4 + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const row = y * (canvas.width * 4 + 1);
    raw[row] = 0;
    Buffer.from(canvas.data.slice(y * canvas.width * 4, (y + 1) * canvas.width * 4)).copy(raw, row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(canvas.width, 0);
  ihdr.writeUInt32BE(canvas.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function renderPng(size) {
  const sample = size >= 512 ? 2 : 4;
  const canvas = makeCanvas(size * sample, size * sample);
  if (size <= 48) drawSmallIcon(canvas);
  else drawLargeIcon(canvas);
  return encodePng(downsample(canvas, size, sample));
}

function writeIco(pngBySize) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = header.length + sizes.length * 16;
  for (const size of sizes) {
    const png = pngBySize.get(size);
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...sizes.map((size) => pngBySize.get(size))]);
}

function icnsEntry(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([header, data]);
}

function writeIcns(pngBySize) {
  const entries = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32],
    ["ic12", 64],
    ["ic13", 256],
    ["ic14", 512],
  ].map(([type, size]) => icnsEntry(type, pngBySize.get(size)));
  const total = 8 + entries.reduce((sum, entry) => sum + entry.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...entries]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pngBySize = new Map();
  for (const size of PNG_SIZES) {
    const png = renderPng(size);
    pngBySize.set(size, png);
    fs.writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), png);
  }
  fs.writeFileSync(path.join(OUT_DIR, "icon-small.png"), pngBySize.get(32));
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), pngBySize.get(1024));
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), writeIco(pngBySize));
  fs.writeFileSync(path.join(OUT_DIR, "icon.icns"), writeIcns(pngBySize));

  const summary = ["icon.svg", "icon.png", "icon.ico", "icon.icns"]
    .map((name) => {
      const file = path.join(OUT_DIR, name);
      const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
      return `${name} ${fs.statSync(file).size} bytes ${hash}`;
    })
    .join("\n");
  console.log(summary);
}

main();
