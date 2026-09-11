import type { IContext } from '../utils/interface';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveStaticDir } from '../config/config';
import { extOf, mimeType } from '../utils/mime';
import { Controller } from './controller';

/**
 * 前端页面与静态资源控制器
 *
 * 所有非 /api 开头的 GET 请求都路由到这里，由 URL 映射到 public/ 下文件。
 */
class Frontend extends Controller {
	private staticDir(): string {
		return resolveStaticDir();
	}

	public async staticFiles(ctx: IContext) {
		const res = ctx.res;
		try {
			const url = new URL(ctx.req.url ?? '/', 'http://localhost');
			let pathname: string;
			try {
				pathname = decodeURIComponent(url.pathname);
			}
			catch {
				// 畸形百分号编码 → 400，而非吞成 500
				res.statusCode = 400;
				res.end('400 Bad Request');
				return;
			}
			if (pathname === '/') {
				pathname = '/index.html';
			}
			else if (pathname === '/favicon.ico') {
				pathname = '/favicon.svg';
			}

			const baseDir = this.staticDir();
			const filePath = path.resolve(baseDir, `.${pathname}`);

			// 防目录穿越
			if (filePath !== baseDir && !filePath.startsWith(`${baseDir}${path.sep}`)) {
				res.statusCode = 403;
				res.end('403 Forbidden');
				return;
			}

			const buffer = await readFile(filePath).catch(() => null);
			if (!buffer) {
				res.statusCode = 404;
				res.setHeader('Content-Type', 'text/plain; charset=utf-8');
				res.end('404 Not Found');
				return;
			}

			res.setHeader('Content-Type', mimeType(extOf(pathname)));
			// 应用外壳与可执行资源需要及时更新（配合 Service Worker 网络优先刷新）；
			// 图片/字体等二进制资源保留短缓存以优化加载
			const noCacheExt = ['.html', '.js', '.mjs', '.css', '.json', '.webmanifest'];
			if (noCacheExt.includes(extOf(pathname)) || pathname === '/sw.js') {
				res.setHeader('Cache-Control', 'no-cache');
			}
			else {
				res.setHeader('Cache-Control', 'public, max-age=86400');
			}
			res.write(buffer);
		}
		catch {
			res.statusCode = 500;
			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
			res.end('500 Internal Server Error');
		}
	}
}

const frontend = new Frontend();
export default frontend;
