/**
 * @jest-environment jsdom
 */
import type { AppConfig, AuthStatus, QuotaSnapshot } from '../../src/frontend/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const initQuotaMock = jest.fn();
const setPreferenceMock = jest.fn();
const syncAuthMock = jest.fn();
const initMeasureFormMock = jest.fn();
const renderAuthMock = jest.fn();
const initThemeMock = jest.fn();
const toggleThemeMock = jest.fn();
const setLangMock = jest.fn(async () => {});
const applyI18nMock = jest.fn();
const loadConfigMock = jest.fn();
const loadAuthStatusMock = jest.fn();
const registerMock = jest.fn(async () => {});

let config: AppConfig;
let authStatus: AuthStatus;
let quotaState: {
	mode: 'direct' | 'proxy' | 'exhausted' | 'unreachable';
	activeActor: 'ip' | 'user';
	proxyUsable: boolean;
	local: QuotaSnapshot;
	proxy: QuotaSnapshot;
};
let renderAuthImpl: (status: AuthStatus) => void;

const quotaCallbacks: Array<() => void> = [];
const authCallbacks: Array<(status: AuthStatus) => void> = [];

jest.unstable_mockModule('../../src/frontend/api', () => ({
	getConfig: () => config,
	loadConfig: loadConfigMock,
	loadAuthStatus: loadAuthStatusMock,
	onAuthChange: (callback: (status: AuthStatus) => void) => {
		authCallbacks.push(callback);
		callback(authStatus);
	},
}));

jest.unstable_mockModule('../../src/frontend/quota', () => ({
	getQuotaState: () => quotaState,
	getResetSeconds: (snapshot: QuotaSnapshot) => snapshot.reset,
	initQuota: initQuotaMock,
	onQuotaChange: (callback: () => void) => {
		quotaCallbacks.push(callback);
		callback();
	},
	setPreference: setPreferenceMock,
	syncAuth: syncAuthMock,
}));

jest.unstable_mockModule('../../src/frontend/i18n', () => ({
	applyI18n: applyI18nMock,
	getLang: () => 'en',
	initI18n: async () => {},
	setLang: setLangMock,
	SUPPORTED_LANGS: [
		{ code: 'en', label: 'English' },
		{ code: 'zh-Hans', label: '简体中文' },
	],
	t: (key: string, params?: { time?: string }) => (params?.time === undefined ? key : `${key}:${params.time}`),
}));

jest.unstable_mockModule('../../src/frontend/auth', () => ({
	renderAuth: renderAuthMock,
}));

jest.unstable_mockModule('../../src/frontend/measure', () => ({
	initMeasureForm: initMeasureFormMock,
}));

jest.unstable_mockModule('../../src/frontend/theme', () => ({
	initTheme: initThemeMock,
	toggleTheme: toggleThemeMock,
}));

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
	return {
		status: 'ready',
		actor: 'ip',
		limit: 250,
		remaining: 200,
		reset: 0,
		updatedAt: Date.now(),
		...overrides,
	};
}

const HTML = `
	<header>
		<select id="lang-select"></select>
		<button id="theme-toggle" type="button"></button>
		<div id="user-area"></div>
	</header>
	<main id="results"></main>
	<footer>
		<p id="footer-note"></p>
		<p id="footer-credit"></p>
		<span id="footer-version"></span>
	</footer>
	<div id="quota-meters"></div>
`;

function metersRoot(): HTMLElement {
	return document.getElementById('quota-meters') as HTMLElement;
}

function meter(actor: 'ip' | 'user'): HTMLElement | null {
	return metersRoot().querySelector(`.quota-meter[data-actor="${actor}"]`);
}

function note(actor: 'ip' | 'user'): HTMLElement | null {
	return meter(actor)?.querySelector('.quota-meter-note') ?? null;
}

/** 触发主流程中的额度变更回调（等价于 quota 模块通知刷新） */
function notifyQuota(): void {
	for (const callback of quotaCallbacks) {
		callback();
	}
}

