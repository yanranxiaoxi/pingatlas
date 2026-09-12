import type { AddressInfo } from 'node:net';
import type { VenNodeDriver } from '../../src/utils/venation/driver';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { PROBE_LIST_URL } from '../../src/frontend/probes';
import { resetEnv } from '../helpers/env';
import { publicDir } from '../helpers/paths';

interface TestServer {
	baseUrl: string;
	session: typeof import('../../src/utils/session');
	close: () => Promise<void>;
}

/** 用真实的 node:http 驱动 + 真实路由器启动一个监听随机端口的实例 */
async function startServer(env: Record<string, string | undefined> = {}): Promise<TestServer> {
	let driver!: VenNodeDriver;
	let session!: typeof import('../../src/utils/session');
	resetEnv({ STATIC_DIR: publicDir, GP_TOKEN: '', ...env });
	await jest.isolateModulesAsync(async () => {
		const { Venation } = await import('../../src/utils/venation');
		const { VenNodeDriver: Driver } = await import('../../src/utils/venation/driver');
		const logger = (await import('../../src/utils/logger')).default;
		const venRouter = (await import('../../src/router')).default;
		session = await import('../../src/utils/session');

		driver = new Driver(logger);
		const venation = new Venation(logger);
		venation.addDriver(driver);
		await venRouter(venation);
		await new Promise<void>((resolve) => {
			driver.server.listen(0, '127.0.0.1', () => resolve());
		});
	});

	const address = driver.server.address() as AddressInfo | null;
	if (!address) {
		throw new Error('server did not bind a port');
	}

	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		session,
		close: () => new Promise<void>((resolve) => {
			driver.server.close(() => resolve());
		}),
	};
}

