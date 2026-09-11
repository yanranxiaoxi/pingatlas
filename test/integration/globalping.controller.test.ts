import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PROBE_INDEX_VERSION } from '../../src/utils/probe-index';
import { resetEnv } from '../helpers/env';
import { createMockContext } from '../helpers/http';

type Controller = typeof import('../../src/controller/globalping.controller');

/** 在隔离模块注册表中按给定环境重新求值控制器（CONFIG 在模块顶层冻结） */
async function loadController(env: Record<string, string>): Promise<Controller> {
	let controller!: Controller;
	resetEnv({ GP_API_URL: 'https://api.globalping.test', GP_TOKEN: '', ...env });
	await jest.isolateModulesAsync(async () => {
		controller = await import('../../src/controller/globalping.controller');
	});
	return controller;
}

/** 归一化 fetch init 中的请求头（HTTP 头大小写不敏感） */
function headersOf(init: RequestInit | undefined): Record<string, string> {
	const raw = (init?.headers ?? {}) as Record<string, string>;
	return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
}

/** 构造上游 JSON 响应 */
function upstreamJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

const USER = { sub: 'user-1', username: 'alice' };

let fetchMock: jest.MockedFunction<typeof fetch>;

beforeEach(() => {
	fetchMock = jest.fn<typeof fetch>();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	resetEnv();
});

describe('GET /api/config', () => {
	it('暴露上游地址、代理可用性与节点上限', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({ url: '/api/config' });

		await controller.default.config(ctx);

		expect(res.statusCode).toBe(200);
		expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
		expect(JSON.parse(res.body)).toEqual({
			apiUrl: 'https://api.globalping.test',
			proxyAvailable: true,
			maxProbes: { direct: 50, proxy: 500 },
		});
	});

	it('未配置服务端代币时 proxyAvailable 为 false', async () => {
		const controller = await loadController({});
		const { ctx, res } = createMockContext({ url: '/api/config' });

		await controller.default.config(ctx);

		expect(JSON.parse(res.body).proxyAvailable).toBe(false);
	});

	it('不下发任何令牌字段', async () => {
		const controller = await loadController({ GP_TOKEN: 'super-secret-token' });
		const { ctx, res } = createMockContext({ url: '/api/config' });

		await controller.default.config(ctx);

		expect(res.body).not.toContain('super-secret-token');
		expect(res.body).not.toContain('token');
	});

	it('导出与前端共享的节点上限常量', async () => {
		const controller = await loadController({});
		expect(controller.ANONYMOUS_MAX_PROBES).toBe(50);
		expect(controller.AUTHENTICATED_MAX_PROBES).toBe(500);
	});
});

describe('代理前置校验', () => {
	it('未配置服务端代币时返回 503 proxy_unavailable', async () => {
		const controller = await loadController({});
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(503);
		expect(JSON.parse(res.body)).toEqual({ error: { type: 'proxy_unavailable', message: 'Server token is not configured' } });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('未登录时返回 401 unauthorized', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({ url: '/api/limits', user: null });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body).error.type).toBe('unauthorized');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('ctx.user 结构不完整时同样视为未登录', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({ url: '/api/limits', user: { sub: 'only-sub' } });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(401);
	});

	it('三个代理接口都执行相同的校验', async () => {
		const controller = await loadController({});
		for (const call of [
			(ctx: never) => controller.default.limits(ctx as never),
			(ctx: never) => controller.default.createMeasurement(ctx as never),
			(ctx: never) => controller.default.getMeasurement(ctx as never),
		]) {
			const { ctx, res } = createMockContext({ url: '/api/x', user: USER, method: 'POST' });
			await call(ctx as never);
			expect(res.statusCode).toBe(503);
		}
	});
});