/** 加载 main 模块并等待 main() 的首轮异步流程结束 */
async function boot(): Promise<void> {
	await jest.advanceTimersByTimeAsync(0);
	await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
	jest.useFakeTimers();
	document.documentElement.setAttribute('data-theme', 'light');
	document.body.innerHTML = HTML;
	window.history.replaceState({}, '', '/');
	quotaCallbacks.length = 0;
	authCallbacks.length = 0;
	config = { apiUrl: 'https://api.globalping.io', proxyAvailable: false, maxProbes: { direct: 50, proxy: 500 } };
	authStatus = { loggedIn: false, authEnabled: true, user: null };
	quotaState = {
		mode: 'direct',
		activeActor: 'ip',
		proxyUsable: false,
		local: snapshot(),
		proxy: snapshot({ actor: 'user', limit: 500, remaining: 500 }),
	};
	renderAuthImpl = (status) => {
		(document.getElementById('user-area') as HTMLElement).textContent = status.loggedIn ? 'logged-in' : 'anonymous';
	};
	loadConfigMock.mockImplementation(async () => config);
	loadAuthStatusMock.mockImplementation(async () => authStatus);
	renderAuthMock.mockImplementation((_container: HTMLElement, status: AuthStatus) => renderAuthImpl(status));
	setPreferenceMock.mockReset();
	setLangMock.mockReset();
	renderAuthMock.mockClear();
});

async function loadMain(): Promise<void> {
	jest.resetModules();
	await import('../../src/frontend/main');
	await boot();
}

describe('启动流程', () => {
	it('初始化主题、语言、额度与测量表单', async () => {
		await loadMain();
		expect(initThemeMock).toHaveBeenCalledTimes(1);
		expect(applyI18nMock).toHaveBeenCalledTimes(1);
		expect(loadConfigMock).toHaveBeenCalledTimes(1);
		expect(initQuotaMock).toHaveBeenCalledWith(config);
		expect(initMeasureFormMock).toHaveBeenCalledWith(document.getElementById('results'));
		expect(quotaCallbacks).toHaveLength(1);
		expect(authCallbacks).toHaveLength(1);
	});

	it('缺少结果容器时不初始化测量表单', async () => {
		document.getElementById('results')!.remove();
		await loadMain();
		expect(initMeasureFormMock).not.toHaveBeenCalled();
	});

	it('页脚展示说明与版本', async () => {
		await loadMain();
		expect(document.getElementById('footer-note')?.textContent).toBe('footerNote');
		expect(document.getElementById('footer-version')?.textContent)
			.toBe('PingAtlas · globalping.io · https://api.globalping.io');
	});

	it('页脚署名把 Markdown 链接渲染成外链', async () => {
		await loadMain();
		const credit = document.getElementById('footer-credit') as HTMLElement;
		expect(credit.textContent).toBe('footerCredit');
		expect(credit.querySelectorAll('a')).toHaveLength(0);
	});

	it('缺少头部与页脚元素时安全跳过', async () => {
		for (const id of ['lang-select', 'theme-toggle', 'footer-note', 'footer-version', 'footer-credit']) {
			document.getElementById(id)!.remove();
		}
		await loadMain();
		expect(document.querySelectorAll('#lang-select, #footer-note, #footer-credit')).toHaveLength(0);
		expect(loadConfigMock).toHaveBeenCalledTimes(1);
	});
});

describe('语言选择', () => {
	it('填充支持的语言并选中当前语言', async () => {
		await loadMain();
		const select = document.getElementById('lang-select') as HTMLSelectElement;
		expect([...select.options].map(option => option.value)).toEqual(['en', 'zh-Hans']);
		expect([...select.options].map(option => option.textContent)).toEqual(['English', '简体中文']);
		expect(select.value).toBe('en');
	});

	it('切换语言时调用 setLang', async () => {
		await loadMain();
		const select = document.getElementById('lang-select') as HTMLSelectElement;
		select.value = 'zh-Hans';
		select.dispatchEvent(new Event('change'));
		expect(setLangMock).toHaveBeenCalledWith('zh-Hans');
	});
});

describe('主题切换按钮', () => {
	it('浅色主题显示月亮图标', async () => {
		await loadMain();
		expect(document.getElementById('theme-toggle')?.textContent).toBe('☾');
	});

	it('深色主题显示太阳图标', async () => {
		document.documentElement.setAttribute('data-theme', 'dark');
		await loadMain();
		expect(document.getElementById('theme-toggle')?.textContent).toBe('☀');
	});

	it('点击后按返回值切换图标与无障碍标签', async () => {
		toggleThemeMock.mockReturnValueOnce('dark').mockReturnValueOnce('light');
		await loadMain();
		const button = document.getElementById('theme-toggle') as HTMLButtonElement;
		button.click();
		expect(button.textContent).toBe('☀');
		expect(button.getAttribute('aria-label')).toBe('themeToLight');
		button.click();
		expect(button.textContent).toBe('☾');
		expect(button.getAttribute('aria-label')).toBe('themeToDark');
	});
});

