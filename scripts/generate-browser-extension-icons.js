// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const repoRoot = path.resolve(__dirname, "..");
const iconDir = path.join(repoRoot, "browser-extension", "icons");
const sizes = [16, 32, 48, 128];

fs.mkdirSync(iconDir, { recursive: true });

const masterSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#1f232d"/>
  <path d="M71 17 34 56c-12 13-11 33 2 45l20 19c8 8 22 8 31 0l17-17" fill="none" stroke="#f89f1b" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M61 42c11-6 24-5 34 3l20 16" fill="none" stroke="#eef2f7" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M54 76h42" fill="none" stroke="#eef2f7" stroke-width="13" stroke-linecap="round"/>
  <circle cx="94" cy="95" r="20" fill="#2563eb"/>
  <path d="M86 95h17m-7-7 7 7-7 7" fill="none" stroke="#eef2f7" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

fs.writeFileSync(path.join(iconDir, "icon.svg"), masterSvg);

for (const size of sizes) {
    fs.writeFileSync(path.join(iconDir, `icon-${size}.png`), createIconPng(size));
}

console.log(`Generated browser extension icons in ${iconDir}`);

function createIconPng(size) {
    const scale = size / 128;
    const sampleCount = size < 48 ? 3 : 2;
    const pixels = Buffer.alloc(size * size * 4);

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const color = samplePixel(x, y, scale, sampleCount);
            const offset = (y * size + x) * 4;
            pixels[offset] = color.r;
            pixels[offset + 1] = color.g;
            pixels[offset + 2] = color.b;
            pixels[offset + 3] = color.a;
        }
    }

    return encodePng(size, size, pixels);
}

function samplePixel(x, y, scale, sampleCount) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    const total = sampleCount * sampleCount;

    for (let sy = 0; sy < sampleCount; sy++) {
        for (let sx = 0; sx < sampleCount; sx++) {
            const px = (x + (sx + 0.5) / sampleCount) / scale;
            const py = (y + (sy + 0.5) / sampleCount) / scale;
            const color = drawAt(px, py);
            r += color.r;
            g += color.g;
            b += color.b;
            a += color.a;
        }
    }

    return {
        r: Math.round(r / total),
        g: Math.round(g / total),
        b: Math.round(b / total),
        a: Math.round(a / total),
    };
}

function drawAt(x, y) {
    let color = { r: 0, g: 0, b: 0, a: 0 };

    if (insideRoundedRect(x, y, 0, 0, 128, 128, 28)) {
        color = { r: 31, g: 35, b: 45, a: 255 };
    }

    color = strokePolyline(color, x, y, [[71, 17], [34, 56], [28, 76], [36, 101], [56, 120], [75, 123], [87, 120], [104, 103]], 13, { r: 248, g: 159, b: 27, a: 255 });
    color = strokePolyline(color, x, y, [[61, 42], [73, 38], [95, 45], [115, 61]], 13, { r: 238, g: 242, b: 247, a: 255 });
    color = strokePolyline(color, x, y, [[54, 76], [96, 76]], 13, { r: 238, g: 242, b: 247, a: 255 });

    if (distance(x, y, 94, 95) <= 20) {
        color = { r: 37, g: 99, b: 235, a: 255 };
    }

    color = strokePolyline(color, x, y, [[86, 95], [103, 95]], 6, { r: 238, g: 242, b: 247, a: 255 });
    color = strokePolyline(color, x, y, [[96, 88], [103, 95], [96, 102]], 6, { r: 238, g: 242, b: 247, a: 255 });

    return color;
}

function strokePolyline(base, x, y, points, width, color) {
    const radius = width / 2;

    for (const point of points) {
        if (distance(x, y, point[0], point[1]) <= radius) {
            return color;
        }
    }

    for (let i = 0; i < points.length - 1; i++) {
        if (distanceToSegment(x, y, points[i], points[i + 1]) <= radius) {
            return color;
        }
    }

    return base;
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
    const right = left + width;
    const bottom = top + height;
    const cx = Math.max(left + radius, Math.min(x, right - radius));
    const cy = Math.max(top + radius, Math.min(y, bottom - radius));
    return x >= left && x <= right && y >= top && y <= bottom && distance(x, y, cx, cy) <= radius;
}

function distanceToSegment(x, y, a, b) {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const wx = x - a[0];
    const wy = y - a[1];
    const lengthSquared = vx * vx + vy * vy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lengthSquared));
    return distance(x, y, a[0] + t * vx, a[1] + t * vy);
}

function distance(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

function encodePng(width, height, rgba) {
    const scanlineLength = width * 4 + 1;
    const raw = Buffer.alloc(scanlineLength * height);

    for (let y = 0; y < height; y++) {
        raw[y * scanlineLength] = 0;
        rgba.copy(raw, y * scanlineLength + 1, y * width * 4, (y + 1) * width * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", Buffer.concat([
            uint32(width),
            uint32(height),
            Buffer.from([8, 6, 0, 0, 0]),
        ])),
        pngChunk("IDAT", zlib.deflateSync(raw)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function pngChunk(type, data) {
    const typeBuffer = Buffer.from(type, "ascii");
    const crcBuffer = Buffer.concat([typeBuffer, data]);
    return Buffer.concat([
        uint32(data.length),
        typeBuffer,
        data,
        uint32(crc32(crcBuffer)),
    ]);
}

function uint32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer;
}

function crc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}
