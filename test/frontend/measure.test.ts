/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type MeasureModule = typeof import('../../src/frontend/measure');

const toastMock = jest.fn();
const applyQuotaHeadersMock = jest.fn();
const setDesiredProbesMock = jest.fn();
const renderMeasurementMock = jest.fn();
const renderResultsErrorMock = jest.fn();
const renderResultsPlaceholderMock = jest.fn();
const renderResultsRunningMock = jest.fn();

/** 由各用例控制的额度/模式状态 */
const quotaState = {
	mode: 'direct' as 'direct' | 'proxy' | 'unreachable' | 'exhausted',
	maxProbes: 50,
	proxyUsable: false,
	desiredProbes: 3,
};

jest.unstable_mockModule('../../src/frontend/quota', () => ({
	getQuotaState: () => ({ ...quotaState }),
	resolveMode: () => quotaState.mode,
	applyQuotaHeaders: applyQuotaHeadersMock,
	setDesiredProbes: (value: number) => {
		quotaState.desiredProbes = value;
		setDesiredProbesMock(value);
	},
	onQuotaChange: (listener: () => void) => {
		listener();
		return () => {};
	},
}));

jest.unstable_mockModule('../../src/frontend/results', () => ({
	renderMeasurement: renderMeasurementMock,
	renderResultsError: renderResultsErrorMock,
	renderResultsPlaceholder: renderResultsPlaceholderMock,
	renderResultsRunning: renderResultsRunningMock,
}));

jest.unstable_mockModule('../../src/frontend/i18n', () => ({
	t: (key: string, params?: Record<string, unknown>) => (params ? `t:${key}${JSON.stringify(params)}` : `t:${key}`),
}));

jest.unstable_mockModule('../../src/frontend/ui', () => ({
	toast: toastMock,
	countryName: (code: string) => code,
	flagEmoji: () => '',
	// location-suggest（经 measure 间接导入）会用到，未覆盖的地区无额外搜索名
	regionSearchNames: () => [],
	el: (tag: string, attrs: Record<string, unknown> = {}, children: unknown[] = []): HTMLElement => {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) {
				continue;
			}
			if (key === 'text') {
				node.textContent = String(value);
			}
			else {
				node.setAttribute(key, String(value));
			}
		}
		for (const child of children) {
			if (child === undefined || child === null) {
				continue;
			}
			node.append(child as Node);
		}
		return node;
	},
}));

interface FetchCall {
	url: string;
	init?: RequestInit;
}

type Queued = Response | Error | (() => Response | Promise<Response>);

let queue: Queued[] = [];
const calls: FetchCall[] = [];

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers(headers),
		json: async () => payload,
		clone() {
			return this;
		},
	} as unknown as Response;
}

function errorResponse(status: number, type: string, message: string, params?: Record<string, string>): Response {
	return jsonResponse({ error: { type, message, ...(params ? { params } : {}) } }, status);
}

function measurement(status: string, extra: Record<string, unknown> = {}): Response {
	return jsonResponse({ id: 'mid-1', status, ...extra });
}

function setQueue(...items: Queued[]): void {
	queue = items;
}

/** 队列耗尽后 GET 轮询使用的默认响应 */
let defaultGet: () => Response;

function lastBody(): Record<string, unknown> {
	const call = [...calls].reverse().find(item => item.init?.method === 'POST') ?? calls[0];
	expect(call).toBeDefined();
	return JSON.parse(String(call!.init?.body)) as Record<string, unknown>;
}

const FORM_HTML = `
	<form id="measure-form">
		<div id="type-tabs">
			<input type="radio" name="type" value="ping" checked>
			<input type="radio" name="type" value="traceroute">
			<input type="radio" name="type" value="dns">
			<input type="radio" name="type" value="mtr">
			<input type="radio" name="type" value="http">
		</div>
		<input id="target">
		<input id="limit" value="3">
		<select id="limit-presets"></select>
		<span id="limit-hint"></span>
		<input id="timeout">
		<textarea id="loc-magic"></textarea>
		<input id="loc-tags">
		<select id="loc-continent"><option value=""></option><option value="EU">EU</option></select>
		<select id="loc-country"><option value=""></option><option value="DE">DE</option></select>
		<input id="loc-city">
		<input id="loc-asn">
		<input id="loc-network">
		<div data-for="ping">
			<input id="ping-packets">
			<select id="ping-protocol"><option value=""></option><option value="ICMP">ICMP</option><option value="TCP">TCP</option></select>
			<input id="ping-port">
			<select id="ping-ipv"><option value=""></option><option value="4">4</option><option value="6">6</option></select>
		</div>
		<div data-for="traceroute" hidden>
			<select id="tr-protocol"><option value=""></option><option value="UDP">UDP</option></select>
			<input id="tr-port">
			<select id="tr-ipv"><option value=""></option><option value="4">4</option></select>
		</div>
		<div data-for="mtr" hidden>
			<input id="mtr-packets">
			<select id="mtr-protocol"><option value=""></option><option value="ICMP">ICMP</option></select>
			<input id="mtr-port">
			<select id="mtr-ipv"><option value=""></option><option value="6">6</option></select>
		</div>
		<div data-for="dns" hidden>
			<select id="dns-qtype"><option value=""></option><option value="A">A</option><option value="AAAA">AAAA</option></select>
			<input type="checkbox" id="dns-trace">
			<input id="dns-resolver">
			<select id="dns-protocol"><option value=""></option><option value="UDP">UDP</option></select>
			<input id="dns-port">
			<select id="dns-ipv"><option value=""></option><option value="4">4</option></select>
		</div>
		<div data-for="http" hidden>
			<textarea id="http-headers"></textarea>
			<select id="http-method"><option value=""></option><option value="GET">GET</option><option value="POST">POST</option></select>
			<input id="http-path">
			<input id="http-query">
			<input id="http-resolver">
			<select id="http-protocol"><option value=""></option><option value="HTTP">HTTP</option><option value="HTTPS">HTTPS</option></select>
			<input id="http-port">
			<select id="http-ipv"><option value=""></option><option value="4">4</option></select>
		</div>
		<button id="submit-btn" type="submit">Go</button>
		<button id="reset-btn" type="button">Reset</button>
	</form>
`;

