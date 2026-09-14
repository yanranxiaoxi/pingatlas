import * as nodeFs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CONFIG, resolveStaticDir } from '../../src/config/config';
import { resetEnv } from '../helpers/env';
import { projectRoot } from '../helpers/paths';

beforeEach(() => resetEnv());
afterAll(() => resetEnv());

/** 在隔离的模块注册表中按当前 `process.env` 重新求值配置模块 */
async function importConfig() {
	return await import('../../src/config/config');
}

describe('CONFIG 基线（test/setup/env.ts 提供的环境）', () => {
	it('读取服务与运行时配置', () => {
		expect(CONFIG.env).toBe('test');
		expect(CONFIG.envProduct).toBe('test');
		expect(CONFIG.host).toBe('127.0.0.1');
		expect(CONFIG.port).toBe(3001);
		expect(CONFIG.serverName).toBe('pingatlas-test');
		expect(CONFIG.logLevel).toBe('error');
	});

	it('projectName 回退到 package.json 的 name（未设置 PROJECT_NAME）', () => {
		expect(process.env.PROJECT_NAME).toBeUndefined();
		expect(CONFIG.projectName).toBe('pingatlas');
	});

	it('读取 Globalping 配置', () => {
		expect(CONFIG.gp.apiUrl).toBe('http://127.0.0.1:1');
		expect(CONFIG.gp.token).toBe('');
		expect(CONFIG.gp.timeout).toBe(30_000);
	});

	it('未配置 OIDC 时全部为空，scope 与 usernameClaim 使用默认值', () => {
		expect(CONFIG.oidc.issuer).toBe('');
		expect(CONFIG.oidc.clientId).toBe('');
		expect(CONFIG.oidc.clientSecret).toBe('');
		expect(CONFIG.oidc.redirectUri).toBe('');
		expect(CONFIG.oidc.providerName).toBe('');
		expect(CONFIG.oidc.scope).toBe('openid profile email');
		expect(CONFIG.oidc.usernameClaim).toBe('preferred_username');
		expect(CONFIG.oidc.postLogoutRedirectUri).toBe('');
		expect(CONFIG.oidc.accountUrl).toBe('');
	});

	it('读取会话配置', () => {
		expect(CONFIG.session.secret).toBe('test-session-secret-0123456789abcdef');
		expect(CONFIG.session.cookieName).toBe('pa_session');
		expect(CONFIG.session.ttl).toBe(7 * 24 * 60 * 60);
	});

	it('staticDir 为空时由 resolveStaticDir 兜底', () => {
		expect(CONFIG.staticDir).toBe('');
	});
});

