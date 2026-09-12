/**
 * @jest-environment jsdom
 */
import type { LocationFilters, ProbeRecord } from '../../src/frontend/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type ProbesModule = typeof import('../../src/frontend/probes');

/** 造一条精简探针记录 */
function probe(
	partial: Partial<{
		city: string;
		country: string;
		continent: string;
		region: string;
		asn: number;
		network: string;
		tags: string[];
	}> = {},
): ProbeRecord {
	const {
		city = '',
		country = '',
		continent = '',
		region = '',
		asn = 0,
		network = '',
		tags = [],
	} = partial;
	return [city, country, continent, region, asn, network, tags];
}

const HELSINKI = probe({ city: 'Helsinki', country: 'FI', continent: 'EU', region: 'Northern Europe', asn: 24940, network: 'Hetzner Online', tags: ['datacenter-network'] });
const FRANKFURT = probe({ city: 'Frankfurt', country: 'DE', continent: 'EU', region: 'Western Europe', asn: 15169, network: 'Google LLC', tags: ['datacenter-network'] });
const BERLIN = probe({ city: 'Berlin', country: 'DE', continent: 'EU', region: 'Western Europe', asn: 3320, network: 'Deutsche Telekom AG', tags: ['eyeball-network'] });
const FUZHOU = probe({ city: 'Fuzhou', country: 'CN', continent: 'AS', region: 'Eastern Asia', asn: 4134, network: 'Chinanet', tags: ['eyeball-network'] });

const ALL = [HELSINKI, FRANKFURT, BERLIN, FUZHOU];

function filters(overrides: Partial<LocationFilters> = {}): LocationFilters {
	return {
		continent: '',
		country: '',
		city: '',
		asn: null,
		network: '',
		tags: [],
		magic: '',
		...overrides,
	};
}

async function freshProbes(): Promise<ProbesModule> {
	return import('../../src/frontend/probes');
}

describe('formatAsn / probeFragment', () => {
	it('ASN 归一为 AS<数字>', async () => {
		const { formatAsn } = await freshProbes();

		expect(formatAsn(24940)).toBe('AS24940');
		expect(formatAsn('AS24940')).toBe('AS24940');
		expect(formatAsn('24940')).toBe('AS24940');
		expect(formatAsn('')).toBe('');
		expect(formatAsn(null)).toBe('');
	});

	it('片段为 城市+国家+AS号+网络标签', async () => {
		const { probeFragment } = await freshProbes();

		expect(probeFragment(HELSINKI)).toBe('Helsinki+FI+AS24940+datacenter-network');
		expect(probeFragment(BERLIN)).toBe('Berlin+DE+AS3320+eyeball-network');
	});

	it('字段缺失时退化为 world', async () => {
		const { probeFragment } = await freshProbes();

		expect(probeFragment(probe())).toBe('world');
	});

	it('片段能被自身匹配', async () => {
		const { probeFragment, probeMatchesMagic } = await freshProbes();

		for (const item of ALL) {
			expect(probeMatchesMagic(item, probeFragment(item))).toBe(true);
		}
	});
});

describe('normalizeMagic / splitMagic / splitToken', () => {
	it('换行归一为逗号分隔', async () => {
		const { normalizeMagic } = await freshProbes();

		expect(normalizeMagic('Berlin+DE\nFrankfurt+DE')).toBe('Berlin+DE, Frankfurt+DE');
		expect(normalizeMagic('  A ,, B  ')).toBe('A, B');
	});

	it('按逗号拆条件并去掉空项', async () => {
		const { splitMagic } = await freshProbes();

		expect(splitMagic('A, B ,, C')).toEqual(['A', 'B', 'C']);
		expect(splitMagic('  ')).toEqual([]);
	});

	it('条件按 + 拆片段', async () => {
		const { splitToken } = await freshProbes();

		expect(splitToken('Helsinki+FI+AS24940')).toEqual(['Helsinki', 'FI', 'AS24940']);
		expect(splitToken('  ')).toEqual([]);
	});
});

