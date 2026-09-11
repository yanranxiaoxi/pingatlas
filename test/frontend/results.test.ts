/**
 * @jest-environment jsdom
 */
import type {
	MeasurementRequest,
	MeasurementResponse,
	MeasurementResultItem,
	ProbeLocation,
	ResultProbe,
	TestResult,
} from '../../src/frontend/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/frontend/i18n', () => ({
	getLang: () => 'en',
	t: (key: string) => key,
}));

const { countryName } = await import('../../src/frontend/ui');
const {
	renderMeasurement,
	renderResultsError,
	renderResultsPlaceholder,
	renderResultsRunning,
} = await import('../../src/frontend/results');

const PROBE_BASE: ResultProbe = {
	continent: 'EU',
	region: 'Bavaria',
	country: 'DE',
	state: null,
	city: 'Falkenstein',
	asn: 24940,
	network: 'Hetzner Online GmbH',
	latitude: 50.47,
	longitude: 12.37,
	tags: [],
	resolvers: [],
};

function probe(overrides: Partial<ProbeLocation> = {}): ResultProbe {
	return { ...PROBE_BASE, ...overrides };
}

function item(result: Partial<TestResult> = {}, probeOverrides: Partial<ProbeLocation> = {}): MeasurementResultItem {
	return {
		probe: probe(probeOverrides),
		result: { status: 'finished', rawOutput: '', ...result } as TestResult,
	};
}

function measurement(overrides: Partial<MeasurementResponse> = {}): MeasurementResponse {
	return {
		id: 'meas-1',
		type: 'ping',
		target: 'example.com',
		status: 'finished',
		createdAt: '2024-05-01T10:00:00.000Z',
		updatedAt: '2024-05-01T10:00:05.000Z',
		probesCount: 1,
		results: [item({ resolvedAddress: '93.184.216.34' })],
		...overrides,
	};
}

let root: HTMLElement;
const writeText = jest.fn<(text: string) => Promise<void>>();

function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function lastToast(): string {
	const toasts = document.querySelectorAll('#toast-box .toast');
	return toasts[toasts.length - 1]?.textContent ?? '';
}

beforeEach(() => {
	document.body.innerHTML = '<div id="root"></div>';
	root = document.getElementById('root') as HTMLElement;
	writeText.mockReset();
	writeText.mockResolvedValue(undefined);
	Object.defineProperty(navigator, 'clipboard', {
		value: { writeText },
		configurable: true,
	});
});

describe('renderResultsPlaceholder / renderResultsError', () => {
	it('占位符清空旧内容并渲染提示文案', () => {
		root.innerHTML = '<p>stale-content</p>';
		renderResultsPlaceholder(root);
		expect(root.children).toHaveLength(1);
		expect(root.querySelector('p')?.textContent).toBe('resultsPlaceholder');
		expect(root.textContent).not.toContain('stale-content');
		expect(root.firstElementChild?.classList.contains('placeholder')).toBe(true);
		expect(root.firstElementChild?.classList.contains('error')).toBe(false);
	});

	it('错误占位符同样替换旧内容', () => {
		root.innerHTML = '<p>stale-content</p>';
		renderResultsError(root, 'boom');
		expect(root.children).toHaveLength(1);
		expect(root.textContent).not.toContain('stale-content');
	});

	it('错误占位符带 error 修饰类与原始文案', () => {
		renderResultsError(root, 'line1\nline2');
		const box = root.firstElementChild as HTMLElement;
		expect(box.classList.contains('placeholder')).toBe(true);
		expect(box.classList.contains('error')).toBe(true);
		expect(box.querySelector('p')?.textContent).toBe('resultsError');
		expect(box.querySelector('pre')?.textContent).toBe('line1\nline2');
	});
});

describe('renderResultsRunning', () => {
	function request(overrides: Partial<MeasurementRequest> = {}): MeasurementRequest {
		return { type: 'ping', target: 'example.com', ...overrides };
	}

	it('展示类型、目标与派发提示', () => {
		renderResultsRunning(root, request(), false);
		expect(root.querySelector('.type-badge')?.textContent).toBe('typePing');
		expect(root.querySelector('.measure-target')?.textContent).toBe('example.com');
		expect(root.querySelector('.status-pending')?.textContent).toBe('statusInProgress');
		expect(root.querySelector('.spinner-line')?.textContent).toBe('dispatchingProbes');
	});

	it('直连与代理两种来源提示不同', () => {
		renderResultsRunning(root, request({ type: 'http', target: 'https://example.com' }), false);
		expect(root.querySelector('.result-note')?.textContent).toBe('viaDirect');
		renderResultsRunning(root, request({ type: 'http', target: 'https://example.com' }), true);
		expect(root.querySelector('.result-note')?.textContent).toBe('viaProxy');
		expect(root.querySelector('.type-badge')?.textContent).toBe('typeHttp');
	});

	it('五种测量类型都有本地化标签', () => {
		const types: Array<MeasurementRequest['type']> = ['ping', 'traceroute', 'dns', 'mtr', 'http'];
		for (const type of types) {
			renderResultsRunning(root, request({ type }), false);
			expect(root.querySelector('.type-badge')?.textContent).toBe(`type${type[0]!.toUpperCase()}${type.slice(1)}`);
		}
	});
});