let resultsRoot: HTMLElement;
let measure: MeasureModule;

function field(id: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
	return document.getElementById(id) as HTMLInputElement;
}

function selectType(value: string): void {
	const radio = document.querySelector<HTMLInputElement>(`input[name="type"][value="${value}"]`);
	radio!.checked = true;
	document.getElementById('type-tabs')!.dispatchEvent(new Event('change', { bubbles: true }));
}

async function submitForm(flushMs = 2000): Promise<void> {
	const form = document.getElementById('measure-form') as HTMLFormElement;
	form.dispatchEvent(new Event('submit', { cancelable: true }));
	await jest.advanceTimersByTimeAsync(flushMs);
}

/** 初始化表单并返回一个可复用的测量模块 */
async function boot(): Promise<MeasureModule> {
	measure = await import('../../src/frontend/measure');
	measure.initMeasureForm(resultsRoot);
	return measure;
}

beforeEach(() => {
	jest.resetModules();
	jest.useFakeTimers();
	localStorage.clear();
	document.body.innerHTML = FORM_HTML;
	resultsRoot = document.createElement('div');
	document.body.append(resultsRoot);
	queue = [];
	calls.length = 0;
	defaultGet = () => measurement('finished');
	toastMock.mockClear();
	applyQuotaHeadersMock.mockClear();
	setDesiredProbesMock.mockClear();
	renderMeasurementMock.mockClear();
	renderResultsErrorMock.mockClear();
	renderResultsPlaceholderMock.mockClear();
	renderResultsRunningMock.mockClear();
	quotaState.mode = 'direct';
	quotaState.maxProbes = 50;
	quotaState.proxyUsable = false;
	quotaState.desiredProbes = 3;

	globalThis.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		const next = queue.shift();
		if (next instanceof Error) {
			return Promise.reject(next);
		}
		if (typeof next === 'function') {
			return Promise.resolve(next());
		}
		if (next) {
			return Promise.resolve(next);
		}
		return Promise.resolve(init?.method === 'POST' ? jsonResponse({ id: 'mid-1' }, 202) : defaultGet());
	}) as unknown as typeof fetch;
});

describe('initMeasureForm 初始化', () => {
	it('缺少表单时安全返回', async () => {
		document.body.innerHTML = '';
		await expect(boot()).resolves.toBeDefined();
	});

	it('生成节点数预设并禁用超出上限的选项', async () => {
		await boot();
		const options = Array.from((field('limit-presets') as HTMLSelectElement).options);
		expect(options).toHaveLength(9);
		expect(options[0].value).toBe('');
		expect(options.map(option => option.value)).toEqual(['', '1', '3', '5', '10', '25', '50', '100', '500']);
		expect(options.find(option => option.value === '50')!.disabled).toBe(false);
		expect(options.find(option => option.value === '100')!.disabled).toBe(true);
		expect(options.find(option => option.value === '500')!.disabled).toBe(true);
	});

	it('渲染占位结果与上限提示', async () => {
		await boot();
		expect(renderResultsPlaceholderMock).toHaveBeenCalledWith(resultsRoot);
		expect(document.getElementById('limit-hint')!.textContent).toBe('t:limitHintAnonymous{"max":50}');
	});

	it('已登录且代理可用时提示使用代理上限', async () => {
		quotaState.proxyUsable = true;
		quotaState.maxProbes = 500;
		await boot();
		expect(document.getElementById('limit-hint')!.textContent).toBe('t:limitHintProxy{"max":500}');
	});

	it('初始化时把节点数输入钳制到上限并同步给额度模块', async () => {
		quotaState.maxProbes = 5;
		field('limit').value = '100';
		await boot();
		expect(field('limit').value).toBe('5');
		expect(field('limit').max).toBe('5');
		expect(setDesiredProbesMock).toHaveBeenCalledWith(5);
	});

	it('默认隐藏与当前类型无关的高级选项', async () => {
		await boot();
		expect(document.querySelector<HTMLElement>('[data-for="ping"]')!.hidden).toBe(false);
		expect(document.querySelector<HTMLElement>('[data-for="http"]')!.hidden).toBe(true);
	});

	it('缺少上限提示与节点数预设时安全初始化', async () => {
		document.getElementById('limit-hint')!.remove();
		document.getElementById('limit-presets')!.remove();
		await expect(boot()).resolves.toBeDefined();
	});

	it('缺少提交按钮时运行状态切换被跳过', async () => {
		await boot();
		document.getElementById('submit-btn')!.remove();
		field('target').value = 'example.com';
		await submitForm();
		expect(calls.some(call => call.init?.method === 'POST')).toBe(true);
	});

	it('缺少节点数输入时重置按钮仍然安全', async () => {
		document.getElementById('limit')!.remove();
		await boot();
		document.getElementById('reset-btn')!.click();
		expect(renderResultsPlaceholderMock).toHaveBeenCalledWith(resultsRoot);
	});
});

