import type { IContext } from '../utils/interface';
import type { ProbeIndexData, ProbeRecord, RawProbe } from '../utils/probe-index';
import * as packageJson from '../../package.json';
import { CONFIG } from '../config/config';
import { buildProbeIndex, buildProbeList } from '../utils/probe-index';
import { exceedsContentLength, MAX_UPSTREAM_BODY, readJsonBody, readTextWithLimit } from '../utils/request';
import { getSessionUser, sendJson } from '../utils/respond';
import { Controller } from './controller';

/** 匿名单次测量可选的 probe 数量上限（Globalping 官方硬限制，实测 limit:60 → 400） */
export const ANONYMOUS_MAX_PROBES = 50;
/** 认证（含服务端代币）单次测量可选的上限 */
export const AUTHENTICATED_MAX_PROBES = 500;

/**
 * 探针索引缓存时长
 *
 * 探针上下线是分钟级的，5 分钟足够新鲜；缓存同时也把「任何人猛刷 /api/probes」
 * 转化成最多每 5 分钟一次上游请求。
 */
export const PROBE_INDEX_TTL = 5 * 60 * 1000;

/**
 * 需要透传给前端的上游响应头
 *
 * 限额头让前端在每次测量后「就地更新」额度显示，无需额外请求；
 * ETag / Location 用于测量轮询与缓存协商。
 */
const PASSTHROUGH_HEADERS = [
	'x-ratelimit-limit',
	'x-ratelimit-consumed',
	'x-ratelimit-remaining',
	'x-ratelimit-reset',
	'x-request-cost',
	'x-credits-consumed',
	'x-credits-remaining',
	'retry-after',
	'location',
	'etag',
];

/** 上游不可达 / 超时的统一错误体（结构对齐 Globalping 报错体，前端可复用同一套渲染） */
const UPSTREAM_ERROR = { error: { type: 'upstream_error', message: 'Globalping API is unreachable' } };
/** 上游响应超过本地缓冲上限：不限制用量，只避免病态响应耗尽内存 */
const RESPONSE_TOO_LARGE = { error: { type: 'response_too_large', message: 'Upstream response exceeds the local buffer limit' } };

/** 探针索引进程内缓存（含过期时刻） */
let probeIndexCache: { index: ProbeIndexData; list: ProbeRecord[]; expiresAt: number } | null = null;
/** 正在进行的上游拉取，用于把并发请求合并成一次 */
let probeIndexPending: Promise<{ index: ProbeIndexData; list: ProbeRecord[] } | null> | null = null;

/** 同一份上游数据同时产出「去重索引」与「精简探针列表」 */
interface ProbeData {
	index: ProbeIndexData;
	list: ProbeRecord[];
}

/**
 * Globalping 代理控制器
 *
 * 仅在「用户本地 250/h 额度已用尽」或「请求节点数超过匿名上限」等场景被使用：
 * 后端注入 `GP_TOKEN` 转发请求，并原样透传上游状态码、JSON 与限量响应头。
 * 全部接口返回原生 JSON（不使用框架 `api.middleware.ts` 的 `{success,code,result}` 信封），
 * 因为必须原样保留上游报错结构；`GP_TOKEN` 永不下发前端。
 */
class Globalping extends Controller {
	/** GET /api/config：前端配置（不含任何机密，可公开） */
	public async config(ctx: IContext) {
		sendJson(ctx.res, 200, {
			apiUrl: CONFIG.gp.apiUrl,
			proxyAvailable: this.proxyAvailable(),
			maxProbes: {
				direct: ANONYMOUS_MAX_PROBES,
				proxy: AUTHENTICATED_MAX_PROBES,
			},
		});
	}

	/** GET /api/limits：服务端代币的额度快照（登录后用于左下角第二条额度） */
	public async limits(ctx: IContext) {
		if (!this.requireProxy(ctx)) {
			return;
		}
		await this.forward(ctx, '/v1/limits', { method: 'GET' });
	}

