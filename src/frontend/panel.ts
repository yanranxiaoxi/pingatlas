import type { ResultTab } from './types';

/**
 * 右侧结果面板的标签页
 *
 * 只负责「哪个标签页可见」，不关心各标签页的内容；三个面板在 `index.html` 里已经
 * 就位，这里只切换 `hidden` 与 ARIA 状态，避免重建 DOM 丢失滚动位置与已渲染内容。
 */

/** 标签页 → 面板元素 id */
const PANEL_IDS: Record<ResultTab, string> = {
	probes: 'panel-probes',
	matched: 'panel-matched',
	results: 'results',
};

/**
 * 首次加载默认停留在「测试结果」
 *
 * 让结果最先可见，同时避免一进页面就为探针列表多拉 500 KB 数据；
 * 「Probes 列表」在用户真正切过去时才加载。
 */
const DEFAULT_TAB: ResultTab = 'results';

const listeners = new Set<(tab: ResultTab) => void>();

let activeTab: ResultTab = DEFAULT_TAB;

export function getActiveTab(): ResultTab {
	return activeTab;
}

/** 订阅标签页切换（只在真正变化时触发） */
export function onTabChange(listener: (tab: ResultTab) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function isResultTab(value: string | undefined): value is ResultTab {
	return value === 'probes' || value === 'matched' || value === 'results';
}

/**
 * 切到指定标签页
 *
 * 幂等：重复切到当前标签页不会通知订阅者，因此调用方可以放心地在每次筛选变化时
 * 调用它，而不用先判断当前状态。
 */
export function setActiveTab(tab: ResultTab): void {
	const changed = activeTab !== tab;
	activeTab = tab;
	for (const [kind, id] of Object.entries(PANEL_IDS) as Array<[ResultTab, string]>) {
		const pane = document.getElementById(id);
		if (pane) {
			pane.hidden = kind !== tab;
		}
	}
	const tabs = document.querySelectorAll<HTMLButtonElement>('#result-tabs .panel-tab');
	for (const button of tabs) {
		const isActive = button.dataset.tab === tab;
		button.classList.toggle('is-active', isActive);
		button.setAttribute('aria-selected', isActive ? 'true' : 'false');
		// 只有当前标签可 Tab 进入，其余用方向键切换（ARIA tabs 模式）
		button.tabIndex = isActive ? 0 : -1;
	}
	if (!changed) {
		return;
	}
	for (const listener of listeners) {
		listener(tab);
	}
}

/** 绑定标签栏交互（点击 + 左右方向键）；由 `main.ts` 在 DOM 就绪后调用 */
export function initPanelTabs(): void {
	const bar = document.getElementById('result-tabs');
	if (!bar) {
		return;
	}
	bar.addEventListener('click', (event) => {
		const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.panel-tab');
		const tab = button?.dataset.tab;
		if (isResultTab(tab)) {
			setActiveTab(tab);
		}
	});
	bar.addEventListener('keydown', (event) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
			return;
		}
		const order: ResultTab[] = ['probes', 'matched', 'results'];
		const current = order.indexOf(activeTab);
		const step = event.key === 'ArrowRight' ? 1 : -1;
		const next = order[(current + step + order.length) % order.length];
		event.preventDefault();
		setActiveTab(next);
		document.querySelector<HTMLButtonElement>(`#result-tabs .panel-tab[data-tab="${next}"]`)?.focus();
	});
	// 与 HTML 里的初始 aria-selected 对齐（默认「测试结果」）
	setActiveTab(activeTab);
}
