import type { AppConfig, AuthStatus, UpstreamErrorBody } from './types';
import { ApiError } from './types';

export { ApiError } from './types';

/** 上游默认地址；后端 `/api/config` 不可用时使用 */
const DEFAULT_API_URL = 'https://api.globalping.io';

const FALLBACK_CONFIG: AppConfig = {
	apiUrl: DEFAULT_API_URL,
	proxyAvailable: false,
	maxProbes: { direct: 50, proxy: 500 },
};

let config: AppConfig | null = null;
let configPromise: Promise<AppConfig> | null = null;
let authStatus: AuthStatus = { loggedIn: false, authEnabled: false, user: null };
const authListeners = new Set<(status: AuthStatus) => void>();

/** 从上游错误体提取可读信息，构造零状态码的 ApiError */
function toApiError(body: UpstreamErrorBody | null, status: number, headers: Headers): ApiError {
	const rawType = body?.error?.type ?? '';
	const message = body?.error?.message ?? `HTTP ${status}`;
	return new ApiError(message, status, rawType, body?.error?.params ?? {}, headers);
}

/** 尽力解析 JSON 错误体；非 JSON 时返回 null */
async function parseErrorBody(res: Response): Promise<UpstreamErrorBody | null> {
	try {
		return (await res.json()) as UpstreamErrorBody;
	}
	catch {
		return null;
	}
}

/**
 * 发起请求并解析 JSON。
 * 非 2xx 时抛出带状态码/错误类型/响应头的 {@link ApiError}，调用方据此更新额度并提示。
 */
async function requestJsonData<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	if (!res.ok) {
		throw toApiError(await parseErrorBody(res), res.status, res.headers);
	}
	// 204 等无正文响应
	if (res.status === 204) {
		return undefined as T;
	}
	return (await res.json()) as T;
}

/** 读取站点配置（进程内缓存单次请求结果） */
export async function loadConfig(): Promise<AppConfig> {
	if (config) {
		return config;
	}
	if (!configPromise) {
		configPromise = requestJsonData<AppConfig>('/api/config')
			.then((data) => {
				config = data;
				return data;
			})
			.catch(() => {
				config = FALLBACK_CONFIG;
				return FALLBACK_CONFIG;
			});
	}
	return configPromise;
}

export function getConfig(): AppConfig {
	return config ?? FALLBACK_CONFIG;
}

/** 直连上游（浏览器 → globalping.io），携带用户自己的 IP 额度 */
export function directFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${getConfig().apiUrl}${path}`, init);
}

/** 代理请求（浏览器 → 本服务后端 → globalping.io，套用服务端代币） */
export function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
	return fetch(`/api${path}`, init);
}

/** 拉取登录态；401 时自动重新读取一次（会话可能已在别处刷新） */
export async function loadAuthStatus(): Promise<AuthStatus> {
	try {
		authStatus = await requestJsonData<AuthStatus>('/api/auth/status');
	}
	catch (error) {
		if (error instanceof ApiError && error.status === 401) {
			try {
				authStatus = await requestJsonData<AuthStatus>('/api/auth/status');
			}
			catch {
				authStatus = { loggedIn: false, authEnabled: false, user: null };
			}
		}
		else {
			authStatus = { loggedIn: false, authEnabled: false, user: null };
		}
	}
	for (const listener of authListeners) {
		listener(authStatus);
	}
	return authStatus;
}

export function getAuthStatus(): AuthStatus {
	return authStatus;
}

export function isLoggedIn(): boolean {
	return authStatus.loggedIn;
}

/** 订阅登录态变化（回调立即以当前值触发一次） */
export function onAuthChange(listener: (status: AuthStatus) => void): () => void {
	authListeners.add(listener);
	listener(authStatus);
	return () => authListeners.delete(listener);
}

/** 统一的 JSON 请求入口（同源后端），非 2xx 抛 {@link ApiError} */
export function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
	return requestJsonData<T>(`/api${path}`, init);
}

/** 把上游 JSON 响应转成 `{ status, data }`；额度相关的错误也一并回传响应头 */
export async function readUpstream<T>(res: Response): Promise<{ data: T; headers: Headers }> {
	if (!res.ok) {
		throw toApiError(await parseErrorBody(res), res.status, res.headers);
	}
	const data = (await res.json()) as T;
	return { data, headers: res.headers };
}
