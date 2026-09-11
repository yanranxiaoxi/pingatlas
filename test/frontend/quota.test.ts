/**
 * @jest-environment jsdom
 */
import type { AppConfig, QuotaSnapshot } from '../../src/frontend/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type QuotaModule = typeof import('../../src/frontend/quota');

const toastMock = jest.fn();
let loggedIn = false;
let localImplCalls = 0;
let proxyImplCalls = 0;
let localImpl: () => Promise<Response>;
let proxyImpl: () => Promise<Response>;

jest.unstable_mockModule('../../src/frontend/api', () => ({
	isLoggedIn: () => loggedIn,
	directFetch: () => {
		localImplCalls += 1;
		return localImpl();
	},
	proxyFetch: () => {
		proxyImplCalls += 1;
		return proxyImpl();
	},
}));

jest.unstable_mockModule('../../src/frontend/ui', () => ({
	toast: toastMock,
}));

jest.unstable_mockModule('../../src/frontend/i18n', () => ({
	t: (key: string) => `t:${key}`,
}));

function limitsResponse(
	rate: { limit: number; remaining: number; reset?: number },
	creditsRemaining?: number,
	status = 200,
): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(),
		json: async () => ({
			rateLimit: { measurements: { create: rate } },
			...(creditsRemaining === undefined ? {} : { credits: { remaining: creditsRemaining } }),
		}),
	} as unknown as Response;
}

function rateHeaders(limit: number, remaining: number, reset = 0, credits?: number): Headers {
	const headers = new Headers({
		'X-RateLimit-Limit': String(limit),
		'X-RateLimit-Remaining': String(remaining),
		'X-RateLimit-Reset': String(reset),
	});
	if (credits !== undefined) {
		headers.set('X-Credits-Remaining', String(credits));
	}
	return headers;
}

function configFixture(overrides: Partial<AppConfig> = {}): AppConfig {
	return {
		apiUrl: 'https://api.globalping.io',
		proxyAvailable: true,
		maxProbes: { direct: 50, proxy: 500 },
		...overrides,
	};
}

async function freshQuota(): Promise<QuotaModule> {
	return import('../../src/frontend/quota');
}

/** 初始化额度模块并等待首次拉取完成 */
async function init(config: AppConfig = configFixture()): Promise<QuotaModule> {
	const quota = await freshQuota();
	quota.initQuota(config);
	await jest.advanceTimersByTimeAsync(0);
	return quota;
}

beforeEach(() => {
	jest.resetModules();
	jest.useFakeTimers();
	localStorage.clear();
	document.body.replaceChildren();
	toastMock.mockClear();
	loggedIn = false;
	localImplCalls = 0;
	proxyImplCalls = 0;
	localImpl = async () => limitsResponse({ limit: 60, remaining: 60 });
	proxyImpl = async () => limitsResponse({ limit: 250, remaining: 250 });
});

afterEach(() => {
	jest.useRealTimers();
});

describe('resolveMode 优先级', () => {
	it('未初始化时默认为直连', async () => {
		const quota = await freshQuota();
		expect(quota.resolveMode()).toBe('direct');
	});

	it('直连不可达且代理不可用时为 unreachable', async () => {
		localImpl = async () => {
			throw new TypeError('network down');
		};
		const quota = await init();
		expect(quota.getQuotaState().directReachable).toBe(false);
		expect(quota.resolveMode()).toBe('unreachable');
	});

	it('直连不可达但代理可用时走代理', async () => {
		loggedIn = true;
		localImpl = async () => {
			throw new TypeError('network down');
		};
		const quota = await init();
		expect(quota.resolveMode()).toBe('proxy');
	});

	it('本地额度耗尽且代理不可用时为 exhausted', async () => {
		localImpl = async () => limitsResponse({ limit: 60, remaining: 0 });
		const quota = await init();
		expect(quota.resolveMode()).toBe('exhausted');
	});

	it('本地额度耗尽但代理可用时走代理', async () => {
		loggedIn = true;
		localImpl = async () => limitsResponse({ limit: 60, remaining: 0 });
		const quota = await init();
		expect(quota.resolveMode()).toBe('proxy');
	});

	it('节点数超过匿名上限且代理可用时走代理', async () => {
		loggedIn = true;
		const quota = await init();
		expect(quota.resolveMode(51)).toBe('proxy');
		expect(quota.resolveMode(50)).toBe('direct');
	});

	it('节点数超过匿名上限但代理不可用时仍走直连', async () => {
		const quota = await init();
		expect(quota.resolveMode(500)).toBe('direct');
	});

	it('用户偏好代理且可用时走代理', async () => {
		loggedIn = true;
		const quota = await init();
		quota.setPreference('proxy');
		expect(quota.getQuotaState().preference).toBe('proxy');
		expect(quota.resolveMode()).toBe('proxy');
	});

	it('偏好代理但代理不可用时忽略偏好', async () => {
		localStorage.setItem('pa-quota-preference', 'proxy');
		const quota = await init(configFixture({ proxyAvailable: false }));
		expect(quota.getQuotaState().preference).toBe('proxy');
		expect(quota.resolveMode()).toBe('direct');
	});
});

