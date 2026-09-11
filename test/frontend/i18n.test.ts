/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	applyI18n,
	getLang,
	initI18n,
	setLang,
	SUPPORTED_LANGS,
	t,
} from '../../src/frontend/i18n';
import { publicDir } from '../helpers/paths';

function jsonResponse(payload: unknown, ok = true): Response {
	return {
		ok,
		json: async () => payload,
	} as unknown as Response;
}

beforeEach(() => {
	localStorage.clear();
	document.body.replaceChildren();
	Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
});

describe('t', () => {
	it('未加载词典时回退为 key 本身', () => {
		expect(t('some.missing.key')).toBe('some.missing.key');
	});

	it('加载词典后返回翻译并替换占位符', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ greet: 'Hello {name}!' })) as unknown as typeof fetch;
		await initI18n();
		expect(t('greet', { name: 'Ada' })).toBe('Hello Ada!');
	});

	it('占位符出现多次时全部替换', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ k: '{a}-{a}' })) as unknown as typeof fetch;
		await initI18n();
		expect(t('k', { a: 1 })).toBe('1-1');
	});

	it('数值参数被转为字符串', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ k: 'n={n}' })) as unknown as typeof fetch;
		await initI18n();
		expect(t('k', { n: 42 })).toBe('n=42');
	});

	it('缺少参数时保留占位符原文', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ k: 'Hi {name}' })) as unknown as typeof fetch;
		await initI18n();
		expect(t('k')).toBe('Hi {name}');
	});
});

describe('detectLang / initI18n', () => {
	it('localStorage 中的受支持语言优先', async () => {
		localStorage.setItem('pa-lang', 'zh-Hans');
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
		const fetchMock = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		await initI18n();
		expect(getLang()).toBe('zh-Hans');
		expect(fetchMock).toHaveBeenCalledWith('/locales/zh-Hans.json', { cache: 'no-cache' });
	});

	it('localStorage 存储非法语言时按浏览器语言判断', async () => {
		localStorage.setItem('pa-lang', 'fr');
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-GB' });
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(getLang()).toBe('en');
	});

	it('浏览器语言为中文时默认简体中文', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(getLang()).toBe('zh-Hans');
	});

	it('其他浏览器语言回退英文', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'ja' });
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(getLang()).toBe('en');
	});

	it('浏览器未提供 language 时回退英文', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: undefined });
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(getLang()).toBe('en');
	});

	it('localStorage 读取失败时仍按浏览器语言判断', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
		jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(getLang()).toBe('zh-Hans');
	});

	it('初始化后 <html lang> 与当前语言一致', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(document.documentElement.lang).toBe('zh-Hans');
	});

	it('切换语言后 <html lang> 覆盖静态标记里的默认值', async () => {
		document.documentElement.lang = 'zh-CN';
		localStorage.setItem('pa-lang', 'en');
		globalThis.fetch = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		await initI18n();
		expect(document.documentElement.lang).toBe('en');
	});
});

describe('loadDictionary 回退策略', () => {
	it('目标语言缺失时回退英文', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
		const fetchMock = jest.fn(async (url: string) => {
			if (url === '/locales/zh-Hans.json') {
				return jsonResponse({}, false);
			}
			return jsonResponse({ fallbackKey: 'from english' });
		}) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		await initI18n();
		expect(t('fallbackKey')).toBe('from english');
	});

	it('全部候选都失败时词典为空（t 回退 key）', async () => {
		Object.defineProperty(navigator, 'language', { configurable: true, value: 'zh-CN' });
		globalThis.fetch = jest.fn(async () => {
			throw new Error('offline');
		}) as unknown as typeof fetch;
		await initI18n();
		expect(t('anything')).toBe('anything');
	});

	it('英文语言只请求 en.json', async () => {
		const fetchMock = jest.fn(async () => jsonResponse({})) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		await initI18n();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith('/locales/en.json', { cache: 'no-cache' });
	});
});

