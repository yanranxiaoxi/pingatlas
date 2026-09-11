import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { resetEnv } from '../helpers/env';
import { createMockContext } from '../helpers/http';
import { publicDir } from '../helpers/paths';

type Controller = typeof import('../../src/controller/frontend.controller');

/** 在隔离模块注册表中把静态目录固定到仓库的 public/ */
async function loadController(): Promise<Controller> {
	let controller!: Controller;
	resetEnv({ STATIC_DIR: publicDir });
	await jest.isolateModulesAsync(async () => {
		controller = await import('../../src/controller/frontend.controller');
	});
	return controller;
}

afterEach(() => resetEnv());

describe('静态资源服务', () => {
	it('/ 映射到 index.html 且不缓存', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('text/html; charset=utf-8');
		expect(res.getHeader('cache-control')).toBe('no-cache');
		expect(res.body).toContain('<html');
	});

	it('/index.html 直接命中同一文件', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/index.html' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('<html');
	});

	it('/favicon.ico 回落到 favicon.svg', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/favicon.ico' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('image/svg+xml');
		// .svg 不在 no-cache 列表内，走短缓存
		expect(res.getHeader('cache-control')).toBe('public, max-age=86400');
	});

	it.each([
		['/css/style.css', 'text/css; charset=utf-8', 'no-cache'],
		['/locales/en.json', 'application/json; charset=utf-8', 'no-cache'],
		['/manifest.webmanifest', 'application/manifest+json; charset=utf-8', 'no-cache'],
		['/sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
		['/icons/icon-192.png', 'image/png', 'public, max-age=86400'],
	])('%s 返回正确的类型与缓存策略', async (url, contentType, cacheControl) => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe(contentType);
		expect(res.getHeader('cache-control')).toBe(cacheControl);
		expect(res.body.length).toBeGreaterThan(0);
	});

	it('未知扩展名回落为 octet-stream', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/sw.js?v=1' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('text/javascript; charset=utf-8');
	});

	it('文件不存在返回 404 纯文本', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/definitely-missing.html' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(404);
		expect(res.getHeader('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.body).toBe('404 Not Found');
	});

	it('路径指向目录时返回 404', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/icons' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(404);
	});

	it('没有任何 SPA fallback：未知路径不会返回 index.html', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/some/spa/route' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(404);
		expect(res.body).not.toContain('<html');
	});

	it('畸形百分号编码返回 400', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/%E0%A4%A' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(400);
		expect(res.body).toBe('400 Bad Request');
	});

	it('编码后的目录穿越被拒绝（403）', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/..%2F..%2Fpackage.json' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(403);
		expect(res.body).toBe('403 Forbidden');
	});

	it('URL 规范化的 .. 段落被解析后仍限制在静态目录内', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/../package.json' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(404);
		expect(res.body).toBe('404 Not Found');
	});

	it('req.url 缺失时按 / 处理', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({});
		ctx.req.url = undefined;

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('<html');
	});

	it('路径带查询串时忽略查询部分', async () => {
		const controller = await loadController();
		const { ctx, res } = createMockContext({ url: '/css/style.css?ts=123' });

		await controller.default.staticFiles(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('text/css; charset=utf-8');
	});
});