describe('maxProbesForCurrentAuth / buildState', () => {
	it('未配置时返回 50', async () => {
		const quota = await freshQuota();
		expect(quota.getQuotaState().maxProbes).toBe(50);
	});

	it('匿名时使用直连上限', async () => {
		const quota = await init();
		expect(quota.getQuotaState().maxProbes).toBe(50);
	});

	it('已登录且后端支持代理时使用代理上限', async () => {
		loggedIn = true;
		const quota = await init();
		expect(quota.getQuotaState().maxProbes).toBe(500);
	});

	it('已登录但后端未配置代币时仍用直连上限', async () => {
		loggedIn = true;
		const quota = await init(configFixture({ proxyAvailable: false }));
		expect(quota.getQuotaState().maxProbes).toBe(50);
	});

	it('activeActor 跟随模式', async () => {
		const quota = await init();
		expect(quota.getQuotaState().activeActor).toBe('ip');

		loggedIn = true;
		const quota2 = await init();
		quota2.setPreference('proxy');
		expect(quota2.getQuotaState().activeActor).toBe('user');

		loggedIn = false;
		localImpl = async () => {
			throw new TypeError('offline');
		};
		const quota3 = await init();
		expect(quota3.getQuotaState().activeActor).toBeNull();
	});
});

describe('getResetSeconds', () => {
	it('未就绪时返回 0', async () => {
		const quota = await freshQuota();
		const snapshot: QuotaSnapshot = { status: 'loading', actor: 'ip', limit: 0, remaining: 0, reset: 0, updatedAt: 0 };
		expect(quota.getResetSeconds(snapshot)).toBe(0);
	});

	it('按快照时间推算剩余秒数', async () => {
		const quota = await freshQuota();
		jest.setSystemTime(new Date('2024-01-01T00:00:05.000Z'));
		const snapshot: QuotaSnapshot = {
			status: 'ready',
			actor: 'ip',
			limit: 60,
			remaining: 0,
			reset: 30,
			updatedAt: Date.now() - 5000,
		};
		expect(quota.getResetSeconds(snapshot)).toBe(25);
	});

	it('已过重置时间时钳制为 0', async () => {
		const quota = await freshQuota();
		const snapshot: QuotaSnapshot = {
			status: 'ready',
			actor: 'ip',
			limit: 60,
			remaining: 0,
			reset: 10,
			updatedAt: Date.now() - 60_000,
		};
		expect(quota.getResetSeconds(snapshot)).toBe(0);
	});
});

