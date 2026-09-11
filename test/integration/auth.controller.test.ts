import type { OidcParams } from '../../src/service/oidc';
import type { MockResponse } from '../helpers/http';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetEnv } from '../helpers/env';
import { createMockContext } from '../helpers/http';

const generateOidcParamsMock = jest.fn<() => Promise<OidcParams>>();
const buildAuthorizationUrlMock = jest.fn<(params: OidcParams) => Promise<string>>();
const exchangeCodeMock = jest.fn<(url: URL, params: OidcParams) => Promise<{ access_token?: string }>>();
const fetchUsernameMock = jest.fn<(tokens: unknown) => Promise<{ sub: string; username: string }>>();
const buildEndSessionMock = jest.fn<() => Promise<string | null>>();
let oidcEnabledValue = true;

jest.unstable_mockModule('../../src/service/oidc', () => ({
	buildAuthorizationUrlFromParams: buildAuthorizationUrlMock,
	buildEndSessionUrlForLogout: buildEndSessionMock,
	exchangeCodeAtCallback: exchangeCodeMock,
	fetchUsername: fetchUsernameMock,
	generateOidcParams: generateOidcParamsMock,
	getOidcConfig: jest.fn(),
	oidcEnabled: () => oidcEnabledValue,
}));

type AuthController = typeof import('../../src/controller/auth.controller');
type SessionModule = typeof import('../../src/utils/session');

/** 在隔离模块注册表中加载控制器与真实的会话模块（保证共用同一份 SESSION_SECRET） */
async function loadModules(env: Record<string, string> = {}): Promise<{ auth: AuthController['default']; session: SessionModule }> {
	let auth!: AuthController['default'];
	let session!: SessionModule;
	resetEnv({
		OIDC_ISSUER: 'https://idp.example.test',
		OIDC_CLIENT_ID: 'pingatlas',
		OIDC_CLIENT_SECRET: 'oidc-secret',
		OIDC_REDIRECT_URI: 'https://ping.example.test/api/auth/callback',
		...env,
	});
	await jest.isolateModulesAsync(async () => {
		auth = (await import('../../src/controller/auth.controller')).default;
		session = await import('../../src/utils/session');
	});
	return { auth, session };
}

function cookiesOf(res: MockResponse): string[] {
	const raw = res.getHeader('set-cookie');
	if (raw === undefined) {
		return [];
	}
	return Array.isArray(raw) ? raw : [raw];
}

function cookieNamed(res: MockResponse, name: string): string {
	const found = cookiesOf(res).find(cookie => cookie.startsWith(`${name}=`));
	if (!found) {
		throw new Error(`cookie ${name} not found in ${JSON.stringify(cookiesOf(res))}`);
	}
	return found;
}

/** 取出 Set-Cookie 的值部分 */
function valueOf(cookie: string): string {
	const rest = cookie.slice(cookie.indexOf('=') + 1);
	const end = rest.indexOf(';');
	return end === -1 ? rest : rest.slice(0, end);
}

const PARAMS: OidcParams = {
	state: 'state-123',
	codeVerifier: 'verifier-abc',
	codeChallenge: 'challenge-xyz',
};

beforeEach(() => {
	oidcEnabledValue = true;
	generateOidcParamsMock.mockResolvedValue(PARAMS);
	buildAuthorizationUrlMock.mockResolvedValue('https://idp.example.test/auth?state=state-123');
	exchangeCodeMock.mockResolvedValue({ access_token: 'at-1' });
	fetchUsernameMock.mockResolvedValue({ sub: 'user-1', username: 'alice' });
	buildEndSessionMock.mockResolvedValue(null);
});

afterEach(() => resetEnv());

describe('GET /api/auth/status', () => {
	it('未登录且未启用 OIDC', async () => {
		oidcEnabledValue = false;
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/status' });

		await auth.status(ctx);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ loggedIn: false, authEnabled: false, user: null });
	});

	it('启用 OIDC 时带出提供商名称', async () => {
		const { auth } = await loadModules({ OIDC_PROVIDER_NAME: 'Example SSO' });
		const { ctx, res } = createMockContext({ url: '/api/auth/status' });

		await auth.status(ctx);

		expect(JSON.parse(res.body)).toEqual({
			loggedIn: false,
			authEnabled: true,
			providerName: 'Example SSO',
			user: null,
		});
	});

	it('启用但未配置提供商名称时省略该字段', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/status' });

		await auth.status(ctx);

		expect(JSON.parse(res.body)).not.toHaveProperty('providerName');
	});

	it('已登录时返回用户名', async () => {
		oidcEnabledValue = false;
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({
			url: '/api/auth/status',
			user: { sub: 'user-1', username: 'alice' },
		});

		await auth.status(ctx);

		expect(JSON.parse(res.body)).toEqual({
			loggedIn: true,
			authEnabled: false,
			user: { username: 'alice' },
		});
	});

	it('ctx.user 结构不完整时视为未登录', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/status', user: 'garbage' });

		await auth.status(ctx);

		expect(JSON.parse(res.body).loggedIn).toBe(false);
	});
});