describe('GET /api/limits', () => {
	it('转发到上游 /v1/limits 并注入服务端令牌', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({ limit: 500, remaining: 480 }));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://api.globalping.test/v1/limits');
		expect(init?.method).toBe('GET');
		expect(headersOf(init).authorization).toBe('Bearer server-token');
		expect(headersOf(init)['user-agent']).toMatch(/^pingatlas\//);
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ limit: 500, remaining: 480 });
	});

	it('透传上游状态码与限量响应头', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({ limit: 500 }, 429, {
			'x-ratelimit-limit': '500',
			'x-ratelimit-consumed': '500',
			'x-ratelimit-remaining': '0',
			'x-ratelimit-reset': '60',
			'retry-after': '60',
			'x-credits-remaining': '12',
		}));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(429);
		expect(res.getHeader('x-ratelimit-limit')).toBe('500');
		expect(res.getHeader('x-ratelimit-consumed')).toBe('500');
		expect(res.getHeader('x-ratelimit-remaining')).toBe('0');
		expect(res.getHeader('x-ratelimit-reset')).toBe('60');
		expect(res.getHeader('retry-after')).toBe('60');
		expect(res.getHeader('x-credits-remaining')).toBe('12');
		expect(res.getHeader('content-type')).toBe('application/json');
	});

	it('声明可被同页脚本读取的响应头', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}, 200, { etag: 'W/"abc"' }));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		const exposed = String(res.getHeader('access-control-expose-headers')).split(', ');
		expect(exposed).toEqual(expect.arrayContaining([
			'x-ratelimit-limit',
			'x-ratelimit-remaining',
			'x-ratelimit-reset',
			'x-credits-remaining',
			'retry-after',
			'location',
			'etag',
		]));
		expect(res.getHeader('etag')).toBe('W/"abc"');
	});

	it('上游缺少限量头时不写入空值', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.getHeader('x-ratelimit-limit')).toBeUndefined();
		expect(res.getHeader('etag')).toBeUndefined();
	});

	it('上游 Content-Type 缺失时回落到 JSON', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
		expect(res.body).toBe('');
	});

	it('透传上游的非 JSON Content-Type', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502, headers: { 'content-type': 'text/plain' } }));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.getHeader('content-type')).toBe('text/plain');
		expect(res.body).toBe('oops');
	});

	it('网络错误返回 502 结构化错误并记录日志', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.body)).toEqual({ error: { type: 'upstream_error', message: 'Globalping API is unreachable' } });
	});

	it('超时（AbortError）同样返回 502', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const abort = new Error('The operation was aborted');
		abort.name = 'TimeoutError';
		fetchMock.mockRejectedValueOnce(abort);
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(502);
	});

	it('传入带超时的 AbortSignal', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}));
		const { ctx } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe('POST /api/measurements', () => {
	it('转发 POST 请求体到上游', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({ id: 'm-1' }, 202, { location: '/v1/measurements/m-1' }));
		const payload = { target: 'example.com', type: 'ping', limit: 3 };
		const { ctx, res } = createMockContext({
			url: '/api/measurements',
			method: 'POST',
			user: USER,
			body: JSON.stringify(payload),
		});

		await controller.default.createMeasurement(ctx);

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://api.globalping.test/v1/measurements');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual(payload);
		expect(headersOf(init)['content-type']).toBe('application/json');
		expect(res.statusCode).toBe(202);
		expect(res.getHeader('location')).toBe('/v1/measurements/m-1');
	});

	it('空请求体按空对象转发', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}, 202));
		const { ctx } = createMockContext({ url: '/api/measurements', method: 'POST', user: USER, body: '' });

		await controller.default.createMeasurement(ctx);

		expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({});
	});

	it('请求体声明超过 2MB 时返回 413', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({
			url: '/api/measurements',
			method: 'POST',
			user: USER,
			headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
			body: '{}',
		});

		await controller.default.createMeasurement(ctx);

		expect(res.statusCode).toBe(413);
		expect(JSON.parse(res.body).error.type).toBe('payload_too_large');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('恰好 2MB 时放行', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}, 202));
		const { ctx, res } = createMockContext({
			url: '/api/measurements',
			method: 'POST',
			user: USER,
			headers: { 'content-length': String(2 * 1024 * 1024) },
			body: '{}',
		});

		await controller.default.createMeasurement(ctx);

		expect(res.statusCode).toBe(202);
	});

	it('非法 JSON 请求体返回 400 invalid_body', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({
			url: '/api/measurements',
			method: 'POST',
			user: USER,
			body: '{not json',
		});

		await controller.default.createMeasurement(ctx);

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body)).toEqual({ error: { type: 'invalid_body', message: 'Request body must be valid JSON' } });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('透传上游 400 校验错误体', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson(
			{ error: { type: 'validation_error', message: 'target is required' } },
			400,
		));
		const { ctx, res } = createMockContext({ url: '/api/measurements', method: 'POST', user: USER, body: '{}' });

		await controller.default.createMeasurement(ctx);

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error.type).toBe('validation_error');
	});
});

