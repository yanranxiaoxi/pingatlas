import type {
	AppConfig,
	QuotaActor,
	QuotaMode,
	QuotaPreference,
	QuotaSnapshot,
} from './types';
import { directFetch, isLoggedIn, proxyFetch } from './api';
import { t } from './i18n';
import { toast } from './ui';

/** 用户偏好持久化键；`auto` = 本地优先、耗尽自动降级 */
const PREFERENCE_KEY = 'pa-quota-preference';
/** 本地额度心跳间隔。`/v1/limits` 不消耗额度，可以放心定期拉取 */
const HEARTBEAT_MS = 5 * 60 * 1000;
/** 从后台切回前台时，超过该时长才补一次查询，避免频繁请求 */
const RESUME_STALE_MS = 30 * 1000;
/** 本地额度耗尽后，在 `reset` 基础上多等这段时间再复查，规避边界误差 */
const RESET_GRACE_MS = 2000;

export interface QuotaState {
	local: QuotaSnapshot;
	proxy: QuotaSnapshot;
	preference: QuotaPreference;
	/** 浏览器能否直达 globalping.io（false 表示必须走代理） */
	directReachable: boolean;
	/** 代理路径当前是否可用（后端已配置代币且用户已登录） */
	proxyUsable: boolean;
	/** 表单当前期望的节点数 */
	desiredProbes: number;
	/** 当前登录态允许的最大节点数 */
	maxProbes: number;
	mode: QuotaMode;
	/** 当前生效的额度条（`unreachable` 时为 null） */
	activeActor: QuotaActor | null;
}

function emptySnapshot(actor: QuotaActor): QuotaSnapshot {
	return { status: 'loading', actor, limit: 0, remaining: 0, reset: 0, updatedAt: 0 };
}

const state: {
	local: QuotaSnapshot;
	proxy: QuotaSnapshot;
	preference: QuotaPreference;
	directReachable: boolean;
	desiredProbes: number;
} = {
	local: emptySnapshot('ip'),
	proxy: emptySnapshot('user'),
	preference: 'auto',
	// 首次探测完成前乐观地认为可直连，避免登录后才首次可用
	directReachable: true,
	desiredProbes: 3,
};

let config: AppConfig | null = null;
let initialized = false;
let heartbeatTimer: number | undefined;
let resetTimer: number | undefined;
let localInFlight: Promise<void> | null = null;
let proxyInFlight: Promise<void> | null = null;
let lastLocalFetch = 0;

const listeners = new Set<(state: QuotaState) => void>();

function storageGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	}
	catch {
		return null;
	}
}

function storageSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// 忽略
	}
}

function persistPreference(preference: QuotaPreference): void {
	storageSet(PREFERENCE_KEY, preference);
}

function proxyUsable(): boolean {
	return Boolean(config?.proxyAvailable) && isLoggedIn();
}

function maxProbesForCurrentAuth(): number {
	if (!config) {
		return 50;
	}
	if (config.proxyAvailable && isLoggedIn()) {
		// 已登录时按代理上限放开；实际生效路径再由 resolveMode 决定
		return config.maxProbes.proxy;
	}
	return config.maxProbes.direct;
}

/**
 * 判定本次请求应该走哪条路径。顺序即优先级：
 * 1. 直连不可达 → 代理（否则 unreachable）
 * 2. 本地额度耗尽 → 代理（否则 exhausted）
 * 3. 节点数超过匿名上限 → 代理
 * 4. 用户手动切到代理 → 代理
 * 5. 否则直连
 */
export function resolveMode(probeCount = state.desiredProbes): QuotaMode {
	const usable = proxyUsable();
	if (!state.directReachable) {
		return usable ? 'proxy' : 'unreachable';
	}
	if (state.local.status === 'ready' && state.local.remaining <= 0) {
		return usable ? 'proxy' : 'exhausted';
	}
	if (config && probeCount > config.maxProbes.direct && usable) {
		return 'proxy';
	}
	if (state.preference === 'proxy' && usable) {
		return 'proxy';
	}
	return 'direct';
}

function buildState(): QuotaState {
	const mode = resolveMode();
	let activeActor: QuotaActor | null = null;
	if (mode === 'direct') {
		activeActor = 'ip';
	}
	else if (mode === 'proxy') {
		activeActor = 'user';
	}
	return {
		local: state.local,
		proxy: state.proxy,
		preference: state.preference,
		directReachable: state.directReachable,
		proxyUsable: proxyUsable(),
		desiredProbes: state.desiredProbes,
		maxProbes: maxProbesForCurrentAuth(),
		mode,
		activeActor,
	};
}

