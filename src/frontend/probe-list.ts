import type { LocationFilters, ProbeRecord } from './types';
import { t } from './i18n';
import { getActiveTab, onTabChange, setActiveTab } from './panel';
import {
	appendFragment,
	loadProbeList,
	matchProbes,
	PROBE_LIST_LIMIT,
	probeAsnNumber,
	probeCity,
	probeContinent,
	probeCountry,
	probeFragment,
	probeMatchesFilters,
	probeNetwork,
	probeRegion,
	removeFragment,
} from './probes';
import { countryName, el, flagEmoji, toast } from './ui';

/**
 * 「Probes 列表」与「匹配 Probes 列表」两个标签页的渲染
 *
 * 两者的区别是筛选口径：
 * - Probes 列表：只看结构化位置筛选（大洲 / 国家 / 城市 / ASN / 网络 / 标签），
 *   不含 magic。这样用户在里面反复点 + 时列表不会因为 magic 变化而缩水。
 * - 匹配 Probes 列表：看最终会发给上游的完整条件（有结构化字段就只看结构化字段，
 *   否则看 magic），因此它就是「本次测量实际会用到的探针」。
 */

/** 位置筛选以外的字段 id；改动这些字段要切换标签页 */
const STRUCTURED_FIELDS = ['loc-continent', 'loc-country', 'loc-city', 'loc-asn', 'loc-network', 'loc-tags'] as const;
/** magic 字段 id */
const MAGIC_FIELD = 'loc-magic';

/** 由 `measure.ts` 注入：读取当前表单里的位置筛选条件 */
type FilterReader = () => LocationFilters;
/** 由 `measure.ts` 注入：提交前需要把 magic 归一化后写回表单 */
type MagicWriter = (value: string) => void;

let readFilters: FilterReader | null = null;
let writeMagic: MagicWriter | null = null;
let probesRoot: HTMLElement | null = null;
let matchedRoot: HTMLElement | null = null;
let initialized = false;

/** 上次渲染结果，避免每次输入都重建 DOM */
let lastProbesKey = '';
let lastMatchedKey = '';

function filtersKey(filters: LocationFilters, includeMagic: boolean): string {
	const structured = [
		filters.continent,
		filters.country,
		filters.city,
		filters.asn ?? '',
		filters.network,
		[...filters.tags].sort().join(','),
	].join('\u0000');
	return includeMagic ? `${structured}\u0000${filters.magic}` : structured;
}

function magicField(): HTMLTextAreaElement | null {
	return document.getElementById(MAGIC_FIELD) as HTMLTextAreaElement | null;
}

/** 探针位置描述：`🇫🇮 Helsinki, Finland` */
function locationLabel(probe: ProbeRecord): string {
	const city = probeCity(probe);
	const country = probeCountry(probe);
	const name = country ? countryName(country) : '';
	return [city, name || country].filter(Boolean).join(', ');
}

/**
 * 位置单元格的悬浮提示
 *
 * 次区域与大洲不单独占一列：列一多，网络名会被挤到词中间断行（如 `Contab o`）。
 * 完整位置改为悬浮查看。
 */
function locationTitle(probe: ProbeRecord): string {
	return [
		locationLabel(probe),
		probeRegion(probe),
		probeContinent(probe),
	].filter(Boolean).join(' · ');
}

function probeRow(probe: ProbeRecord, action: HTMLElement | null): HTMLElement {
	const row = el('tr', { class: 'probe-row' }, [
		el('td', { 'class': 'probe-loc', 'data-label': t('probeColumnLocation'), 'title': locationTitle(probe) }, [
			el('span', { class: 'probe-flag' }, [flagEmoji(probeCountry(probe))]),
			el('span', { class: 'probe-loc-text' }, [locationLabel(probe) || '—']),
		]),
		el('td', { 'class': 'mono num', 'data-label': t('probeColumnAsn') }, [
			probeAsnNumber(probe) ? `AS${probeAsnNumber(probe)}` : '—',
		]),
		el('td', { 'class': 'probe-network', 'data-label': t('probeColumnNetwork') }, [
			probeNetwork(probe) || '—',
		]),
		el('td', { 'class': 'probe-tags-cell', 'data-label': t('probeColumnTags') }, [
			el('span', { class: 'probe-tag-list' }, probeTagsText(probe)),
		]),
		el('td', { class: 'probe-action' }, action ? [action] : []),
	]);
	return row;
}