describe('CONFIG 自定义环境', () => {
	it('读取显式配置的值，并推导 postLogoutRedirectUri', async () => {
		resetEnv({
			ENV_PRODUCT: 'production',
			SERVER_HOST: '0.0.0.0',
			SERVER_PORT: '8080',
			SERVER_NAME: 'pingatlas-prod',
			LOG_LEVEL: 'warn',
			GP_API_URL: 'https://api.example.com',
			GP_TOKEN: 'gp-token-value',
			GP_TIMEOUT: '5000',
			OIDC_ISSUER: 'https://idp.example.com/realms/main',
			OIDC_CLIENT_ID: 'pingatlas',
			OIDC_CLIENT_SECRET: 'secret',
			OIDC_REDIRECT_URI: 'https://ping.example.com/api/auth/callback',
			OIDC_SCOPE: 'openid',
			OIDC_USERNAME_CLAIM: 'name',
			OIDC_PROVIDER_NAME: 'Example SSO',
			OIDC_ACCOUNT_URL: 'https://sso.example.com/realms/main/account',
			SESSION_SECRET: 'another-secret-abcdefghijkl',
			SESSION_COOKIE_NAME: 'pa_sid',
			SESSION_TTL: '60',
			STATIC_DIR: './dist/public',
		});

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom, resolveStaticDir: resolve } = await importConfig();

			expect(custom.env).toBe('production');
			expect(custom.envProduct).toBe('production');
			expect(custom.host).toBe('0.0.0.0');
			expect(custom.port).toBe(8080);
			expect(custom.serverName).toBe('pingatlas-prod');
			expect(custom.logLevel).toBe('warn');
			expect(custom.gp).toEqual({ apiUrl: 'https://api.example.com', token: 'gp-token-value', timeout: 5000 });
			expect(custom.oidc.issuer).toBe('https://idp.example.com/realms/main');
			expect(custom.oidc.clientId).toBe('pingatlas');
			expect(custom.oidc.clientSecret).toBe('secret');
			expect(custom.oidc.redirectUri).toBe('https://ping.example.com/api/auth/callback');
			expect(custom.oidc.scope).toBe('openid');
			expect(custom.oidc.usernameClaim).toBe('name');
			expect(custom.oidc.providerName).toBe('Example SSO');
			expect(custom.oidc.postLogoutRedirectUri).toBe('https://ping.example.com/');
			expect(custom.oidc.accountUrl).toBe('https://sso.example.com/realms/main/account');
			expect(custom.session).toMatchObject({ cookieName: 'pa_sid', ttl: 60 });
			expect(custom.session.secret).toBe('another-secret-abcdefghijkl');
			expect(custom.staticDir).toBe('./dist/public');
			expect(resolve()).toBe(path.resolve('./dist/public'));
		});
	});

	it('显式配置 OIDC_POST_LOGOUT_REDIRECT_URI 时优先使用', async () => {
		resetEnv({
			OIDC_REDIRECT_URI: 'https://ping.example.com/api/auth/callback',
			OIDC_POST_LOGOUT_REDIRECT_URI: 'https://ping.example.com/bye',
		});

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.oidc.postLogoutRedirectUri).toBe('https://ping.example.com/bye');
		});
	});

	it('OIDC_REDIRECT_URI 畸形时 postLogoutRedirectUri 退化为空串', async () => {
		resetEnv({ OIDC_REDIRECT_URI: 'not a url', OIDC_POST_LOGOUT_REDIRECT_URI: '' });

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.oidc.postLogoutRedirectUri).toBe('');
		});
	});

	it('未配置 OIDC_ACCOUNT_URL 时 accountUrl 为空串', async () => {
		resetEnv({ OIDC_ACCOUNT_URL: undefined });

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.oidc.accountUrl).toBe('');
		});
	});

	it('accountUrl 保留原样（不做 URL 归一化，避免给运维意外结果）', async () => {
		resetEnv({ OIDC_ACCOUNT_URL: 'https://sso.example.com/account?tab=profile#top' });

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.oidc.accountUrl).toBe('https://sso.example.com/account?tab=profile#top');
		});
	});

	it('accountUrl 也接受 http（本地开发常用）', async () => {
		resetEnv({ OIDC_ACCOUNT_URL: 'http://localhost:8080/account' });

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.oidc.accountUrl).toBe('http://localhost:8080/account');
		});
	});

	it('accountUrl 非 http(s) 协议时丢弃（会作为 <a href> 下发，必须堵住 javascript: 等）', async () => {
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'ftp://example.com/account',
			'file:///etc/passwd',
		]) {
			resetEnv({ OIDC_ACCOUNT_URL: bad });
			await jest.isolateModulesAsync(async () => {
				const { CONFIG: custom } = await importConfig();
				expect(custom.oidc.accountUrl).toBe('');
			});
		}
	});

	it('accountUrl 畸形时退化为空串', async () => {
		resetEnv({ OIDC_ACCOUNT_URL: 'not a url' });

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.oidc.accountUrl).toBe('');
		});
	});

	it('PROJECT_NAME 显式配置时覆盖 package.json 的 name', async () => {
		resetEnv({ PROJECT_NAME: 'custom-project' });

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.projectName).toBe('custom-project');
		});
	});

	it('未填 SERVER_PORT / SERVER_HOST / SERVER_NAME 时使用默认值', async () => {
		resetEnv({
			SERVER_PORT: undefined,
			SERVER_HOST: undefined,
			SERVER_NAME: undefined,
			GP_TIMEOUT: undefined,
			SESSION_TTL: undefined,
			OIDC_SCOPE: undefined,
			OIDC_USERNAME_CLAIM: undefined,
			SESSION_COOKIE_NAME: undefined,
			GP_API_URL: undefined,
			ENV_PRODUCT: undefined,
			LOG_LEVEL: undefined,
		});

		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.port).toBe(80);
			expect(custom.host).toBe('0.0.0.0');
			expect(custom.serverName).toBe('server');
			expect(custom.envProduct).toBe('development');
			expect(custom.logLevel).toBe('info');
			expect(custom.gp.apiUrl).toBe('https://api.globalping.io');
			expect(custom.gp.timeout).toBe(30_000);
			expect(custom.session.ttl).toBe(7 * 24 * 60 * 60);
			expect(custom.session.cookieName).toBe('pa_session');
			expect(custom.oidc.scope).toBe('openid profile email');
			expect(custom.oidc.usernameClaim).toBe('preferred_username');
		});
	});
});

