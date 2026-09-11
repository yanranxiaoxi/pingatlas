import type { ProbeIndex, ProbeIndexKind, SuggestCandidate } from './types';
import { t } from './i18n';
import { countryName, el, flagEmoji } from './ui';

/**
 * 位置筛选自动补全
 *
 * 数据来自站内 `/api/probes`（服务端把 Globalping 全部探针压成去重索引），
 * 拉到本地后一次遍历即可模糊匹配——不区分大小写、忽略变音符号、支持跳字子序列，
 * 因此输入 `Fuzho` 也能命中 `Fuzhou`。
 */

/** 索引结构版本，与后端 `PROBE_INDEX_VERSION` 对应；不一致时丢弃旧缓存 */
export const INDEX_VERSION = 1;
/** 本地缓存保质期：过期后先用手上的数据，同时在后台静默刷新 */
export const INDEX_TTL = 24 * 60 * 60 * 1000;
/** 本地缓存最多留 3 天，再久就当作脏数据丢掉 */
const INDEX_MAX_AGE = INDEX_TTL * 3;
/** 前缀/包含/子序列三档之外的质量分——精确命中优先级最高 */
const SCORE_EXACT = 4000;
const SCORE_PREFIX = 3000;
const SCORE_CONTAINS = 2000;
const SCORE_SUBSEQUENCE = 1000;
/** `u-<用户名>` 是探针属主的个人标签，保留可搜但不上前排 */
const USER_TAG_PENALTY = 500;
/** 候选上下拉面板最多显示多少条 */
export const SUGGEST_LIMIT = 8;
/** 面板最大高度，超过就内部滚动 */
const MAX_PANEL_HEIGHT = 280;
/** 向下展开至少需要的高度，低于此值就改从输入框上方展开 */
const MIN_PANEL_HEIGHT = 96;
/** 输入停顿多久后才真正匹配（ms），避免每个按键都重排一次 */
const DEBOUNCE_MS = 120;
/** 选中候选项后短暂静默：避免回填又触发一次「自我匹配」把面板弹回来 */
const SILENCE_MS = 350;

const INDEX_URL = '/api/probes';
const STORAGE_KEY = 'pa-probe-index';

// ===================== 数据加载 =====================

let memoryIndex: ProbeIndex | null = null;
let pendingIndex: Promise<ProbeIndex | null> | null = null;

function readStoredIndex(): ProbeIndex | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return null;
		}
		const saved = JSON.parse(raw) as { savedAt?: number; index?: ProbeIndex };
		const index = saved?.index;
		if (!index || index.version !== INDEX_VERSION) {
			return null;
		}
		if (!Array.isArray(index.countries) || !Array.isArray(index.cities) || !Array.isArray(index.networks)) {
			return null;
		}
		if (Date.now() - (saved.savedAt ?? 0) > INDEX_MAX_AGE) {
			return null;
		}
		return index;
	}
	catch {
		// 隐私模式 / 配额用尽 / 内容损坏：当作没有缓存
		return null;
	}
}

function writeStoredIndex(index: ProbeIndex): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), index }));
	}
	catch {
		// 写不进去不影响本次会话，内存里已经有数据了
	}
}

/** 单次真正请求 `/api/probes`；任何异常都降级为 null（补全功能静默失效） */
async function fetchIndex(): Promise<ProbeIndex | null> {
	try {
		const res = await fetch(INDEX_URL, { headers: { Accept: 'application/json' } });
		if (!res.ok) {
			return null;
		}
		const data = (await res.json()) as ProbeIndex;
		if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.countries)) {
			return null;
		}
		return data;
	}
	catch {
		// 离线 / 服务端不可用：退化成「没有补全」，不影响手动填写
		return null;
	}
}

function refreshIndex(): Promise<ProbeIndex | null> {
	if (!pendingIndex) {
		pendingIndex = fetchIndex()
			.then((index) => {
				if (index) {
					memoryIndex = index;
					writeStoredIndex(index);
				}
				return index;
			})
			.finally(() => {
				pendingIndex = null;
			});
	}
	return pendingIndex;
}