describe('请求体构造', () => {
	it('ping 默认只发送必要字段', async () => {
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		const body = lastBody();
		expect(body).toEqual({ type: 'ping', target: 'example.com', inProgressUpdates: true, limit: 3 });
		expect(body.measurementOptions).toBeUndefined();
	});

	it('ping 高级选项按填写情况透传', async () => {
		await boot();
		field('target').value = 'example.com';
		field('ping-packets').value = '5';
		field('ping-protocol').value = 'ICMP';
		field('ping-port').value = '443';
		field('ping-ipv').value = '4';
		await submitForm();
		expect(lastBody().measurementOptions).toEqual({ packets: 5, protocol: 'ICMP', port: 443, ipVersion: 4 });
	});

	it('traceroute 选项正确映射', async () => {
		await boot();
		selectType('traceroute');
		field('target').value = 'example.com';
		field('tr-protocol').value = 'UDP';
		field('tr-port').value = '33434';
		field('tr-ipv').value = '4';
		await submitForm();
		const body = lastBody();
		expect(body.type).toBe('traceroute');
		expect(body.measurementOptions).toEqual({ protocol: 'UDP', port: 33434, ipVersion: 4 });
	});

	it('mtr 选项正确映射', async () => {
		await boot();
		selectType('mtr');
		field('target').value = 'example.com';
		field('mtr-packets').value = '3';
		field('mtr-protocol').value = 'ICMP';
		field('mtr-ipv').value = '6';
		await submitForm();
		expect(lastBody().measurementOptions).toEqual({ packets: 3, protocol: 'ICMP', ipVersion: 6 });
	});

	it('dns 选项包含 query 与 trace', async () => {
		await boot();
		selectType('dns');
		field('target').value = 'example.com';
		field('dns-qtype').value = 'AAAA';
		field('dns-resolver').value = '1.1.1.1';
		field('dns-ipv').value = '4';
		(field('dns-trace') as HTMLInputElement).checked = true;
		await submitForm();
		expect(lastBody().measurementOptions).toEqual({
			query: { type: 'AAAA' },
			resolver: '1.1.1.1',
			ipVersion: 4,
			trace: true,
		});
	});

	it('dns 未勾选 trace 时不发送该字段', async () => {
		await boot();
		selectType('dns');
		field('target').value = 'example.com';
		await submitForm();
		expect(lastBody().measurementOptions).toBeUndefined();
	});

	it('http 选项包含 request 且解析多行 headers', async () => {
		await boot();
		selectType('http');
		field('target').value = 'example.com';
		field('http-method').value = 'POST';
		field('http-path').value = '/submit';
		field('http-query').value = 'a=1';
		field('http-protocol').value = 'HTTPS';
		field('http-headers').value = 'X-A: 1\n\nbroken-line\n: leading\nX-B:two:three\n';
		await submitForm();
		expect(lastBody().measurementOptions).toEqual({
			request: {
				method: 'POST',
				path: '/submit',
				query: 'a=1',
				headers: { 'X-A': '1', 'X-B': 'two:three' },
			},
			protocol: 'HTTPS',
		});
	});

	it('超时时间透传', async () => {
		await boot();
		field('target').value = 'example.com';
		field('timeout').value = '20';
		await submitForm();
		expect(lastBody().timeout).toBe(20);
	});

	it('节点数超过上限时钳制到上限', async () => {
		await boot();
		field('target').value = 'example.com';
		field('limit').value = '500';
		await submitForm();
		expect(lastBody().limit).toBe(50);
		expect(field('limit').value).toBe('50');
	});

	it('节点数非法时回落到默认值 3', async () => {
		await boot();
		field('target').value = 'example.com';
		field('limit').value = 'abc';
		await submitForm();
		expect(lastBody().limit).toBe(3);
	});

	it('目标为空时提示并聚焦，不发起请求', async () => {
		await boot();
		await submitForm();
		expect(toastMock).toHaveBeenCalledWith('t:targetRequired', 'error');
		expect(document.activeElement).toBe(field('target'));
		expect(calls).toHaveLength(0);
		expect(renderResultsErrorMock).not.toHaveBeenCalled();
	});

	it('http 目标为 URL 时拆分为 target/protocol/path/query', async () => {
		await boot();
		selectType('http');
		field('target').value = 'https://example.com/a/b?x=1#frag';
		await submitForm();
		const body = lastBody();
		expect(body.target).toBe('example.com');
		expect(body.measurementOptions).toMatchObject({
			protocol: 'HTTPS',
			request: { path: '/a/b', query: 'x=1' },
		});
		expect(field('target').value).toBe('example.com');
		expect(field('http-path').value).toBe('/a/b');
		expect(field('http-query').value).toBe('x=1');
	});

	it('http 目标已填写的字段不会被覆盖', async () => {
		await boot();
		selectType('http');
		field('http-path').value = '/custom';
		field('target').value = 'http://example.com/other';
		await submitForm();
		expect(field('http-path').value).toBe('/custom');
		expect(lastBody().measurementOptions).toMatchObject({ request: { path: '/custom' } });
	});

	it('非 http 类型同样剥离 URL 的协议与路径', async () => {
		await boot();
		field('target').value = 'https://example.com/a?b=1';
		await submitForm();
		expect(lastBody().target).toBe('example.com');
		expect(lastBody().measurementOptions).toBeUndefined();
	});

	it('根路径不会写入 path 字段', async () => {
		await boot();
		selectType('http');
		field('target').value = 'example.com/';
		await submitForm();
		expect(field('http-path').value).toBe('');
		expect(lastBody().measurementOptions).toBeUndefined();
	});

	it('超时时间非数字时忽略该字段', async () => {
		await boot();
		field('target').value = 'example.com';
		field('timeout').value = 'abc';
		await submitForm();
		expect(lastBody().timeout).toBeUndefined();
	});

	it('目标以路径分隔符开头时保留原始字符串', async () => {
		await boot();
		field('target').value = '/example.com';
		await submitForm();
		expect(lastBody().target).toBe('/example.com');
	});

	it('无法识别的协议不写入 protocol 字段', async () => {
		await boot();
		selectType('http');
		field('target').value = 'ftp://example.com/a';
		await submitForm();
		const body = lastBody();
		expect(body.target).toBe('example.com');
		expect(body.measurementOptions).toEqual({ request: { path: '/a' } });
	});

	it('节点数输入缺失时回落到默认值 3', async () => {
		document.getElementById('limit')!.remove();
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		expect(lastBody().limit).toBe(3);
	});

	it('目标输入缺失时提示必填且不发起请求', async () => {
		document.getElementById('target')!.remove();
		await boot();
		await submitForm();
		expect(toastMock).toHaveBeenCalledWith('t:targetRequired', 'error');
		expect(calls).toHaveLength(0);
	});
});

