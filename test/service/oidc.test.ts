import type { OidcParams } from '../../src/service/oidc';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetEnv } from '../helpers/env';

/** 伪 IdP 的 serverMetadata，供 buildEndSessionUrl 桩读取 */
let serverMetadata: { end_session_endpoint?: string } = { end_session_endpoint: 'https://idp.example.test/logout' };

const discoveryMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const randomStateMock = jest.fn<() => string>();
const randomVerifierMock = jest.fn<() => string>();
const challengeMock = jest.fn<(verifier: string) => Promise<string>>();
const buildAuthUrlMock = jest.fn<(config: unknown, params: unknown) => URL>();
const codeGrantMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const userInfoMock = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const buildEndSessionMock = jest.fn<(config: unknown, params?: unknown) => URL>();

jest.unstable_mockModule('openid-client', () => ({
	authorizationCodeGrant: codeGrantMock,
	buildAuthorizationUrl: buildAuthUrlMock,
	buildEndSessionUrl: buildEndSessionMock,
	calculatePKCECodeChallenge: challengeMock,
	discovery: discoveryMock,
	fetchUserInfo: userInfoMock,
	randomPKCECodeVerifier: randomVerifierMock,
	randomState: randomStateMock,
	skipSubjectCheck: Symbol('skipSubjectCheck'),
}));

const OIDC_ENV = {
	OIDC_ISSUER: 'https://idp.example.test',
	OIDC_CLIENT_ID: 'pingatlas',
	OIDC_CLIENT_SECRET: 'oidc-secret',
	OIDC_REDIRECT_URI: 'https://ping.example.test/api/auth/callback',
};

type OidcService = typeof import('../../src/service/oidc');

/** 每次重新求值模块（清掉 cachedConfig），返回全新的 service 命名空间 */
async function freshOidc(env: Record<string, string | undefined> = OIDC_ENV): Promise<OidcService> {
	resetEnv(env);
	let service!: OidcService;
	await jest.isolateModulesAsync(async () => {
		service = await import('../../src/service/oidc');
	});
	return service;
}

beforeEach(() => {
	serverMetadata = { end_session_endpoint: 'https://idp.example.test/logout' };
	discoveryMock.mockImplementation(async () => ({ serverMetadata: () => serverMetadata }));
	randomStateMock.mockReturnValue('state-1');
	randomVerifierMock.mockReturnValue('verifier-1');
	challengeMock.mockResolvedValue('challenge-1');
	buildAuthUrlMock.mockImplementation(() => new URL('https://idp.example.test/authorize?state=state-1'));
	codeGrantMock.mockResolvedValue({ access_token: 'at-1', id_token: 'it-1', claims: () => ({ sub: 'sub-1' }) });
	userInfoMock.mockResolvedValue({ sub: 'sub-1', preferred_username: 'alice' });
	buildEndSessionMock.mockImplementation(() => new URL('https://idp.example.test/logout'));
});

afterEach(() => resetEnv());

describe('oidcEnabled', () => {
	it('四项配置齐全时为 true', async () => {
		const { oidcEnabled } = await freshOidc();
		expect(oidcEnabled()).toBe(true);
	});

	it.each([
		['OIDC_ISSUER'],
		['OIDC_CLIENT_ID'],
		['OIDC_CLIENT_SECRET'],
		['OIDC_REDIRECT_URI'],
	])('缺少 %s 时为 false', async (key) => {
		const { oidcEnabled } = await freshOidc({ ...OIDC_ENV, [key]: '' });
		expect(oidcEnabled()).toBe(false);
	});

	it('完全未配置时为 false', async () => {
		const { oidcEnabled } = await freshOidc({
			OIDC_ISSUER: '',
			OIDC_CLIENT_ID: '',
			OIDC_CLIENT_SECRET: '',
			OIDC_REDIRECT_URI: '',
		});
		expect(oidcEnabled()).toBe(false);
	});
});

describe('getOidcConfig', () => {
	it('首次调用做 discovery 并缓存结果', async () => {
		const { getOidcConfig } = await freshOidc();

		const first = await getOidcConfig();
		const second = await getOidcConfig();

		expect(first).toBe(second);
		expect(discoveryMock).toHaveBeenCalledTimes(1);
		const [issuer, clientId, clientSecret] = discoveryMock.mock.calls[0]!;
		expect((issuer as URL).href).toBe('https://idp.example.test/');
		expect(clientId).toBe('pingatlas');
		expect(clientSecret).toBe('oidc-secret');
	});

	it('discovery 失败时向上抛出，且不缓存失败结果', async () => {
		const { getOidcConfig } = await freshOidc();
		discoveryMock.mockRejectedValueOnce(new Error('issuer unreachable'));

		await expect(getOidcConfig()).rejects.toThrow('issuer unreachable');
		discoveryMock.mockResolvedValueOnce({ serverMetadata: () => serverMetadata });
		await expect(getOidcConfig()).resolves.toBeDefined();
	});
});