/**
 * 取得探针位置索引
 *
 * 优先内存 → 本地存储 → 网络；网络失败且无缓存时返回 null，调用方直接放弃补全。
 */
export async function loadProbeIndex(): Promise<ProbeIndex | null> {
	if (memoryIndex) {
		return memoryIndex;
	}
	const stored = readStoredIndex();
	if (stored) {
		memoryIndex = stored;
		if (Date.now() - stored.generatedAt > INDEX_TTL) {
			// 后台刷新，本轮先用旧数据；下一次打开补全就是新的
			void refreshIndex();
		}
		return stored;
	}
	return refreshIndex();
}

/** 清空内存索引（切换账号等场景，以及测试隔离用） */
export function resetProbeIndexCache(): void {
	memoryIndex = null;
	pendingIndex = null;
}

// ===================== 候选构建 =====================

/** 各来源在候选列表里的类型标签（magic 字段混合展示时需要） */
const KIND_LABEL_KEYS: Record<ProbeIndexKind, string> = {
	asn: 'suggestKindAsn',
	city: 'suggestKindCity',
	country: 'suggestKindCountry',
	network: 'suggestKindNetwork',
	region: 'suggestKindRegion',
	tag: 'suggestKindTag',
};

function base(kind: ProbeIndexKind, text: string, count: number, extra: Partial<SuggestCandidate> = {}): SuggestCandidate {
	return { kind, text, label: text, count, score: 0, ...extra };
}

const englishRegions = typeof Intl !== 'undefined' && 'DisplayNames' in Intl
	? new Intl.DisplayNames(['en'], { type: 'region' })
	: null;

/** 国家代码 → 英文国家名（界面语言非英文时，用户仍可能按英文名搜索） */
function englishCountryName(country: string): string {
	try {
		return englishRegions?.of(country.toUpperCase()) ?? '';
	}
	catch {
		return '';
	}
}

/**
 * 把索引里某一类取值摊平成候选列表
 *
 * `text` 是最终回填进输入框的值（Globalping 只认 ISO 国家码 / ASN 数字 / 名字原文），
 * `label`/`meta`/`badge` 只用于展示。
 */
export function buildCandidates(index: ProbeIndex, kind: ProbeIndexKind): SuggestCandidate[] {
	switch (kind) {
		case 'country':
			return index.countries.map(([code, count]) => base(kind, code, count, {
				label: countryName(code) || code,
				meta: code,
				badge: flagEmoji(code),
				// 展示用的是本地化国名，但占位符承诺过可以输入 `Poland` 这类英文名
				keywords: englishCountryName(code),
			}));
		case 'region':
			return index.regions.map(([name, count]) => base(kind, name, count));
		case 'city':
			return index.cities.map(([city, country, count]) => base(kind, city, count, {
				meta: [flagEmoji(country), countryName(country)].filter(Boolean).join(' '),
				// 展示用的是本地化国名，但用户很可能直接输入 ISO 码或英文国名
				keywords: [country, englishCountryName(country)].filter(Boolean).join(' '),
			}));
		case 'network':
			return index.networks.map(([name, asn, count]) => base(kind, name, count, { meta: `AS${asn}` }));
		case 'tag':
			return index.tags.map(([tag, count]) => base(kind, tag, count));
		case 'asn': {
			// 同一 ASN 可能挂着多个网络名：合并计数，并取探针最多的那个名字做说明
			const totals = new Map<number, { count: number; name: string; best: number }>();
			for (const [name, asn, count] of index.networks) {
				const entry = totals.get(asn);
				if (!entry) {
					totals.set(asn, { count, name, best: count });
					continue;
				}
				entry.count += count;
				if (count > entry.best) {
					entry.best = count;
					entry.name = name;
				}
			}
			return [...totals.entries()]
				.sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
				.map(([asn, entry]) => base(kind, String(asn), entry.count, {
					label: `AS${asn}`,
					meta: entry.name,
				}));
		}
	}
}

