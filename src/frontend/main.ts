import type { QuotaSnapshot } from './types';
import { getConfig, loadAuthStatus, loadConfig, onAuthChange } from './api';
import { renderAuth } from './auth';
import { applyI18n, getLang, initI18n, setLang, SUPPORTED_LANGS, t } from './i18n';
import { initMeasureForm } from './measure';
import {
	getQuotaState,
	getResetSeconds,
	initQuota,
	onQuotaChange,
	setPreference,
	syncAuth,
} from './quota';
import { initTheme, toggleTheme } from './theme';
import { el, formatCountdown, textWithLinks, toast } from './ui';

/** 额度条中需要就地更新的节点引用（避免每秒重建 DOM 导致焦点丢失） */
interface MeterRefs {
	root: HTMLButtonElement;
	value: HTMLElement;
	note: HTMLElement;
	fill: HTMLElement;
}

let localMeter: MeterRefs | null = null;
let proxyMeter: MeterRefs | null = null;
let meterContainer: HTMLElement | null = null;

function buildMeter(actor: 'ip' | 'user', onClick: () => void): MeterRefs {
	const root = el('button', {
		'class': 'quota-meter',
		'type': 'button',
		'data-actor': actor,
		'data-active': 'false',
		'data-level': 'normal',
	}) as HTMLButtonElement;
	const head = el('div', { class: 'quota-meter-head' });
	const label = el('span', { class: 'quota-meter-label' }, [
		actor === 'ip' ? t('quotaLocalLabel') : t('quotaProxyLabel'),
	]);
	const value = el('span', { class: 'quota-meter-value' }, ['— / —']);
	head.append(label, value);

	const track = el('div', { class: 'quota-meter-track' });
	const fill = el('span', { class: 'quota-meter-fill' });
	fill.setAttribute('data-level', 'normal');
	track.append(fill);

	const note = el('p', { class: 'quota-meter-note' });
	root.append(head, track, note);
	root.addEventListener('click', onClick);
	return { root, value, note, fill };
}

/** 按快照刷新单条额度条 */
function updateMeter(refs: MeterRefs, snapshot: QuotaSnapshot, active: boolean, actorHint: string): void {
	refs.root.setAttribute('data-active', active ? 'true' : 'false');
	const ready = snapshot.status === 'ready';
	const limit = snapshot.limit || 0;
	const remaining = snapshot.remaining || 0;
	if (!ready) {
		refs.value.textContent = '— / —';
		refs.fill.style.width = '0%';
		refs.fill.setAttribute('data-level', 'normal');
		refs.note.replaceChildren(el('span', { class: 'quota-meter-mode' }, [
			snapshot.status === 'loading' ? t('quotaLoading') : t('quotaUnavailable'),
		]));
		return;
	}
	refs.value.textContent = `${remaining} / ${limit}`;
	const ratio = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 0;
	refs.fill.style.width = `${(ratio * 100).toFixed(1)}%`;
	const level = remaining <= 0 ? 'empty' : ratio <= 0.15 ? 'low' : 'normal';
	refs.fill.setAttribute('data-level', level);

	// 各片段必须是 .quota-meter-note 的直接子元素，才能让 flex gap 生效
	const parts: HTMLElement[] = [el('span', { class: 'quota-meter-mode' }, [actorHint])];
	const reset = getResetSeconds(snapshot);
	// 上游在窗口尚未开始时会返回 reset: 0（额度还是满的），此时不展示倒计时，避免出现「00:00 后重置」
	if (remaining <= 0 || reset > 0) {
		parts.push(el('span', { class: 'quota-meter-reset' }, [
			remaining <= 0 ? t('quotaResetIn', { time: formatCountdown(reset) }) : t('quotaResetHint', { time: formatCountdown(reset) }),
		]));
	}
	if (typeof snapshot.creditsRemaining === 'number') {
		parts.push(el('span', { class: 'quota-meter-credits' }, [t('quotaCredits', { n: snapshot.creditsRemaining })]));
	}
	if (active) {
		parts.push(el('span', { class: 'quota-meter-active-tag' }, [t('quotaActive')]));
	}
	refs.note.replaceChildren(...parts);
}