describe('generateOidcParams', () => {
	it('返回 state 与 S256 PKCE 三件套', async () => {
		const { generateOidcParams } = await freshOidc();

		await expect(generateOidcParams()).resolves.toEqual({
			state: 'state-1',
			codeVerifier: 'verifier-1',
			codeChallenge: 'challenge-1',
		});
		expect(challengeMock).toHaveBeenCalledWith('verifier-1');
	});
});

describe('buildAuthorizationUrlFromParams', () => {
	it('带上 redirect_uri / scope / S256 / state', async () => {
		const { buildAuthorizationUrlFromParams } = await freshOidc();
		const params: OidcParams = { state: 'state-9', codeVerifier: 'v', codeChallenge: 'c-9' };

		const url = await buildAuthorizationUrlFromParams(params);

		expect(url).toBe('https://idp.example.test/authorize?state=state-1');
		expect(buildAuthUrlMock).toHaveBeenCalledTimes(1);
		expect(buildAuthUrlMock.mock.calls[0]![1]).toEqual({
			redirect_uri: 'https://ping.example.test/api/auth/callback',
			scope: 'openid profile email',
			code_challenge: 'c-9',
			code_challenge_method: 'S256',
			state: 'state-9',
		});
	});

	it('自定义 scope 生效', async () => {
		const { buildAuthorizationUrlFromParams } = await freshOidc({ ...OIDC_ENV, OIDC_SCOPE: 'openid email groups' });

		await buildAuthorizationUrlFromParams({ state: 's', codeVerifier: 'v', codeChallenge: 'c' });

		expect((buildAuthUrlMock.mock.calls[0]![1] as { scope: string }).scope).toBe('openid email groups');
	});
});

describe('exchangeCodeAtCallback', () => {
	it('把 pkceCodeVerifier 与 expectedState 交给授权码流', async () => {
		const { exchangeCodeAtCallback } = await freshOidc();
		const currentUrl = new URL('https://ping.example.test/api/auth/callback?code=abc&state=state-1');

		const tokens = await exchangeCodeAtCallback(currentUrl, {
			state: 'state-1',
			codeVerifier: 'verifier-1',
			codeChallenge: 'challenge-1',
		});

		expect(tokens).toEqual({ access_token: 'at-1', id_token: 'it-1', claims: expect.any(Function) });
		expect(codeGrantMock).toHaveBeenCalledWith(
			expect.anything(),
			currentUrl,
			{ pkceCodeVerifier: 'verifier-1', expectedState: 'state-1' },
		);
	});

	it('授权码流报错时向上抛出', async () => {
		const { exchangeCodeAtCallback } = await freshOidc();
		codeGrantMock.mockRejectedValueOnce(new Error('invalid_grant'));

		await expect(exchangeCodeAtCallback(new URL('https://ping.example.test/cb?code=bad'), {
			state: 'state-1',
			codeVerifier: 'verifier-1',
			codeChallenge: 'challenge-1',
		})).rejects.toThrow('invalid_grant');
	});
});