/** magic 字段的池子：跨全部来源混合，并标出来源类型 */
export function buildMixedCandidates(index: ProbeIndex): SuggestCandidate[] {
	const kinds: ProbeIndexKind[] = ['country', 'region', 'city', 'network', 'asn', 'tag'];
	return kinds.flatMap(kind => buildCandidates(index, kind).map(candidate => ({
		...candidate,
		badge: t(KIND_LABEL_KEYS[kind]),
	})));
}

// ===================== 模糊匹配 =====================

/** 小写 + 去变音符号，让 `Zurich` 与 `Zürich` 互相命中 */
function normalize(text: string): string {
	return text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
}

/**
 * 子序列匹配的最紧跨度
 * @returns 命中时返回「跨越多出来的字符数」，越小说明越接近连续；未命中返回 null
 */
function subsequenceSkips(haystack: string, needle: string): number | null {
	let cursor = 0;
	let end = -1;
	for (const char of needle) {
		const at = haystack.indexOf(char, cursor);
		if (at === -1) {
			return null;
		}
		cursor = at + 1;
		end = at;
	}
	// 从已确定的末尾往前收，找到最晚的起点，得到最紧的跨度
	let back = end;
	let start = end;
	for (let index = needle.length - 1; index >= 0; index--) {
		const at = haystack.lastIndexOf(needle[index], back);
		if (index === 0) {
			start = at;
		}
		back = at - 1;
	}
	return end - start + 1 - needle.length;
}

/** 单个关键词对一个候选文本打分 */
function scoreToken(haystack: string, needle: string): number | null {
	if (!needle) {
		return null;
	}
	const at = haystack.indexOf(needle);
	if (at === 0) {
		return haystack.length === needle.length ? SCORE_EXACT : SCORE_PREFIX;
	}
	if (at > 0) {
		return SCORE_CONTAINS - Math.min(at, 999);
	}
	const skips = subsequenceSkips(haystack, needle);
	return skips === null ? null : SCORE_SUBSEQUENCE - Math.min(skips, 999);
}

/** 候选中用于匹配的全部文本（回填值 + 展示名 + 说明 + 国旗/类型 + 隐藏关键词） */
function haystackOf(candidate: SuggestCandidate): string {
	return normalize([
		candidate.text,
		candidate.label,
		candidate.meta ?? '',
		candidate.badge ?? '',
		candidate.keywords ?? '',
	].join(' '));
}

/**
 * 模糊匹配候选
 *
 * 规则：关键词支持空格分隔的多词，每个词都必须命中；命中质量分档
 * （精确 > 前缀 > 包含 > 跳字子序列），同档内再按探针数量降序。
 * 空查询返回空数组——不想每次聚焦都弹一大片。
 */
export function matchCandidates(
	candidates: SuggestCandidate[],
	query: string,
	limit = SUGGEST_LIMIT,
): SuggestCandidate[] {
	const tokens = normalize(query.trim()).split(/\s+/).filter(Boolean);
	if (!tokens.length) {
		return [];
	}
	const matched: SuggestCandidate[] = [];
	for (const candidate of candidates) {
		const haystack = haystackOf(candidate);
		let score = 0;
		let hit = true;
		for (const token of tokens) {
			const tokenScore = scoreToken(haystack, token);
			if (tokenScore === null) {
				hit = false;
				break;
			}
			score += tokenScore;
		}
		if (!hit) {
			continue;
		}
		if (candidate.kind === 'tag' && candidate.text.startsWith('u-')) {
			score -= USER_TAG_PENALTY;
		}
		matched.push({ ...candidate, score });
	}
	matched.sort((a, b) =>
		b.score - a.score
		|| b.count - a.count
		|| a.label.length - b.label.length
		|| a.label.localeCompare(b.label));
	return matched.slice(0, limit);
}

// ===================== 输入框绑定 =====================

let instanceSeq = 0;

/** 一个输入框对应的补全面板实例 */
interface Instance {
	input: HTMLInputElement;
	root: HTMLElement;
	list: HTMLElement;
	kind: ProbeIndexKind | 'mixed';
	multiple: boolean;
	pool: SuggestCandidate[] | null;
	options: SuggestCandidate[];
	activeIndex: number;
	open: boolean;
	timer: number | null;
	silentUntil: number;
}

