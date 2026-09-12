import type { LocationFilters, MatchedProbe, ProbeRecord } from './types';

/**
 * 精简探针列表：加载、magic 片段拼装与匹配
 *
 * 「Probes 列表」与「匹配 Probes 列表」两个标签页共用这里的数据与匹配逻辑。
 * 匹配语义对齐 Globalping magic 的官方约定：
 * - magic 用逗号分隔多个条件，条件之间是「或」；同一条件内用 `+` 连接，是「与」
 * - 纯数字或 `AS` + 数字按 ASN 精确比较
 * - `eyeball(-network)` / `datacenter(-network)` 按探针标签判断
 * - 其余按「探针字段包含该片段」模糊比较（国家码、城市、大洲、次区域、网络、标签）
 */

/** 列表数据源；后端与 `/api/probes` 共用同一份上游缓存 */
export const PROBE_LIST_URL = '/api/probe-list';
/** 列表最多渲染多少条：5062 条全量塞进 DOM 会明显卡顿，故与参考实现一致取前 160 条 */
export const PROBE_LIST_LIMIT = 160;
/** magic 里的「不限」关键字 */
export const MAGIC_ANY = 'world';
/** 标签筛选的别名：这些片段按标签判断，而不是按位置字段 */
const EYEBALL_ALIASES = new Set(['eyeball', 'eyeball-network']);
const DATACENTER_ALIASES = new Set(['datacenter', 'datacenter-network']);

let cachedList: ProbeRecord[] | null = null;
let pendingList: Promise<ProbeRecord[] | null> | null = null;

function isProbeRecord(value: unknown): value is ProbeRecord {
	return Array.isArray(value) && typeof value[1] === 'string' && typeof value[4] === 'number' && Array.isArray(value[6]);
}

/** 单次请求 `/api/probe-list`；任何异常都降级为 null（两个列表都不渲染） */
async function fetchProbeList(): Promise<ProbeRecord[] | null> {
	try {
		const res = await fetch(PROBE_LIST_URL, { headers: { Accept: 'application/json' } });
		if (!res.ok) {
			return null;
		}
		const data = (await res.json()) as unknown;
		if (!Array.isArray(data)) {
			return null;
		}
		return data.filter(isProbeRecord);
	}
	catch {
		// 离线 / 服务端不可用：退化为「没有列表」，不影响测量本身
		return null;
	}
}

/**
 * 取得精简探针列表
 *
 * 只在内存里缓存（约 500 KB，放 localStorage 会挤爆配额），页面刷新后重新拉取；
 * 并发调用会合并成一次请求。
 */
export function loadProbeList(): Promise<ProbeRecord[] | null> {
	if (cachedList) {
		return Promise.resolve(cachedList);
	}
	if (!pendingList) {
		pendingList = fetchProbeList()
			.then((list) => {
				if (list) {
					cachedList = list;
				}
				return list;
			})
			.finally(() => {
				pendingList = null;
			});
	}
	return pendingList;
}

/** 清空内存缓存（测试隔离用） */
export function resetProbeListCache(): void {
	cachedList = null;
	pendingList = null;
}

// ===================== 字段读取 =====================

export function probeCity(probe: ProbeRecord): string {
	return probe[0];
}

export function probeCountry(probe: ProbeRecord): string {
	return probe[1];
}

export function probeContinent(probe: ProbeRecord): string {
	return probe[2];
}

export function probeRegion(probe: ProbeRecord): string {
	return probe[3];
}

export function probeAsnNumber(probe: ProbeRecord): number {
	return probe[4];
}

export function probeNetwork(probe: ProbeRecord): string {
	return probe[5];
}

export function probeTags(probe: ProbeRecord): string[] {
	return probe[6];
}

/** `24940` → `AS24940`；空值返回空串 */
export function formatAsn(asn: number | string | null | undefined): string {
	const raw = String(asn ?? '').trim();
	if (!raw) {
		return '';
	}
	const digits = raw.replace(/^AS/i, '').trim();
	return digits ? `AS${digits}` : '';
}

// ===================== magic 片段 =====================

/**
 * 一条探针 → magic 片段，例如 `Helsinki+FI+AS24940+datacenter-network`
 *
 * 城市 + 国家码 + ASN 已足以把绝大多数探针定位到唯一一条，网络标签用于进一步区分
 * 同城同 ASN 下的不同类型节点。位置字段全缺时退回 `world`（不限）。
 */
