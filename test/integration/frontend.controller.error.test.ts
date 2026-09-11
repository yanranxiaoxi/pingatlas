import { describe, expect, it, jest } from '@jest/globals';
import { createMockContext } from '../helpers/http';

/**
 * 静态目录无法解析时（`resolveStaticDir` 抛错）控制器必须返回 500 而不是让异常冒泡。
 *
 * 由于需要替换 `../config/config` 的导出，这里单独成文件并在动态 import 控制器之前
 * 用 `jest.unstable_mockModule` 注册桩模块。
 */
const resolveStaticDirMock = jest.fn<() => string>(() => {
	throw new Error('Cannot resolve static directory. Set STATIC_DIR explicitly.');
});

jest.unstable_mockModule('../../src/config/config', () => ({
	CONFIG: { staticDir: '' },
	resolveStaticDir: resolveStaticDirMock,
}));

type Frontend = typeof import('../../src/controller/frontend.controller');

async function loadFrontend(): Promise<Frontend> {
	let frontend!: Frontend;
	await jest.isolateModulesAsync(async () => {
		frontend = await import('../../src/controller/frontend.controller');
	});
	return frontend;
}

describe('Frontend.staticFiles 异常兜底', () => {
	it('静态目录解析失败时返回 500 纯文本', async () => {
		const frontend = await loadFrontend();
		const { ctx, res } = createMockContext({ url: '/' });

		await frontend.default.staticFiles(ctx);

		expect(resolveStaticDirMock).toHaveBeenCalled();
		expect(res.statusCode).toBe(500);
		expect(res.getHeader('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.body).toBe('500 Internal Server Error');
	});

	it('畸形百分号编码优先返回 400（不会走到目录解析）', async () => {
		resolveStaticDirMock.mockClear();
		const frontend = await loadFrontend();
		const { ctx, res } = createMockContext({ url: '/%E0%A4%A' });

		await frontend.default.staticFiles(ctx);

		expect(res.statusCode).toBe(400);
		expect(res.body).toBe('400 Bad Request');
		expect(resolveStaticDirMock).not.toHaveBeenCalled();
	});
});
