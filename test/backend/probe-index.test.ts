import type { RawProbe } from '../../src/utils/probe-index';
import { describe, expect, it } from '@jest/globals';
import { buildProbeIndex, buildProbeList, PROBE_INDEX_VERSION } from '../../src/utils/probe-index';

/** 造一条探针，只填建立索引需要的字段 */
function probe(location: RawProbe['location'], tags: string[] = []): RawProbe {
	return { location, tags };
}

describe('buildProbeIndex', () => {
	it('输出去重后的索引骨架与版本号', () => {
		const index = buildProbeIndex([probe({ country: 'DE' })]);

		expect(index.version).toBe(PROBE_INDEX_VERSION);
		expect(index.total).toBe(1);
		expect(index.generatedAt).toBeLessThanOrEqual(Date.now());
		expect(index.generatedAt).toBeGreaterThan(Date.now() - 10_000);
	});

	it('按取值聚合探针数量', () => {
		const index = buildProbeIndex([
			probe({ country: 'DE', region: 'Western Europe', city: 'Fuzhou', asn: 4134, network: 'Chinanet' }, ['eyeball-network']),
			probe({ country: 'DE', region: 'Western Europe', city: 'Fuzhou', asn: 4134, network: 'Chinanet' }, ['eyeball-network']),
			probe({ country: 'CN', region: 'Eastern Asia', city: 'Fuzhou', asn: 4134, network: 'Chinanet' }),
		]);

		expect(index.total).toBe(3);
		expect(index.countries).toEqual([['DE', 2], ['CN', 1]]);
		expect(index.regions).toEqual([['Western Europe', 2], ['Eastern Asia', 1]]);
		expect(index.cities).toEqual([['Fuzhou', 'DE', 2], ['Fuzhou', 'CN', 1]]);
		expect(index.tags).toEqual([['eyeball-network', 2]]);
	});

	it('城市名相同但国家不同时分别统计（避免跨国混淆）', () => {
		const index = buildProbeIndex([
			probe({ country: 'US', city: 'Springfield' }),
			probe({ country: 'US', city: 'Springfield' }),
			probe({ country: 'AU', city: 'Springfield' }),
		]);

		expect(index.cities).toEqual([['Springfield', 'US', 2], ['Springfield', 'AU', 1]]);
	});

	it('同一 ASN 的不同网络名分开统计', () => {
		const index = buildProbeIndex([
			probe({ network: 'Google LLC', asn: 15169 }),
			probe({ network: 'Google LLC', asn: 15169 }),
			probe({ network: 'Google Cloud', asn: 15169 }),
		]);

		expect(index.networks).toEqual([
			['Google LLC', 15169, 2],
			['Google Cloud', 15169, 1],
		]);
	});

	it('缺少 ASN 或网络名时不产生网络条目', () => {
		const index = buildProbeIndex([
			probe({ network: 'Only Name' }),
			probe({ asn: 13335 }),
		]);

		expect(index.networks).toEqual([]);
	});

	it('数量相同时按取值升序，保证输出稳定可测', () => {
		const index = buildProbeIndex([
			probe({ country: 'US' }),
			probe({ country: 'DE' }),
			probe({ country: 'AE' }),
		]);

		expect(index.countries.map(([code]) => code)).toEqual(['AE', 'DE', 'US']);
	});

	it('忽略空字段与空标签，不会产生空键条目', () => {
		const index = buildProbeIndex([
			probe({ country: '', region: undefined, city: '', asn: 0, network: '' }, ['', 'datacenter-network']),
		]);

		expect(index.countries).toEqual([]);
		expect(index.regions).toEqual([]);
		expect(index.cities).toEqual([]);
		expect(index.networks).toEqual([]);
		expect(index.tags).toEqual([['datacenter-network', 1]]);
		expect(index.total).toBe(1);
	});

	it('容忍缺字段的畸形探针条目', () => {
		const index = buildProbeIndex([
			{} as RawProbe,
			{ location: {} } as RawProbe,
			{ tags: ['x'] } as RawProbe,
		]);

		expect(index.total).toBe(3);
		expect(index.tags).toEqual([['x', 1]]);
	});

	it('传入非数组时返回空索引', () => {
		const index = buildProbeIndex(null as unknown as RawProbe[]);

		expect(index.total).toBe(0);
		expect(index.countries).toEqual([]);
		expect(index.cities).toEqual([]);
		expect(index.tags).toEqual([]);
	});

	it('输出结构可直接序列化为 JSON（无 Map/undefined 残留）', () => {
		const index = buildProbeIndex([probe({ country: 'DE', city: 'Berlin' }, ['datacenter-network'])]);
		const parsed = JSON.parse(JSON.stringify(index)) as typeof index;

		expect(parsed).toEqual(index);
	});
});

describe('buildProbeList', () => {
	it('保留每一条探针，字段顺序为 [城市, 国家, 大洲, 次区域, ASN, 网络, 标签]', () => {
		const list = buildProbeList([
			probe({ city: 'Helsinki', country: 'FI', continent: 'EU', region: 'Northern Europe', asn: 24940, network: 'Hetzner Online' }, ['datacenter-network']),
		]);

		expect(list).toEqual([
			['Helsinki', 'FI', 'EU', 'Northern Europe', 24940, 'Hetzner Online', ['datacenter-network']],
		]);
	});

	it('不去重：重复位置的探针各占一条（列表要逐条展示）', () => {
		const list = buildProbeList([
			probe({ city: 'Fuzhou', country: 'CN', asn: 4134 }),
			probe({ city: 'Fuzhou', country: 'CN', asn: 4134 }),
		]);

		expect(list).toHaveLength(2);
	});

	it('缺失字段补空串 / 0，且丢弃没有 location 的条目', () => {
		const list = buildProbeList([
			{ location: {} } as RawProbe,
			{} as RawProbe,
		]);

		expect(list).toEqual([['', '', '', '', 0, '', []]]);
	});

	it('标签数组是拷贝，改列表不会影响原始数据', () => {
		const source = [probe({ country: 'DE' }, ['datacenter-network'])];
		const list = buildProbeList(source);
		list[0][6].push('mutated');

		expect(source[0].tags).toEqual(['datacenter-network']);
	});

	it('传入非数组时返回空列表', () => {
		expect(buildProbeList(null as unknown as RawProbe[])).toEqual([]);
	});
});