const instances = new Set<Instance>();

export interface SuggestBinding {
	/** 目标输入框：元素本身或元素 id */
	input: string | HTMLInputElement;
	/** 候选来源；magic 字段用 `mixed` 混合全部来源 */
	source: ProbeIndexKind | 'mixed';
	/** 多值输入（如 tags）：只补全光标所在的最后一个片段 */
	multiple?: boolean;
}

/** 判断候选池是否需要走混合模式 */
function buildPool(index: ProbeIndex, source: Instance['kind']): SuggestCandidate[] {
	return source === 'mixed' ? buildMixedCandidates(index) : buildCandidates(index, source);
}

/** 取出「光标所在的片段」，供多值输入替换用 */
function readSegment(input: HTMLInputElement, multiple: boolean): { start: number; end: number; query: string } {
	const value = input.value;
	if (!multiple) {
		return { start: 0, end: value.length, query: value };
	}
	const caret = input.selectionStart ?? value.length;
	const before = value.slice(0, caret);
	const head = /[^,\s]*$/.exec(before)?.[0] ?? '';
	const tail = /^[^,\s]*/.exec(value.slice(caret))?.[0] ?? '';
	return { start: caret - head.length, end: caret + tail.length, query: head + tail };
}

/** 把选中的候选项写回输入框，并尽量把光标停在便于继续输入的位置 */
function applyCandidate(instance: Instance, candidate: SuggestCandidate): void {
	const { input, multiple } = instance;
	const segment = readSegment(input, multiple);
	if (!multiple) {
		input.value = candidate.text;
	}
	else {
		const value = input.value;
		const atTail = segment.end >= value.length;
		const inserted = atTail ? `${candidate.text}, ` : candidate.text;
		input.value = value.slice(0, segment.start) + inserted + value.slice(segment.end);
		const caret = segment.start + inserted.length;
		try {
			input.setSelectionRange(caret, caret);
		}
		catch {
			// number 类型输入框不支持选区操作，忽略即可
		}
	}
	close(instance);
	instance.silentUntil = Date.now() + SILENCE_MS;
	// 通知表单已经变化，但不要让这次变化立刻把面板弹回来
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 面板定位：挂在 body 上、用 fixed 坐标，避免被表单面板的滚动容器裁掉 */
function position(instance: Instance): void {
	const rect = instance.input.getBoundingClientRect();
	const width = Math.min(rect.width, window.innerWidth - 16);
	const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
	const gap = 4;
	const margin = 12;
	const below = window.innerHeight - rect.bottom - gap - margin;
	const above = rect.top - gap - margin;
	// 下方连最小高度都撑不开、而上方的空间更宽裕时，翻到输入框上方展开
	const flip = below < MIN_PANEL_HEIGHT && above > below;
	// 空间不足时以实际可用空间为准，宁可变矮也不溢出视口
	const room = Math.max(0, Math.min(MAX_PANEL_HEIGHT, flip ? above : below));
	instance.root.style.width = `${Math.round(width)}px`;
	instance.root.style.left = `${Math.round(left)}px`;
	instance.root.style.maxHeight = `${Math.round(room)}px`;
	if (flip) {
		instance.root.style.top = 'auto';
		instance.root.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
	}
	else {
		instance.root.style.top = `${Math.round(rect.bottom + gap)}px`;
		instance.root.style.bottom = 'auto';
	}
}

function setActive(instance: Instance, index: number): void {
	const count = instance.options.length;
	if (!count) {
		instance.activeIndex = -1;
		return;
	}
	instance.activeIndex = ((index % count) + count) % count;
	const nodes = instance.list.children;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i] as HTMLElement;
		const active = i === instance.activeIndex;
		node.classList.toggle('is-active', active);
		node.setAttribute('aria-selected', active ? 'true' : 'false');
	}
	const activeNode = nodes[instance.activeIndex] as HTMLElement | undefined;
	if (activeNode) {
		instance.input.setAttribute('aria-activedescendant', activeNode.id);
		// jsdom 未实现 scrollIntoView，判空后再调用
		if (typeof activeNode.scrollIntoView === 'function') {
			activeNode.scrollIntoView({ block: 'nearest' });
		}
	}
}