describe('appendFragment / removeFragment', () => {
	it('追加片段并去掉占位的 world', async () => {
		const { appendFragment } = await freshProbes();

		expect(appendFragment('', 'Berlin+DE')).toBe('Berlin+DE');
		expect(appendFragment('world', 'Berlin+DE')).toBe('Berlin+DE');
		expect(appendFragment('Berlin+DE', 'Frankfurt+DE')).toBe('Berlin+DE, Frankfurt+DE');
	});

	it('重复添加同一片段时保持不变', async () => {
		const { appendFragment } = await freshProbes();

		expect(appendFragment('Berlin+DE', 'Berlin+DE')).toBe('Berlin+DE');
	});

	it('移除片段', async () => {
		const { removeFragment } = await freshProbes();

		expect(removeFragment('Berlin+DE, Frankfurt+DE', 'Berlin+DE')).toBe('Frankfurt+DE');
		expect(removeFragment('Berlin+DE', 'Berlin+DE')).toBe('');
		expect(removeFragment('Berlin+DE', 'Nope+DE')).toBe('Berlin+DE');
	});
});

describe('probeMatchesMagic', () => {
	it('空 magic 与 world 都不做限制', async () => {
		const { probeMatchesMagic } = await freshProbes();

		expect(probeMatchesMagic(HELSINKI, '')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'world')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'WORLD')).toBe(true);
	});

	it('同一条件内片段是「与」', async () => {
		const { probeMatchesMagic } = await freshProbes();

		expect(probeMatchesMagic(HELSINKI, 'Helsinki+FI')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'Helsinki+DE')).toBe(false);
		expect(probeMatchesMagic(HELSINKI, 'Helsinki+AS24940')).toBe(true);
	});

	it('多个条件之间是「或」', async () => {
		const { probeMatchesMagic } = await freshProbes();

		expect(probeMatchesMagic(HELSINKI, 'Berlin+DE, Helsinki+FI')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'Berlin+DE, Fuzhou+CN')).toBe(false);
	});

	it('纯数字与 AS 前缀都按 ASN 精确比较', async () => {
		const { probeMatchesMagic } = await freshProbes();

		expect(probeMatchesMagic(HELSINKI, 'AS24940')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, '24940')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'AS24941')).toBe(false);
	});

	it('国家码 / 城市 / 大洲 / 次区域 / 网络都能命中', async () => {
		const { probeMatchesMagic } = await freshProbes();

		for (const token of ['FI', 'Helsinki', 'EU', 'Northern Europe', 'Hetzner']) {
			expect(probeMatchesMagic(HELSINKI, token)).toBe(true);
		}
		expect(probeMatchesMagic(HELSINKI, 'Fuzhou')).toBe(false);
	});

	it('eyeball / datacenter 别名按标签判断', async () => {
		const { probeMatchesMagic } = await freshProbes();

		expect(probeMatchesMagic(BERLIN, 'eyeball')).toBe(true);
		expect(probeMatchesMagic(BERLIN, 'eyeball-network')).toBe(true);
		expect(probeMatchesMagic(BERLIN, 'datacenter')).toBe(false);
		expect(probeMatchesMagic(HELSINKI, 'datacenter-network')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'eyeball-network')).toBe(false);
	});

	it('大小写不敏感', async () => {
		const { probeMatchesMagic } = await freshProbes();

		expect(probeMatchesMagic(HELSINKI, 'helsinki+fi')).toBe(true);
		expect(probeMatchesMagic(HELSINKI, 'AS24940+HETZNER')).toBe(true);
	});
});

describe('probeMatchesFilters', () => {
	it('无任何条件时全部命中', async () => {
		const { probeMatchesFilters } = await freshProbes();

		expect(ALL.filter(item => probeMatchesFilters(item, filters()))).toHaveLength(4);
	});

	it('按国家 / 城市 / 大洲 / 网络筛选', async () => {
		const { probeMatchesFilters } = await freshProbes();

		expect(ALL.filter(item => probeMatchesFilters(item, filters({ country: 'DE' })))).toEqual([FRANKFURT, BERLIN]);
		expect(ALL.filter(item => probeMatchesFilters(item, filters({ city: 'Helsinki' })))).toEqual([HELSINKI]);
		expect(ALL.filter(item => probeMatchesFilters(item, filters({ continent: 'AS' })))).toEqual([FUZHOU]);
		expect(ALL.filter(item => probeMatchesFilters(item, filters({ network: 'Chinanet' })))).toEqual([FUZHOU]);
	});

	it('ASN 精确匹配', async () => {
		const { probeMatchesFilters } = await freshProbes();

		expect(ALL.filter(item => probeMatchesFilters(item, filters({ asn: 15169 })))).toEqual([FRANKFURT]);
	});

	it('多个标签取「与」（与上游语义一致）', async () => {
		const { probeMatchesFilters } = await freshProbes();

		expect(ALL.filter(item => probeMatchesFilters(item, filters({ tags: ['datacenter-network'] })))).toEqual([HELSINKI, FRANKFURT]);
		// 没有任何探针同时具备这两种标签
		expect(ALL.filter(item => probeMatchesFilters(item, filters({ tags: ['datacenter-network', 'eyeball-network'] })))).toEqual([]);
	});

	it('有结构化字段时忽略 magic（与 buildLocation 口径一致）', async () => {
		const { probeMatchesFilters } = await freshProbes();

		// magic 指向 Fuzhou，但结构化字段限定 DE：结构化字段优先
		const result = ALL.filter(item => probeMatchesFilters(item, filters({ country: 'DE', magic: 'Fuzhou+CN' })));

		expect(result).toEqual([FRANKFURT, BERLIN]);
	});

	it('只有 magic 时按 magic 匹配', async () => {
		const { probeMatchesFilters } = await freshProbes();

		expect(ALL.filter(item => probeMatchesFilters(item, filters({ magic: 'Fuzhou+CN' })))).toEqual([FUZHOU]);
	});
});

