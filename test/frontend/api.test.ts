/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const DEFAULT_CONFIG = {
	apiUrl: 'https://api.globalping.io',
	proxyAvailable: false,
	maxProbes: { direct: 50, proxy: 500 },
};

type ApiModule = typeof import('../../src/frontend/api');

function jsonResponse(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	const status = init.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(init.headers),
		json: async () => payload,
	} as unknown as Response;
}

function textResponse(status: number, body = 'not json'): Response {
	return {
		ok: false,
		status,
		headers: new Headers(),
		json: async () => {
			throw new SyntaxError('Unexpected token');
		},
		text: async () => body,
	} as unknown as Response;
}

beforeEach(() => {
	// api.ts 有模块级缓存，resetModules 后每个用例拿到全新实例
	jest.resetModules();
});

async function freshApi(): Promise<ApiModule> {
	return import('../../src/frontend/api');
}

/** loadConfig 用默认配置响应，其余路径返回给定载荷 */
function fetchWithConfig(handler: (url: string, init?: RequestInit) => Response): jest.Mock {
	const mock = jest.fn(async (url: string, init?: RequestInit) => (
		url === '/api/config' ? jsonResponse(DEFAULT_CONFIG) : handler(url, init)
	));
	globalThis.fetch = mock as unknown as typeof fetch;
	return mock;
}