describe('测量头部', () => {
	it('已完成测量展示 ok 徽标与统计信息', () => {
		const data = measurement({
			probesCount: 4,
			results: [
				item({ resolvedAddress: '1.1.1.1' }),
				item({ status: 'in-progress' }),
				item({ status: 'failed' }),
				item({ status: 'finished' }),
			],
		});
		renderMeasurement(root, data, 4200);
		const head = root.querySelector('.measure-head') as HTMLElement;
		expect(head.querySelector('.type-badge')?.textContent).toBe('typePing');
		expect(head.querySelector('.measure-target')?.textContent).toBe('example.com');
		expect(head.querySelector('.status-ok')?.textContent).toBe('statusFinished');
		const meta = [...head.querySelectorAll('.measure-meta span')].map(node => node.textContent);
		expect(meta).toContain('probesCount: 4 / 4');
		expect(meta).toContain('finishedCount: 2');
		expect(meta).toContain('elapsed: 4.2s');
		expect(meta.some(text => text?.startsWith('createdAt: '))).toBe(true);
		expect(meta).toContain('id: meas-1');
	});

	it('进行中的测量展示 pending 徽标', () => {
		renderMeasurement(root, measurement({ status: 'in-progress' }), 0);
		expect(root.querySelector('.measure-head .status-pending')?.textContent).toBe('statusInProgress');
		expect(root.querySelector('.measure-head .status-ok')).toBeNull();
	});

	it('耗时保留一位小数', () => {
		renderMeasurement(root, measurement(), 999);
		const meta = [...root.querySelectorAll('.measure-meta span')].map(node => node.textContent);
		expect(meta).toContain('elapsed: 1.0s');
	});

	it('createdAt 使用本地时钟格式', () => {
		renderMeasurement(root, measurement(), 0);
		const expected = new Date('2024-05-01T10:00:00.000Z').toLocaleTimeString(undefined, { hour12: false });
		const meta = [...root.querySelectorAll('.measure-meta span')].map(node => node.textContent);
		expect(meta).toContain(`createdAt: ${expected}`);
	});

	it('复制 id 按钮写入剪贴板并提示成功', async () => {
		renderMeasurement(root, measurement(), 0);
		const buttons = [...root.querySelectorAll('.measure-actions button')] as HTMLButtonElement[];
		expect(buttons.map(button => button.textContent)).toEqual(['copyId', 'copyJson']);
		buttons[0]!.click();
		await flush();
		expect(writeText).toHaveBeenCalledWith('meas-1');
		expect(lastToast()).toBe('copied');
	});

	it('复制 JSON 按钮序列化完整测量', async () => {
		const data = measurement();
		renderMeasurement(root, data, 0);
		const buttons = [...root.querySelectorAll('.measure-actions button')] as HTMLButtonElement[];
		buttons[1]!.click();
		await flush();
		expect(writeText).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
		expect(lastToast()).toBe('copied');
	});

	it('剪贴板不可用时提示失败', async () => {
		writeText.mockRejectedValueOnce(new Error('denied'));
		renderMeasurement(root, measurement(), 0);
		(root.querySelector('.measure-actions button') as HTMLButtonElement).click();
		await flush();
		await flush();
		expect(lastToast()).toBe('copyFailed');
	});

	it('复制 JSON 失败时同样提示', async () => {
		writeText.mockRejectedValueOnce(new Error('denied'));
		renderMeasurement(root, measurement(), 0);
		const buttons = [...root.querySelectorAll('.measure-actions button')] as HTMLButtonElement[];
		buttons[1]!.click();
		await flush();
		await flush();
		expect(lastToast()).toBe('copyFailed');
	});
});

describe('未知测量类型', () => {
	it('类型标签回落为原始字符串且不渲染专属正文', () => {
		renderMeasurement(root, measurement({ type: 'weird' as MeasurementResponse['type'] }), 0);
		const card = root.querySelector('.result-card') as HTMLElement;
		expect(root.querySelector('.type-badge')?.textContent).toBe('weird');
		expect((card.querySelector('.result-card-metric') as HTMLElement).textContent).toBe('—');
		expect((card.querySelector('.result-body') as HTMLElement).children).toHaveLength(0);
	});
});