function notify(): void {
	const snapshot = buildState();
	for (const listener of listeners) {
		listener(snapshot);
	}
}

/** 订阅额度状态变化（回调立即以当前值触发一次） */
export function onQuotaChange(listener: (state: QuotaState) => void): () => void {
	listeners.add(listener);
	listener(buildState());
	return () => listeners.delete(listener);
}

export function getQuotaState(): QuotaState {
	return buildState();
}

/** 剩余的重置秒数（按快照时刻本地推算，避免每秒重算依赖上游） */
export function getResetSeconds(snapshot: QuotaSnapshot): number {
	if (snapshot.status !== 'ready') {
		return 0;
	}
	const elapsed = (Date.now() - snapshot.updatedAt) / 1000;
	return Math.max(0, snapshot.reset - elapsed);
}

function readRateLimit(headers: Headers): { limit: number; remaining: number; reset: number } | null {
	const limitRaw = headers.get('X-RateLimit-Limit');
	const remainingRaw = headers.get('X-RateLimit-Remaining');
	if (limitRaw === null || remainingRaw === null) {
		return null;
	}
	const limit = Number(limitRaw);
	const remaining = Number(remainingRaw);
	if (!Number.isFinite(limit) || !Number.isFinite(remaining)) {
		return null;
	}
	const reset = Number(headers.get('X-RateLimit-Reset') ?? '');
	return { limit, remaining, reset: Number.isFinite(reset) ? Math.max(0, reset) : 0 };
}