describe('GET /api/auth/login', () => {
	it('未配置 OIDC 时返回 503', async () => {
		oidcEnabledValue = false;
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/login' });

		await auth.login(ctx);

		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body)).toEqual({ error: 'OIDC is not configured on this server' });
		expect(buildAuthorizationUrlMock).not.toHaveBeenCalled();
	});

	it('跳转到授权地址并写入状态 Cookie', async () => {
		const { auth, session } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/login' });

		await auth.login(ctx);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('https://idp.example.test/auth?state=state-123');
		expect(buildAuthorizationUrlMock).toHaveBeenCalledWith(PARAMS);

		const cookie = cookieNamed(res, 'pa_oidc_state');
		expect(cookie).toContain('Max-Age=600');
		expect(cookie).toContain('Path=/');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('SameSite=Lax');
		await expect(session.verifyTransientToken(valueOf(cookie))).resolves.toMatchObject(PARAMS);
	});

	it('OIDC 发现失败时返回 500', async () => {
		const { auth } = await loadModules();
		generateOidcParamsMock.mockRejectedValueOnce(new Error('discovery failed'));
		const { ctx, res } = createMockContext({ url: '/api/auth/login' });

		await auth.login(ctx);

		expect(res.statusCode).toBe(500);
		expect(JSON.parse(res.body)).toEqual({ error: 'Failed to start OIDC login' });
	});
});

describe('GET /api/auth/callback', () => {
	it('缺少状态 Cookie 时回到首页并标记失败', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/callback?code=x&state=state-123' });

		await auth.callback(ctx);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/?login=failed');
		expect(cookieNamed(res, 'pa_oidc_state')).toContain('Max-Age=0');
		expect(exchangeCodeMock).not.toHaveBeenCalled();
	});

	it('状态 Cookie 无法验证时失败', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({
			url: '/api/auth/callback?code=x&state=state-123',
			headers: { cookie: 'pa_oidc_state=not-a-jwt' },
		});

		await auth.callback(ctx);

		expect(res.getHeader('location')).toBe('/?login=failed');
	});

	it('状态 Cookie 缺少必要字段时失败', async () => {
		const { auth, session } = await loadModules();
		const token = await session.signTransientToken({ state: 'state-123' }, 600);
		const { ctx, res } = createMockContext({
			url: '/api/auth/callback?code=x&state=state-123',
			headers: { cookie: `pa_oidc_state=${token}` },
		});

		await auth.callback(ctx);

		expect(res.getHeader('location')).toBe('/?login=failed');
		expect(exchangeCodeMock).not.toHaveBeenCalled();
	});

	it('成功换取会话并写入会话 Cookie', async () => {
		const { auth, session } = await loadModules();
		const token = await session.signTransientToken({ ...PARAMS }, 600);
		const { ctx, res } = createMockContext({
			url: '/api/auth/callback?code=auth-code&state=state-123',
			headers: { cookie: `pa_oidc_state=${token}` },
		});

		await auth.callback(ctx);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/');
		expect(exchangeCodeMock).toHaveBeenCalledTimes(1);
		const [currentUrl, params] = exchangeCodeMock.mock.calls[0]!;
		expect(currentUrl.href).toBe('https://ping.example.test/api/auth/callback?code=auth-code&state=state-123');
		expect(params).toEqual({ state: 'state-123', codeVerifier: 'verifier-abc', codeChallenge: '' });

		const sessionCookie = cookieNamed(res, 'pa_session');
		expect(sessionCookie).toContain('Max-Age=604800');
		await expect(session.verifySession(valueOf(sessionCookie))).resolves.toEqual({ sub: 'user-1', username: 'alice' });
		expect(cookieNamed(res, 'pa_oidc_state')).toContain('Max-Age=0');
	});

	it('Token 交换失败时回到失败提示', async () => {
		const { auth, session } = await loadModules();
		const token = await session.signTransientToken({ ...PARAMS }, 600);
		exchangeCodeMock.mockRejectedValueOnce(new Error('invalid_grant'));
		const { ctx, res } = createMockContext({
			url: '/api/auth/callback?code=bad&state=state-123',
			headers: { cookie: `pa_oidc_state=${token}` },
		});

		await auth.callback(ctx);

		expect(res.getHeader('location')).toBe('/?login=failed');
		expect(cookiesOf(res).some(cookie => cookie.startsWith('pa_session='))).toBe(false);
	});

	it('取用户信息失败时不写会话 Cookie', async () => {
		const { auth, session } = await loadModules();
		const token = await session.signTransientToken({ ...PARAMS }, 600);
		fetchUsernameMock.mockRejectedValueOnce(new Error('userinfo 500'));
		const { ctx, res } = createMockContext({
			url: '/api/auth/callback?code=x&state=state-123',
			headers: { cookie: `pa_oidc_state=${token}` },
		});

		await auth.callback(ctx);

		expect(res.getHeader('location')).toBe('/?login=failed');
	});

	it('req.url 缺失时以 redirectUri 为基准解析回调地址', async () => {
		const { auth, session } = await loadModules();
		const token = await session.signTransientToken({ ...PARAMS }, 600);
		const { ctx, res } = createMockContext({ headers: { cookie: `pa_oidc_state=${token}` } });
		ctx.req.url = undefined;

		await auth.callback(ctx);

		expect(exchangeCodeMock.mock.calls[0]![0].href).toBe('https://ping.example.test/');
		expect(res.getHeader('location')).toBe('/');
	});
});