describe('节点列表', () => {
	it('列出全部探测点并锚定到结果卡片', () => {
		const data = measurement({
			probesCount: 2,
			results: [
				item({ resolvedAddress: '1.1.1.1' }, { country: 'JP', city: 'Tokyo', asn: 2497, network: 'IIJ' }),
				item({ status: 'in-progress' }, { country: 'US', city: 'Dallas', asn: 15169, network: 'Google' }),
			],
		});
		renderMeasurement(root, data, 0);
		const section = root.querySelector('.probe-section') as HTMLElement;
		expect(section.querySelector('.section-heading')?.textContent).toBe('probeList (2)');
		const links = [...section.querySelectorAll('a.probe-list-link')] as HTMLAnchorElement[];
		expect(links.map(link => link.getAttribute('href'))).toEqual(['#result-0', '#result-1']);
		expect(links[0]!.querySelector('.probe-list-name')?.textContent).toBe(`Tokyo, ${countryName('JP')}`);
		expect(links[0]!.querySelector('.probe-list-network')?.textContent).toBe('AS2497 IIJ');
		expect(links[0]!.querySelector('.badge')?.textContent).toBe('statusFinished');
		expect(links[1]!.querySelector('.badge')?.textContent).toBe('statusInProgress');
	});

	it('没有结果时不渲染节点列表', () => {
		renderMeasurement(root, measurement({ results: [], probesCount: 0 }), 0);
		expect(root.querySelector('.probe-section')).toBeNull();
	});

	it('每个探测点都生成一张结果卡片', () => {
		renderMeasurement(root, measurement({ results: [item(), item(), item()], probesCount: 3 }), 0);
		expect(root.querySelectorAll('.result-card')).toHaveLength(3);
		expect(root.querySelectorAll('.result-card')[2]!.id).toBe('result-2');
	});
});

describe('探测点卡片头部', () => {
	it('展示城市、国家、ASN、大洲/区域与标签', () => {
		const data = measurement({
			results: [item({ resolvedAddress: '1.1.1.1' }, {
				tags: ['datacenter', 'gcp'],
				resolvers: ['8.8.8.8'],
				country: 'US',
				city: 'Ashburn',
				region: 'Virginia',
				continent: 'NA',
			})],
		});
		renderMeasurement(root, data, 0);
		const card = root.querySelector('.result-card') as HTMLElement;
		expect(card.querySelector('.probe-name')?.textContent).toBe(`Ashburn, ${countryName('US')}`);
		expect(card.querySelector('.probe-meta')?.textContent).toBe('AS24940 · Hetzner Online GmbH');
		expect(card.querySelector('.result-card-sub')?.textContent).toContain('NA / Virginia');
		expect(card.querySelector('.probe-tags')?.textContent).toBe('datacenter, gcp');
		expect(card.querySelector('.probe-resolvers')?.textContent).toBe('8.8.8.8');
	});

	it('缺少城市时回落到网络名，没有大洲/区域时子行为空', () => {
		const data = measurement({
			results: [item({ resolvedAddress: '1.1.1.1' }, { city: '', country: '', continent: '', region: '' })],
		});
		renderMeasurement(root, data, 0);
		const card = root.querySelector('.result-card') as HTMLElement;
		expect(card.querySelector('.probe-name')?.textContent).toBe('Hetzner Online GmbH');
		expect(card.querySelector('.result-card-sub')?.textContent).toBe('');
		expect(card.querySelector('.probe-tags')).toBeNull();
		expect(card.querySelector('.probe-resolvers')).toBeNull();
	});

	it('国家代码非法时国旗为空串', () => {
		const data = measurement({ results: [item({}, { country: 'XT' })] });
		renderMeasurement(root, data, 0);
		const flag = (root.querySelector('.result-card') as HTMLElement).querySelector('.probe-flag');
		expect(flag?.textContent).toBe('XT'.replace(/./g, char => String.fromCodePoint(0x1F1A5 + char.charCodeAt(0))));
		renderMeasurement(root, measurement({ results: [item({}, { country: '' })] }), 0);
		expect((root.querySelector('.result-card') as HTMLElement).querySelector('.probe-flag')?.textContent).toBe('');
	});
});

describe('结果状态徽标', () => {
	function statusBadge(result: Partial<TestResult>): string {
		renderMeasurement(root, measurement({ results: [item(result)] }), 0);
		return (root.querySelector('.result-card .badge.status-ok, .result-card .badge.status-pending, .result-card .badge.status-bad, .result-card .badge.status-warn') as HTMLElement)?.textContent ?? '';
	}

	it('finished / in-progress / offline 分别映射到 ok / pending / warn', () => {
		expect(statusBadge({ status: 'finished' })).toBe('statusFinished');
		expect(statusBadge({ status: 'in-progress' })).toBe('statusInProgress');
		expect(statusBadge({ status: 'offline' })).toBe('statusOffline');
	});

	it('failed 附带 failureSource', () => {
		renderMeasurement(root, measurement({ results: [item({ status: 'failed', failureSource: 'target' })] }), 0);
		expect(root.querySelector('.result-card .status-bad')?.textContent).toBe('statusFailed (target)');
	});

	it('failed 无 failureSource 时只显示状态文案', () => {
		renderMeasurement(root, measurement({ results: [item({ status: 'failed' })] }), 0);
		expect(root.querySelector('.result-card .status-bad')?.textContent).toBe('statusFailed');
	});

	it('未知状态原样展示且不带色调类', () => {
		renderMeasurement(root, measurement({ results: [item({ status: 'weird' as TestResult['status'] })] }), 0);
		const badge = (root.querySelector('.result-card') as HTMLElement).querySelector('.badge.status-');
		expect(badge?.textContent).toBe('weird');
	});
});

