/**
 * 探针位置索引
 *
 * Globalping `/v1/probes` 返回全部在线探针（约 5000 条 / 2 MB），前端做位置筛选
 * 自动补全只需要「有哪些取值、各有多少探针」这两件事。这里把它压成约 90 KiB 的
 * 去重索引（按出现次数降序），前端一次拉取后即可在本地完成模糊匹配。
 */

/** 索引结构版本；结构变化时递增，用于让前端丢弃旧缓存 */
export const PROBE_INDEX_VERSION = 1;

/** 上游探针条目（只声明建立索引用到的字段） */
export interface RawProbe {
	location?: {
		continent?: string;
		region?: string;
		country?: string;
		city?: string;
		asn?: number;
		network?: string;
	};
	tags?: string[];
}

/**
 * 去重后的探针位置索引
 *
 * 每个条目都是 `[..., 探针数量]`，且已按「数量降序 + 取值升序」稳定排序，
 * 因此前端无需再排序即可得到「热门优先」的候选顺序。
 */
export interface ProbeIndexData {
	version: number;
	/** 生成时刻（Unix ms） */
	generatedAt: number;
	/** 参与统计的探针总数 */
	total: number;
	/** `[ISO 3166-1 alpha-2 国家代码, 探针数]` */
	countries: Array<[string, number]>;
	/** `[UN 次区域名（如 Western Europe）, 探针数]` */
	regions: Array<[string, number]>;
	/** `[城市名, 国家代码, 探针数]`（城市名跨国不唯一，必须带国家消歧） */
	cities: Array<[string, string, number]>;
	/** `[网络名, ASN, 探针数]`（同一网络可能对应多个国家的探针） */
	networks: Array<[string, number, number]>;
	/** `[标签, 探针数]` */
	tags: Array<[string, number]>;
}

/** 组合键分隔符：探针取值里不可能出现的控制字符 */
const SEP = '\u0000';

/** 数量降序、同数量按第一个字段升序，保证输出稳定可测 */
function compareEntries(a: [string, number], b: [string, number]): number {
	return b[1] - a[1] || a[0].localeCompare(b[0]);
}

/** 从 `map` 取出 `[组合键, 数量]`并按热度排序 */
function toPairs(map: Map<string, number>): Array<[string, number]> {
	return [...map.entries()].sort(compareEntries);
}

function bump(map: Map<string, number>, key: string | undefined): void {
	if (!key) {
		return;
	}
	map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * 把原始探针列表压成去重索引
 *
 * 传入非数组时按空列表处理，返回 `total: 0` 的空索引。
 */
export function buildProbeIndex(probes: RawProbe[]): ProbeIndexData {
	const countries = new Map<string, number>();
	const regions = new Map<string, number>();
	const cities = new Map<string, number>();
	const networks = new Map<string, number>();
	const tags = new Map<string, number>();

	const list = Array.isArray(probes) ? probes : [];
	for (const probe of list) {
		const location = probe?.location ?? {};
		bump(countries, location.country);
		bump(regions, location.region);
		if (location.city) {
			bump(cities, `${location.city}${SEP}${location.country ?? ''}`);
		}
		// 同一网络可能在不同国家的探针上出现，按「网络名 + ASN」聚合
		if (location.network && location.asn) {
			bump(networks, `${location.network}${SEP}${location.asn}`);
		}
		for (const tag of probe?.tags ?? []) {
			bump(tags, tag);
		}
	}

	return {
		version: PROBE_INDEX_VERSION,
		generatedAt: Date.now(),
		total: list.length,
		countries: toPairs(countries),
		regions: toPairs(regions),
		cities: toPairs(cities).map(([key, count]) => {
			const [city, country] = key.split(SEP);
			return [city, country ?? '', count];
		}),
		networks: toPairs(networks).map(([key, count]) => {
			const [name, asn] = key.split(SEP);
			return [name, Number(asn) || 0, count];
		}),
		tags: toPairs(tags),
	};
}