describe('位置构造', () => {
	it('位置输入缺失时不发送 locations', async () => {
		document.getElementById('loc-magic')!.remove();
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		expect(lastBody().locations).toBeUndefined();
	});
	it('仅填写 magic 时发送 magic', async () => {
		await boot();
		field('target').value = 'example.com';
		field('loc-magic').value = 'Germany';
		await submitForm();
		expect(lastBody().locations).toEqual([{ magic: 'Germany' }]);
	});

	it('magic 里的换行被归一成逗号后的条件列表', async () => {
		await boot();
		field('target').value = 'example.com';
		// 多行 textarea：换行不是 magic 的分隔符，必须转成逗号
		field('loc-magic').value = 'Helsinki+FI+AS24940\nFrankfurt+DE+AS15169';
		await submitForm();
		expect(lastBody().locations).toEqual([{ magic: 'Helsinki+FI+AS24940, Frankfurt+DE+AS15169' }]);
	});

	it('magic 里的多余分隔符与空白被清理', async () => {
		await boot();
		field('target').value = 'example.com';
		field('loc-magic').value = '  Berlin+DE ,,  Frankfurt+DE  ';
		await submitForm();
		expect(lastBody().locations).toEqual([{ magic: 'Berlin+DE, Frankfurt+DE' }]);
	});

	it('只有空白字符的 magic 不发送 locations', async () => {
		await boot();
		field('target').value = 'example.com';
		field('loc-magic').value = '   \n  ';
		await submitForm();
		expect(lastBody().locations).toBeUndefined();
	});

	it('结构化字段优先于 magic', async () => {
		await boot();
		field('target').value = 'example.com';
		field('loc-magic').value = 'Germany';
		field('loc-continent').value = 'EU';
		field('loc-country').value = 'DE';
		field('loc-city').value = 'Berlin';
		field('loc-asn').value = '24940';
		field('loc-network').value = 'Hetzner';
		field('loc-tags').value = 'datacenter, europe  cloud';
		await submitForm();
		expect(lastBody().locations).toEqual([{
			continent: 'EU',
			country: 'DE',
			city: 'Berlin',
			asn: 24940,
			network: 'Hetzner',
			tags: ['datacenter', 'europe', 'cloud'],
		}]);
	});

	it('未填写任何位置时不发送 locations', async () => {
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		expect(lastBody().locations).toBeUndefined();
	});
});