describe('ping 结果', () => {
	it('展示解析地址与主机名', () => {
		renderMeasurement(root, measurement({
			results: [item({ resolvedAddress: '93.184.216.34', resolvedHostname: 'example.com' })],
		}), 0);
		const body = root.querySelector('.result-card .result-body') as HTMLElement;
		const labels = [...body.querySelectorAll('dt')].map(node => node.textContent);
		const values = [...body.querySelectorAll('dd')].map(node => node.textContent);
		expect(labels.slice(0, 2)).toEqual(['resolvedAddress', 'resolvedHostname']);
		expect(values.slice(0, 2)).toEqual(['93.184.216.34', 'example.com']);
	});

	it('缺失的字段显示破折号', () => {
		renderMeasurement(root, measurement({ results: [item({ resolvedAddress: null })] }), 0);
		const values = [...root.querySelectorAll('.result-card .result-body dd')].map(node => node.textContent);
		expect(values[0]).toBe('—');
	});

	it('展示统计指标', () => {
		renderMeasurement(root, measurement({
			results: [item({
				stats: { min: 1.2, avg: 3.4, max: 9.9, total: 10, rcv: 8, drop: 2, loss: 20 },
			})],
		}), 0);
		const body = root.querySelector('.result-card .result-body') as HTMLElement;
		const pairs = [...body.querySelectorAll('dl.kv-inline dt')].map(node => node.textContent);
		const values = [...body.querySelectorAll('dl.kv-inline dd')].map(node => node.textContent);
		expect(pairs).toEqual(['statMin', 'statAvg', 'statMax', 'statLoss', 'statRcv', 'statDrop']);
		expect(values).toEqual(['1.20 ms', '3.40 ms', '9.90 ms', '20%', '8 / 10', '2']);
	});

	it('逐包时序渲染为条形图', () => {
		renderMeasurement(root, measurement({
			results: [item({ timings: [{ rtt: 5 }, { rtt: 10 }, { rtt: 7.5 }] })],
		}), 0);
		const bars = root.querySelectorAll('.result-card .timing-bar');
		expect(root.querySelector('.result-card .result-section-title')?.textContent).toBe('timings');
		expect(bars).toHaveLength(3);
		expect(Number.parseFloat((bars[1] as HTMLElement).style.height)).toBeCloseTo(100, 1);
		expect(Number.parseFloat((bars[0] as HTMLElement).style.height)).toBeCloseTo(56, 1);
		expect(bars[1]!.getAttribute('title')).toBe('10.0 ms');
	});

	it('超过 32 个包时截断并提示剩余数量', () => {
		const timings = Array.from({ length: 40 }, (_, index) => ({ rtt: index + 1 }));
		renderMeasurement(root, measurement({ results: [item({ timings })] }), 0);
		expect(root.querySelectorAll('.result-card .timing-bar')).toHaveLength(32);
		expect(root.querySelector('.result-card .timing-bar-more')?.textContent).toBe('+8');
	});

	it('进行中的结果只显示等待提示', () => {
		renderMeasurement(root, measurement({ results: [item({ status: 'in-progress' })] }), 0);
		const card = root.querySelector('.result-card') as HTMLElement;
		expect(card.querySelector('p.result-note')?.textContent).toBe('resultPending');
		expect(card.querySelector('table')).toBeNull();
		expect(card.querySelector('dl')).toBeNull();
	});
});

