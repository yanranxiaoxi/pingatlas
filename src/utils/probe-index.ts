/**
 * 探针位置索引
 *
 * Globalping `/v1/probes` 返回全部在线探针（约 5000 条 / 2 MB），前端做位置筛选
 * 自动补全只需要「有哪些取值、各有多少探针」这两件事。这里把它压成约 90 KiB 的
 * 去重索引（按出现次数降序），前端一次拉取后即可在本地完成模糊匹配。
 */

/** 索引结构版本；结构变化时递增，用于让前端丢弃旧缓存 */
export const PROBE_INDEX_VERSION = 1;

/** 上游探针条目（只声明建立索引与列表用到的字段） */
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
 * 精简探针记录：`[城市, 国家码, 大洲码, 次区域名, ASN, 网络名, 标签]`
 *
 * 用元组而不是对象：5062 条探针走对象嵌套约 800 KB，元组约 500 KB（gzip 后
 * 约 70 KB），而前端只在「探针列表」标签页需要时才拉取。字段顺序与下方
 * `buildProbeList` 一一对应，缺省值统一用空串 / 0，避免前端反复判空。
 */
export type ProbeRecord = [string, string, string, string, number, string, string[]];

/** `ProbeRecord` 各下标，避免调用方写魔法数字 */
export const PROBE_FIELD = {
	city: 0,
	country: 1,
	continent: 2,
	region: 3,
	asn: 4,
	network: 5,
	tags: 6,
} as const;

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

/**
 * 把原始探针列表压成精简记录数组，供「探针列表」标签页逐条展示与匹配
 *
 * 与索引不同，这里保留每一条探针，因此调用方要控制下发体积；
 * 缺少位置的条目会被丢弃（无法参与位置筛选，展示也没有意义）。
 */
export function buildProbeList(probes: RawProbe[]): ProbeRecord[] {
	const list = Array.isArray(probes) ? probes : [];
	const records: ProbeRecord[] = [];
	for (const probe of list) {
		const location = probe?.location;
		if (!location) {
			continue;
		}
		records.push([
			location.city ?? '',
			location.country ?? '',
			location.continent ?? '',
			location.region ?? '',
			typeof location.asn === 'number' ? location.asn : 0,
			location.network ?? '',
			Array.isArray(probe.tags) ? [...probe.tags] : [],
		]);
	}
	return records;
}