describe('端到端 HTTP 服务（未配置服务端令牌）', () => {
	let server: TestServer;
	let sessionCookie: string;

	beforeAll(async () => {
		server = await startServer();
		sessionCookie = `pa_session=${await server.session.signSession({ sub: 'u1', username: 'e2e' })}`;
	});

	afterAll(async () => {
		await server.close();
		resetEnv();
	});

	it('GET /api/config 返回前端配置且不含机密', async () => {
		const res = await fetch(`${server.baseUrl}/api/config`);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		const body = await res.json() as Record<string, unknown>;
		expect(body).toEqual({
			apiUrl: 'http://127.0.0.1:1',
			proxyAvailable: false,
			maxProbes: { direct: 50, proxy: 500 },
		});
		expect(JSON.stringify(body)).not.toMatch(/token/i);
	});

	it('GET /api/auth/status 未配置 OIDC 且未登录', async () => {
		const res = await fetch(`${server.baseUrl}/api/auth/status`);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ loggedIn: false, authEnabled: false, user: null });
	});

	it('携带会话 Cookie 时 status 反映登录态（会话中间件 + Cookie 解析端到端）', async () => {
		const res = await fetch(`${server.baseUrl}/api/auth/status`, {
			headers: { cookie: sessionCookie },
		});

		expect(await res.json()).toEqual({
			loggedIn: true,
			authEnabled: false,
			user: { username: 'e2e' },
		});
	});

	it('伪造的会话 Cookie 不产生 500，仅视为未登录', async () => {
		const res = await fetch(`${server.baseUrl}/api/auth/status`, {
			headers: { cookie: 'pa_session=forged.jwt.value' },
		});

		expect(res.status).toBe(200);
		expect((await res.json() as { loggedIn: boolean }).loggedIn).toBe(false);
	});

	it('缺少服务端令牌时代理接口返回 503', async () => {
		for (const [method, path] of [['GET', '/api/limits'], ['GET', '/api/measurements/m-1'], ['POST', '/api/measurements']] as const) {
			const res = await fetch(`${server.baseUrl}${path}`, { method, headers: { cookie: sessionCookie } });
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({
				error: { type: 'proxy_unavailable', message: 'Server token is not configured' },
			});
		}
	});

	/**
	 * 回归护栏：前端代理路径与后端路由必须一致。
	 *
	 * `proxyFetch` 的调用方传的是上游路径（`/v1/...`），若忘了去掉 `/v1` 版本段，
	 * 浏览器就会请求不存在的 `/api/v1/*` 并拿到 404——表现为左下角公共账号额度
	 * 「不可用」、且每次测量都报「未找到该测量记录」。这里用真实的 proxyFetch
	 * 生成路径，再打到真实服务器上，确保两侧不会再次各自漂移。
	 */
	it('前端 proxyFetch 生成的代理路径都能命中后端路由（不出现 404）', async () => {
		const realFetch = globalThis.fetch;
		const produced: Array<{ path: string; method: string }> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			produced.push({ path: String(input), method: init?.method ?? 'GET' });
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		try {
			const { proxyFetch } = await import('../../src/frontend/api');
			await proxyFetch('/v1/limits');
			await proxyFetch('/v1/measurements', { method: 'POST' });
			await proxyFetch('/v1/measurements/mid-1');
		}
		finally {
			globalThis.fetch = realFetch;
		}

		expect(produced).toEqual([
			{ path: '/api/limits', method: 'GET' },
			{ path: '/api/measurements', method: 'POST' },
			{ path: '/api/measurements/mid-1', method: 'GET' },
		]);
		for (const { path, method } of produced) {
			const res = await realFetch(`${server.baseUrl}${path}`, { method, headers: { cookie: sessionCookie } });
			// 未配置令牌时为 503，路由不存在时才是 404
			expect(res.status).not.toBe(404);
		}
	});

	it('GET /api/probes 无需登录，上游不可达时返回 502 而非 503', async () => {
		const res = await fetch(`${server.baseUrl}/api/probes`);

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({
			error: { type: 'upstream_error', message: 'Globalping API is unreachable' },
		});
	});

	it('GET /api/probe-list 与 /api/probes 同样无需登录', async () => {
		const res = await fetch(`${server.baseUrl}/api/probe-list`);

		expect(res.status).toBe(502);
		expect(await res.json()).toEqual({
			error: { type: 'upstream_error', message: 'Globalping API is unreachable' },
		});
	});

	it('前端 probes 模块请求的路径能命中后端路由（不出现 404）', async () => {
		const realFetch = globalThis.fetch;
		let requested = '';
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested = String(input);
			// 返回空数组，让 loadProbeList 走完正常分支
			return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
		}) as typeof fetch;
		try {
			const probes = await import('../../src/frontend/probes');
			probes.resetProbeListCache();
			await probes.loadProbeList();
		}
		finally {
			globalThis.fetch = realFetch;
		}

		expect(requested).toBe(PROBE_LIST_URL);
		// 路由存在（上游不可达是 502），只有路径写错才会是 404
		const res = await realFetch(`${server.baseUrl}${requested}`);
		expect(res.status).not.toBe(404);
	});

	it('未配置 OIDC 时 /api/auth/login 返回 503', async () => {
		const res = await fetch(`${server.baseUrl}/api/auth/login`);

		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: 'OIDC is not configured on this server' });
	});

	it('GET / 返回首页 HTML 且不缓存', async () => {
		const res = await fetch(`${server.baseUrl}/`);

		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/html');
		expect(res.headers.get('cache-control')).toBe('no-cache');
		expect(await res.text()).toMatch(/<!doctype html>/i);
	});

	it('Service Worker 与语言包可被静态服务命中', async () => {
		const sw = await fetch(`${server.baseUrl}/sw.js`);
		expect(sw.status).toBe(200);
		expect(sw.headers.get('content-type')).toContain('javascript');
		expect(sw.headers.get('cache-control')).toBe('no-cache');

		const locale = await fetch(`${server.baseUrl}/locales/zh-Hans.json`);
		expect(locale.status).toBe(200);
		expect(locale.headers.get('content-type')).toContain('application/json');
		expect(Object.keys(await locale.json() as object).length).toBeGreaterThan(100);
	});

	it('图标走长缓存', async () => {
		const res = await fetch(`${server.baseUrl}/icons/icon-192.png`);

		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
	});

	it('不存在的静态路径返回 404 纯文本', async () => {
		const res = await fetch(`${server.baseUrl}/definitely-missing-page`);

		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('text/plain');
		expect(await res.text()).toBe('404 Not Found');
	});

	it('未知 API 与错误方法返回 404', async () => {
		const unknown = await fetch(`${server.baseUrl}/api/unknown`);
		expect(unknown.status).toBe(404);

		const wrongMethod = await fetch(`${server.baseUrl}/api/config`, { method: 'POST' });
		expect(wrongMethod.status).toBe(404);

		const nested = await fetch(`${server.baseUrl}/api/auth/unknown`);
		expect(nested.status).toBe(404);
	});

	it('trace 中间件回显 x-request-id，缺失时自动生成', async () => {
		const echoed = await fetch(`${server.baseUrl}/api/config`, { headers: { 'x-request-id': 'trace-e2e-1' } });
		expect(echoed.headers.get('x-request-id')).toBe('trace-e2e-1');

		const generated = await fetch(`${server.baseUrl}/api/config`);
		expect(generated.headers.get('x-request-id')).toMatch(/^TraceId:[\w-]{8,}$/);
	});
});