describe('节点数与类型交互', () => {
	it('选择快捷预设会写回节点数输入', async () => {
		await boot();
		const presets = field('limit-presets') as HTMLSelectElement;
		presets.value = '25';
		presets.dispatchEvent(new Event('change'));
		expect(field('limit').value).toBe('25');
		expect(presets.value).toBe('');
		expect(setDesiredProbesMock).toHaveBeenCalledWith(25);
	});

	it('选择超出上限的预设会被钳制', async () => {
		quotaState.maxProbes = 10;
		await boot();
		const presets = field('limit-presets') as HTMLSelectElement;
		presets.value = '500';
		presets.dispatchEvent(new Event('change'));
		expect(field('limit').value).toBe('10');
	});

	it('预设为空时忽略 change 事件', async () => {
		await boot();
		const before = setDesiredProbesMock.mock.calls.length;
		const presets = field('limit-presets') as HTMLSelectElement;
		presets.value = '';
		presets.dispatchEvent(new Event('change'));
		expect(field('limit').value).toBe('3');
		expect(setDesiredProbesMock.mock.calls.length).toBe(before);
	});

	it('切换测量类型会刷新高级选项分组', async () => {
		await boot();
		selectType('dns');
		expect(document.querySelector<HTMLElement>('[data-for="dns"]')!.hidden).toBe(false);
		expect(document.querySelector<HTMLElement>('[data-for="ping"]')!.hidden).toBe(true);
		field('target').value = 'example.com';
		await submitForm();
		expect(lastBody().type).toBe('dns');
	});

	it('未知类型不会改变当前类型', async () => {
		await boot();
		const radio = document.querySelector<HTMLInputElement>('input[name="type"][value="dns"]')!;
		radio.checked = false;
		const bogus = document.createElement('input');
		bogus.type = 'radio';
		bogus.name = 'type';
		bogus.value = 'bogus';
		bogus.checked = true;
		document.getElementById('type-tabs')!.append(bogus);
		document.getElementById('type-tabs')!.dispatchEvent(new Event('change', { bubbles: true }));
		expect(document.querySelector<HTMLElement>('[data-for="ping"]')!.hidden).toBe(false);
	});

	it('重置按钮恢复默认状态', async () => {
		await boot();
		selectType('http');
		field('target').value = 'example.com';
		field('limit').value = '10';
		document.getElementById('reset-btn')!.dispatchEvent(new Event('click'));
		expect(field('target').value).toBe('');
		expect(field('limit').value).toBe('3');
		expect(document.querySelector<HTMLElement>('[data-for="ping"]')!.hidden).toBe(false);
		expect(renderResultsPlaceholderMock).toHaveBeenCalledTimes(2);
	});
});