function close(instance: Instance): void {
	instance.open = false;
	instance.activeIndex = -1;
	instance.options = [];
	instance.list.replaceChildren();
	instance.root.hidden = true;
	instance.input.setAttribute('aria-expanded', 'false');
	instance.input.removeAttribute('aria-activedescendant');
}

/** 关闭全部补全面板（表单重置、提交、语言切换等场景） */
export function closeAllSuggests(): void {
	for (const instance of instances) {
		close(instance);
	}
}

function renderMessage(instance: Instance, text: string): void {
	instance.options = [];
	instance.activeIndex = -1;
	instance.open = true;
	instance.list.replaceChildren(el('li', { class: 'suggest-empty', role: 'presentation' }, [text]));
	instance.root.hidden = false;
	instance.input.setAttribute('aria-expanded', 'true');
	instance.input.removeAttribute('aria-activedescendant');
}

function renderOptions(instance: Instance, options: SuggestCandidate[]): void {
	instance.options = options;
	instance.open = true;
	instance.list.replaceChildren(...options.map((candidate, index) => {
		const node = el('li', {
			'class': `suggest-item suggest-item-${candidate.kind}`,
			'id': `${instance.list.id}-opt-${index}`,
			'role': 'option',
			'aria-selected': 'false',
			'data-index': String(index),
		}, [
			el('span', { class: 'suggest-label' }, [candidate.label]),
			...(candidate.meta ? [el('span', { class: 'suggest-meta' }, [candidate.meta])] : []),
			...(candidate.badge ? [el('span', { class: 'suggest-badge' }, [candidate.badge])] : []),
			el('span', { class: 'suggest-count' }, [t('suggestProbes', { count: candidate.count })]),
		]);
		// mousedown 阻止默认行为，避免点选前输入框先失焦
		node.addEventListener('mousedown', event => event.preventDefault());
		node.addEventListener('click', () => applyCandidate(instance, candidate));
		node.addEventListener('mouseenter', () => setActive(instance, index));
		return node;
	}));
	instance.root.hidden = false;
	instance.input.setAttribute('aria-expanded', 'true');
	setActive(instance, 0);
}

async function ensurePool(instance: Instance): Promise<SuggestCandidate[] | null> {
	if (!instance.pool) {
		const index = await loadProbeIndex();
		if (!index) {
			return null;
		}
		instance.pool = buildPool(index, instance.kind);
	}
	return instance.pool;
}

async function refresh(instance: Instance): Promise<void> {
	const segment = readSegment(instance.input, instance.multiple);
	const query = segment.query.trim();
	if (!query) {
		close(instance);
		return;
	}
	let pool = instance.pool;
	if (!pool) {
		renderMessage(instance, t('suggestLoading'));
		position(instance);
		pool = await ensurePool(instance);
		// 索引拿不到时静默失效，保留用户手动输入原始值的通路
		if (!pool) {
			close(instance);
			return;
		}
	}
	if (document.activeElement !== instance.input) {
		close(instance);
		return;
	}
	const matches = matchCandidates(pool, query);
	if (!matches.length) {
		renderMessage(instance, t('suggestEmpty'));
		position(instance);
		return;
	}
	renderOptions(instance, matches);
	position(instance);
}

function schedule(instance: Instance, delay = DEBOUNCE_MS): void {
	if (Date.now() < instance.silentUntil) {
		return;
	}
	if (instance.timer !== null) {
		window.clearTimeout(instance.timer);
	}
	instance.timer = window.setTimeout(() => {
		instance.timer = null;
		void refresh(instance);
	}, delay);
}