describe('端到端 HTTP 服务（已配置服务端令牌，模拟上游）', () => {
	let server: TestServer;
	let sessionCookie: string;
	let realFetch: typeof fetch;
	const upstreamCalls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];

	function upstreamJson(body: unknown, status: number, headers: Record<string, string> = {}) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json', ...headers },
		});
	}

	function headerMap(init: RequestInit): Record<string, string> {
		const raw = (init.headers ?? {}) as Record<string, string>;
		return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), String(value)]));
	}

	beforeAll(async () => {
		realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init: any = {}) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url);
			if (!url.startsWith('http://127.0.0.1:1')) {
				return realFetch(input, init);
			}
			upstreamCalls.push({ url, method: init.method ?? 'GET', headers: headerMap(init), body: init.body });
			if (url.endsWith('/v1/limits')) {
				return upstreamJson({ limit: 250, remaining: 199 }, 200, {
					'x-ratelimit-limit': '250',
					'x-ratelimit-remaining': '199',
					'x-ratelimit-reset': '42',
					'x-request-cost': '1',
				});
			}
			if (init.method === 'POST') {
				return upstreamJson({ id: 'm-e2e', status: 'in-progress' }, 202, {
					'x-ratelimit-remaining': '198',
					'location': '/v1/measurements/m-e2e',
				});
			}
			return upstreamJson({ id: 'm-e2e', status: 'finished', results: [{ probe: { country: 'JP' } }] }, 200);
		}) as typeof fetch;

		server = await startServer({ GP_TOKEN: 'e2e-server-token' });
		sessionCookie = `pa_session=${await server.session.signSession({ sub: 'u2', username: 'proxy-user' })}`;
	});

	afterAll(async () => {
		globalThis.fetch = realFetch;
		await server.close();
		resetEnv();
	});

	it('配置接口反映服务端令牌可用（但不下发令牌本身）', async () => {
		const res = await fetch(`${server.baseUrl}/api/config`);
		const body = await res.json() as Record<string, unknown>;

		expect(body.proxyAvailable).toBe(true);
		expect(JSON.stringify(body)).not.toContain('e2e-server-token');
	});

	it('未登录调用代理接口返回 401', async () => {
		const res = await fetch(`${server.baseUrl}/api/limits`);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({
			error: { type: 'unauthorized', message: 'Login required to use the server token' },
		});
	});

	it('登录后代理 /v1/limits 并透传限量响应头', async () => {
		upstreamCalls.length = 0;
		const res = await fetch(`${server.baseUrl}/api/limits`, { headers: { cookie: sessionCookie } });

		expect(res.status).toBe(200);
		expect(res.headers.get('x-ratelimit-remaining')).toBe('199');
		expect(res.headers.get('x-ratelimit-limit')).toBe('250');
		expect(res.headers.get('x-ratelimit-reset')).toBe('42');
		expect(res.headers.get('access-control-expose-headers')).toContain('x-ratelimit-remaining');
		expect(await res.json()).toEqual({ limit: 250, remaining: 199 });

		expect(upstreamCalls).toHaveLength(1);
		expect(upstreamCalls[0]!.url).toBe('http://127.0.0.1:1/v1/limits');
		expect(upstreamCalls[0]!.headers.authorization).toBe('Bearer e2e-server-token');
	});

	it('登录后代理创建测量并透传 202 与 Location', async () => {
		upstreamCalls.length = 0;
		const res = await fetch(`${server.baseUrl}/api/measurements`, {
			method: 'POST',
			headers: { 'cookie': sessionCookie, 'content-type': 'application/json' },
			body: JSON.stringify({ type: 'ping', target: 'example.com', limit: 3 }),
		});

		expect(res.status).toBe(202);
		expect(res.headers.get('location')).toBe('/v1/measurements/m-e2e');
		expect(await res.json()).toEqual({ id: 'm-e2e', status: 'in-progress' });
		expect(JSON.parse(upstreamCalls[0]!.body!)).toEqual({ type: 'ping', target: 'example.com', limit: 3 });
		expect(upstreamCalls[0]!.headers['content-type']).toBe('application/json');
	});

	it('请求体不是合法 JSON 时返回 400 且不打上游', async () => {
		upstreamCalls.length = 0;
		const res = await fetch(`${server.baseUrl}/api/measurements`, {
			method: 'POST',
			headers: { 'cookie': sessionCookie, 'content-type': 'application/json' },
			body: '{not json',
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: { type: 'invalid_body', message: 'Request body must be valid JSON' },
		});
		expect(upstreamCalls).toHaveLength(0);
	});

	it('查询测量结果会带上编码后的 id', async () => {
		upstreamCalls.length = 0;
		const res = await fetch(`${server.baseUrl}/api/measurements/m_e2e-1`, { headers: { cookie: sessionCookie } });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: 'm-e2e', status: 'finished', results: [{ probe: { country: 'JP' } }] });
		expect(upstreamCalls[0]!.url).toBe('http://127.0.0.1:1/v1/measurements/m_e2e-1');
	});

	it('非法测量 id 直接 400，不请求上游', async () => {
		upstreamCalls.length = 0;
		const res = await fetch(`${server.baseUrl}/api/measurements/..%2F..%2Fv1%2Flimits`, { headers: { cookie: sessionCookie } });

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: { type: 'invalid_id', message: 'Invalid measurement id' } });
		expect(upstreamCalls).toHaveLength(0);
	});

	it('上游不可达时返回 502 结构化错误', async () => {
		const patched = globalThis.fetch;
		globalThis.fetch = (async (input: any, init: any = {}) => {
			const url = typeof input === 'string' ? input : String(input.url);
			if (url.startsWith('http://127.0.0.1:1')) {
				throw new TypeError('fetch failed');
			}
			return patched(input, init);
		}) as typeof fetch;

		try {
			const res = await fetch(`${server.baseUrl}/api/limits`, { headers: { cookie: sessionCookie } });
			expect(res.status).toBe(502);
			expect(await res.json()).toEqual({
				error: { type: 'upstream_error', message: 'Globalping API is unreachable' },
			});
		}
		finally {
			globalThis.fetch = patched;
		}
	});
});