/** 额度条提示文案：说明该额度当前是否生效、为何生效 */
function actorHint(state: ReturnType<typeof getQuotaState>, actor: 'ip' | 'user'): string {
	if (state.mode === 'unreachable') {
		return t('quotaUnreachable');
	}
	if (actor === 'ip') {
		if (state.mode === 'direct') {
			return t('quotaModeDirect');
		}
		if (state.local.status === 'ready' && state.local.remaining <= 0) {
			return t('quotaExhausted');
		}
		return t('quotaStandby');
	}
	if (!state.proxyUsable) {
		return t('quotaLoginRequired');
	}
	return state.mode === 'proxy' ? t('quotaModeProxy') : t('quotaStandby');
}

function renderQuotaMeters(): void {
	if (!meterContainer) {
		return;
	}
	const state = getQuotaState();
	if (!localMeter) {
		localMeter = buildMeter('ip', () => setPreference('auto'));
		meterContainer.append(localMeter.root);
	}
	// 服务端未配置代币时不展示第二条额度条
	if (getConfig().proxyAvailable && !proxyMeter) {
		proxyMeter = buildMeter('user', () => setPreference('proxy'));
		meterContainer.append(proxyMeter.root);
	}
	updateMeter(localMeter, state.local, state.activeActor === 'ip', actorHint(state, 'ip'));
	if (proxyMeter) {
		updateMeter(proxyMeter, state.proxy, state.activeActor === 'user', actorHint(state, 'user'));
		proxyMeter.root.disabled = !state.proxyUsable;
		proxyMeter.root.setAttribute('aria-disabled', state.proxyUsable ? 'false' : 'true');
	}
	meterContainer.setAttribute('data-mode', state.mode);
}

function buildHeader(): void {
	const langSelect = document.getElementById('lang-select') as HTMLSelectElement | null;
	if (langSelect) {
		const current = getLang();
		for (const lang of SUPPORTED_LANGS) {
			langSelect.append(el('option', { value: lang.code }, [lang.label]));
		}
		langSelect.value = current;
		langSelect.addEventListener('change', () => {
			void setLang(langSelect.value);
		});
	}
	const themeBtn = document.getElementById('theme-toggle');
	themeBtn?.addEventListener('click', () => {
		const theme = toggleTheme();
		themeBtn.setAttribute('aria-label', theme === 'dark' ? t('themeToLight') : t('themeToDark'));
		themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
	});
	if (themeBtn) {
		const dark = document.documentElement.getAttribute('data-theme') === 'dark';
		themeBtn.textContent = dark ? '☀' : '☾';
	}
}

function buildFooter(): void {
	const note = document.getElementById('footer-note');
	if (note) {
		note.textContent = t('footerNote');
	}
	const version = document.getElementById('footer-version');
	if (version) {
		version.textContent = `PingAtlas · globalping.io · ${getConfig().apiUrl}`;
	}
	const credit = document.getElementById('footer-credit');
	if (credit) {
		credit.replaceChildren(...textWithLinks(t('footerCredit')));
	}
}

/** 处理登录回跳标记（?login=failed），并在提示后清理 URL */
function handleLoginFlag(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get('login') === 'failed') {
		toast(t('loginFailed'), 'error');
		params.delete('login');
		const query = params.toString();
		window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
	}
}

function registerServiceWorker(): void {
	if (!('serviceWorker' in navigator)) {
		return;
	}
	const register = (): void => {
		navigator.serviceWorker.register('/sw.js').catch(() => {
			// 注册失败（非安全上下文/隐私模式）不影响功能
		});
	};
	// main() 在调用到这里之前已 await 过网络请求，load 事件通常早已触发
	if (document.readyState === 'complete') {
		register();
		return;
	}
	window.addEventListener('load', register, { once: true });
}

async function main(): Promise<void> {
	initTheme();
	await initI18n();
	applyI18n();

	const config = await loadConfig();
	initQuota(config);
	buildHeader();
	buildFooter();
	handleLoginFlag();

	meterContainer = document.getElementById('quota-meters');
	onQuotaChange(renderQuotaMeters);
	// 每秒刷新重置倒计时
	window.setInterval(renderQuotaMeters, 1000);

	const resultsRoot = document.getElementById('results');
	if (resultsRoot) {
		initMeasureForm(resultsRoot);
	}

	const userArea = document.getElementById('user-area');
	// 先确定登录态，再订阅：避免用「未登录」的初始值多做一次无用的额度查询
	await loadAuthStatus();
	onAuthChange((status) => {
		if (userArea) {
			renderAuth(userArea, status);
		}
		// 登录态变化后刷新服务端代币额度并重算路由
		syncAuth();
	});

	registerServiceWorker();
}

void main();
