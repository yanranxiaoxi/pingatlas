import type { AuthStatus } from './types';
import { t } from './i18n';
import { el } from './ui';

/** 当前打开的弹窗（同时只允许一个） */
let activeModal: HTMLElement | null = null;
/** 当前弹窗类型，用于登录态变化时判断是否应自动关闭 */
let activeModalKind: 'login' | 'logout' | null = null;
/** 弹窗打开前的焦点元素，关闭后归还焦点 */
let restoreFocus: HTMLElement | null = null;

function onKeyDown(event: KeyboardEvent): void {
	if (event.key === 'Escape') {
		closeModal();
	}
}

/**
 * 关闭弹窗（未打开时为空操作）
 * @param restore - 是否把焦点归还给触发按钮（重渲染时该按钮已被移除，无需归还）
 */
function closeModal(restore = true): void {
	if (!activeModal) {
		return;
	}
	document.removeEventListener('keydown', onKeyDown);
	activeModal.remove();
	activeModal = null;
	activeModalKind = null;
	document.body.classList.remove('modal-open');
	if (restore) {
		restoreFocus?.focus();
	}
	restoreFocus = null;
}

/**
 * 打开弹窗：半透明遮罩 + 居中提示框。点击遮罩（提示框外部）或按 Esc 关闭。
 * @param trigger - 触发元素，关闭后归还焦点
 * @param kind - 弹窗类型（登录/登出），登录态变化时据此自动关闭
 * @param children - 提示框内的内容节点
 * @param focusTarget - 打开后获得焦点的元素（默认第一个按钮）
 */
function openModal(trigger: HTMLElement, kind: 'login' | 'logout', children: HTMLElement[], focusTarget?: HTMLElement): void {
	if (activeModal) {
		return;
	}
	restoreFocus = trigger;

	const overlay = el('div', { 'class': 'modal-overlay', 'role': 'dialog', 'aria-modal': 'true' });
	// 仅当点击发生在遮罩本身（而非提示框内部）时关闭
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) {
			closeModal();
		}
	});

	overlay.append(el('div', { class: 'modal-dialog' }, children));
	document.body.append(overlay);
	document.body.classList.add('modal-open');

	activeModal = overlay;
	activeModalKind = kind;
	document.addEventListener('keydown', onKeyDown);
	(focusTarget ?? children.find(child => child instanceof HTMLButtonElement))?.focus();
}

/**
 * 打开登录弹窗：半透明遮罩 + 居中提示框，框内为 SSO 提供商登录按钮。
 */
function openLoginModal(trigger: HTMLElement, providerName: string): void {
	const ssoButton = el('button', { class: 'btn primary modal-action', type: 'button' }, [providerName]);
	ssoButton.addEventListener('click', () => {
		window.location.href = '/api/auth/login';
	});

	openModal(trigger, 'login', [ssoButton], ssoButton);
}

/**
 * 打开登出确认弹窗：让用户选择仅登出当前服务，还是同时登出 SSO 系统。
 */
function openLogoutModal(trigger: HTMLElement): void {
	const question = el('p', { class: 'modal-text' }, [t('logoutConfirm')]);

	const localButton = el('button', { class: 'btn ghost modal-action', type: 'button' }, [t('logoutLocal')]);
	localButton.addEventListener('click', () => {
		window.location.href = '/api/auth/logout';
	});

	const ssoButton = el('button', { class: 'btn primary modal-action', type: 'button' }, [t('logoutSso')]);
	ssoButton.addEventListener('click', () => {
		window.location.href = '/api/auth/logout?sso=1';
	});

	openModal(trigger, 'logout', [question, localButton, ssoButton], localButton);
}

/**
 * 渲染右上角用户区（登录按钮 / 用户名 + 登出）
 */
export function renderAuth(container: HTMLElement, status: AuthStatus): void {
	// 登录态变化后弹窗内容可能已失效：登录弹窗在已登录时关闭，登出弹窗在已登出时关闭
	if ((activeModalKind === 'login' && status.loggedIn) || (activeModalKind === 'logout' && !status.loggedIn) || !status.authEnabled) {
		closeModal(false);
	}

	container.replaceChildren();

	if (!status.authEnabled) {
		// 服务端未配置 OIDC，不显示登录入口
		return;
	}

	if (status.loggedIn && status.user) {
		/*
		 * 配置了用户中心就把用户名渲染成链接。
		 *
		 * 用 `<a href>` 而不是点击事件：中键新标签、右键复制链接等浏览器行为都可
		 * 直接用。提示只加在 `title` 上而不加 `aria-label`——后者会覆盖链接的可
		 * 访问名称，读屏就念不出用户名了。
		 */
		const chip = status.accountUrl
			? el('a', {
					class: 'user-chip user-chip-link',
					href: status.accountUrl,
					title: t('accountCenter'),
				}, [status.user.username])
			: el('span', { class: 'user-chip' }, [status.user.username]);

		const logout = el('button', { class: 'btn ghost', type: 'button' }, [t('logout')]);
		logout.addEventListener('click', () => openLogoutModal(logout));

		container.append(chip, logout);
	}
	else {
		// 提供商名称由服务端 OIDC_PROVIDER_NAME 下发，未配置时用本地化默认文案
		const providerName = status.providerName || t('ssoLogin');
		const login = el('button', { class: 'btn primary', type: 'button' }, [t('login')]);
		login.addEventListener('click', () => openLoginModal(login, providerName));
		container.append(login);
	}
}