describe('CONFIG 非法环境', () => {
	async function expectConfigFailure(env: Record<string, string>, message: string) {
		resetEnv(env);
		await jest.isolateModulesAsync(async () => {
			await expect(importConfig()).rejects.toThrow(message);
		});
	}

	it('SERVER_PORT 非数字时抛错', async () => {
		await expectConfigFailure({ SERVER_PORT: 'abc' }, 'Invalid port number: abc');
	});

	it('SERVER_PORT 越界时抛错', async () => {
		await expectConfigFailure({ SERVER_PORT: '70000' }, 'Invalid port number: 70000');
		await expectConfigFailure({ SERVER_PORT: '0' }, 'Invalid port number: 0');
		await expectConfigFailure({ SERVER_PORT: '-1' }, 'Invalid port number: -1');
	});

	it('GP_TIMEOUT 非法时抛错', async () => {
		await expectConfigFailure({ GP_TIMEOUT: 'abc' }, 'Invalid environment variable GP_TIMEOUT: abc');
		await expectConfigFailure({ GP_TIMEOUT: '0' }, 'Invalid environment variable GP_TIMEOUT: 0');
		await expectConfigFailure({ GP_TIMEOUT: '-100' }, 'Invalid environment variable GP_TIMEOUT: -100');
	});

	it('SESSION_TTL 非法时抛错', async () => {
		await expectConfigFailure({ SESSION_TTL: '-5' }, 'Invalid environment variable SESSION_TTL: -5');
		await expectConfigFailure({ SESSION_TTL: 'nope' }, 'Invalid environment variable SESSION_TTL: nope');
	});

	it('带默认值的变量被置空时回落到默认值（不抛错）', async () => {
		resetEnv({ ENV_PRODUCT: '' });
		await jest.isolateModulesAsync(async () => {
			const { CONFIG: custom } = await importConfig();
			expect(custom.envProduct).toBe('development');
		});
	});

	it('必需变量既无值也无默认值时抛错', async () => {
		// PROJECT_NAME 未设置时回落到 package.json 的 name，这里模拟包名缺失
		resetEnv({ PROJECT_NAME: undefined, TEST_PACKAGE_NAME: '-' });
		await jest.isolateModulesAsync(async () => {
			await expect(importConfig()).rejects.toThrow('Required environment variable PROJECT_NAME is not set');
		});
		resetEnv();
	});

	it('非法环境不会污染后续用例', async () => {
		resetEnv({ SERVER_PORT: 'abc' });
		await jest.isolateModulesAsync(async () => {
			await expect(importConfig()).rejects.toThrow('Invalid port number');
		});
		resetEnv();
		await jest.isolateModulesAsync(async () => {
			const { CONFIG: fresh } = await importConfig();
			expect(fresh.port).toBe(3001);
		});
	});
});

describe('resolveStaticDir', () => {
	it('解析到仓库 public 目录', () => {
		expect(resolveStaticDir()).toBe(path.join(projectRoot, 'public'));
		expect(resolveStaticDir().endsWith(`public${path.sep}`)).toBe(false);
	});

	it('STATIC_DIR 优先且被解析为绝对路径', async () => {
		resetEnv({ STATIC_DIR: 'relative/static' });
		await jest.isolateModulesAsync(async () => {
			const { resolveStaticDir: resolve } = await importConfig();
			expect(resolve()).toBe(path.resolve('relative/static'));
		});
	});

	it('运行入口同级的 public/ 存在时直接使用', async () => {
		jest.unstable_mockModule('node:fs', () => ({ ...nodeFs, existsSync: () => true }));
		resetEnv();
		await jest.isolateModulesAsync(async () => {
			const { resolveStaticDir: resolve } = await importConfig();
			const dir = resolve();
			expect(dir.endsWith(path.join('config', 'public'))).toBe(true);
		});
		jest.unstable_mockModule('node:fs', () => ({ ...nodeFs }));
	});

	it('任何 public/ 都找不到时抛出明确错误', async () => {
		jest.unstable_mockModule('node:fs', () => ({ ...nodeFs, existsSync: () => false }));
		resetEnv();
		await jest.isolateModulesAsync(async () => {
			const { resolveStaticDir: resolve } = await importConfig();
			expect(() => resolve()).toThrow('Cannot resolve static directory. Set STATIC_DIR explicitly.');
		});
		jest.unstable_mockModule('node:fs', () => ({ ...nodeFs }));
	});

	it('只找到 package.json 而没有 public/ 时同样抛错', async () => {
		jest.unstable_mockModule('node:fs', () => ({
			...nodeFs,
			existsSync: (target: string) => String(target).endsWith('package.json'),
		}));
		resetEnv();
		await jest.isolateModulesAsync(async () => {
			const { resolveStaticDir: resolve } = await importConfig();
			expect(() => resolve()).toThrow('Cannot resolve static directory. Set STATIC_DIR explicitly.');
		});
		jest.unstable_mockModule('node:fs', () => ({ ...nodeFs }));
	});
});
