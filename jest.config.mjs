/**
 * Jest 配置（ESM 项目）
 *
 * 本项目 `package.json` 为 `"type": "module"`，源码使用 `import.meta.url`，
 * 因此测试必须以 ESM 方式运行：
 *   node --experimental-vm-modules node_modules/jest/bin/jest.js
 *
 * 默认环境为 node（后端）；依赖 DOM 的前端测试在文件头用
 * `/** @jest-environment jsdom *\/` 单独切换。
 */
export default {
	// 默认 node 环境（后端测试）；前端测试用文件级 docblock 切到 jsdom
	testEnvironment: 'node',
	roots: ['<rootDir>/test'],
	extensionsToTreatAsEsm: ['.ts'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', useESM: true }],
	},
	// 保留源码里的 `./x.js` 风格导入在转译后仍能解析
	moduleNameMapper: {
		'^(\\.{1,2}/.*)\\.js$': '$1',
		// JSON 模块在 Jest 的 ESM 链接器里没有具名导出，用等价 TS 垫片替代。
		// 模式必须精确到源码使用的 `'../../package.json'`：若写成 `^.*/package\.json$`，
		// 会连带命中 winston 等依赖内部的 `require('../package.json')`，
		// 导致 CJS 依赖去 require 一个 ESM 垫片而报 “cycle” 错误。
		'^\\.\\./\\.\\./package\\.json$': '<rootDir>/test/setup/package-json.ts',
	},
	testMatch: ['**/*.test.ts'],
	setupFiles: ['<rootDir>/test/setup/env.ts'],
	clearMocks: true,
	restoreMocks: true,
	// 集成测试需要起真实 HTTP server，放宽超时
	testTimeout: 30000,
	collectCoverageFrom: ['src/**/*.ts'],
	coverageDirectory: 'coverage',
	coveragePathIgnorePatterns: ['/node_modules/', '/src/main/'],
};