describe('登录回跳标记', () => {
	it('login=failed 时提示失败并清理 URL', async () => {
		window.history.replaceState({}, '', '/?login=failed&tab=ping');
		await loadMain();
		expect(document.getElementById('toast-box')?.textContent).toBe('loginFailed');
		expect(window.location.search).toBe('?tab=ping');
	});

	it('清理后只保留其他查询参数', async () => {
		window.history.replaceState({}, '', '/?login=failed');
		await loadMain();
		expect(window.location.search).toBe('');
		expect(window.location.pathname).toBe('/');
	});

	it('没有标记时不提示', async () => {
		await loadMain();
		expect(document.getElementById('toast-box')).toBeNull();
	});
});

describe('额度条渲染', () => {
	it('后端未配置代币时只显示本地额度条', async () => {
		await loadMain();
		expect(metersRoot().querySelectorAll('.quota-meter')).toHaveLength(1);
		expect(meter('ip')).not.toBeNull();
		expect(meter('user')).toBeNull();
	});

	it('后端配置代币后追加代理额度条', async () => {
		config.proxyAvailable = true;
		await loadMain();
		const all = metersRoot().querySelectorAll('.quota-meter');
		expect(all).toHaveLength(2);
		expect(meter('ip')?.querySelector('.quota-meter-label')?.textContent).toBe('quotaLocalLabel');
		expect(meter('user')?.querySelector('.quota-meter-label')?.textContent).toBe('quotaProxyLabel');
	});

	it('重复渲染不会重复创建额度条', async () => {
		config.proxyAvailable = true;
		await loadMain();
		notifyQuota();
		notifyQuota();
		expect(metersRoot().querySelectorAll('.quota-meter')).toHaveLength(2);
	});

	it('缺少额度条容器时跳过渲染', async () => {
		metersRoot().remove();
		await loadMain();
		notifyQuota();

		expect(document.querySelectorAll('.quota-meter')).toHaveLength(0);

		// 每秒刷新同样安全
		await jest.advanceTimersByTimeAsync(1000);
		expect(document.querySelectorAll('.quota-meter')).toHaveLength(0);
	});

	it('总量为 0 时按 0% 渲染进度条', async () => {
		await loadMain();
		quotaState.local = snapshot({ limit: 0, remaining: 0 });
		notifyQuota();
		const fill = meter('ip')?.querySelector('.quota-meter-fill') as HTMLElement;
		expect(meter('ip')?.querySelector('.quota-meter-value')?.textContent).toBe('0 / 0');
		expect(fill.style.width).toBe('0%');
		expect(fill.getAttribute('data-level')).toBe('empty');
	});

	it('展示剩余量与总量并更新进度条', async () => {
		await loadMain();
		quotaState.local = snapshot({ limit: 250, remaining: 125 });
		notifyQuota();
		expect(meter('ip')?.querySelector('.quota-meter-value')?.textContent).toBe('125 / 250');
		const fill = meter('ip')?.querySelector('.quota-meter-fill') as HTMLElement;
		expect(Number.parseFloat(fill.style.width)).toBeCloseTo(50, 1);
		expect(fill.getAttribute('data-level')).toBe('normal');
	});

	it('低于 15% 标记为告警色', async () => {
		await loadMain();
		quotaState.local = snapshot({ limit: 200, remaining: 20 });
		notifyQuota();
		expect(meter('ip')?.querySelector('.quota-meter-fill')?.getAttribute('data-level')).toBe('low');
	});

	it('额度耗尽标记为空并显示重置倒计时', async () => {
		await loadMain();
		quotaState.local = snapshot({ limit: 250, remaining: 0, reset: 61 });
		notifyQuota();
		const fill = meter('ip')?.querySelector('.quota-meter-fill') as HTMLElement;
		expect(fill.getAttribute('data-level')).toBe('empty');
		expect(Number.parseFloat(fill.style.width)).toBe(0);
		expect(note('ip')?.querySelector('.quota-meter-reset')?.textContent).toBe('quotaResetIn:01:01');
	});

	it('有剩余且存在重置窗口时显示重置提示', async () => {
		await loadMain();
		quotaState.local = snapshot({ remaining: 10, reset: 3661 });
		notifyQuota();
		expect(note('ip')?.querySelector('.quota-meter-reset')?.textContent).toBe('quotaResetHint:61:01');
	});

	it('窗口未开始（reset 为 0）时不显示倒计时', async () => {
		await loadMain();
		quotaState.local = snapshot({ remaining: 250, reset: 0 });
		notifyQuota();
		expect(note('ip')?.querySelector('.quota-meter-reset')).toBeNull();
	});

	it('额度为 0 且 reset 为 0 时仍显示 00:00 倒计时', async () => {
		await loadMain();
		quotaState.local = snapshot({ remaining: 0, reset: 0 });
		notifyQuota();
		expect(note('ip')?.querySelector('.quota-meter-reset')?.textContent).toBe('quotaResetIn:00:00');
	});

	it('认证额度附带 credits 提示', async () => {
		config.proxyAvailable = true;
		await loadMain();
		quotaState.proxy = snapshot({ actor: 'user', limit: 500, remaining: 400, creditsRemaining: 1234 });
		notifyQuota();
		expect(note('user')?.querySelector('.quota-meter-credits')?.textContent).toBe('quotaCredits');
		expect(note('user')?.querySelector('.quota-meter-reset')).toBeNull();
	});

	it('副标题各片段都是 flex 容器的直接子元素', async () => {
		config.proxyAvailable = true;
		await loadMain();
		quotaState.proxy = snapshot({ actor: 'user', limit: 500, remaining: 400, creditsRemaining: 1234, reset: 61 });
		notifyQuota();
		expect([...(note('user')?.children ?? [])].map(child => child.className)).toEqual([
			'quota-meter-mode',
			'quota-meter-reset',
			'quota-meter-credits',
		]);
	});

	it('生效标记与其它片段同级，不嵌套在模式文案内', async () => {
		config.proxyAvailable = true;
		quotaState.activeActor = 'user';
		quotaState.proxyUsable = true;
		await loadMain();
		quotaState.proxy = snapshot({ actor: 'user', reset: 61 });
		notifyQuota();
		expect([...(note('user')?.children ?? [])].map(child => child.className)).toEqual([
			'quota-meter-mode',
			'quota-meter-reset',
			'quota-meter-active-tag',
		]);
		expect(note('user')?.querySelector('.quota-meter-mode .quota-meter-active-tag')).toBeNull();
	});

	it('不可用状态下的占位文案也是独立片段', async () => {
		await loadMain();
		quotaState.local = snapshot({ status: 'unavailable' });
		notifyQuota();
		expect([...(note('ip')?.children ?? [])].map(child => child.className)).toEqual(['quota-meter-mode']);
		expect(note('ip')?.textContent).toBe('quotaUnavailable');
	});

	it('加载中与不可用状态显示占位数值', async () => {
		config.proxyAvailable = true;
		quotaState.proxy = snapshot({ actor: 'user', status: 'loading', limit: 0, remaining: 0 });
		await loadMain();
		expect(meter('ip')?.querySelector('.quota-meter-value')?.textContent).toBe('200 / 250');
		expect(note('user')?.textContent).toBe('quotaLoading');

		quotaState.local = snapshot({ status: 'unavailable' });
		notifyQuota();
		expect(meter('ip')?.querySelector('.quota-meter-value')?.textContent).toBe('— / —');
		expect(note('ip')?.textContent).toBe('quotaUnavailable');
		expect((meter('ip')?.querySelector('.quota-meter-fill') as HTMLElement).style.width).toBe('0%');
	});

	it('标记当前生效的额度条', async () => {
		config.proxyAvailable = true;
		quotaState.activeActor = 'user';
		quotaState.proxyUsable = true;
		await loadMain();
		expect(meter('ip')?.getAttribute('data-active')).toBe('false');
		expect(meter('user')?.getAttribute('data-active')).toBe('true');
		expect(note('user')?.querySelector('.quota-meter-active-tag')?.textContent).toBe('quotaActive');
	});

	it('把当前路由模式写入容器', async () => {
		await loadMain();
		expect(metersRoot().getAttribute('data-mode')).toBe('direct');
		quotaState.mode = 'proxy';
		notifyQuota();
		expect(metersRoot().getAttribute('data-mode')).toBe('proxy');
	});

	it('代理额度不可用时禁用第二条额度条', async () => {
		config.proxyAvailable = true;
		await loadMain();
		const proxy = meter('user') as HTMLButtonElement;
		expect(proxy.disabled).toBe(true);
		expect(proxy.getAttribute('aria-disabled')).toBe('true');

		quotaState.proxyUsable = true;
		notifyQuota();
		expect(proxy.disabled).toBe(false);
		expect(proxy.getAttribute('aria-disabled')).toBe('false');
	});

	it('点击本地额度条恢复本地优先', async () => {
		await loadMain();
		(meter('ip') as HTMLButtonElement).click();
		expect(setPreferenceMock).toHaveBeenCalledWith('auto');
	});

	it('点击代理额度条切换到代理额度', async () => {
		config.proxyAvailable = true;
		quotaState.proxyUsable = true;
		await loadMain();
		(meter('user') as HTMLButtonElement).click();
		expect(setPreferenceMock).toHaveBeenCalledWith('proxy');
	});

	it('每秒刷新一次倒计时', async () => {
		await loadMain();
		quotaState.local = snapshot({ remaining: 30, reset: 100 });
		await jest.advanceTimersByTimeAsync(1000);
		expect(meter('ip')?.querySelector('.quota-meter-value')?.textContent).toBe('30 / 250');
	});
});