describe('提交与轮询', () => {
	it('成功提交后轮询直到完成并渲染结果', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(
			jsonResponse({ id: 'mid-1' }, 202),
			measurement('in-progress'),
			measurement('finished', { results: [{ probe: {} }] }),
		);
		await submitForm();
		expect(calls[0].url).toBe('https://api.globalping.io/v1/measurements');
		expect(calls[1].url).toBe('https://api.globalping.io/v1/measurements/mid-1');
		expect(calls).toHaveLength(3);
		expect(renderMeasurementMock).toHaveBeenCalledTimes(2);
		expect(renderMeasurementMock.mock.calls[1][1]).toMatchObject({ status: 'finished' });
		expect(renderResultsErrorMock).not.toHaveBeenCalled();
		expect(renderResultsRunningMock).toHaveBeenCalledWith(resultsRoot, expect.anything(), false);
	});

	it('轮询在响应之后按 500ms 节流', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(
			jsonResponse({ id: 'mid-1' }, 202),
			measurement('in-progress'),
			measurement('finished'),
		);
		const form = document.getElementById('measure-form') as HTMLFormElement;
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		await jest.advanceTimersByTimeAsync(0);
		expect(calls).toHaveLength(2);
		await jest.advanceTimersByTimeAsync(400);
		expect(calls).toHaveLength(2);
		await jest.advanceTimersByTimeAsync(200);
		expect(calls).toHaveLength(3);
	});

	it('轮询超过截止时间后停止', async () => {
		await boot();
		field('target').value = 'example.com';
		field('timeout').value = '5';
		defaultGet = () => measurement('in-progress');
		setQueue(jsonResponse({ id: 'mid-1' }, 202));
		const form = document.getElementById('measure-form') as HTMLFormElement;
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		await jest.advanceTimersByTimeAsync(21_000);
		expect(renderMeasurementMock.mock.calls.at(-1)![1]).toMatchObject({ status: 'in-progress' });
		const pollCount = calls.length;
		await jest.advanceTimersByTimeAsync(5000);
		expect(calls.length).toBe(pollCount);
	});

	it('响应缺少 id 时回退到 Location 头', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(
			jsonResponse({}, 202, { Location: 'https://api.globalping.io/v1/measurements/abc-123' }),
			measurement('finished'),
		);
		await submitForm();
		expect(calls[1].url).toBe('https://api.globalping.io/v1/measurements/abc-123');
	});

	it('响应既无 id 也无 Location 时报错', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({}, 202));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'Missing measurement id in response (internal)');
	});

	it('轮询返回错误时渲染失败信息', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(
			jsonResponse({ id: 'mid-1' }, 202),
			errorResponse(500, 'internal_error', 'boom'),
		);
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorUpstream');
	});

	it('提交后按钮进入 busy 状态并在结束后恢复', async () => {
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		const submit = document.getElementById('submit-btn') as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
		expect(submit.getAttribute('aria-busy')).toBe('false');
	});

	it('失败后按钮同样恢复可用', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(422, 'no_probes_found', 'no probes'));
		await submitForm();
		const submit = document.getElementById('submit-btn') as HTMLButtonElement;
		expect(submit.disabled).toBe(false);
	});
});

describe('模式与降级', () => {
	it('模式为 unreachable 时提示并渲染错误', async () => {
		quotaState.mode = 'unreachable';
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		expect(toastMock).toHaveBeenCalledWith('t:noRouteAvailable', 'error');
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:noRouteAvailableHint');
		expect(calls).toHaveLength(0);
	});

	it('模式为 exhausted 时提示本地额度耗尽', async () => {
		quotaState.mode = 'exhausted';
		await boot();
		field('target').value = 'example.com';
		await submitForm();
		expect(toastMock).toHaveBeenCalledWith('t:quotaLocalExhausted', 'error');
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:quotaLocalExhaustedHint');
	});

	it('模式为 proxy 时改走后端代理并标记运行来源', async () => {
		quotaState.mode = 'proxy';
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({ id: 'mid-1' }, 202), measurement('finished'));
		await submitForm();
		expect(calls[0].url).toBe('/api/measurements');
		expect(calls[1].url).toBe('/api/measurements/mid-1');
		expect(renderResultsRunningMock).toHaveBeenCalledWith(resultsRoot, expect.anything(), true);
		expect(applyQuotaHeadersMock).toHaveBeenCalledWith(expect.any(Headers), 'user');
	});

	it('直连网络失败且代理可用时自动降级重试', async () => {
		quotaState.proxyUsable = true;
		await boot();
		field('target').value = 'example.com';
		setQueue(new TypeError('failed to fetch'), jsonResponse({ id: 'mid-1' }, 202), measurement('finished'));
		await submitForm();
		expect(toastMock).toHaveBeenCalledWith('t:fallbackToProxy', 'info');
		expect(calls[1].url).toBe('/api/measurements');
		expect(renderMeasurementMock).toHaveBeenCalled();
	});

	it('直连网络失败且代理不可用时渲染网络错误', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(new TypeError('failed to fetch'));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:networkError');
	});

	it('本地 429 且代理可用时改走代理', async () => {
		quotaState.proxyUsable = true;
		await boot();
		field('target').value = 'example.com';
		setQueue(
			errorResponse(429, 'too_many_requests', 'rate limited'),
			jsonResponse({ id: 'mid-1' }, 202),
			measurement('finished'),
		);
		await submitForm();
		expect(toastMock).toHaveBeenCalledWith('t:fallbackToProxy', 'info');
		expect(calls[1].url).toBe('/api/measurements');
		expect(renderMeasurementMock).toHaveBeenCalled();
	});

	it('代理重试仍失败时抛出错误', async () => {
		quotaState.proxyUsable = true;
		await boot();
		field('target').value = 'example.com';
		setQueue(
			errorResponse(429, 'too_many_requests', 'rate limited'),
			errorResponse(503, 'proxy_unavailable', 'no token'),
		);
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorProxyUnavailable');
	});

	it('本地 429 且代理不可用时展示本地化 429 文案', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(429, 'too_many_requests', 'rate limited'));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorTooManyRequests');
		expect(applyQuotaHeadersMock).toHaveBeenCalledWith(expect.any(Headers), 'ip');
	});

	it('代理模式下错误响应按用户额度记账', async () => {
		quotaState.mode = 'proxy';
		quotaState.proxyUsable = true;
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(500, 'upstream_error', 'boom'));
		await submitForm();
		expect(applyQuotaHeadersMock).toHaveBeenCalledWith(expect.any(Headers), 'user');
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorUpstream');
	});

	it('正在测量时拒绝重复提交', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(() => new Promise<Response>(() => {}));
		const form = document.getElementById('measure-form') as HTMLFormElement;
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		await jest.advanceTimersByTimeAsync(0);
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		expect(toastMock).toHaveBeenCalledWith('t:measurementBusy', 'info');
		expect(calls).toHaveLength(1);
	});
});