describe('applyQuotaHeaders', () => {
	it('缺少限额头时不做任何更新', async () => {
		const quota = await init();
		const before = quota.getQuotaState().local;
		quota.applyQuotaHeaders(new Headers({ 'Content-Type': 'application/json' }), 'ip');
		expect(quota.getQuotaState().local).toEqual(before);
	});

	it('限额头非法时不做更新', async () => {
		const quota = await init();
		const before = quota.getQuotaState().local;
		quota.applyQuotaHeaders(new Headers({ 'X-RateLimit-Limit': 'abc', 'X-RateLimit-Remaining': '1' }), 'ip');
		expect(quota.getQuotaState().local).toEqual(before);
	});

	it('更新本地额度并带上 credits', async () => {
		const quota = await init();
		quota.applyQuotaHeaders(rateHeaders(60, 42, 120, 7), 'ip');
		const local = quota.getQuotaState().local;
		expect(local.status).toBe('ready');
		expect(local.limit).toBe(60);
		expect(local.remaining).toBe(42);
		expect(local.reset).toBe(120);
		expect(local.creditsRemaining).toBe(7);
	});

	it('reset 非法时回落为 0', async () => {
		const quota = await init();
		quota.applyQuotaHeaders(new Headers({ 'X-RateLimit-Limit': '60', 'X-RateLimit-Remaining': '5', 'X-RateLimit-Reset': 'x' }), 'ip');
		expect(quota.getQuotaState().local.reset).toBe(0);
	});

	it('actor=user 时只更新代理额度', async () => {
		loggedIn = true;
		const quota = await init();
		const localBefore = quota.getQuotaState().local;
		quota.applyQuotaHeaders(rateHeaders(250, 100, 60), 'user');
		expect(quota.getQuotaState().local).toEqual(localBefore);
		expect(quota.getQuotaState().proxy.remaining).toBe(100);
	});

	it('缺少 X-RateLimit-Reset 时重置窗口记为 0', async () => {
		const quota = await init();
		const headers = new Headers({ 'X-RateLimit-Limit': '250', 'X-RateLimit-Remaining': '10' });

		quota.applyQuotaHeaders(headers, 'ip');

		const local = quota.getQuotaState().local;
		expect(local.limit).toBe(250);
		expect(local.remaining).toBe(10);
		expect(local.reset).toBe(0);
	});

	it('credits 头非法时忽略该字段', async () => {
		const quota = await init();
		const headers = rateHeaders(250, 10, 60);
		headers.set('X-Credits-Remaining', 'abc');

		quota.applyQuotaHeaders(headers, 'ip');

		expect(quota.getQuotaState().local.remaining).toBe(10);
		expect(quota.getQuotaState().local.creditsRemaining).toBeUndefined();
	});
});

describe('本地额度耗尽与重置回切', () => {
	it('耗尽后自动降级到代理', async () => {
		loggedIn = true;
		const quota = await init();
		expect(quota.resolveMode()).toBe('direct');
		quota.applyQuotaHeaders(rateHeaders(60, 0, 30), 'ip');
		expect(quota.resolveMode()).toBe('proxy');
	});

	it('耗尽前的手动代理偏好在重置后自动切回 auto', async () => {
		loggedIn = true;
		const quota = await init();
		quota.setPreference('proxy');
		expect(localStorage.getItem('pa-quota-preference')).toBe('proxy');

		quota.applyQuotaHeaders(rateHeaders(60, 0, 30), 'ip');
		toastMock.mockClear();
		quota.applyQuotaHeaders(rateHeaders(60, 60, 0), 'ip');

		expect(quota.getQuotaState().preference).toBe('auto');
		expect(localStorage.getItem('pa-quota-preference')).toBe('auto');
		expect(toastMock).toHaveBeenCalledWith('t:quotaResetBackToLocal', 'success');
		expect(quota.resolveMode()).toBe('direct');
	});

	it('偏好本来就是 auto 时重置不弹提示', async () => {
		loggedIn = true;
		const quota = await init();
		quota.applyQuotaHeaders(rateHeaders(60, 0, 30), 'ip');
		toastMock.mockClear();
		quota.applyQuotaHeaders(rateHeaders(60, 60, 0), 'ip');
		expect(toastMock).not.toHaveBeenCalled();
		expect(quota.getQuotaState().preference).toBe('auto');
	});

	it('额度耗尽时会安排一次精准复查', async () => {
		const quota = await init();
		const localCallsBefore = localImplCalls;
		quota.applyQuotaHeaders(rateHeaders(60, 0, 4), 'ip');
		await jest.advanceTimersByTimeAsync(6000);
		expect(localImplCalls).toBeGreaterThan(localCallsBefore);
	});

	it('reset 缺失时退回心跳间隔而非短轮询', async () => {
		const quota = await init();
		const before = localImplCalls;
		quota.applyQuotaHeaders(rateHeaders(60, 0, 0), 'ip');
		await jest.advanceTimersByTimeAsync(60_000);
		expect(localImplCalls).toBe(before);
		await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(localImplCalls).toBeGreaterThan(before);
	});

	it('额度未耗尽时也在窗口重置后复查，倒计时不会停在 00:00', async () => {
		const quota = await init();
		const before = localImplCalls;
		localImpl = async () => limitsResponse({ limit: 60, remaining: 60, reset: 0 });
		quota.applyQuotaHeaders(rateHeaders(60, 42, 30), 'ip');
		expect(quota.getResetSeconds(quota.getQuotaState().local)).toBeCloseTo(30, 5);

		await jest.advanceTimersByTimeAsync(29_000);
		expect(localImplCalls).toBe(before);

		// 窗口边界后 2s 宽限内必须复查，并把新窗口的数值写入快照
		await jest.advanceTimersByTimeAsync(4_000);
		expect(localImplCalls).toBeGreaterThan(before);
		expect(quota.getQuotaState().local.remaining).toBe(60);
		expect(quota.getResetSeconds(quota.getQuotaState().local)).toBe(0);
	});

	it('连续快照只保留一个复查定时器', async () => {
		const quota = await init();
		const before = localImplCalls;
		localImpl = async () => limitsResponse({ limit: 60, remaining: 60, reset: 0 });
		quota.applyQuotaHeaders(rateHeaders(60, 42, 30), 'ip');
		quota.applyQuotaHeaders(rateHeaders(60, 41, 20), 'ip');
		quota.applyQuotaHeaders(rateHeaders(60, 40, 10), 'ip');

		await jest.advanceTimersByTimeAsync(12_000);
		expect(localImplCalls).toBe(before + 1);
	});
});

