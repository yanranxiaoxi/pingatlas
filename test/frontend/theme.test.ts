/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { applyTheme, getPreferredTheme, initTheme, toggleTheme } from '../../src/frontend/theme';

interface MatchMediaStub {
	matches: boolean;
	onChange: ((event: MediaQueryListEvent) => void) | null;
}

function stubMatchMedia(initialMatches: boolean): MatchMediaStub {
	const stub: MatchMediaStub = { matches: initialMatches, onChange: null };
	window.matchMedia = jest.fn(() => ({
		matches: stub.matches,
		addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
			stub.onChange = listener;
		},
	})) as unknown as typeof window.matchMedia;
	return stub;
}

beforeEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute('data-theme');
	document.head.replaceChildren();
	stubMatchMedia(false);
});

describe('getPreferredTheme', () => {
	it('默认跟随系统深色', () => {
		stubMatchMedia(true);
		expect(getPreferredTheme()).toBe('dark');
	});

	it('默认跟随系统浅色', () => {
		stubMatchMedia(false);
		expect(getPreferredTheme()).toBe('light');
	});

	it('localStorage 的显式选择优先于系统', () => {
		stubMatchMedia(true);
		localStorage.setItem('pa-theme', 'light');
		expect(getPreferredTheme()).toBe('light');
	});

	it('localStorage 存非法值时忽略', () => {
		localStorage.setItem('pa-theme', 'blue');
		stubMatchMedia(true);
		expect(getPreferredTheme()).toBe('dark');
	});

	it('localStorage 读取失败时跟随系统', () => {
		jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		stubMatchMedia(false);
		expect(getPreferredTheme()).toBe('light');
	});
});

describe('applyTheme', () => {
	it('写入 data-theme 并更新 theme-color', () => {
		document.head.innerHTML = '<meta name="theme-color" content="#000000">';
		applyTheme('dark');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
		expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#0e1116');

		applyTheme('light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#ffffff');
	});

	it('缺少 theme-color meta 时不抛错', () => {
		expect(() => applyTheme('dark')).not.toThrow();
	});
});

describe('toggleTheme', () => {
	it('从深色切到浅色并持久化', () => {
		stubMatchMedia(true);
		expect(toggleTheme()).toBe('light');
		expect(localStorage.getItem('pa-theme')).toBe('light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('从浅色切到深色并持久化', () => {
		stubMatchMedia(false);
		expect(toggleTheme()).toBe('dark');
		expect(localStorage.getItem('pa-theme')).toBe('dark');
	});

	it('连续切换回到原主题', () => {
		stubMatchMedia(false);
		toggleTheme();
		expect(toggleTheme()).toBe('light');
		expect(localStorage.getItem('pa-theme')).toBe('light');
	});
});

describe('initTheme', () => {
	it('按偏好应用主题', () => {
		localStorage.setItem('pa-theme', 'dark');
		initTheme();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('未显式选择时跟随系统变更', () => {
		const stub = stubMatchMedia(false);
		initTheme();
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		stub.onChange!({ matches: true } as MediaQueryListEvent);
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});

	it('已显式选择时不跟随系统变更', () => {
		localStorage.setItem('pa-theme', 'light');
		const stub = stubMatchMedia(false);
		initTheme();
		stub.onChange!({ matches: true } as MediaQueryListEvent);
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
	});

	it('系统从深色切回浅色时同步为浅色', () => {
		const stub = stubMatchMedia(true);
		initTheme();
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

		stub.onChange!({ matches: false } as MediaQueryListEvent);

		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
	});
});