describe('错误文案映射', () => {
	it.each([
		[422, 'no_probes_found', 't:errorNoProbesFound'],
		[400, 'validation_error', 't:errorValidation'],
		[404, 'not_found', 't:errorNotFound'],
		[401, 'unauthorized', 't:errorUnauthorized'],
		[429, 'too_many_requests', 't:errorTooManyRequests'],
		[413, 'payload_too_large', 't:errorPayloadTooLarge'],
		[503, 'proxy_unavailable', 't:errorProxyUnavailable'],
		[500, 'upstream_error', 't:errorUpstream'],
	])('类型 %s/%s → %s', async (status, type, expected) => {
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(status, type, 'raw upstream message'));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, expected);
	});

	it('错误类型缺失时按状态码兜底', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({ error: { message: 'Bad Request' } }, 400));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorValidation');
	});

	it('5xx 且无类型时兜底为上游错误', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({ error: { message: 'Internal' } }, 502));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorUpstream');
	});

	it('无法识别的类型与状态码时附带上游原文与 params', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(418, 'weird_error', 'Something odd', { field: 'target' }));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'Something odd (weird_error)\nfield: target');
	});

	it('无法识别的类型与状态码且无 params 时只显示原文', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(418, 'weird_error', 'Something odd'));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'Something odd (weird_error)');
	});

	it('错误体缺少 message 时回退为 HTTP 状态码', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({ error: { type: 'weird_error' } }, 418));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'HTTP 418 (weird_error)');
	});

	it('已知类型带 params 时附在文案后', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(errorResponse(422, 'no_probes_found', 'no probes', { continent: 'AN' }));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorNoProbesFound\ncontinent: AN');
	});

	it('非 JSON 错误体时使用状态码文案', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue({
			ok: false,
			status: 429,
			headers: new Headers(),
			json: async () => {
				throw new SyntaxError('not json');
			},
			clone() {
				return this;
			},
		} as unknown as Response);
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 't:errorTooManyRequests');
	});

	it('未知错误对象退化为字符串', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(() => {
			// 故意抛出非 Error 对象，覆盖 describeFailure 的 String(error) 兜底分支
			// eslint-disable-next-line no-throw-literal
			throw 'plain-string';
		});
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'plain-string');
	});

	it('普通 Error 直接展示其消息', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(new Error('boom'));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'boom');
	});

	it('未知状态码且缺少类型时带上 params', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({ error: { message: 'Odd failure', params: { field: 'target' } } }, 418));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'Odd failure\nfield: target');
	});

	it('未知状态码且缺少类型与 params 时只显示原文', async () => {
		await boot();
		field('target').value = 'example.com';
		setQueue(jsonResponse({ error: { message: 'Odd failure' } }, 418));
		await submitForm();
		expect(renderResultsErrorMock).toHaveBeenCalledWith(resultsRoot, 'Odd failure');
	});
});

describe('导出常量', () => {
	it('暴露测量类型与节点数预设', async () => {
		const mod = await boot();
		expect(mod.MEASUREMENT_TYPES).toEqual(['ping', 'traceroute', 'dns', 'mtr', 'http']);
		expect(mod.LIMIT_PRESETS).toEqual([1, 3, 5, 10, 25, 50, 100, 500]);
	});
});