describe('fetchUsername', () => {
	it('优先使用 userinfo 的 preferred_username', async () => {
		const { fetchUsername } = await freshOidc();

		await expect(fetchUsername({ access_token: 'at-1', claims: () => ({ sub: 'sub-1' }) } as any)).resolves.toEqual({
			sub: 'sub-1',
			username: 'alice',
		});
		expect(userInfoMock).toHaveBeenCalledWith(expect.anything(), 'at-1', 'sub-1');
	});

	it('自定义用户名 claim 优先于 preferred_username', async () => {
		const { fetchUsername } = await freshOidc({ ...OIDC_ENV, OIDC_USERNAME_CLAIM: 'email' });
		userInfoMock.mockResolvedValue({ sub: 'sub-1', email: 'a@example.test', preferred_username: 'alice' });

		await expect(fetchUsername({ access_token: 'at-1', claims: () => ({ sub: 'sub-1' }) } as any)).resolves.toMatchObject({
			username: 'a@example.test',
		});
	});

	it('claim 链回退：preferred_username → name → nickname', async () => {
		const { fetchUsername } = await freshOidc();
		userInfoMock.mockResolvedValue({ sub: 'sub-1', name: 'Alice Wang' });
		await expect(fetchUsername({ access_token: 'at-1' } as any)).resolves.toMatchObject({ username: 'Alice Wang' });

		userInfoMock.mockResolvedValue({ sub: 'sub-1', nickname: 'alicew' });
		await expect(fetchUsername({ access_token: 'at-1' } as any)).resolves.toMatchObject({ username: 'alicew' });
	});

	it('空白字符串不会命中 claim 链', async () => {
		const { fetchUsername } = await freshOidc();
		userInfoMock.mockResolvedValue({ sub: 'sub-1', preferred_username: '   ', name: 'Alice' });

		await expect(fetchUsername({ access_token: 'at-1' } as any)).resolves.toMatchObject({ username: 'Alice' });
	});

	it('userinfo 失败时回退到 id_token claims', async () => {
		const { fetchUsername } = await freshOidc();
		userInfoMock.mockRejectedValue(new Error('userinfo 500'));

		await expect(fetchUsername({
			access_token: 'at-1',
			claims: () => ({ sub: 'sub-9', preferred_username: 'bob' }),
		} as any)).resolves.toEqual({ sub: 'sub-9', username: 'bob' });
	});

	it('userinfo 无可用 claim 时回退到 id_token claims', async () => {
		const { fetchUsername } = await freshOidc();
		userInfoMock.mockResolvedValue({ sub: 'sub-1' });

		await expect(fetchUsername({
			access_token: 'at-1',
			claims: () => ({ sub: 'sub-1', name: 'Alice' }),
		} as any)).resolves.toMatchObject({ username: 'Alice' });
	});

	it('没有 access_token 时直接用 id_token claims', async () => {
		const { fetchUsername } = await freshOidc();

		await expect(fetchUsername({ claims: () => ({ sub: 'sub-2', nickname: 'carol' }) } as any)).resolves.toEqual({
			sub: 'sub-2',
			username: 'carol',
		});
		expect(userInfoMock).not.toHaveBeenCalled();
	});

	it('userinfo 与 claims 都不可用时用 sub 兜底', async () => {
		const { fetchUsername } = await freshOidc();
		userInfoMock.mockResolvedValue({});

		await expect(fetchUsername({ access_token: 'at-1', claims: () => ({ sub: 'sub-3' }) } as any)).resolves.toEqual({
			sub: 'sub-3',
			username: 'sub-3',
		});
	});

	it('完全没有信息时返回 unknown', async () => {
		const { fetchUsername } = await freshOidc();

		await expect(fetchUsername({} as any)).resolves.toEqual({ sub: 'unknown', username: 'unknown' });
	});

	it('claims() 抛错会向上传播（由调用方兜底）', async () => {
		const { fetchUsername } = await freshOidc();
		userInfoMock.mockResolvedValue({ preferred_username: 'dave' });

		await expect(fetchUsername({
			access_token: 'at-1',
			claims: () => {
				throw new Error('bad id_token');
			},
		} as any)).rejects.toThrow('bad id_token');
	});
});

describe('buildEndSessionUrlForLogout', () => {
	it('IdP 提供 end_session_endpoint 时返回地址', async () => {
		const { buildEndSessionUrlForLogout } = await freshOidc();

		await expect(buildEndSessionUrlForLogout()).resolves.toBe('https://idp.example.test/logout');
	});

	it('未提供 end_session_endpoint 时返回 null', async () => {
		const { buildEndSessionUrlForLogout } = await freshOidc();
		serverMetadata = {};

		await expect(buildEndSessionUrlForLogout()).resolves.toBeNull();
		expect(buildEndSessionMock).not.toHaveBeenCalled();
	});

	it('默认使用 redirectUri 的站点根作为 post_logout_redirect_uri', async () => {
		const { buildEndSessionUrlForLogout } = await freshOidc();

		await buildEndSessionUrlForLogout();

		expect(buildEndSessionMock.mock.calls[0]![1]).toEqual({ post_logout_redirect_uri: 'https://ping.example.test/' });
	});

	it('显式配置 OIDC_POST_LOGOUT_REDIRECT_URI 时优先使用', async () => {
		const { buildEndSessionUrlForLogout } = await freshOidc({
			...OIDC_ENV,
			OIDC_POST_LOGOUT_REDIRECT_URI: 'https://ping.example.test/logged-out',
		});

		await buildEndSessionUrlForLogout();

		expect(buildEndSessionMock.mock.calls[0]![1]).toEqual({
			post_logout_redirect_uri: 'https://ping.example.test/logged-out',
		});
	});

	it('回跳地址不可用时省略参数', async () => {
		const { buildEndSessionUrlForLogout } = await freshOidc({ ...OIDC_ENV, OIDC_REDIRECT_URI: 'not-a-url' });

		await buildEndSessionUrlForLogout();

		expect(buildEndSessionMock.mock.calls[0]![1]).toBeUndefined();
	});
});