function probeTagsText(probe: ProbeRecord): HTMLElement[] {
	const tags = probe[6];
	if (!tags.length) {
		return [el('span', { class: 'dim' }, ['—'])];
	}
	return tags.map(tag => el('span', { class: 'probe-tag' }, [tag]));
}

function stateBlock(key: string, extra?: Record<string, string>): HTMLElement {
	return el('div', { 'class': 'probe-state', 'data-state': key, ...extra }, [t(key)]);
}

function tableHead(): HTMLElement {
	return el('thead', {}, [el('tr', {}, [
		el('th', {}, [t('probeColumnLocation')]),
		el('th', {}, [t('probeColumnAsn')]),
		el('th', {}, [t('probeColumnNetwork')]),
		el('th', {}, [t('probeColumnTags')]),
		el('th', { class: 'probe-action' }, [t('probeColumnAction')]),
	])]);
}

/** 通用列表渲染：把命中的探针画成表格，超过上限时给出说明 */
function renderTable(
	root: HTMLElement,
	probes: ProbeRecord[],
	total: number,
	actionOf: (probe: ProbeRecord) => HTMLElement | null,
): void {
	const rows = probes.map(probe => probeRow(probe, actionOf(probe)));
	const table = el('table', { class: 'data-table probe-table' }, [tableHead(), el('tbody', {}, rows)]);
	root.replaceChildren(
		summaryLine(rows.length, total, 'top'),
		el('div', { class: 'table-wrap' }, [table]),
		// 无命中时不重复输出：顶部那行与空表头本来就同屏可见，再写一遍只是噪声
		...(rows.length ? [summaryLine(rows.length, total, 'bottom')] : []),
	);
}

/**
 * 「共匹配 N 个探针」（被截断时附上「显示前 M 个」）
 *
 * 列表最多 160 行，滚到底部时顶部那行早已滚出视口，所以在末尾再放一份同样的
 * 汇总。末尾这份标记为 `aria-hidden`：同一区域内把同一句话念两遍对读屏用户只是
 * 噪声，信息已由顶部那份提供。
 */
function summaryLine(shown: number, total: number, position: 'top' | 'bottom'): HTMLElement {
	const bottom = position === 'bottom';
	// 命中数没超过上限时全部都已列出，再说「显示前 M 个」是废话
	const text = shown < total
		? t('probeListSummaryTruncated', { shown, total })
		: t('probeListSummary', { total });
	return el('p', {
		class: bottom ? 'probe-summary probe-summary-bottom' : 'probe-summary',
		...(bottom ? { 'aria-hidden': 'true' } : {}),
	}, [text]);
}

/** 新增一个探针片段到 magic（+ 按钮） */
function addProbe(probe: ProbeRecord): void {
	const field = magicField();
	if (!field || !writeMagic) {
		return;
	}
	const next = appendFragment(field.value, probeFragment(probe));
	if (next === field.value) {
		toast(t('probeAlreadyAdded'), 'info');
		return;
	}
	field.value = next;
	writeMagic(next);
	field.dispatchEvent(new Event('input', { bubbles: true }));
	render();
}

/** 从 magic 移除一个片段（X 按钮） */
function removeProbe(fragment: string): void {
	const field = magicField();
	if (!field || !writeMagic) {
		return;
	}
	const next = removeFragment(field.value, fragment);
	field.value = next;
	writeMagic(next);
	field.dispatchEvent(new Event('input', { bubbles: true }));
	render();
}

function addButton(probe: ProbeRecord): HTMLElement {
	const label = probeFragment(probe);
	const button = el('button', {
		'class': 'icon-btn probe-add',
		'type': 'button',
		'title': t('probeAddTitle'),
		'aria-label': t('probeAddTitle'),
		'data-fragment': label,
	}, ['+']);
	button.addEventListener('click', () => addProbe(probe));
	return button;
}

function removeButton(fragment: string): HTMLElement {
	const button = el('button', {
		'class': 'icon-btn probe-remove',
		'type': 'button',
		'title': t('probeRemoveTitle', { fragment }),
		'aria-label': t('probeRemoveTitle', { fragment }),
		'data-fragment': fragment,
	}, ['×']);
	button.addEventListener('click', () => removeProbe(fragment));
	return button;
}