describe('traceroute / mtr 结果', () => {
	const tracerouteHops = [
		{ resolvedAddress: '10.0.0.1', resolvedHostname: null, timings: [{ rtt: 1.23 }, { rtt: 2.34 }] },
		{ resolvedAddress: null, resolvedHostname: 'gw.example.net', timings: [] },
	];

	it('traceroute 表头与每跳 RTT', () => {
		renderMeasurement(root, measurement({ type: 'traceroute', results: [item({ hops: tracerouteHops })] }), 0);
		const table = root.querySelector('.result-card table.data-table') as HTMLElement;
		expect([...table.querySelectorAll('thead th')].map(node => node.textContent))
			.toEqual(['#', 'hopAddress', 'hopHostname', 'hopRtt']);
		const rows = [...table.querySelectorAll('tbody tr')];
		expect(rows).toHaveLength(2);
		const cells = [...rows[0]!.querySelectorAll('td')].map(node => node.textContent);
		expect(cells).toEqual(['1', '10.0.0.1', '—', '1.23 ms / 2.34 ms']);
		const second = [...rows[1]!.querySelectorAll('td')].map(node => node.textContent);
		expect(second).toEqual(['2', '*', 'gw.example.net', '*']);
	});

	it('traceroute 没有跳数时不渲染表格', () => {
		renderMeasurement(root, measurement({ type: 'traceroute', results: [item({ hops: [] })] }), 0);
		expect(root.querySelector('.result-card table')).toBeNull();
	});

	it('跳数缺少 timings 字段时按无 RTT 处理', () => {
		renderMeasurement(root, measurement({
			type: 'traceroute',
			results: [item({ hops: [{ resolvedAddress: '10.0.0.1', resolvedHostname: null }] as never })],
		}), 0);
		const cells = [...root.querySelectorAll('.result-card table.data-table tbody tr td')].map(node => node.textContent);
		expect(cells).toEqual(['1', '10.0.0.1', '—', '*']);
	});

	it('traceroute / mtr 结果缺少 hops 字段时按空跳数处理', () => {
		renderMeasurement(root, measurement({ type: 'traceroute', results: [item({})] }), 0);
		expect(root.querySelector('.result-card table')).toBeNull();
		expect((root.querySelector('.result-card-metric') as HTMLElement).textContent).toBe('0 hopsUnit');

		renderMeasurement(root, measurement({ type: 'mtr', results: [item({})] }), 0);
		expect(root.querySelector('.result-card table')).toBeNull();
		expect((root.querySelector('.result-card-metric') as HTMLElement).textContent).toBe('0 hopsUnit');
	});

	it('mtr 表头包含统计列且默认值为 0% / 破折号', () => {
		renderMeasurement(root, measurement({
			type: 'mtr',
			results: [item({
				hops: [
					{
						resolvedAddress: '10.0.0.1',
						resolvedHostname: 'r1',
						asn: [1],
						timings: [],
						stats: { min: 1, avg: 2, max: 3, total: 3, rcv: 3, drop: 0, loss: 0, stDev: null, jMin: null, jAvg: null, jMax: null },
					},
					{ resolvedAddress: '10.0.0.2', resolvedHostname: null, asn: [], timings: [], stats: undefined as never },
				],
			})],
		}), 0);
		const table = root.querySelector('.result-card table.data-table') as HTMLElement;
		expect([...table.querySelectorAll('thead th')].map(node => node.textContent))
			.toEqual(['#', 'hopAddress', 'hopHostname', 'hopLoss', 'statAvg', 'statMin', 'statMax']);
		const rows = [...table.querySelectorAll('tbody tr')];
		expect([...rows[0]!.querySelectorAll('td')].map(node => node.textContent))
			.toEqual(['1', '10.0.0.1', 'r1', '0%', '2.00 ms', '1.00 ms', '3.00 ms']);
		expect([...rows[1]!.querySelectorAll('td')].map(node => node.textContent))
			.toEqual(['2', '10.0.0.2', '—', '0%', '—', '—', '—']);
	});
});

describe('dns 结果', () => {
	const answers = [
		{ name: 'example.com', type: 'A', ttl: 300, class: 'IN', value: '93.184.216.34' },
		{ name: 'example.com', type: 'AAAA', ttl: 60, class: 'IN', value: '2606:2800::1' },
	];

	it('优先展示状态名并列出应答记录', () => {
		renderMeasurement(root, measurement({
			type: 'dns',
			results: [item({ statusCode: 0, statusCodeName: 'NOERROR', resolver: '8.8.8.8', answers })],
		}), 0);
		const body = root.querySelector('.result-card .result-body') as HTMLElement;
		const values = [...body.querySelectorAll('dl.kv dd')].map(node => node.textContent);
		expect(values).toEqual(['NOERROR', '8.8.8.8']);
		const table = body.querySelector('table.data-table') as HTMLElement;
		expect([...table.querySelectorAll('thead th')].map(node => node.textContent))
			.toEqual(['dnsName', 'dnsType', 'dnsTtl', 'dnsClass', 'dnsValue']);
		const rows = [...table.querySelectorAll('tbody tr')];
		expect(rows).toHaveLength(2);
		expect([...rows[0]!.querySelectorAll('td')].map(node => node.textContent))
			.toEqual(['example.com', 'A', '300', 'IN', '93.184.216.34']);
	});

	it('没有状态名时回落状态码，没有应答时不渲染表', () => {
		renderMeasurement(root, measurement({
			type: 'dns',
			results: [item({ statusCode: 3, resolver: '1.1.1.1' })],
		}), 0);
		const body = root.querySelector('.result-card .result-body') as HTMLElement;
		expect([...body.querySelectorAll('dl.kv dd')].map(node => node.textContent)).toEqual(['3', '1.1.1.1']);
		expect(body.querySelector('table')).toBeNull();
	});

	it('trace 模式渲染逐跳解析链', () => {
		renderMeasurement(root, measurement({
			type: 'dns',
			results: [item({
				statusCodeName: 'NOERROR',
				resolver: '8.8.8.8',
				hops: [
					{ resolver: 'a.root-servers.net', answers: [answers[0]!], timings: { total: 12.5 } },
					{ resolver: 'b.root-servers.net', answers: [], timings: { total: 30 } },
					{ resolver: 'not-a-dns-hop', answers: undefined as never, timings: { total: 1 } },
				],
			})],
		}), 0);
		const hops = [...root.querySelectorAll('.result-card .dns-hop')];
		expect(hops).toHaveLength(2);
		expect(hops[0]!.querySelector('.dns-hop-title')?.textContent).toBe('a.root-servers.net · 12.5 ms');
		expect(hops[0]!.querySelectorAll('tbody tr')).toHaveLength(1);
		expect(hops[1]!.querySelector('table')).toBeNull();
		const titles = [...root.querySelectorAll('.result-card .result-section-title')].map(node => node.textContent);
		expect(titles).toEqual(['dnsTrace']);
	});
});