describe('GET /api/measurements/:id', () => {
	it('转发请求并编码 id', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({ status: 'finished' }));
		const { ctx } = createMockContext({ url: '/api/measurements/abc-123', user: USER, routerParams: { id: 'abc-123' } });

		await controller.default.getMeasurement(ctx);

		expect(fetchMock.mock.calls[0]![0]).toBe('https://api.globalping.test/v1/measurements/abc-123');
		expect(fetchMock.mock.calls[0]![1]?.method).toBe('GET');
	});

	it('64 位 id 合法', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}));
		const id = 'a'.repeat(64);
		const { ctx, res } = createMockContext({ url: `/api/measurements/${id}`, user: USER, routerParams: { id } });

		await controller.default.getMeasurement(ctx);

		expect(res.statusCode).toBe(200);
	});

	it.each([
		['超过 64 位', 'a'.repeat(65)],
		['空字符串', ''],
		['含百分号编码', 'abc%2Fdef'],
		['含斜杠', 'abc/def'],
		['含空格', 'abc def'],
		['含点号穿越', '../../etc/passwd'],
	])('%s 的 id 被拒绝（400 invalid_id）', async (_label, id) => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({ url: '/api/measurements/x', user: USER, routerParams: { id } });

		await controller.default.getMeasurement(ctx);

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error.type).toBe('invalid_id');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('id 参数缺失或非字符串时被拒绝', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		for (const routerParams of [{}, { id: 42 }, { id: undefined }]) {
			const { ctx, res } = createMockContext({ url: '/api/measurements/', user: USER, routerParams: routerParams as never });
			await controller.default.getMeasurement(ctx);
			expect(res.statusCode).toBe(400);
		}
	});
});

describe('上游地址拼接', () => {
	it('去掉配置里的多余结尾斜杠', async () => {
		const controller = await loadController({ GP_API_URL: 'https://api.globalping.test///', GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({}));
		const { ctx } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(fetchMock.mock.calls[0]![0]).toBe('https://api.globalping.test/v1/limits');
	});

	it('/api/config 返回配置原文（不做规范化，规范化只在转发时进行）', async () => {
		const controller = await loadController({ GP_API_URL: 'https://api.globalping.test///' });
		const { ctx, res } = createMockContext({ url: '/api/config' });

		await controller.default.config(ctx);

		expect(JSON.parse(res.body).apiUrl).toBe('https://api.globalping.test///');
	});

	it('上游返回空 body 时透传空字符串', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(204);
		expect(res.body).toBe('');
	});

	it('上游 body 读取失败时按空字符串透传状态码', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const broken = new Response(null, { status: 500 });
		jest.spyOn(broken, 'text').mockRejectedValue(new Error('stream torn down'));
		fetchMock.mockResolvedValueOnce(broken);
		const { ctx, res } = createMockContext({ url: '/api/limits', user: USER });

		await controller.default.limits(ctx);

		expect(res.statusCode).toBe(500);
		expect(res.body).toBe('');
		expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
	});
});

