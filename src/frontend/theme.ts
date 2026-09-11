const STORAGE_KEY = 'pa-theme';
export type Theme = 'light' | 'dark';

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

/** 读取偏好主题，默认跟随系统 */
export function getPreferredTheme(): Theme {
	const stored = storageGet(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark') {
		return stored;
	}
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 应用主题到 `<html data-theme>` 并同步 PWA 的 theme-color */
export function applyTheme(theme: Theme): void {
	document.documentElement.setAttribute('data-theme', theme);
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute('content', theme === 'dark' ? '#0e1116' : '#ffffff');
	}
}

/** 切换主题并持久化 */
export function toggleTheme(): Theme {
	const next: Theme = getPreferredTheme() === 'dark' ? 'light' : 'dark';
	storageSet(STORAGE_KEY, next);
	applyTheme(next);
	return next;
}

export function initTheme(): void {
	applyTheme(getPreferredTheme());
	// 未显式选择时跟随系统变化
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
		if (!storageGet(STORAGE_KEY)) {
			applyTheme(e.matches ? 'dark' : 'light');
		}
	});
}
