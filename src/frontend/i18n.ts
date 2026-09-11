export interface LangMeta {
	code: string;
	label: string;
}

/** 支持的语言（扩展新语言：在此追加并新增 public/locales/<code>.json） */
export const SUPPORTED_LANGS: LangMeta[] = [
	{ code: 'zh-Hans', label: '简体中文' },
	{ code: 'en', label: 'English' },
];

const STORAGE_KEY = 'pa-lang';
let currentLang = 'en';
let dictionary: Record<string, string> = {};

/** 安全读写 localStorage（隐私模式/沙箱下可能抛错，一律吞掉） */
function storageGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	}
	catch {
		return null;
	}
}

function storageSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// 忽略
	}
}

/** 根据浏览器语言与本地存储确定默认语言 */
function detectLang(): string {
	const stored = storageGet(STORAGE_KEY) ?? '';
	if (stored && SUPPORTED_LANGS.some(l => l.code === stored)) {
		return stored;
	}
	const nav = navigator.language?.toLowerCase() ?? '';
	if (nav.startsWith('zh')) {
		return 'zh-Hans';
	}
	return 'en';
}

/** 初始化 i18n，返回当前语言代码 */
export async function initI18n(): Promise<string> {
	currentLang = detectLang();
	await loadDictionary(currentLang);
	applyDocumentLang(currentLang);
	return currentLang;
}

/** 让 `<html lang>` 跟随当前语言：屏幕阅读器发音、断行与浏览器翻译提示都依赖它 */
function applyDocumentLang(lang: string): void {
	document.documentElement.lang = lang;
}

async function loadDictionary(lang: string): Promise<void> {
	// 先加载目标语言；失败（缺文件/网络/非 200）再回退英文，避免界面显示原始 key
	const candidates = lang === 'en' ? ['en'] : [lang, 'en'];
	for (const candidate of candidates) {
		try {
			const res = await fetch(`/locales/${candidate}.json`, { cache: 'no-cache' });
			if (res.ok) {
				dictionary = (await res.json()) as Record<string, string>;
				return;
			}
		}
		catch {
			// 尝试下一个候选
		}
	}
	dictionary = {};
}

export function getLang(): string {
	return currentLang;
}

/** 切换语言并整页刷新（最简单可靠的更新方式） */
export async function setLang(lang: string): Promise<void> {
	if (!SUPPORTED_LANGS.some(l => l.code === lang)) {
		return;
	}
	storageSet(STORAGE_KEY, lang);
	window.location.reload();
}

/** 翻译文案：t('key')，支持 {name} 占位符 */
export function t(key: string, params?: Record<string, string | number>): string {
	let text = dictionary[key] ?? key;
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			text = text.replaceAll(`{${name}}`, String(value));
		}
	}
	return text;
}

/**
 * 就地翻译静态标记里的文案，避免把整份表单都写成 DOM 构建代码。
 * 支持 `data-i18n`（textContent）、`data-i18n-placeholder`、`data-i18n-title`、`data-i18n-aria-label`。
 */
export function applyI18n(root: ParentNode = document): void {
	for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
		const key = node.dataset.i18n;
		if (key) {
			node.textContent = t(key);
		}
	}
	const attrMap: Record<string, string> = {
		'data-i18n-placeholder': 'placeholder',
		'data-i18n-title': 'title',
		'data-i18n-aria-label': 'aria-label',
	};
	for (const [dataAttr, target] of Object.entries(attrMap)) {
		for (const node of root.querySelectorAll<HTMLElement>(`[${dataAttr}]`)) {
			const key = node.getAttribute(dataAttr);
			if (key) {
				node.setAttribute(target, t(key));
			}
		}
	}
}