describe('额度条提示文案', () => {
	async function hintFor(actor: 'ip' | 'user'): Promise<string | undefined> {
		await loadMain();
		notifyQuota();
		return note(actor)?.querySelector('.quota-meter-mode')?.firstChild?.textContent ?? undefined;
	}

	it('不可达时两条都提示不可达', async () => {
		config.proxyAvailable = true;
		quotaState.mode = 'unreachable';
		quotaState.proxyUsable = true;
		expect(await hintFor('ip')).toBe('quotaUnreachable');
		expect(await hintFor('user')).toBe('quotaUnreachable');
	});

	it('直连模式提示本地生效', async () => {
		expect(await hintFor('ip')).toBe('quotaModeDirect');
	});

	it('本地额度耗尽时提示已耗尽', async () => {
		quotaState.mode = 'proxy';
		quotaState.proxyUsable = true;
		quotaState.local = snapshot({ remaining: 0 });
		expect(await hintFor('ip')).toBe('quotaExhausted');
	});

	it('代理模式下本地额度条提示待命', async () => {
		quotaState.mode = 'proxy';
		quotaState.proxyUsable = true;
		expect(await hintFor('ip')).toBe('quotaStandby');
	});

	it('未登录时提示需要登录', async () => {
		config.proxyAvailable = true;
		expect(await hintFor('user')).toBe('quotaLoginRequired');
	});

	it('登录后代理生效时提示代理', async () => {
		config.proxyAvailable = true;
		quotaState.mode = 'proxy';
		quotaState.proxyUsable = true;
		expect(await hintFor('user')).toBe('quotaModeProxy');
	});

	it('登录后代理未生效时提示待命', async () => {
		config.proxyAvailable = true;
		quotaState.mode = 'direct';
		quotaState.proxyUsable = true;
		expect(await hintFor('user')).toBe('quotaStandby');
	});
});