describe('loadConfig', () => {
	it('成功时返回后端配置', async () => {
		const payload = { apiUrl: 'https://example.test', proxyAvailable: true, maxProbes: { direct: 50, proxy: 500 } };
		const fetchMock = jest.fn(async () => jsonResponse(payload)) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const api = await freshApi();
		await expect(api.loadConfig()).resolves.toEqual(payload);
		expect((fetchMock as unknown as jest.Mock).mock.calls[0][0]).toBe('/api/config');
	});

	it('失败时回退内置默认配置', async () => {
		globalThis.fetch = jest.fn(async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		const api = await freshApi();
		const config = await api.loadConfig();
		expect(config.apiUrl).toBe('https://api.globalping.io');
		expect(config.proxyAvailable).toBe(false);
		expect(config.maxProbes).toEqual({ direct: 50, proxy: 500 });
	});

	it('非 2xx 也回退默认配置', async () => {
		globalThis.fetch = jest.fn(async () => textResponse(500)) as unknown as typeof fetch;
		const api = await freshApi();
		await expect(api.loadConfig()).resolves.toEqual(DEFAULT_CONFIG);
	});

	it('并发调用只发起一次请求（单飞）', async () => {
		const fetchMock = jest.fn(async () => jsonResponse(DEFAULT_CONFIG)) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const api = await freshApi();
		await Promise.all([api.loadConfig(), api.loadConfig(), api.loadConfig()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('成功结果被缓存，后续调用不再请求', async () => {
		const fetchMock = jest.fn(async () => jsonResponse(DEFAULT_CONFIG)) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const api = await freshApi();
		await api.loadConfig();
		await api.loadConfig();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('请求未完成时 getConfig 返回兜底配置', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		const api = await freshApi();
		expect(api.getConfig().apiUrl).toBe('https://api.globalping.io');
	});
});

describe('directFetch / proxyFetch', () => {
	it('directFetch 拼接上游地址', async () => {
		const fetchMock = fetchWithConfig(() => jsonResponse({}));
		const api = await freshApi();
		await api.loadConfig();
		await api.directFetch('/v1/limits', { headers: { Accept: 'application/json' } });
		expect(fetchMock.mock.calls.at(-1)).toEqual([
			'https://api.globalping.io/v1/limits',
			{ headers: { Accept: 'application/json' } },
		]);
	});

	it('proxyFetch 走同源 /api 前缀', async () => {
		const fetchMock = fetchWithConfig(() => jsonResponse({}));
		const api = await freshApi();
		await api.proxyFetch('/v1/limits');
		expect(fetchMock.mock.calls.at(-1)).toEqual(['/api/v1/limits', undefined]);
	});

	it('配置加载后 directFetch 使用后端下发的 apiUrl', async () => {
		globalThis.fetch = jest.fn(async (url: string) => jsonResponse(
			url === '/api/config'
				? { apiUrl: 'https://mirror.test', proxyAvailable: true, maxProbes: { direct: 10, proxy: 20 } }
				: {},
		)) as unknown as typeof fetch;
		const api = await freshApi();
		await api.loadConfig();
		expect(api.getConfig().apiUrl).toBe('https://mirror.test');
		await api.directFetch('/x');
		expect((globalThis.fetch as unknown as jest.Mock).mock.calls.at(-1)).toEqual(['https://mirror.test/x', undefined]);
	});
});

describe('ApiError', () => {
	it('保留状态码、错误类型与参数', async () => {
		const api = await freshApi();
		const error = new api.ApiError('boom', 429, 'too_many_requests', { limit: '60' }, new Headers({ a: 'b' }));
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('ApiError');
		expect(error.message).toBe('boom');
		expect(error.status).toBe(429);
		expect(error.type).toBe('too_many_requests');
		expect(error.params).toEqual({ limit: '60' });
		expect(error.headers.get('a')).toBe('b');
	});

	it('默认参数为零状态码与空集合', async () => {
		const api = await freshApi();
		const error = new api.ApiError('x');
		expect(error.status).toBe(0);
		expect(error.type).toBe('');
		expect(error.params).toEqual({});
		expect([...error.headers.entries()]).toEqual([]);
	});
});

describe('apiJson', () => {
	it('2xx 返回解析后的 JSON', async () => {
		const fetchMock = fetchWithConfig(() => jsonResponse({ loggedIn: false }));
		const api = await freshApi();
		await expect(api.apiJson('/auth/status')).resolves.toEqual({ loggedIn: false });
		expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/auth/status');
	});

	it('204 返回 undefined', async () => {
		fetchWithConfig(() => jsonResponse(null, { status: 204 }));
		const api = await freshApi();
		await expect(api.apiJson('/auth/logout')).resolves.toBeUndefined();
	});

	it('非 2xx 抛出带上游信息的 ApiError', async () => {
		fetchWithConfig(() => jsonResponse(
			{ error: { type: 'validation_error', message: 'Bad input', params: { target: 'invalid' } } },
			{ status: 400, headers: { 'X-RateLimit-Limit': '60' } },
		));
		const api = await freshApi();
		const error = await api.apiJson('/v1/measurements').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(api.ApiError);
		const apiError = error as InstanceType<ApiModule['ApiError']>;
		expect(apiError.status).toBe(400);
		expect(apiError.type).toBe('validation_error');
		expect(apiError.message).toBe('Bad input');
		expect(apiError.params).toEqual({ target: 'invalid' });
		expect(apiError.headers.get('X-RateLimit-Limit')).toBe('60');
	});

	it('错误体不是 JSON 时回退到 HTTP 状态文案', async () => {
		fetchWithConfig(() => textResponse(500));
		const api = await freshApi();
		const error = (await api.apiJson('/x').catch((e: unknown) => e)) as InstanceType<ApiModule['ApiError']>;
		expect(error).toBeInstanceOf(api.ApiError);
		expect(error.status).toBe(500);
		expect(error.message).toBe('HTTP 500');
		expect(error.type).toBe('');
	});
});

describe('readUpstream', () => {
	it('成功时返回数据与响应头', async () => {
		const api = await freshApi();
		const res = jsonResponse({ body: { id: 'abc' } }, { headers: { 'X-RateLimit-Remaining': '9' } });
		const { data, headers } = await api.readUpstream<{ body: { id: string } }>(res);
		expect(data.body.id).toBe('abc');
		expect(headers.get('X-RateLimit-Remaining')).toBe('9');
	});

	it('失败时抛 ApiError 并保留限额头（供额度条使用）', async () => {
		const api = await freshApi();
		const res = jsonResponse(
			{ error: { type: 'too_many_requests', message: 'rate limited' } },
			{ status: 429, headers: { 'X-RateLimit-Remaining': '0', 'Retry-After': '120' } },
		);
		const error = (await api.readUpstream(res).catch((e: unknown) => e)) as InstanceType<ApiModule['ApiError']>;
		expect(error).toBeInstanceOf(api.ApiError);
		expect(error.status).toBe(429);
		expect(error.type).toBe('too_many_requests');
		expect(error.headers.get('X-RateLimit-Remaining')).toBe('0');
		expect(error.headers.get('Retry-After')).toBe('120');
	});
});

describe('loadAuthStatus / onAuthChange', () => {
	it('成功时写入登录态', async () => {
		fetchWithConfig(() => jsonResponse({ loggedIn: true, authEnabled: true, user: { username: 'alice' } }));
		const api = await freshApi();
		const status = await api.loadAuthStatus();
		expect(status.loggedIn).toBe(true);
		expect(api.isLoggedIn()).toBe(true);
		expect(api.getAuthStatus().user).toEqual({ username: 'alice' });
	});

	it('首次 401 时自动重试一次', async () => {
		let call = 0;
		const fetchMock = fetchWithConfig(() => {
			call += 1;
			if (call === 1) {
				return jsonResponse({ error: { type: 'unauthorized', message: 'no session' } }, { status: 401 });
			}
			return jsonResponse({ loggedIn: true, authEnabled: true, user: { username: 'bob' } });
		});
		const api = await freshApi();
		const status = await api.loadAuthStatus();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(status.loggedIn).toBe(true);
	});

	it('两次 401 都失败时回退未登录', async () => {
		const fetchMock = fetchWithConfig(() => jsonResponse({}, { status: 401 }));
		const api = await freshApi();
		const status = await api.loadAuthStatus();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(status).toEqual({ loggedIn: false, authEnabled: false, user: null });
		expect(api.isLoggedIn()).toBe(false);
	});

	it('非 401 错误不重试', async () => {
		const fetchMock = fetchWithConfig(() => jsonResponse({}, { status: 500 }));
		const api = await freshApi();
		await api.loadAuthStatus();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('onAuthChange 立即回调一次并可退订', async () => {
		fetchWithConfig(() => jsonResponse({ loggedIn: true, authEnabled: true, user: { username: 'alice' } }));
		const api = await freshApi();
		const listener = jest.fn();
		const off = api.onAuthChange(listener);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenLastCalledWith({ loggedIn: false, authEnabled: false, user: null });

		await api.loadAuthStatus();
		expect(listener).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ loggedIn: true }));

		off();
		await api.loadAuthStatus();
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