export function probeFragment(probe: ProbeRecord): string {
	const tags = probeTags(probe).map(tag => tag.toLowerCase());
	const asn = probeAsnNumber(probe);
	const parts = [
		probeCity(probe),
		probeCountry(probe),
		// ASN 缺失时是 0，不能渲染成 `AS0`
		asn > 0 ? formatAsn(asn) : '',
		tags.some(tag => DATACENTER_ALIASES.has(tag)) ? 'datacenter-network' : '',
		tags.some(tag => EYEBALL_ALIASES.has(tag)) ? 'eyeball-network' : '',
	];
	return parts.filter(Boolean).join('+') || MAGIC_ANY;
}

/**
 * 把 textarea 里的换行归一成 magic 接受的分隔符（magic 只认逗号）
 *
 * 同时去掉多余的分隔符与首尾空白，因此 `' A ,, B '` 与 `'A\nB'` 都会得到 `'A, B'`。
 */
export function normalizeMagic(raw: string): string {
	return raw
		.replace(/[\r\n]+/g, ',')
		.split(',')
		.map(part => part.trim())
		.filter(Boolean)
		.join(', ');
}

/** 按逗号拆成多个条件，去掉空白项 */
export function splitMagic(magic: string): string[] {
	const normalized = normalizeMagic(magic);
	return normalized ? normalized.split(',').map(part => part.trim()).filter(Boolean) : [];
}

/** 单个条件按 `+` 拆成多个片段 */
export function splitToken(token: string): string[] {
	return token.split('+').map(part => part.trim()).filter(Boolean);
}

/** 追加一个片段到 magic 末尾（已存在时不重复添加） */
export function appendFragment(magic: string, fragment: string): string {
	const tokens = splitMagic(magic).filter(token => token !== MAGIC_ANY);
	const target = fragment.trim();
	if (!target || tokens.includes(target)) {
		return tokens.join(', ');
	}
	tokens.push(target);
	return tokens.join(', ');
}

/** 从 magic 中移除一个片段（不存在时原样返回） */
export function removeFragment(magic: string, fragment: string): string {
	const target = fragment.trim();
	if (!target) {
		return splitMagic(magic).join(', ');
	}
	return splitMagic(magic).filter(token => token !== target).join(', ');
}

// ===================== 匹配 =====================

function trimmedLower(value: string | number | null | undefined): string {
	return String(value ?? '').trim().toLowerCase();
}

/** 片段是否是纯数字或 `AS` + 数字（按 ASN 比较） */
function isAsnPart(part: string): boolean {
	return /^(?:AS)?\d+$/i.test(part.trim());
}

/** 探针字段是否「包含」片段（大小写不敏感）；片段为空时视为不限制 */
function fieldIncludes(value: string, part: string): boolean {
	const needle = trimmedLower(part);
	return !needle || trimmedLower(value).includes(needle);
}

/** 探针标签里是否有包含该片段的项 */
function tagsInclude(tags: string[], part: string): boolean {
	const needle = trimmedLower(part);
	return !needle || tags.some(tag => trimmedLower(tag).includes(needle));
}

/** 探针标签是否命中某一类别（eyeball / datacenter） */
function hasTagKind(tags: string[], kind: 'eyeball' | 'datacenter'): boolean {
	const aliases = kind === 'eyeball' ? EYEBALL_ALIASES : DATACENTER_ALIASES;
	return tags.some(tag => aliases.has(trimmedLower(tag)));
}

/** 单个片段是否命中探针 */
function probeMatchesPart(probe: ProbeRecord, part: string): boolean {
	const raw = part.trim();
	if (!raw) {
		return true;
	}
	if (isAsnPart(raw)) {
		return formatAsn(probeAsnNumber(probe)) === formatAsn(raw);
	}
	const needle = trimmedLower(raw);
	const tags = probeTags(probe);
	if (EYEBALL_ALIASES.has(needle)) {
		return hasTagKind(tags, 'eyeball');
	}
	if (DATACENTER_ALIASES.has(needle)) {
		return hasTagKind(tags, 'datacenter');
	}
	return fieldIncludes(probeCountry(probe), raw)
		|| fieldIncludes(probeCity(probe), raw)
		|| fieldIncludes(probeRegion(probe), raw)
		|| fieldIncludes(probeContinent(probe), raw)
		|| fieldIncludes(probeNetwork(probe), raw)
		|| tagsInclude(tags, raw);
}

