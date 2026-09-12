/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { publicDir } from '../helpers/paths';

/**
 * 探针列表标签页的接线与样式钉子
 *
 * 两侧（`index.html` 的面板/标签栏结构 + `style.css` 的样式）必须与
 * `panel.ts` / `probe-list.ts` 里的 id、class 约定一致，任何一处改名都会让
 * 标签页静默失效，因此在这里钉住。
 */

const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8');
const flatCss = css.replace(/\s+/g, ' ');

describe('结果面板标签页结构', () => {
	it('提供 tablist 与三个标签按钮，并声明 ARIA 关联', () => {
		expect(html).toContain('id="result-tabs"');
		expect(html).toContain('role="tablist"');

		for (const [tab, pane, label] of [
			['tab-probes', 'panel-probes', 'tabProbes'],
			['tab-matched', 'panel-matched', 'tabMatched'],
			['tab-results', 'results', 'tabResults'],
		]) {
			expect(html).toContain(`id="${tab}"`);
			expect(html).toContain(`aria-controls="${pane}"`);
			expect(html).toContain(`data-tab="${tab.replace('tab-', '')}"`);
			expect(html).toContain(`data-i18n="${label}"`);
		}
	});

	it('三个面板都带 role=tabpanel 且与标签相互引用', () => {
		for (const [pane, tab] of [
			['panel-probes', 'tab-probes'],
			['panel-matched', 'tab-matched'],
			['results', 'tab-results'],
		]) {
			expect(html).toContain(`id="${pane}"`);
			expect(html).toContain(`aria-labelledby="${tab}"`);
		}
		expect((html.match(/role="tabpanel"/g) ?? [])).toHaveLength(3);
	});

	it('默认选中「测试结果」，与 panel.ts 的默认值一致', () => {
		const resultsTab = html.slice(html.indexOf('id="tab-results"'));
		const button = resultsTab.slice(0, resultsTab.indexOf('>'));
		expect(button).toContain('aria-selected="true"');

		const probesTab = html.slice(html.indexOf('id="tab-probes"'));
		expect(probesTab.slice(0, probesTab.indexOf('>'))).toContain('aria-selected="false"');
	});

	it('两个探针面板初始为 hidden，测试结果面板可见', () => {
		const probes = html.slice(html.indexOf('id="panel-probes"'));
		expect(probes.slice(0, probes.indexOf('>'))).toContain('hidden');
		const matched = html.slice(html.indexOf('id="panel-matched"'));
		expect(matched.slice(0, matched.indexOf('>'))).toContain('hidden');
		const results = html.slice(html.indexOf('id="results"'));
		expect(results.slice(0, results.indexOf('>'))).not.toContain('hidden');
	});

	it('测试结果面板保留 aria-live，进度与结果仍会被读屏播报', () => {
		const results = html.slice(html.indexOf('id="results"'));
		expect(results.slice(0, results.indexOf('>'))).toContain('aria-live="polite"');
	});
});

describe('magic 输入框', () => {
	it('是 textarea，可以拖拽右下角调整高度', () => {
		expect(html).toContain('<textarea id="loc-magic"');
		expect(html).not.toContain('<input id="loc-magic"');
		expect(flatCss).toContain('.input-magic {');
		expect(flatCss).toContain('resize: vertical;');
	});

	it('占整行宽度，并给出上下限高度', () => {
		const label = html.slice(html.indexOf('for="loc-magic"'));
		expect(label.slice(0, 200)).toContain('data-i18n="locMagic"');
		const field = html.slice(html.lastIndexOf('<div class="field', html.indexOf('<textarea id="loc-magic"')));
		expect(field).toContain('field-wide');

		const block = flatCss.slice(flatCss.indexOf('.input-magic {'));
		expect(block.slice(0, 300)).toContain('min-height:');
		expect(block.slice(0, 300)).toContain('max-height:');
	});
});

describe('标签栏不是滚动容器', () => {
	/** 取出 `.panel-tabs` 规则体 */
	function tabsBlock(): string {
		const start = flatCss.indexOf('.panel-tabs {');
		expect(start).toBeGreaterThan(-1);
		return flatCss.slice(start, flatCss.indexOf('}', start));
	}

	/*
	 * 回归护栏：这里曾写作 overflow-x: auto（想横向滚动），但按 CSS 规范，
	 * 一个轴不是 visible 时另一个轴会被计算成 auto，于是 overflow-y 也变成 auto；
	 * 而 .panel-tab 的 margin-bottom: -1px 让内容比容器高 1px，多出的 1px 就渲染成
	 * 一条多余的纵向滚动条。三个标签文案很短，用换行即可，不需要任何滚动。
	 */
	it('不声明任何 overflow（否则另一轴会被计算成 auto）', () => {
		expect(tabsBlock()).not.toContain('overflow');
	});

	it('改为允许换行，窄屏下折行而不滚动', () => {
		expect(tabsBlock()).toContain('flex-wrap: wrap;');
	});

	it('标签的负外边距保留：用于让激活下划线压住容器下边框', () => {
		const tab = flatCss.slice(flatCss.indexOf('.panel-tab {'));
		expect(tab.slice(0, 300)).toContain('margin-bottom: -1px;');
	});
});

describe('探针列表样式', () => {
	it('面板切换依赖 hidden，必须显式声明 display:none', () => {
		expect(flatCss).toContain('.panel-pane[hidden] { display: none; }');
	});

	it('面板不做内部滚动：整页共用一条滚动条', () => {
		// 探针列表最多 160 行，限高会产生「整页 + 面板」双层滚动
		expect(flatCss).not.toContain('.probe-pane {');
		// 表单面板也不再是 sticky + max-height + overflow-y
		expect(flatCss).not.toContain('.form-panel {');
		const pane = flatCss.slice(flatCss.indexOf('.panel-pane[hidden] {'));
		expect(pane.slice(0, 300)).not.toContain('overflow-y');
	});

	it('结果区的原始输出高度由内容决定，只保留横向滚动', () => {
		const block = flatCss.slice(flatCss.indexOf('.raw-text {'));
		expect(block.slice(0, 200)).not.toContain('max-height:');
		expect(block.slice(0, 200)).toContain('overflow-x: auto;');
	});

	it('自动补全面板是浮层，仍保留自身高度上限', () => {
		// 它是 fixed 浮层、不在文档流里，不限高会伸展到视口之外
		const block = flatCss.slice(flatCss.indexOf('.suggest-panel {'));
		expect(block.slice(0, 200)).toContain('max-height:');
		expect(block.slice(0, 200)).toContain('overflow-y: auto;');
	});

	it('标签页按钮有可点击高度与激活态', () => {
		expect(flatCss).toContain('.panel-tab {');
		expect(flatCss).toContain('.panel-tab.is-active {');
		const block = flatCss.slice(flatCss.indexOf('.panel-tab {'));
		expect(block.slice(0, 300)).toContain('min-height:');
	});

	it('增删按钮与宽泛条件标记都有样式', () => {
		for (const selector of ['.probe-add', '.probe-remove', '.probe-broad', '.probe-tag', '.probe-summary', '.probe-summary-bottom', '.probe-state']) {
			expect(flatCss).toContain(`${selector} {`);
		}
	});

	it('触屏设备放大增删按钮的可点按区域', () => {
		const touch = flatCss.slice(flatCss.indexOf('@media (hover: none) and (pointer: coarse)'));
		expect(touch).toContain('.panel-tab');
	});
});