describe('位置筛选自动补全接线', () => {
	/** 覆盖全部位置字段所需的最小索引 */
	const PROBE_INDEX = {
		version: 1,
		generatedAt: 1,
		total: 3,
		countries: [['DE', 2]],
		regions: [['Western Europe', 2]],
		cities: [['Fuzhou', 'CN', 3]],
		networks: [['Chinanet', 4134, 3]],
		tags: [['datacenter-network', 3], ['eyeball-network', 1]],
	};

	function panels(): HTMLElement[] {
		return [...document.querySelectorAll<HTMLElement>('.suggest-panel')];
	}

	it('为六个位置输入框各挂一个面板', async () => {
		await boot();

		expect(panels().map(node => node.dataset.wrap).sort())
			.toEqual(['loc-asn', 'loc-city', 'loc-country', 'loc-magic', 'loc-network', 'loc-tags']);
	});

	it('面板初始全部隐藏且挂在 body 上', async () => {
		await boot();

		expect(panels()).toHaveLength(6);
		for (const node of panels()) {
			expect(node.hidden).toBe(true);
			expect(node.parentElement).toBe(document.body);
		}
	});

	it('输入城市时下拉出现候选', async () => {
		setQueue(jsonResponse(PROBE_INDEX));
		await boot();

		const city = document.getElementById('loc-city') as HTMLInputElement;
		city.focus();
		city.value = 'Fuzho';
		city.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(400);

		const open = document.querySelector<HTMLElement>('.suggest-panel:not([hidden])');
		expect(open?.dataset.wrap).toBe('loc-city');
		expect(open?.querySelector('.suggest-label')?.textContent).toBe('Fuzhou');
	});

	it('tags 输入框按多值片段补全', async () => {
		setQueue(jsonResponse(PROBE_INDEX));
		await boot();

		const tags = document.getElementById('loc-tags') as HTMLInputElement;
		tags.focus();
		tags.value = 'eyeball, date';
		tags.setSelectionRange(tags.value.length, tags.value.length);
		tags.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(400);

		const option = document.querySelector<HTMLElement>('.suggest-panel:not([hidden]) .suggest-item');
		expect(option?.querySelector('.suggest-label')?.textContent).toBe('datacenter-network');
		option!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(tags.value).toBe('eyeball, datacenter-network, ');
	});

	it('重置表单时关闭已展开的面板', async () => {
		setQueue(jsonResponse(PROBE_INDEX));
		await boot();

		const city = document.getElementById('loc-city') as HTMLInputElement;
		city.focus();
		city.value = 'Fuzho';
		city.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(400);
		expect(document.querySelector('.suggest-panel:not([hidden])')).not.toBeNull();

		document.getElementById('reset-btn')!.click();

		expect(document.querySelector('.suggest-panel:not([hidden])')).toBeNull();
	});

	it('提交测量时关闭已展开的面板', async () => {
		setQueue(jsonResponse(PROBE_INDEX));
		await boot();

		const city = document.getElementById('loc-city') as HTMLInputElement;
		city.focus();
		city.value = 'Fuzho';
		city.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(400);
		expect(document.querySelector('.suggest-panel:not([hidden])')).not.toBeNull();

		field('target').value = 'example.com';
		await submitForm();

		expect(document.querySelector('.suggest-panel:not([hidden])')).toBeNull();
	});

	it('索引接口不可用时手动输入仍然可以提交', async () => {
		setQueue(new Error('offline'));
		await boot();

		const city = document.getElementById('loc-city') as HTMLInputElement;
		city.focus();
		city.value = 'Fuzho';
		city.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(400);
		expect(document.querySelector('.suggest-panel:not([hidden])')).toBeNull();

		field('target').value = 'example.com';
		await submitForm();

		expect(lastBody().locations).toEqual([{ city: 'Fuzho' }]);
	});
});
describe('readLocationFilters / writeMagic（供探针列表复用）', () => {
	it('读出全部位置字段，ASN 缺省为 null', async () => {
		await boot();

		expect(measure.readLocationFilters()).toEqual({
			continent: '',
			country: '',
			city: '',
			asn: null,
			network: '',
			tags: [],
			magic: '',
		});
	});

	it('标签按空格与逗号切分', async () => {
		await boot();
		field('loc-tags').value = 'datacenter, europe  cloud';

		expect(measure.readLocationFilters().tags).toEqual(['datacenter', 'europe', 'cloud']);
	});

	it('ASN 填数字时按数值返回', async () => {
		await boot();
		field('loc-asn').value = '24940';

		expect(measure.readLocationFilters().asn).toBe(24940);
	});

	it('magic 在读取时就已归一化', async () => {
		await boot();
		field('loc-magic').value = 'A+1\nB+2';

		expect(measure.readLocationFilters().magic).toBe('A+1, B+2');
	});

	it('writeMagic 写回 textarea', async () => {
		await boot();

		measure.writeMagic('Helsinki+FI+AS24940');

		expect(document.getElementById('loc-magic')?.value).toBe('Helsinki+FI+AS24940');
	});

	it('writeMagic 在字段缺失时安全跳过', async () => {
		await boot();
		document.getElementById('loc-magic')?.remove();

		expect(() => measure.writeMagic('x')).not.toThrow();
	});
});

describe('开始测试时切换标签页', () => {
	it('从其他标签页提交后切回测试结果', async () => {
		const panel = await import('../../src/frontend/panel');
		await boot();
		panel.setActiveTab('probes');
		expect(panel.getActiveTab()).toBe('probes');

		field('target').value = 'example.com';
		setQueue(jsonResponse({ id: 'mid-1' }, 202), measurement('finished'));
		await submitForm();

		expect(panel.getActiveTab()).toBe('results');
	});

	it('模式不可用时也切到测试结果（错误要显示在那里）', async () => {
		const panel = await import('../../src/frontend/panel');
		await boot();
		panel.setActiveTab('matched');
		quotaState.mode = 'unreachable';

		field('target').value = 'example.com';
		await submitForm();

		expect(panel.getActiveTab()).toBe('results');
		expect(renderResultsErrorMock).toHaveBeenCalled();
	});
});
