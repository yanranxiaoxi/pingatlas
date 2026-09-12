import { getLang } from './i18n';

export type ToastType = 'info' | 'error' | 'success';

const TOAST_DURATION = 3500;
let toastTimer: number | undefined;

/** 简易 toast 提示（同期只保留最新一条，避免刷屏） */
export function toast(message: string, type: ToastType = 'info'): void {
	let box = document.getElementById('toast-box');
	if (!box) {
		box = document.createElement('div');
		box.id = 'toast-box';
		box.className = 'toast-box';
		document.body.appendChild(box);
	}
	const item = document.createElement('div');
	item.className = `toast toast-${type}`;
	item.textContent = message;
	box.appendChild(item);
	window.clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		box?.replaceChildren();
	}, TOAST_DURATION);
}

/** 创建元素的小工具 */
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> = {},
	children: Array<HTMLElement | string> = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, value);
	}
	for (const child of children) {
		node.append(child);
	}
	return node;
}

/**
 * 把文案中的 Markdown 行内链接语法 `[文字](url)` 渲染为 DOM 节点数组。
 * 只接受 http/https 链接，其余按纯文本处理，避免 `javascript:` 等危险协议。
 */
export function textWithLinks(text: string): Array<HTMLElement | string> {
	const nodes: Array<HTMLElement | string> = [];
	const regex = /\[([^\]]+)\]\(([^)\s]+)\)/g;
	let lastIndex = 0;
	for (const match of text.matchAll(regex)) {
		const [full, label, href] = match;
		const index = match.index ?? 0;
		if (index > lastIndex) {
			nodes.push(text.slice(lastIndex, index));
		}
		if (/^https?:\/\//i.test(href)) {
			const a = document.createElement('a');
			a.textContent = label;
			a.href = href;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
			nodes.push(a);
		}
		else {
			nodes.push(full);
		}
		lastIndex = index + full.length;
	}
	if (lastIndex < text.length) {
		nodes.push(text.slice(lastIndex));
	}
	return nodes.length ? nodes : [text];
}

/** 复制文本到剪贴板；返回是否成功（非安全上下文或旧浏览器下可能失败） */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	}
	catch {
		return false;
	}
}

/** 毫秒 → 人类可读，如 `12.4 ms` / `1.23 s` */
export function formatMs(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return '—';
	}
	if (value >= 1000) {
		return `${(value / 1000).toFixed(2)} s`;
	}
	return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

/** 秒 → `mm:ss`（用于额度重置倒计时） */
export function formatCountdown(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const mm = String(Math.floor(total / 60)).padStart(2, '0');
	const ss = String(total % 60).padStart(2, '0');
	return `${mm}:${ss}`;
}

/** ISO 时间字符串 → 本地 `HH:mm:ss` */
export function formatClock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return iso;
	}
	return date.toLocaleTimeString(undefined, { hour12: false });
}

/** 相对时间文案，如 `3.2s 前` */
export function formatAgo(iso: string): string {
	const date = new Date(iso).getTime();
	if (Number.isNaN(date)) {
		return '';
	}
	const diff = Math.max(0, (Date.now() - date) / 1000);
	return `${diff.toFixed(1)}s`;
}

/** 字节数 → 人类可读 */
export function formatBytes(size: number): string {
	if (size < 1024) {
		return `${size} B`;
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KiB`;
	}
	return `${(size / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * 展示信息需要覆盖的地区（ISO 3166-1 alpha-2）
 *
 * Globalping 的原始数据用 ISO 代码标记地区，而 `Intl.DisplayNames` 给出的名称、以及
 * 由代码推导出的旗帜 emoji，都不一定符合本站的展示要求，因此在展示层统一覆盖。
 *
 * 覆盖同时作用于 `countryName()` / `flagEmoji()` 与自动补全的搜索关键词，所以结果
 * 卡片、探针列表、位置筛选三处会一起生效，不需要各自判断。
 */
interface RegionOverride {
	/** 各语言的展示名；未列出的语言回退到 `REGION_OVERRIDE_FALLBACK_LANG` */
	names: Record<string, string>;
	/** 旗帜 emoji */
	flag: string;
	/** 额外参与搜索的名称（不展示），让用户也能按这些写法搜到该地区 */
	searchNames: string[];
}

/** `names` 未覆盖当前语言时的回退语言 */
const REGION_OVERRIDE_FALLBACK_LANG = 'en';

const REGION_OVERRIDES: Record<string, RegionOverride> = {
	TW: {
		names: {
			'zh-Hans': '中国台北',
			'en': 'Chinese Taipei',
		},
		flag: '🇨🇳',
		searchNames: ['中国台北', 'Chinese Taipei'],
	},
};

function regionOverride(country: string | null | undefined): RegionOverride | null {
	if (!country) {
		return null;
	}
	return REGION_OVERRIDES[country.toUpperCase()] ?? null;
}

/** 该地区需要额外参与搜索的名称；无覆盖时返回空数组 */
export function regionSearchNames(country: string): string[] {
	return regionOverride(country)?.searchNames ?? [];
}

/** 两位国家代码 → 国旗 emoji（非两位字母时返回空串） */
export function flagEmoji(country: string | null | undefined): string {
	if (!country || !/^[A-Z]{2}$/i.test(country)) {
		return '';
	}
	const override = regionOverride(country);
	if (override) {
		return override.flag;
	}
	return String.fromCodePoint(...[...country.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0)));
}

const regionNames = new Map<string, Intl.DisplayNames>();

/** 按界面语言取 `Intl.DisplayNames` 实例（惰性创建并缓存，宿主 locale 不参与决定） */
function regionNamesFor(lang: string): Intl.DisplayNames | null {
	if (typeof Intl === 'undefined' || !('DisplayNames' in Intl)) {
		return null;
	}
	let names = regionNames.get(lang);
	if (!names) {
		names = new Intl.DisplayNames(lang, { type: 'region' });
		regionNames.set(lang, names);
	}
	return names;
}

/** 国家代码 → 本地化国家名（不支持时回退代码） */
export function countryName(country: string, lang: string = getLang()): string {
	if (!country) {
		return '';
	}
	const override = regionOverride(country);
	if (override) {
		return override.names[lang] ?? override.names[REGION_OVERRIDE_FALLBACK_LANG] ?? country;
	}
	try {
		return regionNamesFor(lang)?.of(country.toUpperCase()) ?? country;
	}
	catch {
		return country;
	}
}

/** 逐包 timings 的小型条形图（按最大值归一化，缺失包留空位） */
export function buildTimingBars(timings: Array<{ rtt: number }>, maxBars = 32): HTMLElement {
	const wrap = el('div', { class: 'timing-bars' });
	const visible = timings.slice(0, maxBars);
	const values = visible.map(t => t.rtt);
	const max = values.length ? Math.max(...values) : 1;
	for (const rtt of values) {
		const ratio = max > 0 ? rtt / max : 0;
		// 归一化到 12% – 100% 高度，让最小值仍可见
		const height = 12 + ratio * 88;
		const bar = el('span', { class: 'timing-bar', title: formatMs(rtt) });
		bar.style.height = `${height.toFixed(1)}%`;
		wrap.append(bar);
	}
	if (timings.length > maxBars) {
		wrap.append(el('span', { class: 'timing-bar-more' }, [`+${timings.length - maxBars}`]));
	}
	return wrap;
}