describe('http 结果', () => {
	const tls = {
		authorized: true,
		protocol: 'TLSv1.3',
		cipherName: 'TLS_AES_256_GCM_SHA384',
		createdAt: '2024-01-01T00:00:00.000Z',
		expiresAt: '2025-01-01T00:00:00.000Z',
		subject: { CN: 'example.com' },
		issuer: { C: 'US', O: 'DigiCert Inc', CN: 'DigiCert TLS RSA' },
		keyType: 'RSA',
		keyBits: 2048,
		serialNumber: '01',
		fingerprint256: 'AA:BB',
		publicKey: null,
	};

	it('展示状态码与响应时间明细', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({
				statusCode: 200,
				statusCodeName: 'OK',
				resolvedAddress: '93.184.216.34',
				timings: { total: 250, dns: null, tcp: 20, tls: null, firstByte: 180, download: 50 },
			})],
		}), 0);
		const body = root.querySelector('.result-card .result-body') as HTMLElement;
		const values = [...body.querySelectorAll('dl.kv dd')].map(node => node.textContent);
		expect(values[0]).toBe('200 OK');
		expect(values[1]).toBe('93.184.216.34');
		expect([...body.querySelectorAll('.result-section-title')].map(node => node.textContent)).toContain('httpTimings');
		const timingValues = [...body.querySelectorAll('dl.kv-inline dd')].map(node => node.textContent);
		expect(timingValues).toEqual(['250.0 ms', '—', '20.0 ms', '—', '180.0 ms', '50.0 ms']);
	});

	it('响应时间明细中 dns / tls 有值时展示其耗时', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({
				statusCode: 200,
				timings: { total: 250, dns: 12.3, tcp: 20, tls: 45.6, firstByte: 180, download: 50 },
			})],
		}), 0);
		const timingValues = [...root.querySelectorAll('.result-card dl.kv-inline dd')].map(node => node.textContent);
		expect(timingValues).toEqual(['250.0 ms', '12.3 ms', '20.0 ms', '45.6 ms', '180.0 ms', '50.0 ms']);
	});

	it('状态码缺失时回落破折号', () => {
		renderMeasurement(root, measurement({ type: 'http', results: [item({})] }), 0);
		const values = [...root.querySelectorAll('.result-card .result-body dl.kv dd')].map(node => node.textContent);
		expect(values[0]).toBe('—');
	});

	it('渲染 TLS 证书信息', () => {
		renderMeasurement(root, measurement({ type: 'http', results: [item({ statusCode: 200, tls })] }), 0);
		const tlsValues = [...root.querySelectorAll('.result-card dl.kv-inline dd')].map(node => node.textContent);
		expect(tlsValues).toContain('TLSv1.3');
		expect(tlsValues).toContain('TLS_AES_256_GCM_SHA384');
		expect(tlsValues).toContain('yes');
		expect(tlsValues).toContain('example.com');
		expect(tlsValues).toContain('DigiCert Inc / DigiCert TLS RSA');
		expect(tlsValues).toContain('2025-01-01T00:00:00.000Z');
	});

	it('未授权的 TLS 证书附带宽泛错误原因', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, tls: { ...tls, authorized: false, error: 'SELF_SIGNED_CERT', subject: { CN: 'localhost' }, issuer: {} } })],
		}), 0);
		const tlsValues = [...root.querySelectorAll('.result-card dl.kv-inline dd')].map(node => node.textContent);
		expect(tlsValues).toContain('no (SELF_SIGNED_CERT)');
		expect(tlsValues).toContain('—');
	});

	it('未授权且没有错误原因时只显示否', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, tls: { ...tls, authorized: false, error: undefined } })],
		}), 0);
		const tlsValues = [...root.querySelectorAll('.result-card dl.kv-inline dd')].map(node => node.textContent);
		expect(tlsValues).toContain('no');
	});

	it('TLS 主体只有 alt 名称或完全缺失时回落', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, tls: { ...tls, subject: { alt: 'alt.example.com' } } })],
		}), 0);
		let tlsValues = [...root.querySelectorAll('.result-card dl.kv-inline dd')].map(node => node.textContent);
		expect(tlsValues).toContain('alt.example.com');

		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, tls: { ...tls, subject: undefined } })],
		}), 0);
		tlsValues = [...root.querySelectorAll('.result-card dl.kv-inline dd')].map(node => node.textContent);
		expect(tlsValues).toContain('—');
	});

	it('响应头数组值以逗号连接', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({
				statusCode: 200,
				headers: { 'content-type': 'text/html', 'set-cookie': ['a=1', 'b=2'] },
			})],
		}), 0);
		const table = root.querySelector('.result-card table.data-table') as HTMLElement;
		const rows = [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
		expect(rows).toEqual([['content-type', 'text/html'], ['set-cookie', 'a=1, b=2']]);
	});

	it('响应体展示字节数与截断提示', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, rawBody: 'x'.repeat(2048), truncated: true })],
		}), 0);
		const notes = [...root.querySelectorAll('.result-card .result-note')].map(node => node.textContent);
		expect(notes).toContain('httpBodyTruncated');
		expect(notes).toContain('2.0 KiB');
		expect(root.querySelector('.result-card pre.raw-text')?.textContent?.length).toBe(2048);
	});

	it('没有响应体时不渲染 body 区块', () => {
		renderMeasurement(root, measurement({ type: 'http', results: [item({ statusCode: 204, rawBody: null })] }), 0);
		expect([...root.querySelectorAll('.result-card .result-section-title')].map(node => node.textContent))
			.not
			.toContain('httpBody');
	});

	it('没有截断标记时不显示截断提示', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, rawBody: 'hello' })],
		}), 0);
		const notes = [...root.querySelectorAll('.result-card .result-note')].map(node => node.textContent);
		expect(notes).not.toContain('httpBodyTruncated');
		expect(notes).toContain('5 B');
	});

	it('failed / offline 结果不做类型专属渲染', () => {
		renderMeasurement(root, measurement({ type: 'http', results: [item({ status: 'failed' })] }), 0);
		expect(root.querySelector('.result-card .result-note.error')?.textContent).toBe('resultFailed');
		expect(root.querySelector('.result-card table')).toBeNull();
		renderMeasurement(root, measurement({ type: 'http', results: [item({ status: 'offline' })] }), 0);
		expect(root.querySelector('.result-card .result-note')?.textContent).toBe('resultOffline');
	});

	it('结果摘要按类型取不同指标', () => {
		const cases: Array<[MeasurementResponse['type'], Partial<TestResult>, string]> = [
			['ping', { stats: { min: 1, avg: 12.3, max: 20, total: 3, rcv: 3, drop: 0, loss: 0 } }, '12.3 ms'],
			['ping', {}, '—'],
			['dns', { statusCodeName: 'NOERROR' }, 'NOERROR'],
			['dns', {}, '—'],
			['http', { statusCode: 404 }, '404'],
			['traceroute', { hops: tracerouteHopFixture() }, '2 hopsUnit'],
			['mtr', { hops: tracerouteHopFixture() }, '2 hopsUnit'],
		];
		for (const [type, result, expected] of cases) {
			renderMeasurement(root, measurement({ type, results: [item(result)] }), 0);
			expect((root.querySelector('.result-card .result-card-metric') as HTMLElement).textContent).toBe(expected);
		}
	});
});