/**
 * 渲染两个列表
 *
 * 只在筛选条件变化时重建 DOM：输入框每次按键都会触发 input 事件，
 * 无条件重建会让滚动位置和按钮焦点被打断。
 */
export function render(): void {
	if (!readFilters || !probesRoot || !matchedRoot) {
		return;
	}
	const probes = loadProbeList();

	void probes.then((list) => {
		// 等待期间筛选可能又变了：以最新条件为准，避免渲染出过期结果
		const current = readFilters?.();
		if (!current || !probesRoot || !matchedRoot) {
			return;
		}
		if (!list) {
			// 数据拿不到：两个列表都给出同一条说明，并清空缓存键以便下次重试
			probesRoot.replaceChildren(stateBlock('probeListUnavailable'));
			matchedRoot.replaceChildren(stateBlock('probeListUnavailable'));
			lastProbesKey = '';
			lastMatchedKey = '';
			return;
		}

		const probesKey = filtersKey(current, false);
		if (probesKey !== lastProbesKey) {
			lastProbesKey = probesKey;
			// Probes 列表不含 magic：用户点 + 之后它不应该缩水
			const structuredOnly: LocationFilters = { ...current, magic: '' };
			const matched = list.filter(probe => probeMatchesFilters(probe, structuredOnly));
			renderTable(probesRoot, matched.slice(0, PROBE_LIST_LIMIT), matched.length, addButton);
		}

		const matchedKey = filtersKey(current, true);
		if (matchedKey !== lastMatchedKey) {
			lastMatchedKey = matchedKey;
			const hits = matchProbes(list, current);
			const removable = new Map<ProbeRecord, string>();
			for (const hit of hits) {
				if (hit.fragment) {
					removable.set(hit.probe, hit.fragment);
				}
			}
			if (!hits.length) {
				matchedRoot.replaceChildren(stateBlock('probeMatchEmpty'));
				return;
			}
			renderTable(
				matchedRoot,
				hits.slice(0, PROBE_LIST_LIMIT).map(hit => hit.probe),
				hits.length,
				(probe) => {
					const fragment = removable.get(probe);
					return fragment ? removeButton(fragment) : el('span', { class: 'probe-broad dim' }, [t('probeFromBroadFilter')]);
				},
			);
		}
	});
}

/** 位置筛选变化：结构化字段切到 Probes 列表，magic 切到匹配列表 */
function handleFilterChange(event: Event): void {
	const id = (event.target as HTMLElement | null)?.id ?? '';
	if (id === MAGIC_FIELD) {
		setActiveTab('matched');
	}
	else if ((STRUCTURED_FIELDS as readonly string[]).includes(id)) {
		setActiveTab('probes');
	}
	render();
}

export interface ProbePanelOptions {
	probesRoot: HTMLElement;
	matchedRoot: HTMLElement;
	/** 读取当前位置筛选条件 */
	readFilters: FilterReader;
	/** 把归一化后的 magic 写回表单（清掉换行等） */
	writeMagic: MagicWriter;
}

/** 绑定两个列表；由 `main.ts` 在 DOM 就绪后调用 */
export function initProbeLists(options: ProbePanelOptions): void {
	if (initialized) {
		return;
	}
	initialized = true;
	probesRoot = options.probesRoot;
	matchedRoot = options.matchedRoot;
	readFilters = options.readFilters;
	writeMagic = options.writeMagic;

	const form = document.getElementById('measure-form');
	form?.addEventListener('change', handleFilterChange);
	form?.addEventListener('input', handleFilterChange);

	// 切到任一列表标签页时确保已渲染（首次会触发数据加载）
	onTabChange((tab) => {
		if (tab === 'probes' || tab === 'matched') {
			render();
		}
	});
	// 表单重置会改回默认值：清掉缓存键以强制重绘
	document.getElementById('reset-btn')?.addEventListener('click', () => {
		lastProbesKey = '';
		lastMatchedKey = '';
		// 重置后表单值已归零，但要等一个微任务才能读到新值
		window.setTimeout(render, 0);
	});

	if (getActiveTab() === 'probes' || getActiveTab() === 'matched') {
		render();
	}
}

/** 仅测试用：重置模块状态 */
export function resetProbeLists(): void {
	initialized = false;
	readFilters = null;
	writeMagic = null;
	probesRoot = null;
	matchedRoot = null;
	lastProbesKey = '';
	lastMatchedKey = '';
}
