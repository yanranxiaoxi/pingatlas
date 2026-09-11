import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * 生成 PWA 图标（无第三方依赖的纯 Node PNG 编码）
 *
 * 用法：tsx ./config/gen-icons.ts        # 生成到 public/icons/
 * 构建时若图标缺失也会自动调用 ensureIcons()
 */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xFFFFFFFF;
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
	}
	return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
	return out;
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
	const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	return Buffer.concat([
		sig,
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

interface IconSpec {
	size: number;
	/** true 时四角圆角透明，false 铺满（maskable） */
	rounded: boolean;
	/** 中心白色圆点半径（相对尺寸） */
	dotRatio: number;
}

const ICON_SPECS: Record<string, IconSpec> = {
	'icon-192.png': { size: 192, rounded: true, dotRatio: 0.16 },
	'icon-512.png': { size: 512, rounded: true, dotRatio: 0.16 },
	'maskable-512.png': { size: 512, rounded: false, dotRatio: 0.12 },
};

function blend(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function makeIcon(spec: IconSpec): Buffer {
	const { size, rounded, dotRatio } = spec;
	const rgba = Buffer.alloc(size * size * 4);
	const c1 = [91, 141, 239]; // #5b8def
	const c2 = [124, 58, 237]; // #7c3aed
	const half = size / 2;
	const margin = size * (rounded ? 0.04 : 0);
	const corner = size * (rounded ? 0.22 : 0);
	const edge = half - margin - corner;
	const dotR = size * dotRatio;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			let inside = true;
			if (rounded) {
				// 圆角矩形 SDF
				const px = Math.max(Math.abs(x + 0.5 - half) - edge, 0);
				const py = Math.max(Math.abs(y + 0.5 - half) - edge, 0);
				inside = Math.hypot(px, py) <= corner;
			}
			if (!inside) {
				continue; // 透明
			}
			const t = (x + y) / (2 * (size - 1));
			const dx = x + 0.5 - half;
			const dy = y + 0.5 - half;
			const isDot = Math.hypot(dx, dy) <= dotR;
			const r = isDot ? 255 : blend(c1[0], c2[0], t);
			const g = isDot ? 255 : blend(c1[1], c2[1], t);
			const b = isDot ? 255 : blend(c1[2], c2[2], t);
			const idx = (y * size + x) * 4;
			rgba[idx] = r;
			rgba[idx + 1] = g;
			rgba[idx + 2] = b;
			rgba[idx + 3] = 255;
		}
	}
	return encodePng(size, size, rgba);
}

export function iconsDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
}

/**
 * 确保 icons 存在（缺失时生成）。返回生成的文件名列表。
 */
export function ensureIcons(): string[] {
	const dir = iconsDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const generated: string[] = [];
	for (const [file, spec] of Object.entries(ICON_SPECS)) {
		if (!existsSync(path.join(dir, file))) {
			writeFileSync(path.join(dir, file), makeIcon(spec));
			console.warn(`generated public/icons/${file}`);
			generated.push(file);
		}
	}
	return generated;
}

// 直接运行入口：tsx ./config/gen-icons.ts
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	ensureIcons();
	console.warn(`icons ready at ${iconsDir()}`);
}