describe('setPreference 守卫', () => {
	it('代理不可用时拒绝切换到代理并提示', async () => {
		const quota = await init(configFixture({ proxyAvailable: false }));
		quota.setPreference('proxy');
		expect(quota.getQuotaState().preference).toBe('auto');
		expect(toastMock).toHaveBeenCalledWith('t:quotaProxyUnavailable', 'error');
	});

	it('未登录时拒绝切换到代理', async () => {
		const quota = await init();
		quota.setPreference('proxy');
		expect(quota.getQuotaState().preference).toBe('auto');
		expect(localStorage.getItem('pa-quota-preference')).toBeNull();
	});

	it('直连不可达时拒绝切回 auto', async () => {
		loggedIn = true;
		localImpl = async () => {
			throw new TypeError('offline');
		};
		const quota = await init();
		// 代理可用时 resolveMode 为 proxy，但偏好仍是 auto；先手动改为 proxy
		quota.setPreference('proxy');
		quota.setPreference('auto');
		expect(quota.getQuotaState().preference).toBe('proxy');
		expect(toastMock).toHaveBeenCalledWith('t:quotaDirectUnreachable', 'error');
	});

	it('本地额度耗尽时拒绝切回 auto', async () => {
		loggedIn = true;
		const quota = await init();
		quota.setPreference('proxy');
		quota.applyQuotaHeaders(rateHeaders(60, 0, 30), 'ip');
		toastMock.mockClear();
		quota.setPreference('auto');
		expect(quota.getQuotaState().preference).toBe('proxy');
		expect(toastMock).toHaveBeenCalledWith('t:quotaLocalExhausted', 'error');
	});

	it('相同偏好直接返回', async () => {
		loggedIn = true;
		const quota = await init();
		const listener = jest.fn();
		quota.onQuotaChange(listener);
		listener.mockClear();
		quota.setPreference('auto');
		expect(listener).not.toHaveBeenCalled();
	});

	it('本地额度有结余时可以从代理切回 auto', async () => {
		loggedIn = true;
		const quota = await init();
		quota.setPreference('proxy');
		quota.setPreference('auto');
		expect(quota.getQuotaState().preference).toBe('auto');
		expect(localStorage.getItem('pa-quota-preference')).toBe('auto');
	});
});