	/**
	 * GET /api/probes：探针位置索引（位置筛选自动补全的数据源）
	 *
	 * 公开数据、不消耗测量额度、不涉及 `GP_TOKEN`，因此无需登录；
	 * 上游 `Cache-Control` 只有 1 秒，所以在服务端做 5 分钟缓存并直接送给浏览器。
	 */
	public async probes(ctx: IContext) {
		const data = await this.probeData(ctx);
		if (!data) {
			sendJson(ctx.res, 502, UPSTREAM_ERROR);
			return;
		}
		this.sendProbeIndex(ctx, data.index, data.state);
	}

	/**
	 * GET /api/probe-list：精简探针列表（「Probes 列表」标签页的数据源）
	 *
	 * 与索引共用同一次上游拉取和同一份缓存，因此同时打开两个标签页只会打上游一次。
	 * 体积约 500 KB（gzip 后约 70 KB），前端只在真正需要时才拉取。
	 */
	public async probeList(ctx: IContext) {
		const data = await this.probeData(ctx);
		if (!data) {
			sendJson(ctx.res, 502, UPSTREAM_ERROR);
			return;
		}
		ctx.res.setHeader('Cache-Control', `public, max-age=${Math.floor(PROBE_INDEX_TTL / 1000)}`);
		ctx.res.setHeader('X-Probe-Index', data.state);
		sendJson(ctx.res, 200, data.list);
	}

	/**
	 * 取探针数据（缓存命中 → 直出；否则拉取，失败时退回稍旧的缓存）
	 * @returns 上游不可达且无可用缓存时返回 null
	 */
	private async probeData(ctx: IContext): Promise<{ index: ProbeIndexData; list: ProbeRecord[]; state: 'hit' | 'miss' | 'stale' } | null> {
		const cached = probeIndexCache;
		if (cached && cached.expiresAt > Date.now()) {
			return { index: cached.index, list: cached.list, state: 'hit' };
		}
		const fresh = await this.loadProbeIndex(ctx);
		// 上游抖动时退回稍旧的数据，比让前端同时丢掉自动补全和探针列表更好
		const data = fresh ?? cached;
		if (!data) {
			return null;
		}
		return { index: data.index, list: data.list, state: fresh ? 'miss' : 'stale' };
	}

	/** 写出探针索引（浏览器/CDN 也可缓存 5 分钟） */
	private sendProbeIndex(ctx: IContext, data: ProbeIndexData, state: 'hit' | 'miss' | 'stale'): void {
		ctx.res.setHeader('Cache-Control', `public, max-age=${Math.floor(PROBE_INDEX_TTL / 1000)}`);
		ctx.res.setHeader('X-Probe-Index', state);
		sendJson(ctx.res, 200, data);
	}

	/**
	 * 拉取并构建探针数据（进程内缓存 + 并发去重）
	 * @returns 上游不可达且无可用缓存时返回 null
	 */
	private async loadProbeIndex(ctx: IContext): Promise<ProbeData | null> {
		if (!probeIndexPending) {
			probeIndexPending = this.fetchProbeData(ctx)
				.then((data) => {
					if (data) {
						probeIndexCache = { ...data, expiresAt: Date.now() + PROBE_INDEX_TTL };
					}
					return data;
				})
				.finally(() => {
					probeIndexPending = null;
				});
		}
		return probeIndexPending;
	}

	/** 单次真正访问上游；失败返回 null（由调用方决定是否退回旧缓存） */
	private async fetchProbeData(ctx: IContext): Promise<ProbeData | null> {
		const url = `${CONFIG.gp.apiUrl.replace(/\/+$/, '')}/v1/probes`;
		try {
			const res = await fetch(url, {
				headers: {
					'Accept': 'application/json',
					'User-Agent': `${packageJson.name}/${packageJson.version}`,
				},
				signal: AbortSignal.timeout(CONFIG.gp.timeout),
			});
			if (!res.ok) {
				ctx.logger.error(`probe index upstream returned ${res.status}`);
				return null;
			}
			const probes = (await res.json()) as RawProbe[];
			return { index: buildProbeIndex(probes), list: buildProbeList(probes) };
		}
		catch (ex) {
			ctx.logger.error('probe index upstream failed', ex);
			return null;
		}
	}

