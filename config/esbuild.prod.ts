import type { BuildOptions } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';
import { RUNTIME_EXTERNALS } from './esbuild.common';
import { ensureIcons } from './gen-icons';

/**
 * 一次性构建：后端（ESM，dist/index.js）+ 前端（public/assets/*.js）+ 静态资源复制
 *
 * 前端构建产物输出到 public/assets/。生产构建产物文件名带内容 hash
 * （main-<hash>.js）并回写 public/index.html 与 public/sw.js 的引用，
 * 使资源更新时 URL 变化、彻底绕开 HTTP 缓存；随后将整个 public/ 复制到
 * dist/public/，供生产一次性部署。
 * watch/dev 模式产物保持固定名 main.js（开发热更无缓存包袱）。
 */

const isWatch = process.argv.includes('--watch');

/** 替换 index.html / sw.js 中对前端入口脚本的引用（兼容固定名与任意 hash 名） */
async function updateAssetRef(filename: string) {
	const refRegex = /\/assets\/main(?:-\w{8})?\.js/g;
	for (const file of ['./public/index.html', './public/sw.js']) {
		const content = await fs.readFile(file, 'utf8');
		const next = content.replace(refRegex, `/assets/${filename}`);
		if (next !== content) {
			await fs.writeFile(file, next);
		}
		else if (!refRegex.test(content)) {
			// 找不到任何可替换的前端入口引用：产物与页面引用将脱节，直接报错而非静默
			throw new Error(`No /assets/main*.js reference found in ${file}`);
		}
	}
}

async function buildBackend() {
	const options: BuildOptions = {
		entryPoints: { index: './src/entry/index.ts' },
		entryNames: '[name]',
		bundle: true,
		outdir: './dist/',
		sourcemap: 'linked',
		platform: 'node',
		format: 'esm', // 保持框架的 ESM 构建模式
		treeShaking: false,
		ignoreAnnotations: true,
		minify: true,
		external: RUNTIME_EXTERNALS,
	};
	if (isWatch) {
		const ctx = await build({ ...options, minify: false });
		await ctx.watch();
	}
	else {
		await build(options);
	}
}

/**
 * 构建前端。
 * 非 watch：产物 main-<hash>.js，返回入口文件名（调用方需回写引用）。
 */
async function buildFrontend(): Promise<string | undefined> {
	// 清理历史产物（避免残留旧 hash 文件）
	await fs.rm('./public/assets', { recursive: true, force: true });
	await fs.mkdir('./public/assets', { recursive: true });

	const options: BuildOptions = {
		entryPoints: { main: './src/frontend/main.ts' },
		outdir: './public/assets/',
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: ['es2020'],
		minify: !isWatch,
		sourcemap: true,
		logLevel: 'info',
		entryNames: isWatch ? '[name]' : '[name]-[hash]',
	};

	if (isWatch) {
		const ctx = await build(options);
		await ctx.watch();
		return undefined;
	}

	const result = await build({ ...options, metafile: true });
	const entryOutput = Object.keys(result.metafile.outputs).find(f => f.endsWith('.js') && !f.endsWith('.map'));
	return entryOutput ? path.basename(entryOutput) : undefined;
}

async function copyStatic() {
	await fs.mkdir('./dist', { recursive: true });
	await fs.rm('./dist/public', { recursive: true, force: true });
	await fs.cp('./public', './dist/public', { recursive: true });
}

(async () => {
	// 保证 PWA 图标存在
	ensureIcons();

	if (isWatch) {
		// watch 模式：产物固定名 main.js，先回写引用再常驻
		await updateAssetRef('main.js');
		await Promise.all([buildBackend(), buildFrontend()]);
		console.warn('watching... (dev assets stay at /assets/main.js)');
	}
	else {
		await Promise.all([buildBackend(), buildFrontend()]);
		// 回写前端产物引用（内容 hash 文件名，8 位 base64url）
		const outputFiles = await fs.readdir('./public/assets');
		const entryJs = outputFiles.find(f => /^main-\w{8}\.js$/.test(f));
		if (entryJs) {
			await updateAssetRef(entryJs);
		}
		else {
			await updateAssetRef('main.js');
		}
		await copyStatic();
		console.warn(`build finished -> ${path.resolve('./dist')}`);
	}
})().catch((ex) => {
	console.error(ex);
	process.exitCode = 1;
});