describe('测量 id 字符集校验', () => {
	it.each([
		['a'.repeat(64), true],
		['a'.repeat(65), false],
		['', false],
		['abc.def', false],
		['abc/def', false],
		['..%2Fetc%2Fpasswd', false],
		['abc def', false],
		['a_b-c9', true],
	])('id=%p 合法性为 %p', async (id, allowed) => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson({ status: 'finished' }));
		const { ctx, res } = createMockContext({ url: `/api/measurements/${id}`, user: USER, routerParams: { id } });

		await controller.default.getMeasurement(ctx);

		if (allowed) {
			expect(res.statusCode).toBe(200);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
		else {
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body).error.type).toBe('invalid_id');
			expect(fetchMock).not.toHaveBeenCalled();
		}
	});

	it('id 非字符串时拒绝且不请求上游', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		const { ctx, res } = createMockContext({ url: '/api/measurements/1', user: USER, routerParams: { id: 42 } });

		await controller.default.getMeasurement(ctx);

		expect(res.statusCode).toBe(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('GET /api/probes（位置筛选自动补全的数据源）', () => {
	/** 两条探针，足以校验索引骨架与去重结果 */
	const upstreamProbes = [
		{ location: { country: 'CN', region: 'Eastern Asia', city: 'Fuzhou', asn: 4134, network: 'Chinanet' }, tags: ['eyeball-network'] },
		{ location: { country: 'CN', region: 'Eastern Asia', city: 'Fuzhou', asn: 4134, network: 'Chinanet' }, tags: ['eyeball-network'] },
		{ location: { country: 'DE', region: 'Western Europe', city: 'Frankfurt', asn: 15169, network: 'Google LLC' }, tags: ['datacenter-network'] },
	];

	it('无需登录即可访问，并把上游探针压成去重索引', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson(upstreamProbes));
		const { ctx, res } = createMockContext({ url: '/api/probes', user: null });

		await controller.default.probes(ctx);

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.version).toBe(PROBE_INDEX_VERSION);
		expect(body.total).toBe(3);
		expect(body.countries).toEqual([['CN', 2], ['DE', 1]]);
		expect(body.cities).toEqual([['Fuzhou', 'CN', 2], ['Frankfurt', 'DE', 1]]);
		expect(body.networks).toEqual([['Chinanet', 4134, 2], ['Google LLC', 15169, 1]]);
		expect(body.tags).toEqual([['eyeball-network', 2], ['datacenter-network', 1]]);
	});

	it('请求上游 /v1/probes 但不带任何令牌', async () => {
		const controller = await loadController({ GP_TOKEN: 'server-token' });
		fetchMock.mockResolvedValueOnce(upstreamJson(upstreamProbes));
		const { ctx } = createMockContext({ url: '/api/probes' });

		await controller.default.probes(ctx);

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://api.globalping.test/v1/probes');
		expect(headersOf(init).authorization).toBeUndefined();
		expect(headersOf(init)['user-agent']).toMatch(/^pingatlas\//);
	});

	it('首次请求标记 miss，并声明浏览器缓存 5 分钟', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson(upstreamProbes));
		const { ctx, res } = createMockContext({ url: '/api/probes' });

		await controller.default.probes(ctx);

		expect(res.getHeader('x-probe-index')).toBe('miss');
		expect(res.getHeader('cache-control')).toBe('public, max-age=300');
		expect(controller.PROBE_INDEX_TTL).toBe(300_000);
	});

	it('缓存有效期内的第二次请求直接命中缓存', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValue(upstreamJson(upstreamProbes));

		const first = createMockContext({ url: '/api/probes' });
		await controller.default.probes(first.ctx);
		const second = createMockContext({ url: '/api/probes' });
		await controller.default.probes(second.ctx);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second.res.getHeader('x-probe-index')).toBe('hit');
		expect(JSON.parse(second.res.body).total).toBe(3);
	});

	it('独立控制器实例之间不共享缓存', async () => {
		const a = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson(upstreamProbes));
		await a.default.probes(createMockContext({ url: '/api/probes' }).ctx);

		const b = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson(upstreamProbes));
		const second = createMockContext({ url: '/api/probes' });
		await b.default.probes(second.ctx);

		expect(second.res.getHeader('x-probe-index')).toBe('miss');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('上游失败时退回稍旧的缓存并标记 stale', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson(upstreamProbes));
		await controller.default.probes(createMockContext({ url: '/api/probes' }).ctx);

		// 让缓存过期（模块内缓存用 Date.now() 判过期），再让上游报错
		const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + controller.PROBE_INDEX_TTL + 1000);
		try {
			fetchMock.mockRejectedValueOnce(new Error('upstream down'));
			const { ctx, res } = createMockContext({ url: '/api/probes' });
			await controller.default.probes(ctx);

			expect(res.statusCode).toBe(200);
			expect(res.getHeader('x-probe-index')).toBe('stale');
			expect(JSON.parse(res.body).total).toBe(3);
		}
		finally {
			nowSpy.mockRestore();
		}
	});

	it('上游返回非 2xx 且无缓存时返回 502', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson({ error: 'nope' }, 503));
		const { ctx, res } = createMockContext({ url: '/api/probes' });

		await controller.default.probes(ctx);

		expect(res.statusCode).toBe(502);
		expect(JSON.parse(res.body).error.type).toBe('upstream_error');
	});

	it('上游不可达且无缓存时返回 502', async () => {
		const controller = await loadController({});
		fetchMock.mockRejectedValueOnce(new Error('offline'));
		const { ctx, res } = createMockContext({ url: '/api/probes' });

		await controller.default.probes(ctx);

		expect(res.statusCode).toBe(502);
	});

	it('并发请求合并成一次上游调用', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValue(upstreamJson(upstreamProbes));

		await Promise.all(
			Array.from({ length: 5 }, () => controller.default.probes(createMockContext({ url: '/api/probes' }).ctx)),
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('上游返回畸形数据时按空索引返回，不抛异常', async () => {
		const controller = await loadController({});
		fetchMock.mockResolvedValueOnce(upstreamJson('not-an-array'));
		const { ctx, res } = createMockContext({ url: '/api/probes' });

		await controller.default.probes(ctx);

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body).total).toBe(0);
	});
});