describe('GET /api/auth/logout', () => {
	it('清除本地会话并回到首页', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/logout' });

		await auth.logout(ctx);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/');
		const cookie = cookieNamed(res, 'pa_session');
		expect(cookie).toContain('Max-Age=0');
		expect(cookie).toContain('HttpOnly');
		expect(buildEndSessionMock).not.toHaveBeenCalled();
	});

	it('req.url 缺失时清除会话并回到首页', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/logout' });
		(ctx.req as unknown as { url?: string }).url = undefined;

		await auth.logout(ctx);

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/');
		expect(cookieNamed(res, 'pa_session')).toContain('Max-Age=0');
	});

	it('sso=1 且 IdP 支持时跳转统一登出', async () => {
		const { auth } = await loadModules();
		buildEndSessionMock.mockResolvedValueOnce('https://idp.example.test/logout?id_token_hint=x');
		const { ctx, res } = createMockContext({ url: '/api/auth/logout?sso=1' });

		await auth.logout(ctx);

		expect(res.getHeader('location')).toBe('https://idp.example.test/logout?id_token_hint=x');
		expect(cookieNamed(res, 'pa_session')).toContain('Max-Age=0');
	});

	it('IdP 无 end_session_endpoint 时退化为本地登出', async () => {
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/logout?sso=1' });

		await auth.logout(ctx);

		expect(res.getHeader('location')).toBe('/');
	});

	it('统一登出地址构建失败时仍然完成本地登出', async () => {
		const { auth } = await loadModules();
		buildEndSessionMock.mockRejectedValueOnce(new Error('discovery down'));
		const { ctx, res } = createMockContext({ url: '/api/auth/logout?sso=1' });

		await auth.logout(ctx);

		expect(res.getHeader('location')).toBe('/');
		expect(cookieNamed(res, 'pa_session')).toContain('Max-Age=0');
	});

	it('未配置 OIDC 时忽略 sso 参数', async () => {
		oidcEnabledValue = false;
		const { auth } = await loadModules();
		const { ctx, res } = createMockContext({ url: '/api/auth/logout?sso=1' });

		await auth.logout(ctx);

		expect(buildEndSessionMock).not.toHaveBeenCalled();
		expect(res.getHeader('location')).toBe('/');
	});
});

describe('Cookie 安全属性', () => {
	it('测试环境不带 Secure', async () => {
		const { auth } = await loadModules({ ENV_PRODUCT: 'test' });
		const { ctx, res } = createMockContext({ url: '/api/auth/login' });

		await auth.login(ctx);

		expect(cookieNamed(res, 'pa_oidc_state')).not.toContain('Secure');
	});

	it('生产环境写入 Secure', async () => {
		const { auth } = await loadModules({ ENV_PRODUCT: 'production' });
		const { ctx, res } = createMockContext({ url: '/api/auth/login' });

		await auth.login(ctx);

		expect(cookieNamed(res, 'pa_oidc_state')).toContain('Secure');
	});
});
