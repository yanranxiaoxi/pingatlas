import { describe, expect, it } from '@jest/globals';

describe('测试环境自检', () => {
	it('环境变量基线已就绪', () => {
		expect(process.env.SESSION_SECRET).toBeTruthy();
	});

	it('可以导入后端模块', async () => {
		const { CONFIG } = await import('../src/config/config');
		expect(CONFIG.port).toBe(3001);
	});

	it('可以导入依赖 package.json 的控制器', async () => {
		const { default: globalping, ANONYMOUS_MAX_PROBES } = await import('../src/controller/globalping.controller');
		expect(globalping).toBeTruthy();
		expect(ANONYMOUS_MAX_PROBES).toBe(50);
	});
});
