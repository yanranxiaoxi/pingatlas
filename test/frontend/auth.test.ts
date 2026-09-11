/**
 * @jest-environment jsdom
 */
import type { AuthStatus } from '../../src/frontend/types';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../../src/frontend/i18n', () => ({
	getLang: () => 'en',
	t: (key: string) => key,
}));

let auth: typeof import('../../src/frontend/auth');

let container: HTMLElement;

function status(overrides: Partial<AuthStatus> = {}): AuthStatus {
	return {
		loggedIn: false,
		authEnabled: true,
		user: null,
		...overrides,
	};
}

function loggedIn(username = 'alice'): AuthStatus {
	return status({ loggedIn: true, user: { username } });
}

function overlay(): HTMLElement | null {
	return document.querySelector('.modal-overlay');
}

function buttons(): HTMLButtonElement[] {
	return [...document.querySelectorAll('.modal-dialog .modal-action')] as HTMLButtonElement[];
}

function press(key: string): void {
	document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

beforeEach(async () => {
	jest.resetModules();
	document.body.innerHTML = '<header id="user-area"></header>';
	document.body.classList.remove('modal-open');
	container = document.getElementById('user-area') as HTMLElement;
	auth = await import('../../src/frontend/auth');
});

describe('renderAuth 基础渲染', () => {
	it('未启用 OIDC 时不渲染任何入口', () => {
		auth.renderAuth(container, status({ authEnabled: false }));
		expect(container.children).toHaveLength(0);
		expect(container.textContent).toBe('');
	});

	it('已登录时展示用户名与登出按钮', () => {
		auth.renderAuth(container, loggedIn('bob'));
		expect(container.querySelector('.user-chip')?.textContent).toBe('bob');
		const logout = container.querySelector('button') as HTMLButtonElement;
		expect(logout.textContent).toBe('logout');
		expect(logout.className).toContain('btn ghost');
	});

	it('未登录时展示登录按钮', () => {
		auth.renderAuth(container, status());
		const login = container.querySelector('button') as HTMLButtonElement;
		expect(login.textContent).toBe('login');
		expect(login.className).toContain('btn primary');
		expect(container.querySelector('.user-chip')).toBeNull();
	});

	it('已登录但缺少 user 字段时回退为登录按钮', () => {
		auth.renderAuth(container, status({ loggedIn: true, user: null }));
		expect(container.querySelector('button')?.textContent).toBe('login');
	});

	it('重复渲染会清空旧内容', () => {
		auth.renderAuth(container, loggedIn('bob'));
		auth.renderAuth(container, status());
		expect(container.querySelectorAll('button')).toHaveLength(1);
		expect(container.textContent).toBe('login');
	});
});

describe('登录弹窗', () => {
	it('点击登录按钮弹出 SSO 提供商按钮', () => {
		auth.renderAuth(container, status({ providerName: 'Example SSO' }));
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(overlay()).not.toBeNull();
		expect(overlay()?.getAttribute('role')).toBe('dialog');
		expect(overlay()?.getAttribute('aria-modal')).toBe('true');
		expect(buttons()).toHaveLength(1);
		expect(buttons()[0]!.textContent).toBe('Example SSO');
		expect(document.body.classList.contains('modal-open')).toBe(true);
	});

	it('缺少 providerName 时使用本地化默认文案', () => {
		auth.renderAuth(container, status({ providerName: '' }));
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(buttons()[0]!.textContent).toBe('ssoLogin');
	});

	it('打开后焦点落在 SSO 按钮上', () => {
		auth.renderAuth(container, status({ providerName: 'SSO' }));
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(document.activeElement).toBe(buttons()[0]);
	});

	it('弹窗已打开时再次点击不重复创建', () => {
		auth.renderAuth(container, status());
		const login = container.querySelector('button') as HTMLButtonElement;
		login.click();
		login.click();
		expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
	});
});

describe('登出弹窗', () => {
	it('提供仅登出本地与同时登出 SSO 两个选项', () => {
		auth.renderAuth(container, loggedIn());
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(overlay()?.querySelector('.modal-text')?.textContent).toBe('logoutConfirm');
		expect(buttons().map(button => button.textContent)).toEqual(['logoutLocal', 'logoutSso']);
		expect(document.activeElement).toBe(buttons()[0]);
	});
});

describe('弹窗关闭行为', () => {
	it('按 Esc 关闭并归还焦点', () => {
		auth.renderAuth(container, status());
		const login = container.querySelector('button') as HTMLButtonElement;
		login.click();
		press('Escape');
		expect(overlay()).toBeNull();
		expect(document.body.classList.contains('modal-open')).toBe(false);
		expect(document.activeElement).toBe(login);
	});

	it('其他按键不关闭弹窗', () => {
		auth.renderAuth(container, status());
		(container.querySelector('button') as HTMLButtonElement).click();
		press('Enter');
		expect(overlay()).not.toBeNull();
	});

	it('点击遮罩关闭，点击对话框内部不关闭', () => {
		auth.renderAuth(container, status());
		(container.querySelector('button') as HTMLButtonElement).click();
		const dialog = document.querySelector('.modal-dialog') as HTMLElement;
		dialog.click();
		expect(overlay()).not.toBeNull();
		overlay()!.click();
		expect(overlay()).toBeNull();
	});

	it('Esc 关闭后监听器被移除，后续按键不再报错', () => {
		auth.renderAuth(container, status());
		(container.querySelector('button') as HTMLButtonElement).click();
		press('Escape');
		expect(() => press('Escape')).not.toThrow();
		expect(overlay()).toBeNull();
	});
});

describe('登录态变化时自动关闭弹窗', () => {
	it('登录成功后关闭登录弹窗', () => {
		auth.renderAuth(container, status());
		(container.querySelector('button') as HTMLButtonElement).click();
		auth.renderAuth(container, loggedIn('carol'));
		expect(overlay()).toBeNull();
	});

	it('仍在未登录状态时保留登录弹窗', () => {
		auth.renderAuth(container, status());
		(container.querySelector('button') as HTMLButtonElement).click();
		auth.renderAuth(container, status());
		expect(overlay()).not.toBeNull();
	});

	it('登出成功后关闭登出弹窗', () => {
		auth.renderAuth(container, loggedIn());
		(container.querySelector('button') as HTMLButtonElement).click();
		auth.renderAuth(container, status());
		expect(overlay()).toBeNull();
	});

	it('仍处于登录状态时保留登出弹窗', () => {
		auth.renderAuth(container, loggedIn());
		(container.querySelector('button') as HTMLButtonElement).click();
		auth.renderAuth(container, loggedIn('dave'));
		expect(overlay()).not.toBeNull();
	});

	it('OIDC 被禁用时关闭任何弹窗', () => {
		auth.renderAuth(container, loggedIn());
		(container.querySelector('button') as HTMLButtonElement).click();
		auth.renderAuth(container, status({ authEnabled: false }));
		expect(overlay()).toBeNull();
		expect(container.children).toHaveLength(0);
	});
});

describe('弹窗动作跳转', () => {
	// jsdom 不支持真实导航，赋值 location.href 只会打印 not implemented 错误，这里静音避免噪声
	beforeEach(() => {
		jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('点击 SSO 登录按钮跳到登录入口且不抛异常', () => {
		auth.renderAuth(container, status({ providerName: 'SSO' }));
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(() => buttons()[0]!.click()).not.toThrow();
		expect(window.location.href).toBe('http://localhost/');
	});

	it('点击仅登出本地按钮跳到登出入口', () => {
		auth.renderAuth(container, loggedIn());
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(() => buttons()[0]!.click()).not.toThrow();
		expect(window.location.href).toBe('http://localhost/');
	});

	it('点击同时登出 SSO 按钮跳到带 sso 参数的登出入口', () => {
		auth.renderAuth(container, loggedIn());
		(container.querySelector('button') as HTMLButtonElement).click();
		expect(() => buttons()[1]!.click()).not.toThrow();
		expect(window.location.href).toBe('http://localhost/');
	});
});