describe('setDesiredProbes / onQuotaChange', () => {
	it('变化时通知订阅者', async () => {
		const quota = await init();
		const listener = jest.fn();
		quota.onQuotaChange(listener);
		listener.mockClear();
		quota.setDesiredProbes(10);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(quota.getQuotaState().desiredProbes).toBe(10);
	});

	it('值不变时不通知', async () => {
		const quota = await init();
		const listener = jest.fn();
		quota.onQuotaChange(listener);
		listener.mockClear();
		quota.setDesiredProbes(quota.getQuotaState().desiredProbes);
		expect(listener).not.toHaveBeenCalled();
	});

	it('退订后不再收到通知', async () => {
		const quota = await init();
		const listener = jest.fn();
		const off = quota.onQuotaChange(listener);
		expect(listener).toHaveBeenCalledTimes(1);
		off();
		quota.setDesiredProbes(7);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe('refreshLocalQuota', () => {
	it('成功时写入本地额度并标记可达', async () => {
		const quota = await init();
		localImpl = async () => limitsResponse({ limit: 60, remaining: 33, reset: 15 }, 4);
		await quota.refreshLocalQuota();
		const local = quota.getQuotaState().local;
		expect(local.remaining).toBe(33);
		expect(local.reset).toBe(15);
		expect(local.creditsRemaining).toBe(4);
		expect(quota.getQuotaState().directReachable).toBe(true);
	});

	it('非 2xx 视为失败并标记不可达', async () => {
		localImpl = async () => limitsResponse({ limit: 60, remaining: 60 }, undefined, 500);
		const quota = await init();
		expect(quota.getQuotaState().directReachable).toBe(false);
		expect(quota.getQuotaState().local.status).toBe('unavailable');
	});

	it('响应结构不符合预期时按失败处理', async () => {
		localImpl = async () => ({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ unexpected: true }),
		}) as unknown as Response;
		const quota = await init();
		expect(quota.getQuotaState().directReachable).toBe(false);
	});

	it('已有可用快照时刷新失败不清空旧值', async () => {
		const quota = await init();
		expect(quota.getQuotaState().local.status).toBe('ready');
		localImpl = async () => {
			throw new TypeError('offline');
		};
		await quota.refreshLocalQuota();
		expect(quota.getQuotaState().local.status).toBe('ready');
		expect(quota.getQuotaState().directReachable).toBe(false);
	});

	it('并发调用共享同一个在途请求', async () => {
		const quota = await init();
		const before = localImplCalls;
		localImpl = async () => limitsResponse({ limit: 60, remaining: 10 });
		await Promise.all([quota.refreshLocalQuota(), quota.refreshLocalQuota(), quota.refreshLocalQuota()]);
		expect(localImplCalls).toBe(before + 1);
	});
});

describe('refreshProxyQuota', () => {
	it('未登录时标记为不可用且不请求', async () => {
		const quota = await init();
		const before = proxyImplCalls;
		await quota.refreshProxyQuota();
		expect(proxyImplCalls).toBe(before);
		expect(quota.getQuotaState().proxy.status).toBe('unavailable');
	});

	it('后端未开启代理时标记为不可用', async () => {
		loggedIn = true;
		const quota = await init(configFixture({ proxyAvailable: false }));
		expect(quota.getQuotaState().proxy.status).toBe('unavailable');
	});

	it('已登录时拉取代币额度', async () => {
		loggedIn = true;
		proxyImpl = async () => limitsResponse({ limit: 250, remaining: 240, reset: 300 }, 12);
		const quota = await init();
		const proxy = quota.getQuotaState().proxy;
		expect(proxy.status).toBe('ready');
		expect(proxy.limit).toBe(250);
		expect(proxy.remaining).toBe(240);
		expect(proxy.creditsRemaining).toBe(12);
	});

	it('请求失败时标记不可用', async () => {
		loggedIn = true;
		proxyImpl = async () => {
			throw new TypeError('offline');
		};
		const quota = await init();
		expect(quota.getQuotaState().proxy.status).toBe('unavailable');
	});

	it('非 2xx 响应标记不可用', async () => {
		loggedIn = true;
		proxyImpl = async () => limitsResponse({ limit: 250, remaining: 250 }, undefined, 429);
		const quota = await init();
		expect(quota.getQuotaState().proxy.status).toBe('unavailable');
	});

	it('响应缺少测量额度字段时标记不可用', async () => {
		loggedIn = true;
		proxyImpl = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) }) as unknown as Response;
		const quota = await init();
		expect(quota.getQuotaState().proxy.status).toBe('unavailable');
	});

	it('响应字段类型不符时标记不可用', async () => {
		loggedIn = true;
		proxyImpl
			= async () =>
				({
					ok: true,
					status: 200,
					headers: new Headers(),
					json: async () => ({ rateLimit: { measurements: { create: { limit: '250', remaining: 5 } } } }),
				}) as unknown as Response;
		const quota = await init();
		expect(quota.getQuotaState().proxy.status).toBe('unavailable');
	});

	it('并发调用共享同一个在途请求', async () => {
		loggedIn = true;
		const quota = await init();
		const before = proxyImplCalls;
		await Promise.all([quota.refreshProxyQuota(), quota.refreshProxyQuota()]);
		expect(proxyImplCalls).toBe(before + 1);
	});
});

