import type {
	LocationFilters,
	LocationOption,
	MeasurementOptions,
	MeasurementRequest,
	MeasurementResponse,
	MeasurementType,
} from './types';
import { ApiError, directFetch, proxyFetch } from './api';
import { t } from './i18n';
import { closeAllSuggests, initLocationSuggests } from './location-suggest';
import { setActiveTab } from './panel';
import { normalizeMagic } from './probes';
import { applyQuotaHeaders, getQuotaState, onQuotaChange, resolveMode, setDesiredProbes } from './quota';
import { renderMeasurement, renderResultsError, renderResultsPlaceholder, renderResultsRunning } from './results';
import { el, toast } from './ui';

/** 上游要求：收到响应后至少间隔 500ms 再查询，且不超过 2 次/秒/测量 */
const POLL_INTERVAL_MS = 500;
/** 客户端在上游 `timeout` 之外额外预留的时间 */
const POLL_GRACE_MS = 15000;
const MEASUREMENT_TYPES: MeasurementType[] = ['ping', 'traceroute', 'dns', 'mtr', 'http'];
/** 节点数快捷选择值 */
export const LIMIT_PRESETS = [1, 3, 5, 10, 25, 50, 100, 500];

/** 上游/本站错误类型 → 本地化文案 */
const ERROR_TYPE_KEYS: Record<string, string> = {
	no_probes_found: 'errorNoProbesFound',
	validation_error: 'errorValidation',
	not_found: 'errorNotFound',
	unauthorized: 'errorUnauthorized',
	too_many_requests: 'errorTooManyRequests',
	payload_too_large: 'errorPayloadTooLarge',
	proxy_unavailable: 'errorProxyUnavailable',
	upstream_error: 'errorUpstream',
	response_too_large: 'errorResponseTooLarge',
	internal_error: 'errorUpstream',
};

/** 错误类型缺失时的状态码兜底文案 */
const ERROR_STATUS_KEYS: Record<number, string> = {
	400: 'errorValidation',
	401: 'errorUnauthorized',
	403: 'errorUnauthorized',
	404: 'errorNotFound',
	413: 'errorPayloadTooLarge',
	429: 'errorTooManyRequests',
};

let currentType: MeasurementType = 'ping';
let running = false;
/** 测量代次：新的测量提交后自增，旧轮询据此自行退出 */
let pollToken = 0;

function inputValue(id: string): string {
	const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
	return node?.value.trim() ?? '';
}

