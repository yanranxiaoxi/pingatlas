/**
 * 环境变量快照与恢复工具
 *
 * 测试会通过 `process.env` 驱动 `src/config/config.ts` 在不同环境下重新求值，
 * 必须保证用例之间互不污染（否则一个用例的非法值会拖垮后续所有用例）。
 */

const BASE_ENV: Record<string, string | undefined> = { ...process.env };

/**
 * 恢复基线环境变量，并可选地叠加覆盖项
 * @param overrides - 覆盖项，值为 `undefined` 表示删除该变量
 */
export function resetEnv(overrides: Record<string, string | undefined> = {}) {
	for (const key of Object.keys(process.env)) {
		delete process.env[key];
	}
	Object.assign(process.env, BASE_ENV);
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete process.env[key];
		}
		else {
			process.env[key] = value;
		}
	}
}

/** 基线环境下的会话签名密钥（与 test/setup/env.ts 保持一致） */
export const TEST_SESSION_SECRET = 'test-session-secret-0123456789abcdef';