/** 单个条件（`+` 连接）是否命中探针：所有片段都命中才算命中 */
export function probeMatchesToken(probe: ProbeRecord, token: string): boolean {
	const parts = splitToken(token);
	if (!parts.length) {
		return true;
	}
	if (parts.some(part => trimmedLower(part) === MAGIC_ANY)) {
		return true;
	}
	return parts.every(part => probeMatchesPart(probe, part));
}

/** magic 是否命中探针：多个条件之间是「或」；magic 为空或 `world` 时视为不限制 */
export function probeMatchesMagic(probe: ProbeRecord, magic: string): boolean {
	const tokens = splitMagic(magic).filter(token => trimmedLower(token) !== MAGIC_ANY);
	if (!tokens.length) {
		return true;
	}
	return tokens.some(token => probeMatchesToken(probe, token));
}

/**
 * 这个条件能否把探针单独定位出来（用于决定匹配列表里是否给出「移除」按钮）
 *
 * 要求同时含有 ASN 片段和位置/标签片段：只有 `AS24940` 会命中同一网络下的全部
 * 探针，单独移除它影响面过大，因此不视为可单独移除。
 */
function isProbeLevelToken(probe: ProbeRecord, token: string): boolean {
	const fragments = splitToken(token);
	const asnPart = fragments.find(isAsnPart);
	if (!asnPart || formatAsn(probeAsnNumber(probe)) !== formatAsn(asnPart)) {
		return false;
	}
	return fragments.some(part => !isAsnPart(part));
}

/** 当前筛选是否包含任何结构化条件（与 `buildLocation()` 的判断口径一致） */
export function hasStructuredFilters(filters: LocationFilters): boolean {
	return Boolean(
		filters.continent.trim()
		|| filters.country.trim()
		|| filters.city.trim()
		|| filters.network.trim()
		|| filters.tags.length
		|| (filters.asn !== null && Number.isFinite(filters.asn)),
	);
}

/**
 * 探针是否符合当前筛选条件
 *
 * 口径与 `measure.ts` 的 `buildLocation()` 一致：有结构化字段就只看结构化字段，
 * 全为空时才用 magic。这样列表预览与实际发出的请求不会互相矛盾。
 */
export function probeMatchesFilters(probe: ProbeRecord, filters: LocationFilters): boolean {
	if (hasStructuredFilters(filters)) {
		const tags = probeTags(probe);
		if (!fieldIncludes(probeContinent(probe), filters.continent)) {
			return false;
		}
		if (!fieldIncludes(probeCountry(probe), filters.country)) {
			return false;
		}
		if (!fieldIncludes(probeCity(probe), filters.city)) {
			return false;
		}
		if (!fieldIncludes(probeNetwork(probe), filters.network)) {
			return false;
		}
		if (filters.asn !== null && Number.isFinite(filters.asn) && probeAsnNumber(probe) !== filters.asn) {
			return false;
		}
		// 上游对 tags 数组取「与」：实测同时给 datacenter-network 与 eyeball-network
		// 会返回 no_probes_found，说明列出的每个标签都必须命中
		return filters.tags.every(tag => tagsInclude(tags, tag));
	}
	return probeMatchesMagic(probe, filters.magic);
}

/**
 * 匹配探针列表
 *
 * 返回顺序与传入顺序一致（即上游返回顺序），并标出每条探针对应的 magic 片段
 * （仅当该片段能把这条探针单独定位出来时才有值）。
 */
export function matchProbes(list: ProbeRecord[], filters: LocationFilters): MatchedProbe[] {
	const tokens = hasStructuredFilters(filters)
		? []
		: splitMagic(filters.magic).filter(token => trimmedLower(token) !== MAGIC_ANY && token.includes('+'));
	return list
		.filter(probe => probeMatchesFilters(probe, filters))
		.map(probe => ({
			probe,
			fragment: tokens.find(token => probeMatchesToken(probe, token) && isProbeLevelToken(probe, token)) ?? null,
		}));
}