describe('initQuota / 心跳 / 登录态同步', () => {
	it('重复初始化不会重复注册心跳', async () => {
		const quota = await init();
		const before = localImplCalls;
		quota.initQuota(configFixture());
		await jest.advanceTimersByTimeAsync(0);
		expect(localImplCalls).toBe(before + 1);
	});

	it('心跳每 5 分钟刷新一次两条额度', async () => {
		loggedIn = true;
		await init();
		const localBefore = localImplCalls;
		const proxyBefore = proxyImplCalls;
		await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(localImplCalls).toBe(localBefore + 1);
		expect(proxyImplCalls).toBe(proxyBefore + 1);
	});

	it('恢复偏好为 proxy', async () => {
		loggedIn = true;
		localStorage.setItem('pa-quota-preference', 'proxy');
		const quota = await init();
		expect(quota.getQuotaState().preference).toBe('proxy');
	});

	it('错误的存储值被忽略', async () => {
		localStorage.setItem('pa-quota-preference', 'weird');
		const quota = await init();
		expect(quota.getQuotaState().preference).toBe('auto');
	});

	it('localStorage 读取失败时按默认偏好处理', async () => {
		jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const quota = await init();
		expect(quota.getQuotaState().preference).toBe('auto');
	});

	it('切回前台且数据陈旧时补查一次', async () => {
		const quota = await init();
		expect(quota.getQuotaState().local.remaining).toBe(60);
		await jest.advanceTimersByTimeAsync(31_000);
		// 注意：其他用例遗留的 visibilitychange 监听器也会响应这次派发，
		// 因此这里只断言当前模块实例的状态被刷新，而不校验调用次数
		localImpl = async () => limitsResponse({ limit: 60, remaining: 21 });
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
		document.dispatchEvent(new Event('visibilitychange'));
		await jest.advanceTimersByTimeAsync(0);
		expect(quota.getQuotaState().local.remaining).toBe(21);
	});

	it('数据仍然新鲜时切回前台不重复请求', async () => {
		const quota = await init();
		localImpl = async () => limitsResponse({ limit: 60, remaining: 21 });
		Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
		document.dispatchEvent(new Event('visibilitychange'));
		await jest.advanceTimersByTimeAsync(0);
		expect(quota.getQuotaState().local.remaining).toBe(60);
	});

	it('syncAuth 重新拉取代理额度', async () => {
		loggedIn = true;
		const quota = await init();
		const before = proxyImplCalls;
		proxyImpl = async () => limitsResponse({ limit: 250, remaining: 1 });
		quota.syncAuth();
		await jest.advanceTimersByTimeAsync(0);
		expect(proxyImplCalls).toBe(before + 1);
		expect(quota.getQuotaState().proxy.remaining).toBe(1);
	});

	it('refreshAll 同时刷新两条额度', async () => {
		loggedIn = true;
		const quota = await init();
		const localBefore = localImplCalls;
		const proxyBefore = proxyImplCalls;
		quota.refreshAll();
		await jest.advanceTimersByTimeAsync(0);
		expect(localImplCalls).toBe(localBefore + 1);
		expect(proxyImplCalls).toBe(proxyBefore + 1);
	});

	it('stopQuota 后心跳停止', async () => {
		loggedIn = true;
		const quota = await init();
		quota.stopQuota();
		const localBefore = localImplCalls;
		const proxyBefore = proxyImplCalls;
		await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
		expect(localImplCalls).toBe(localBefore);
		expect(proxyImplCalls).toBe(proxyBefore);
	});

	it('stopQuota 后重置复查定时器被清除', async () => {
		const quota = await init();
		quota.applyQuotaHeaders(rateHeaders(60, 0, 3), 'ip');
		quota.stopQuota();
		const before = localImplCalls;
		await jest.advanceTimersByTimeAsync(60_000);
		expect(localImplCalls).toBe(before);
	});

	it('stopQuota 后可重新初始化', async () => {
		const quota = await init();
		quota.stopQuota();
		const before = localImplCalls;
		quota.initQuota(configFixture());
		await jest.advanceTimersByTimeAsync(0);
		expect(localImplCalls).toBe(before + 1);
	});

	it('重复调用 stopQuota 不会报错', async () => {
		const quota = await init();
		quota.stopQuota();
		expect(() => quota.stopQuota()).not.toThrow();
	});
});