describe('登录态变化', () => {
	it('渲染用户区并同步额度', async () => {
		await loadMain();
		expect(document.getElementById('user-area')?.textContent).toBe('anonymous');
		expect(renderAuthMock).toHaveBeenCalledWith(document.getElementById('user-area'), authStatus);
		expect(syncAuthMock).toHaveBeenCalledTimes(1);
		const callback = authCallbacks[0]!;
		callback({ loggedIn: true, authEnabled: true, user: { username: 'alice' } });
		expect(document.getElementById('user-area')?.textContent).toBe('logged-in');
		expect(renderAuthMock).toHaveBeenCalledTimes(2);
		expect(syncAuthMock).toHaveBeenCalledTimes(2);
	});

	it('缺少用户区时仍然同步额度', async () => {
		document.getElementById('user-area')!.remove();
		await loadMain();
		renderAuthMock.mockClear();
		syncAuthMock.mockClear();
		authCallbacks[0]!(authStatus);
		expect(renderAuthMock).not.toHaveBeenCalled();
		expect(syncAuthMock).toHaveBeenCalledTimes(1);
	});
});

describe('Service Worker 注册', () => {
	it('浏览器不支持时跳过', async () => {
		Reflect.deleteProperty(navigator, 'serviceWorker');
		await loadMain();
		expect(registerMock).not.toHaveBeenCalled();
	});

	it('页面已加载完成时立即注册', async () => {
		Object.defineProperty(navigator, 'serviceWorker', { value: { register: registerMock }, configurable: true });
		await loadMain();
		expect(registerMock).toHaveBeenCalledWith('/sw.js');
	});

	it('页面仍在加载时等待 load 事件', async () => {
		Object.defineProperty(navigator, 'serviceWorker', { value: { register: registerMock }, configurable: true });
		const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState');
		Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
		try {
			await loadMain();
			expect(registerMock).not.toHaveBeenCalled();
			window.dispatchEvent(new Event('load'));
			expect(registerMock).toHaveBeenCalledWith('/sw.js');
		}
		finally {
			if (descriptor) {
				Object.defineProperty(Document.prototype, 'readyState', descriptor);
			}
			Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
		}
	});

	it('注册失败不会中断启动', async () => {
		registerMock.mockRejectedValueOnce(new Error('insecure context'));
		Object.defineProperty(navigator, 'serviceWorker', { value: { register: registerMock }, configurable: true });
		await expect(loadMain()).resolves.toBeUndefined();
	});
});