function tracerouteHopFixture(): unknown[] {
	return [
		{ resolvedAddress: '1.1.1.1', resolvedHostname: null, timings: [] },
		{ resolvedAddress: '1.1.1.2', resolvedHostname: null, timings: [] },
	];
}

describe('原始输出与折叠状态', () => {
	it('每张卡片都有原始输出折叠块', () => {
		renderMeasurement(root, measurement({
			results: [item({ rawOutput: 'PING example.com' }), item({ rawOutput: '' })],
		}), 0);
		const details = [...root.querySelectorAll('.result-card details.raw-output')] as HTMLDetailsElement[];
		expect(details.map(node => node.dataset.key)).toEqual(['raw-0', 'raw-1']);
		expect(details[0]!.querySelector('summary')?.textContent).toBe('rawOutput');
		expect(details[0]!.querySelector('pre')?.textContent).toBe('PING example.com');
		expect(details[1]!.querySelector('pre')?.textContent).toBe('—');
	});

	it('重新渲染时还原用户展开的折叠块', () => {
		const data = measurement({ results: [item({ rawOutput: 'a' }), item({ rawOutput: 'b' })] });
		renderMeasurement(root, data, 0);
		const first = root.querySelector('details[data-key="raw-1"]') as HTMLDetailsElement;
		first.open = true;
		renderMeasurement(root, measurement({ results: [item({ rawOutput: 'a' }), item({ rawOutput: 'b' })] }), 100);
		const details = [...root.querySelectorAll('details.raw-output')] as HTMLDetailsElement[];
		expect(details[1]!.open).toBe(true);
		expect(details[0]!.open).toBe(false);
	});

	it('重新渲染会丢弃已消失折叠块的展开状态', () => {
		renderMeasurement(root, measurement({ results: [item()] }), 0);
		(root.querySelector('details[data-key="raw-0"]') as HTMLDetailsElement).open = true;
		renderMeasurement(root, measurement({ results: [] }), 0);
		expect(root.querySelectorAll('details')).toHaveLength(0);
	});

	it('忽略没有 data-key 的展开折叠块', () => {
		const legacy = document.createElement('details');
		legacy.open = true;
		legacy.append(document.createElement('summary'));
		root.append(legacy);
		expect(() => renderMeasurement(root, measurement({ results: [item({ rawOutput: 'x' })] }), 0)).not.toThrow();
		expect(root.querySelectorAll('details.raw-output')).toHaveLength(1);
	});

	it('忽略 data-key 为空字符串的展开折叠块', () => {
		const legacy = document.createElement('details');
		legacy.setAttribute('data-key', '');
		legacy.open = true;
		legacy.append(document.createElement('summary'));
		root.append(legacy);
		expect(() => renderMeasurement(root, measurement({ results: [item({ rawOutput: 'x' })] }), 0)).not.toThrow();
		const details = [...root.querySelectorAll('details.raw-output')] as HTMLDetailsElement[];
		expect(details[0]!.open).toBe(false);
	});
});