describe('matchProbes', () => {
	it('标出能单独定位探针的片段', async () => {
		const { matchProbes } = await freshProbes();

		const hits = matchProbes(ALL, filters({ magic: 'Helsinki+FI+AS24940' }));

		expect(hits).toHaveLength(1);
		expect(hits[0].probe).toBe(HELSINKI);
		expect(hits[0].fragment).toBe('Helsinki+FI+AS24940');
	});

	it('只有 ASN 的宽泛条件不给可移除片段', async () => {
		const { matchProbes } = await freshProbes();

		const hits = matchProbes(ALL, filters({ magic: 'AS24940' }));

		expect(hits).toHaveLength(1);
		expect(hits[0].fragment).toBeNull();
	});

	it('被宽泛条件带进来的探针不给可移除片段', async () => {
		const { matchProbes } = await freshProbes();

		const hits = matchProbes(ALL, filters({ magic: 'DE' }));

		expect(hits).toHaveLength(2);
		expect(hits.every(hit => hit.fragment === null)).toBe(true);
	});

	it('结构化筛选下不提供可移除片段（筛选条件不在 magic 里）', async () => {
		const { matchProbes } = await freshProbes();

		const hits = matchProbes(ALL, filters({ country: 'DE', magic: 'Helsinki+FI+AS24940' }));

		expect(hits.map(hit => hit.probe)).toEqual([FRANKFURT, BERLIN]);
		expect(hits.every(hit => hit.fragment === null)).toBe(true);
	});
});

describe('loadProbeList', () => {
	let fetchMock: jest.Mock;

	beforeEach(() => {
		fetchMock = jest.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(async () => {
		const { resetProbeListCache } = await freshProbes();
		resetProbeListCache();
	});

	function jsonResponse(body: unknown, status = 200): Response {
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as unknown as Response;
	}

	it('请求 /api/probe-list 并返回列表', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([HELSINKI]));

		const { loadProbeList } = await freshProbes();
		const list = await loadProbeList();

		expect(fetchMock.mock.calls[0][0]).toBe('/api/probe-list');
		expect(list).toEqual([HELSINKI]);
	});

	it('内存缓存：第二次调用不再请求', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([HELSINKI]));

		const { loadProbeList } = await freshProbes();
		await loadProbeList();
		await loadProbeList();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('并发调用合并为一次请求', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([HELSINKI]));

		const { loadProbeList } = await freshProbes();
		await Promise.all([loadProbeList(), loadProbeList()]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('HTTP 失败返回 null', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 502));

		const { loadProbeList } = await freshProbes();

		expect(await loadProbeList()).toBeNull();
	});

	it('网络异常返回 null', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('offline'));

		const { loadProbeList } = await freshProbes();

		expect(await loadProbeList()).toBeNull();
	});

	it('响应不是数组时返回 null', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({ nope: true }));

		const { loadProbeList } = await freshProbes();

		expect(await loadProbeList()).toBeNull();
	});

	it('过滤掉结构不符的条目', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse([HELSINKI, { bad: true }, null, ['a', 'b', 'c', 'd', 'e', 'f', 'g']]));

		const { loadProbeList } = await freshProbes();
		const list = await loadProbeList();

		expect(list).toEqual([HELSINKI]);
	});

	it('失败后不写缓存，下次调用会重试', async () => {
		fetchMock.mockResolvedValueOnce(jsonResponse({}, 502));
		fetchMock.mockResolvedValueOnce(jsonResponse([HELSINKI]));

		const { loadProbeList } = await freshProbes();
		expect(await loadProbeList()).toBeNull();
		expect(await loadProbeList()).toEqual([HELSINKI]);
	});
});