function numberValue(id: string): number | undefined {
	const raw = inputValue(id);
	if (!raw) {
		return undefined;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

function ipVersionValue(id: string): 4 | 6 | undefined {
	const raw = inputValue(id);
	if (raw === '4') {
		return 4;
	}
	if (raw === '6') {
		return 6;
	}
	return undefined;
}

/** `Name: value` 多行文本 → headers 对象；忽略空行与不含冒号的行 */
function parseHeaderLines(raw: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const index = trimmed.indexOf(':');
		if (index <= 0) {
			continue;
		}
		headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
	}
	return headers;
}

interface TargetParts {
	/** 主机名或 IP 地址 */
	target: string;
	protocol?: string;
	path?: string;
	query?: string;
}

/**
 * 拆分用户粘贴的 URL：`https://example.com/a?b=1` → `example.com` 作为 target，
 * HTTP 测量还会把协议与路径拆到对应字段（上游只接受主机名，含 `://` 会被拒绝）。
 */
function parseTarget(raw: string, type: MeasurementType): TargetParts {
	const scheme = /^([a-z][a-z\d+.-]*):\/\/(.*)$/i.exec(raw);
	const body = scheme ? scheme[2] : raw;
	const boundary = body.search(/[/?#]/);
	const target = boundary === -1 ? body : body.slice(0, boundary);
	const parts: TargetParts = { target: target || raw };
	if (type !== 'http') {
		return parts;
	}
	if (scheme) {
		const name = scheme[1].toLowerCase();
		if (name === 'http' || name === 'https') {
			parts.protocol = name.toUpperCase();
		}
	}
	if (boundary === -1) {
		return parts;
	}
	// 去掉 #fragment，剩下的按 ? 切成 path 与 query
	const rest = body.slice(boundary).split('#')[0];
	const mark = rest.indexOf('?');
	const path = mark === -1 ? rest : rest.slice(0, mark);
	if (path.length > 1) {
		parts.path = path;
	}
	if (mark !== -1 && rest.length > mark + 1) {
		parts.query = rest.slice(mark + 1);
	}
	return parts;
}

function setIfEmpty(id: string, value?: string): void {
	if (!value) {
		return;
	}
	const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
	if (node && !node.value.trim()) {
		node.value = value;
	}
}

/** 提交前把 target 里的 URL 拆分并回填到 HTTP 字段，使表单显示的内容与实际请求一致 */
function normalizeTargetInput(type: MeasurementType): void {
	const input = document.getElementById('target') as HTMLInputElement | null;
	const raw = input?.value.trim() ?? '';
	if (!input || !raw) {
		return;
	}
	const parts = parseTarget(raw, type);
	if (parts.target !== input.value) {
		input.value = parts.target;
	}
	if (type === 'http') {
		setIfEmpty('http-protocol', parts.protocol);
		setIfEmpty('http-path', parts.path);
		setIfEmpty('http-query', parts.query);
	}
}

/** 仅保留已填写的字段，避免把空字符串或空对象发给上游 */
function compact(source: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || value === null || value === '') {
			continue;
		}
		if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

/** 空对象视为「未填写」，返回 undefined 以便整体忽略该字段 */
function toOptions(fields: Record<string, unknown>): MeasurementOptions | undefined {
	return Object.keys(fields).length ? fields as unknown as MeasurementOptions : undefined;
}

/**
 * 读取当前位置筛选条件
 *
 * 「Probes 列表」与「匹配 Probes 列表」也用它，保证列表预览与实际发出的请求
 * 用的是同一份口径（尤其是结构化字段优先于 magic 这条规则）。
 */
export function readLocationFilters(): LocationFilters {
	const tags = inputValue('loc-tags');
	return {
		continent: inputValue('loc-continent'),
		country: inputValue('loc-country'),
		city: inputValue('loc-city'),
		asn: numberValue('loc-asn') ?? null,
		network: inputValue('loc-network'),
		tags: tags ? tags.split(/[\s,]+/).filter(Boolean) : [],
		magic: normalizeMagic(inputValue('loc-magic')),
	};
}

/** 把 magic 写回表单（用于「+ / ×」按钮与归一化换行） */
export function writeMagic(value: string): void {
	const field = document.getElementById('loc-magic') as HTMLTextAreaElement | null;
	if (field) {
		field.value = value;
	}
}

function buildLocation(): LocationOption | undefined {
	const filters = readLocationFilters();
	const structured = compact({
		continent: filters.continent,
		country: filters.country,
		city: filters.city,
		asn: filters.asn ?? undefined,
		network: filters.network,
		tags: filters.tags.length ? filters.tags : undefined,
	});
	// 结构化字段优先；都没有则退回 magic 自由文本
	if (Object.keys(structured).length > 0) {
		return structured as LocationOption;
	}
	return filters.magic ? { magic: filters.magic } : undefined;
}

function buildMeasurementOptions(type: MeasurementType): MeasurementOptions | undefined {
	switch (type) {
		case 'ping':
			return toOptions(compact({
				packets: numberValue('ping-packets'),
				protocol: inputValue('ping-protocol'),
				port: numberValue('ping-port'),
				ipVersion: ipVersionValue('ping-ipv'),
			}));
		case 'traceroute':
			return toOptions(compact({
				protocol: inputValue('tr-protocol'),
				port: numberValue('tr-port'),
				ipVersion: ipVersionValue('tr-ipv'),
			}));
		case 'mtr':
			return toOptions(compact({
				packets: numberValue('mtr-packets'),
				protocol: inputValue('mtr-protocol'),
				port: numberValue('mtr-port'),
				ipVersion: ipVersionValue('mtr-ipv'),
			}));
		case 'dns': {
			const queryType = inputValue('dns-qtype');
			const trace = document.getElementById('dns-trace') as HTMLInputElement | null;
			return toOptions(compact({
				query: queryType ? { type: queryType } : undefined,
				resolver: inputValue('dns-resolver'),
				protocol: inputValue('dns-protocol'),
				port: numberValue('dns-port'),
				ipVersion: ipVersionValue('dns-ipv'),
				trace: trace?.checked ? true : undefined,
			}));
		}
		case 'http': {
			const headers = parseHeaderLines(inputValue('http-headers'));
			const request = compact({
				method: inputValue('http-method'),
				path: inputValue('http-path'),
				query: inputValue('http-query'),
				headers: Object.keys(headers).length ? headers : undefined,
			});
			return toOptions(compact({
				request: Object.keys(request).length ? request : undefined,
				resolver: inputValue('http-resolver'),
				protocol: inputValue('http-protocol'),
				port: numberValue('http-port'),
				ipVersion: ipVersionValue('http-ipv'),
			}));
		}
		default:
			return undefined;
	}
}

/** 从表单读出一份测量请求；目标为空时返回 null */
function readForm(): MeasurementRequest | null {
	const target = inputValue('target');
	if (!target) {
		return null;
	}
	const type = currentType;
	const state = getQuotaState();
	const requested = numberValue('limit') ?? 3;
	const limit = Math.max(1, Math.min(requested, state.maxProbes));
	const location = buildLocation();
	const timeout = numberValue('timeout');
	const request: MeasurementRequest = {
		type,
		target,
		inProgressUpdates: true,
		limit,
	};
	if (location) {
		request.locations = [location];
	}
	if (timeout) {
		request.timeout = timeout;
	}
	const options = buildMeasurementOptions(type);
	if (options) {
		request.measurementOptions = options;
	}
	return request;
}

interface SubmitOutcome {
	response: Response;
	usedProxy: boolean;
}

/** 解析上游错误体，构造带状态码与响应头的 ApiError */
async function toUpstreamError(res: Response): Promise<ApiError> {
	let type = '';
	let message = `HTTP ${res.status}`;
	let params: Record<string, string> = {};
	try {
		const body = (await res.json()) as { error?: { type?: string; message?: string; params?: Record<string, string> } };
		type = body.error?.type ?? '';
		message = body.error?.message ?? message;
		params = body.error?.params ?? {};
	}
	catch {
		// 保留默认文案
	}
	return new ApiError(message, res.status, type, params, res.headers);
}

/**
 * 提交测量。直连失败（429 或网络不可达）且代理可用时自动改走代理重试一次。
 */
async function postMeasurement(request: MeasurementRequest): Promise<SubmitOutcome> {
	const mode = resolveMode(request.limit ?? 1);
	const send = (useProxy: boolean): Promise<Response> => {
		const path = '/v1/measurements';
		const init: RequestInit = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
		};
		return useProxy ? proxyFetch(path, init) : directFetch(path, init);
	};

	let useProxy = mode === 'proxy';
	let res: Response;
	try {
		res = await send(useProxy);
	}
	catch (error) {
		// 直连出现网络层失败（断网/被拦截）时尝试降级
		if (!useProxy && getQuotaState().proxyUsable) {
			toast(t('fallbackToProxy'), 'info');
			res = await send(true);
			useProxy = true;
		}
		else {
			throw error;
		}
	}

	if (!res.ok) {
		const error = await toUpstreamError(res);
		applyQuotaHeaders(res.headers, useProxy ? 'user' : 'ip');
		// 本地额度不足导致的 429：改走代理重试一次
		if (res.status === 429 && !useProxy && getQuotaState().proxyUsable) {
			toast(t('fallbackToProxy'), 'info');
			const retry = await send(true);
			if (!retry.ok) {
				throw await toUpstreamError(retry);
			}
			return { response: retry, usedProxy: true };
		}
		throw error;
	}
	return { response: res, usedProxy: useProxy };
}

/** 读取测量 id：优先响应体，缺失时退回 `Location` 头 */
async function readMeasurementId(res: Response): Promise<string> {
	try {
		const body = (await res.clone().json()) as { id?: string };
		if (body.id) {
			return body.id;
		}
	}
	catch {
		// 回退到 Location 头
	}
	const location = res.headers.get('Location') ?? '';
	const id = location.split('/').filter(Boolean).pop() ?? '';
	if (!id) {
		throw new ApiError('Missing measurement id in response', res.status, 'internal');
	}
	return id;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

/** 轮询直到测量完成、超时或用户发起新的测量 */
async function pollMeasurement(
	id: string,
	usedProxy: boolean,
	timeoutSeconds: number,
	onUpdate: (measurement: MeasurementResponse, elapsedMs: number) => void,
	token: number,
): Promise<MeasurementResponse> {
	const startedAt = Date.now();
	const deadline = startedAt + timeoutSeconds * 1000 + POLL_GRACE_MS;
	let last: MeasurementResponse | null = null;
	for (;;) {
		const path = `/v1/measurements/${encodeURIComponent(id)}`;
		const res = usedProxy ? await proxyFetch(path) : await directFetch(path);
		if (!res.ok) {
			throw await toUpstreamError(res);
		}
		last = (await res.json()) as MeasurementResponse;
		onUpdate(last, Date.now() - startedAt);
		if (last.status === 'finished' || Date.now() > deadline || token !== pollToken) {
			return last;
		}
		// 必须在收到响应之后等待，避免超过上游的轮询频率限制
		await sleep(POLL_INTERVAL_MS);
		if (token !== pollToken) {
			return last;
		}
	}
}

function setRunning(value: boolean): void {
	running = value;
	const submit = document.getElementById('submit-btn') as HTMLButtonElement | null;
	if (submit) {
		submit.disabled = value;
		submit.setAttribute('aria-busy', value ? 'true' : 'false');
	}
}

/** 执行一次测量并渲染进度 */
async function runMeasurement(request: MeasurementRequest, resultsRoot: HTMLElement): Promise<void> {
	if (running) {
		toast(t('measurementBusy'), 'info');
		return;
	}
	// 开始测试就切到「测试结果」，否则进度与结果会渲染在看不见的标签页里
	setActiveTab('results');
	const mode = resolveMode(request.limit ?? 1);
	if (mode === 'unreachable') {
		toast(t('noRouteAvailable'), 'error');
		renderResultsError(resultsRoot, t('noRouteAvailableHint'));
		return;
	}
	if (mode === 'exhausted') {
		toast(t('quotaLocalExhausted'), 'error');
		renderResultsError(resultsRoot, t('quotaLocalExhaustedHint'));
		return;
	}
	const token = ++pollToken;
	setRunning(true);
	renderResultsRunning(resultsRoot, request, mode === 'proxy');
	const timeoutSeconds = request.timeout ?? 10;
	try {
		const { response, usedProxy } = await postMeasurement(request);
		applyQuotaHeaders(response.headers, usedProxy ? 'user' : 'ip');
		const id = await readMeasurementId(response);
		await pollMeasurement(id, usedProxy, timeoutSeconds, (measurement, elapsed) => {
			renderMeasurement(resultsRoot, measurement, elapsed);
		}, token);
	}
	catch (error) {
		renderResultsError(resultsRoot, describeFailure(error));
	}
	finally {
		if (token === pollToken) {
			setRunning(false);
		}
	}
}

function describeFailure(error: unknown): string {
	if (error instanceof ApiError) {
		const key = ERROR_TYPE_KEYS[error.type] ?? (error.status >= 500 ? 'errorUpstream' : ERROR_STATUS_KEYS[error.status] ?? '');
		const params = Object.entries(error.params).map(([name, value]) => `${name}: ${value}`);
		if (key) {
			return [t(key), ...params].join('\n');
		}
		if (params.length) {
			return [`${error.message}${error.type ? ` (${error.type})` : ''}`, ...params].join('\n');
		}
		return `${error.message}${error.type ? ` (${error.type})` : ''}`;
	}
	if (error instanceof TypeError) {
		return t('networkError');
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/** 按测量类型切换高级选项分组 */
function applyTypeVisibility(): void {
	for (const group of document.querySelectorAll<HTMLElement>('[data-for]')) {
		group.hidden = group.dataset.for !== currentType;
	}
}

/** 把节点数输入框限制在当前登录态允许的范围内 */
function clampLimitInput(): void {
	const input = document.getElementById('limit') as HTMLInputElement | null;
	if (!input) {
		return;
	}
	const state = getQuotaState();
	input.max = String(state.maxProbes);
	const raw = Number(input.value);
	const value = Number.isFinite(raw) ? Math.max(1, Math.min(Math.round(raw), state.maxProbes)) : 3;
	input.value = String(value);
	setDesiredProbes(value);
}

function updateLimitHint(): void {
	const hint = document.getElementById('limit-hint');
	if (!hint) {
		return;
	}
	const state = getQuotaState();
	const key = state.proxyUsable ? 'limitHintProxy' : 'limitHintAnonymous';
	hint.textContent = t(key, { max: state.maxProbes });
}

function updateLimitPresets(): void {
	const select = document.getElementById('limit-presets') as HTMLSelectElement | null;
	if (!select) {
		return;
	}
	const state = getQuotaState();
	for (const option of Array.from(select.options)) {
		option.disabled = Number(option.value) > state.maxProbes;
	}
}

/** 绑定表单事件；由 `main.ts` 在 DOM 就绪后调用 */
export function initMeasureForm(resultsRoot: HTMLElement): void {
	const form = document.getElementById('measure-form') as HTMLFormElement | null;
	if (!form) {
		return;
	}
	const typeTabs = document.getElementById('type-tabs');
	typeTabs?.addEventListener('change', () => {
		const checked = document.querySelector<HTMLInputElement>('input[name="type"]:checked');
		const value = checked?.value as MeasurementType | undefined;
		if (value && MEASUREMENT_TYPES.includes(value)) {
			currentType = value;
			applyTypeVisibility();
		}
	});

	const limitInput = document.getElementById('limit') as HTMLInputElement | null;
	limitInput?.addEventListener('change', clampLimitInput);

	const presets = document.getElementById('limit-presets') as HTMLSelectElement | null;
	if (presets) {
		presets.append(el('option', { value: '' }, [t('limitPresetPlaceholder')]));
		for (const value of LIMIT_PRESETS) {
			presets.append(el('option', { value: String(value) }, [String(value)]));
		}
		presets.addEventListener('change', () => {
			if (!presets.value || !limitInput) {
				return;
			}
			limitInput.value = presets.value;
			presets.value = '';
			clampLimitInput();
		});
	}

	document.getElementById('reset-btn')?.addEventListener('click', () => {
		form.reset();
		closeAllSuggests();
		currentType = 'ping';
		if (limitInput) {
			limitInput.value = '3';
		}
		clampLimitInput();
		applyTypeVisibility();
		renderResultsPlaceholder(resultsRoot);
	});

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		closeAllSuggests();
		// 先按当前登录态收紧节点数，再读取表单，保证 resolveMode 用的是最终值
		clampLimitInput();
		normalizeTargetInput(currentType);
		const request = readForm();
		if (!request) {
			toast(t('targetRequired'), 'error');
			document.getElementById('target')?.focus();
			return;
		}
		void runMeasurement(request, resultsRoot);
	});

	onQuotaChange(() => {
		updateLimitHint();
		updateLimitPresets();
		clampLimitInput();
	});

	initLocationSuggests([
		{ input: 'loc-magic', source: 'mixed' },
		{ input: 'loc-country', source: 'country' },
		{ input: 'loc-city', source: 'city' },
		{ input: 'loc-asn', source: 'asn' },
		{ input: 'loc-network', source: 'network' },
		{ input: 'loc-tags', source: 'tag', multiple: true },
	]);

	applyTypeVisibility();
	clampLimitInput();
	updateLimitHint();
	updateLimitPresets();
	renderResultsPlaceholder(resultsRoot);
}

export { MEASUREMENT_TYPES };