describe('窄屏表格结构', () => {
	const mtrHops = [
		{
			resolvedAddress: '10.0.0.1',
			resolvedHostname: 'gw.example.net',
			asn: [1],
			timings: [],
			stats: { min: 1, avg: 2, max: 3, total: 3, rcv: 3, drop: 0, loss: 0, stDev: null, jMin: null, jAvg: null, jMax: null },
		},
	];

	it('traceroute / mtr 表格外层包一层 .table-wrap 以便横向滚动', () => {
		renderMeasurement(root, measurement({ type: 'mtr', results: [item({ hops: mtrHops })] }), 0);
		const body = root.querySelector('.result-card .result-body') as HTMLElement;
		const wrap = body.querySelector(':scope > .table-wrap') as HTMLElement;
		expect(wrap).not.toBeNull();
		expect(wrap.parentElement).toBe(body);
		const table = wrap.querySelector(':scope > table.data-table.hops') as HTMLElement;
		expect(table).not.toBeNull();
		expect(table.parentElement).toBe(wrap);
	});

	it('dns 应答表同样包裹在 .table-wrap 中', () => {
		renderMeasurement(root, measurement({
			type: 'dns',
			results: [item({ statusCodeName: 'NOERROR', answers: [
				{ name: 'example.com', type: 'A', ttl: 300, class: 'IN', value: '93.184.216.34' },
			] })],
		}), 0);
		const table = root.querySelector('.result-card .table-wrap > table.data-table.dns-answers') as HTMLElement;
		expect(table).not.toBeNull();
	});

	it('http 响应头表同样包裹在 .table-wrap 中', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, headers: { 'content-type': 'text/html' } })],
		}), 0);
		const table = root.querySelector('.result-card .table-wrap > table.data-table.http-headers') as HTMLElement;
		expect(table).not.toBeNull();
	});

	it('逐跳单元格带语义 class，便于小屏卡片式重排', () => {
		renderMeasurement(root, measurement({ type: 'traceroute', results: [item({ hops: mtrHops })] }), 0);
		const row = root.querySelector('.result-card table.hops tbody tr') as HTMLElement;
		expect(row.children[0]!.className).toBe('hop-idx num');
		expect(row.children[1]!.className).toBe('hop-addr mono');
		expect(row.children[2]!.className).toBe('hop-host mono dim');
		expect(row.children[3]!.className).toBe('hop-rtt num');
	});

	it('mtr 统计单元格带 data-label 以替代隐藏的表头', () => {
		renderMeasurement(root, measurement({ type: 'mtr', results: [item({ hops: mtrHops })] }), 0);
		const stats = [...root.querySelectorAll('.result-card table.hops tbody tr .hop-stat')] as HTMLElement[];
		expect(stats.map(cell => cell.dataset.label)).toEqual(['hopLoss', 'statAvg', 'statMin', 'statMax']);
		expect(stats.every(cell => cell.className === 'hop-stat num')).toBe(true);
	});

	it('traceroute 的 RTT 单元格带 data-label', () => {
		renderMeasurement(root, measurement({ type: 'traceroute', results: [item({ hops: mtrHops })] }), 0);
		const cell = root.querySelector('.result-card table.hops tbody tr .hop-rtt') as HTMLElement;
		expect(cell.dataset.label).toBe('hopRtt');
	});

	it('dns 应答单元格带语义 class 与 data-label', () => {
		renderMeasurement(root, measurement({
			type: 'dns',
			results: [item({ statusCodeName: 'NOERROR', answers: [
				{ name: 'example.com', type: 'A', ttl: 300, class: 'IN', value: '93.184.216.34' },
			] })],
		}), 0);
		const row = root.querySelector('.result-card table.dns-answers tbody tr') as HTMLElement;
		expect(row.children[0]!.className).toBe('mono dns-name');
		expect(row.children[1]!.className).toBe('num dns-meta');
		expect(row.children[1]!.getAttribute('data-label')).toBe('dnsType');
		expect(row.children[2]!.getAttribute('data-label')).toBe('dnsTtl');
		expect(row.children[3]!.getAttribute('data-label')).toBe('dnsClass');
		expect(row.children[4]!.className).toBe('mono break dns-value');
		expect(row.children[4]!.getAttribute('data-label')).toBe('dnsValue');
	});

	it('http 响应头单元格带语义 class', () => {
		renderMeasurement(root, measurement({
			type: 'http',
			results: [item({ statusCode: 200, headers: { 'content-type': 'text/html' } })],
		}), 0);
		const row = root.querySelector('.result-card table.http-headers tbody tr') as HTMLElement;
		expect(row.children[0]!.className).toBe('mono hdr-name');
		expect(row.children[1]!.className).toBe('mono break hdr-value');
	});
});
