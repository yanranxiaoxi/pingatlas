/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

type PanelModule = typeof import('../../src/frontend/panel');

/** 铺一套最小 DOM：标签栏 + 三个面板 */
function setupDom(): void {
	document.body.innerHTML = `
		<section class="panel result-panel">
			<div id="result-tabs" class="panel-tabs" role="tablist">
				<button id="tab-probes" class="panel-tab" type="button" role="tab" aria-selected="false" tabindex="-1" data-tab="probes">Probes</button>
				<button id="tab-matched" class="panel-tab" type="button" role="tab" aria-selected="false" tabindex="-1" data-tab="matched">Matched</button>
				<button id="tab-results" class="panel-tab" type="button" role="tab" aria-selected="true" data-tab="results">Results</button>
			</div>
			<div id="panel-probes" class="panel-pane" role="tabpanel" hidden></div>
			<div id="panel-matched" class="panel-pane" role="tabpanel" hidden></div>
			<div id="results" class="results panel-pane" role="tabpanel"></div>
		</section>`;
}

function pane(id: string): HTMLElement {
	return document.getElementById(id) as HTMLElement;
}

function tab(id: string): HTMLButtonElement {
	return document.getElementById(id) as HTMLButtonElement;
}

async function freshPanel(): Promise<PanelModule> {
	return import('../../src/frontend/panel');
}

beforeEach(() => {
	jest.resetModules();
	setupDom();
});

afterEach(() => {
	document.body.replaceChildren();
});

describe('面板标签页', () => {
	it('默认停留在「测试结果」', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();

		expect(panel.getActiveTab()).toBe('results');
		expect(pane('results').hidden).toBe(false);
		expect(pane('panel-probes').hidden).toBe(true);
		expect(pane('panel-matched').hidden).toBe(true);
	});

	it('切换后只显示对应面板，并同步 aria-selected 与 tabindex', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();
		panel.setActiveTab('probes');

		expect(pane('panel-probes').hidden).toBe(false);
		expect(pane('panel-matched').hidden).toBe(true);
		expect(pane('results').hidden).toBe(true);
		expect(tab('tab-probes').getAttribute('aria-selected')).toBe('true');
		expect(tab('tab-probes').classList.contains('is-active')).toBe(true);
		expect(tab('tab-probes').tabIndex).toBe(0);
		expect(tab('tab-results').getAttribute('aria-selected')).toBe('false');
		expect(tab('tab-results').tabIndex).toBe(-1);
	});

	it('点击标签栏可切换', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();

		tab('tab-matched').click();

		expect(panel.getActiveTab()).toBe('matched');
		expect(pane('panel-matched').hidden).toBe(false);
	});

	it('点击非标签区域不改变状态', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();

		document.getElementById('result-tabs')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(panel.getActiveTab()).toBe('results');
	});

	it('方向键在当前标签间循环，并移动焦点', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();
		// 方向键是「从当前激活标签出发」，先把激活标签设为第一个
		panel.setActiveTab('probes');
		tab('tab-probes').focus();

		tab('tab-probes').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		expect(panel.getActiveTab()).toBe('matched');

		tab('tab-matched').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		expect(panel.getActiveTab()).toBe('probes');

		// 从第一个往左回到最后一个
		tab('tab-probes').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		expect(panel.getActiveTab()).toBe('results');

		expect(document.activeElement).toBe(tab('tab-results'));
	});

	it('方向键从默认标签（测试结果）出发时回绕到第一个', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();

		tab('tab-results').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

		expect(panel.getActiveTab()).toBe('probes');
	});

	it('其他按键不处理', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();

		tab('tab-results').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));

		expect(panel.getActiveTab()).toBe('results');
	});

	it('onTabChange 只在真正变化时通知', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();
		const seen: string[] = [];
		panel.onTabChange(value => seen.push(value));

		// 重复切到当前标签页不通知
		panel.setActiveTab('results');
		expect(seen).toEqual([]);

		panel.setActiveTab('probes');
		panel.setActiveTab('matched');
		expect(seen).toEqual(['probes', 'matched']);
	});

	it('onTabChange 返回的取消函数可解绑', async () => {
		const panel = await freshPanel();
		panel.initPanelTabs();
		const seen: string[] = [];
		const off = panel.onTabChange(value => seen.push(value));

		panel.setActiveTab('probes');
		off();
		panel.setActiveTab('matched');

		expect(seen).toEqual(['probes']);
	});

	it('缺少标签栏时初始化不报错', async () => {
		document.body.replaceChildren();
		const panel = await freshPanel();

		expect(() => panel.initPanelTabs()).not.toThrow();
		expect(() => panel.setActiveTab('probes')).not.toThrow();
	});
});