function readCredits(headers: Headers): number | undefined {
	const raw = headers.get('X-Credits-Remaining');
	if (raw === null) {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function clearResetTimer(): void {
	if (resetTimer !== undefined) {
		window.clearTimeout(resetTimer);
		resetTimer = undefined;
	}
}

/**
 * 已知窗口何时重置时，在那一刻之后精准复查一次。
 * 除了让「耗尽 → 恢复」尽快切回本地，也避免额度未耗尽时倒计时走到 00:00
 * 后仍旧挂着过期数值，最长要等一个心跳间隔才纠正。
 */
function scheduleResetCheck(snapshot: QuotaSnapshot): void {
	clearResetTimer();
	if (snapshot.status !== 'ready') {
		return;
	}
	const delay = snapshot.reset > 0
		? (snapshot.reset + RESET_GRACE_MS / 1000) * 1000
		// reset 缺失（窗口尚未开始）时退回心跳间隔，避免每 2 秒重试一次
		: HEARTBEAT_MS;
	resetTimer = window.setTimeout(() => {
		resetTimer = undefined;
		void refreshLocalQuota();
	}, delay);
}

/**
 * 本地额度重置（`remaining` 由 0 变正）时自动切回本地：
 * 若此前因耗尽被自动降级到代理，此时把偏好复位为 `auto`。
 */
function handleLocalReset(): void {
	clearResetTimer();
	if (state.preference === 'proxy') {
		state.preference = 'auto';
		persistPreference('auto');
		toast(t('quotaResetBackToLocal'), 'success');
	}
}

function commit(actor: QuotaActor, next: QuotaSnapshot): void {
	if (actor === 'ip') {
		const previous = state.local;
		state.local = next;
		if (previous.status === 'ready' && previous.remaining <= 0 && next.remaining > 0) {
			handleLocalReset();
		}
		scheduleResetCheck(next);
	}
	else {
		state.proxy = next;
	}
	notify();
}

/**
 * 用测量响应的限额头就地更新额度，避免每次都额外拉 `/v1/limits`。
 * 同时通过 `remaining` 由 0 变正检测本地额度重置。
 */
export function applyQuotaHeaders(headers: Headers, actor: QuotaActor): void {
	const parsed = readRateLimit(headers);
	if (!parsed) {
		return;
	}
	commit(actor, {
		status: 'ready',
		actor,
		limit: parsed.limit,
		remaining: parsed.remaining,
		reset: parsed.reset,
		creditsRemaining: readCredits(headers),
		updatedAt: Date.now(),
	});
}

/** 拉取本地（匿名 IP）额度；`/v1/limits` 不消耗额度 */
export function refreshLocalQuota(): Promise<void> {
	if (localInFlight) {
		return localInFlight;
	}
	localInFlight = (async () => {
		try {
			const res = await directFetch('/v1/limits', { headers: { Accept: 'application/json' } });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				rateLimit?: { measurements?: { create?: { limit?: number; remaining?: number; reset?: number } } };
				credits?: { remaining?: number };
			};
			const rate = data.rateLimit?.measurements?.create;
			if (!rate || typeof rate.limit !== 'number' || typeof rate.remaining !== 'number') {
				throw new Error('Unexpected /v1/limits payload');
			}
			lastLocalFetch = Date.now();
			if (!state.directReachable) {
				state.directReachable = true;
			}
			commit('ip', {
				status: 'ready',
				actor: 'ip',
				limit: rate.limit,
				remaining: rate.remaining,
				reset: typeof rate.reset === 'number' ? rate.reset : 0,
				creditsRemaining: data.credits?.remaining,
				updatedAt: Date.now(),
			});
		}
		catch {
			// 直连失败（断网/CORS/被拦截）：标记不可达，交由 resolveMode 决定降级
			state.directReachable = false;
			if (state.local.status !== 'ready') {
				state.local = { ...state.local, status: 'unavailable' };
			}
			notify();
		}
		finally {
			localInFlight = null;
		}
	})();
	return localInFlight;
}

/** 拉取服务端代币额度（需登录；未登录或后端未配置代币时标记不可用） */
export function refreshProxyQuota(): Promise<void> {
	if (!config?.proxyAvailable || !isLoggedIn()) {
		state.proxy = { ...emptySnapshot('user'), status: 'unavailable' };
		notify();
		return Promise.resolve();
	}
	if (proxyInFlight) {
		return proxyInFlight;
	}
	proxyInFlight = (async () => {
		try {
			const res = await proxyFetch('/v1/limits', { headers: { Accept: 'application/json' } });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const data = (await res.json()) as {
				rateLimit?: { measurements?: { create?: { limit?: number; remaining?: number; reset?: number } } };
				credits?: { remaining?: number };
			};
			const rate = data.rateLimit?.measurements?.create;
			if (!rate || typeof rate.limit !== 'number' || typeof rate.remaining !== 'number') {
				throw new Error('Unexpected /v1/limits payload');
			}
			commit('user', {
				status: 'ready',
				actor: 'user',
				limit: rate.limit,
				remaining: rate.remaining,
				reset: typeof rate.reset === 'number' ? rate.reset : 0,
				creditsRemaining: data.credits?.remaining,
				updatedAt: Date.now(),
			});
		}
		catch {
			state.proxy = { ...state.proxy, status: 'unavailable' };
			notify();
		}
		finally {
			proxyInFlight = null;
		}
	})();
	return proxyInFlight;
}

/** 表单期望节点数变化（会触发模式重算） */
export function setDesiredProbes(count: number): void {
	if (state.desiredProbes === count) {
		return;
	}
	state.desiredProbes = count;
	notify();
}

/**
 * 切换额度偏好。仅在本地额度确有结余或代理可用时才允许，否则提示并保持原状。
 */
export function setPreference(preference: QuotaPreference): void {
	if (preference === state.preference) {
		return;
	}
	if (preference === 'proxy') {
		if (!proxyUsable()) {
			toast(t('quotaProxyUnavailable'), 'error');
			return;
		}
	}
	else {
		if (!state.directReachable) {
			toast(t('quotaDirectUnreachable'), 'error');
			return;
		}
		if (state.local.status === 'ready' && state.local.remaining <= 0) {
			toast(t('quotaLocalExhausted'), 'error');
			return;
		}
	}
	state.preference = preference;
	persistPreference(preference);
	notify();
}

/** 心跳 + 回前台补查 + 初始拉取 */
export function initQuota(appConfig: AppConfig): void {
	config = appConfig;
	if (initialized) {
		void refreshAll();
		return;
	}
	initialized = true;
	const stored = storageGet(PREFERENCE_KEY);
	if (stored === 'proxy') {
		state.preference = 'proxy';
	}
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && Date.now() - lastLocalFetch > RESUME_STALE_MS) {
			void refreshLocalQuota();
		}
	});
	heartbeatTimer = window.setInterval(() => {
		void refreshLocalQuota();
		void refreshProxyQuota();
	}, HEARTBEAT_MS);
	void refreshAll();
}

/** 登录态变化后重新拉取代币额度并重算模式 */
export function syncAuth(): void {
	void refreshProxyQuota();
	notify();
}

export function refreshAll(): void {
	void refreshLocalQuota();
	void refreshProxyQuota();
}

/** 仅测试/诊断用：停止心跳 */
export function stopQuota(): void {
	if (heartbeatTimer !== undefined) {
		window.clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	}
	clearResetTimer();
	initialized = false;
}