	/** POST /api/measurements：创建测量（代理模式） */
	public async createMeasurement(ctx: IContext) {
		if (!this.requireProxy(ctx)) {
			return;
		}
		if (exceedsContentLength(ctx.req)) {
			sendJson(ctx.res, 413, { error: { type: 'payload_too_large', message: 'Request body too large' } });
			return;
		}
		let payload: Record<string, unknown>;
		try {
			payload = await readJsonBody(ctx.req);
		}
		catch {
			sendJson(ctx.res, 400, { error: { type: 'invalid_body', message: 'Request body must be valid JSON' } });
			return;
		}
		await this.forward(ctx, '/v1/measurements', { method: 'POST', body: JSON.stringify(payload) });
	}

	/** GET /api/measurements/:id：查询测量结果（代理模式轮询） */
	public async getMeasurement(ctx: IContext) {
		if (!this.requireProxy(ctx)) {
			return;
		}
		const id = ctx.routerParams.id;
		if (typeof id !== 'string' || !this.isSafeId(id)) {
			sendJson(ctx.res, 400, { error: { type: 'invalid_id', message: 'Invalid measurement id' } });
			return;
		}
		await this.forward(ctx, `/v1/measurements/${encodeURIComponent(id)}`, { method: 'GET' });
	}

	/** 代理是否可用：已配置服务端代币 */
	private proxyAvailable(): boolean {
		return Boolean(CONFIG.gp.token);
	}

	/**
	 * 代理接口前置校验
	 * @returns 通过校验返回 true；否则已写出 503 / 401 并返回 false
	 */
	private requireProxy(ctx: IContext): boolean {
		if (!this.proxyAvailable()) {
			sendJson(ctx.res, 503, { error: { type: 'proxy_unavailable', message: 'Server token is not configured' } });
			return false;
		}
		if (!getSessionUser(ctx.user)) {
			sendJson(ctx.res, 401, { error: { type: 'unauthorized', message: 'Login required to use the server token' } });
			return false;
		}
		return true;
	}

	/** 测量 id 仅允许 Globalping 使用的字符集，避免路径拼接注入 */
	private isSafeId(id: string): boolean {
		return /^[\w-]{1,64}$/.test(id);
	}

	/**
	 * 转发请求到 Globalping 并透传响应
	 *
	 * 网络错误 / 超时返回 502 + 结构化错误体（而非框架的 500 纯文本），
	 * 让前端能和上游自身的错误走同一套本地化渲染。
	 */
	private async forward(ctx: IContext, pathname: string, init: { method: string; body?: string }): Promise<void> {
		const url = `${CONFIG.gp.apiUrl.replace(/\/+$/, '')}${pathname}`;
		const headers: Record<string, string> = {
			'Accept': 'application/json',
			'Authorization': `Bearer ${CONFIG.gp.token}`,
			'User-Agent': `${packageJson.name}/${packageJson.version}`,
		};
		if (init.body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}

		let upstream: Response;
		try {
			upstream = await fetch(url, {
				method: init.method,
				headers,
				body: init.body,
				signal: AbortSignal.timeout(CONFIG.gp.timeout),
			});
		}
		catch (ex) {
			ctx.logger.error('globalping upstream failed', ex);
			sendJson(ctx.res, 502, UPSTREAM_ERROR);
			return;
		}

		// 读取失败（连接中断等）时按空响应处理，保持与既有行为一致；超限则明确报错
		let text: string | null;
		try {
			text = await readTextWithLimit(upstream);
		}
		catch (ex) {
			ctx.logger.warn('globalping upstream body read failed', ex);
			text = '';
		}
		if (text === null) {
			ctx.logger.warn(`globalping upstream response exceeded ${MAX_UPSTREAM_BODY} bytes`);
			sendJson(ctx.res, 502, RESPONSE_TOO_LARGE);
			return;
		}
		for (const name of PASSTHROUGH_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) {
				ctx.res.setHeader(name, value);
			}
		}
		// 便于同页脚本或其他来源读取限量信息
		ctx.res.setHeader('Access-Control-Expose-Headers', PASSTHROUGH_HEADERS.join(', '));
		ctx.res.statusCode = upstream.status;
		ctx.res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
		ctx.res.write(text);
	}
}

const globalping = new Globalping();
export default globalping;