describe('setLang', () => {
	// 注意：jsdom 的 location.reload 是只读属性，无法 spy，
	// 因此这里只断言持久化行为；刷新动作已在端到端（Playwright）验证中覆盖。
	it('受支持语言会持久化', async () => {
		expect(() => setLang('zh-Hans')).not.toThrow();
		await Promise.resolve();
		expect(localStorage.getItem('pa-lang')).toBe('zh-Hans');
	});

	it('不支持的语言不写入', async () => {
		await setLang('fr');
		expect(localStorage.getItem('pa-lang')).toBeNull();
	});

	it('重复选择同一语言仍会写入', async () => {
		await setLang('en');
		await setLang('en');
		expect(localStorage.getItem('pa-lang')).toBe('en');
	});
});

describe('applyI18n', () => {
	it('翻译 data-i18n 的 textContent', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ title: '标题' })) as unknown as typeof fetch;
		await initI18n();
		document.body.innerHTML = '<h1 data-i18n="title"></h1>';
		applyI18n();
		expect(document.querySelector('h1')!.textContent).toBe('标题');
	});

	it('翻译 placeholder / title / aria-label 属性', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ p: 'P', tt: 'T', aa: 'A' })) as unknown as typeof fetch;
		await initI18n();
		document.body.innerHTML = `
			<input data-i18n-placeholder="p">
			<button data-i18n-title="tt"></button>
			<span data-i18n-aria-label="aa"></span>
		`;
		applyI18n();
		expect(document.querySelector('input')!.getAttribute('placeholder')).toBe('P');
		expect(document.querySelector('button')!.getAttribute('title')).toBe('T');
		expect(document.querySelector('span')!.getAttribute('aria-label')).toBe('A');
	});

	it('可以限定作用范围', async () => {
		globalThis.fetch = jest.fn(async () => jsonResponse({ k: 'v' })) as unknown as typeof fetch;
		await initI18n();
		document.body.innerHTML = `
			<div id="a"><span data-i18n="k"></span></div>
			<div id="b"><span data-i18n="k"></span></div>
		`;
		applyI18n(document.getElementById('a')!);
		expect(document.querySelector('#a span')!.textContent).toBe('v');
		expect(document.querySelector('#b span')!.textContent).toBe('');
	});

	it('空 key 被忽略且不抛错', () => {
		document.body.innerHTML = '<div data-i18n=""></div>';
		expect(() => applyI18n()).not.toThrow();
		expect(document.querySelector('div')!.textContent).toBe('');
	});

	it('空的属性 key 同样被忽略', () => {
		document.body.innerHTML = `
			<input data-i18n-placeholder="">
			<button data-i18n-title=""></button>
			<span data-i18n-aria-label=""></span>
		`;
		expect(() => applyI18n()).not.toThrow();
		expect(document.querySelector('input')!.hasAttribute('placeholder')).toBe(false);
		expect(document.querySelector('button')!.hasAttribute('title')).toBe(false);
		expect(document.querySelector('span')!.hasAttribute('aria-label')).toBe(false);
	});
});

describe('SUPPORTED_LANGS', () => {
	it('至少包含中英文且结构完整', () => {
		expect(SUPPORTED_LANGS.map(l => l.code)).toEqual(expect.arrayContaining(['zh-Hans', 'en']));
		for (const lang of SUPPORTED_LANGS) {
			expect(typeof lang.label).toBe('string');
			expect(lang.label.length).toBeGreaterThan(0);
		}
	});
});

describe('locale 文件一致性', () => {
	it('中英文词典的 key 集合完全一致', () => {
		const en = JSON.parse(readFileSync(join(publicDir, 'locales', 'en.json'), 'utf8')) as Record<string, string>;
		const zh = JSON.parse(readFileSync(join(publicDir, 'locales', 'zh-Hans.json'), 'utf8')) as Record<string, string>;
		const enKeys = Object.keys(en).sort();
		const zhKeys = Object.keys(zh).sort();
		expect(zhKeys.filter(k => !enKeys.includes(k))).toEqual([]);
		expect(enKeys.filter(k => !zhKeys.includes(k))).toEqual([]);
	});

	it('没有空字符串文案', () => {
		for (const name of ['en.json', 'zh-Hans.json']) {
			const dict = JSON.parse(readFileSync(join(publicDir, 'locales', name), 'utf8')) as Record<string, string>;
			const empty = Object.entries(dict).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k);
			expect(empty).toEqual([]);
		}
	});
});