function bindInput(instance: Instance): void {
	const { input } = instance;
	input.setAttribute('role', 'combobox');
	input.setAttribute('aria-autocomplete', 'list');
	input.setAttribute('aria-expanded', 'false');
	input.setAttribute('aria-controls', instance.list.id);
	input.setAttribute('autocomplete', 'off');
	input.setAttribute('autocapitalize', 'off');
	input.setAttribute('spellcheck', 'false');

	input.addEventListener('input', () => schedule(instance));
	input.addEventListener('focus', () => {
		if (input.value.trim()) {
			schedule(instance, 0);
		}
	});
	input.addEventListener('blur', () => {
		// 点选候选项时会先失焦，延迟关闭让 click 有机会跑完
		window.setTimeout(() => {
			if (document.activeElement !== input) {
				close(instance);
			}
		}, 150);
	});
	input.addEventListener('keydown', (event) => {
		const opened = instance.open && instance.options.length > 0;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!opened) {
				void refresh(instance);
				return;
			}
			setActive(instance, instance.activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
			return;
		}
		if (event.key === 'Enter') {
			// 有高亮项时回车是「选中」，绝不能顺带提交表单
			if (opened && instance.activeIndex >= 0) {
				event.preventDefault();
				const candidate = instance.options[instance.activeIndex];
				if (candidate) {
					applyCandidate(instance, candidate);
				}
			}
			else {
				close(instance);
			}
			return;
		}
		if (event.key === 'Escape') {
			if (instance.open) {
				event.preventDefault();
				close(instance);
			}
			return;
		}
		if (event.key === 'Tab') {
			close(instance);
		}
	});
}

/** 为一个输入框挂上自动补全；重复调用同一输入框时先解绑旧的 */
export function attachSuggest(binding: SuggestBinding): void {
	const input = typeof binding.input === 'string'
		? document.getElementById(binding.input) as HTMLInputElement | null
		: binding.input;
	if (!input) {
		return;
	}
	for (const existing of instances) {
		if (existing.input === input) {
			destroySuggest(existing);
		}
	}

	const uid = `suggest-${++instanceSeq}`;
	const list = el('ul', { class: 'suggest-list', id: `${uid}-list`, role: 'listbox' });
	const root = el('div', { class: 'suggest-panel', id: uid, hidden: 'hidden' }, [list]);
	root.hidden = true;
	root.dataset.wrap = String(input.id || uid);
	document.body.append(root);

	const instance: Instance = {
		input,
		root,
		list,
		kind: binding.source,
		multiple: Boolean(binding.multiple),
		pool: null,
		options: [],
		activeIndex: -1,
		open: false,
		timer: null,
		silentUntil: 0,
	};
	instances.add(instance);
	bindGlobalListeners();
	bindInput(instance);
}

/** 解绑并移除面板 */
function destroySuggest(instance: Instance): void {
	if (instance.timer !== null) {
		window.clearTimeout(instance.timer);
	}
	instances.delete(instance);
	instance.root.remove();
}

/** 关闭点击/滚动之外的残留面板 */
function handleOutsidePointer(event: Event): void {
	const target = event.target as Node | null;
	if (!target) {
		return;
	}
	for (const instance of instances) {
		if (instance.open && !instance.root.contains(target) && target !== instance.input) {
			close(instance);
		}
	}
}

/** 面板跟随输入框移动（表单面板自身也会滚动，所以用捕获阶段监听） */
function handleViewportChange(): void {
	for (const instance of instances) {
		if (instance.open) {
			position(instance);
		}
	}
}

let globalListenersBound = false;

function bindGlobalListeners(): void {
	if (globalListenersBound) {
		return;
	}
	globalListenersBound = true;
	document.addEventListener('pointerdown', handleOutsidePointer, true);
	// 捕获阶段监听，才能收到左侧表单面板内部的滚动
	window.addEventListener('scroll', handleViewportChange, true);
	window.addEventListener('resize', handleViewportChange);
}

/** 页面初始化时调用一次：惰性拉取索引，用户首次聚焦位置输入框才会真正下载 */
export function initLocationSuggests(bindings: SuggestBinding[]): void {
	bindGlobalListeners();
	for (const binding of bindings) {
		attachSuggest(binding);
	}
}
