/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';
import { publicDir } from '../helpers/paths';

const css = readFileSync(`${publicDir}css/style.css`, 'utf8');

/** 折叠空白，便于对样式块做子串断言 */
function flat(source: string): string {
	return source.replace(/\s+/g, ' ').trim();
}

/** 从给定 `{` 下标开始，返回配对的花括号内部内容 */
function blockAt(index: number): string {
	let depth = 0;
	let start = -1;
	for (let i = index; i < css.length; i += 1) {
		const char = css[i];
		if (char === '{') {
			if (depth === 0)
				start = i + 1;
			depth += 1;
		}
		else if (char === '}') {
			depth -= 1;
			if (depth === 0)
				return css.slice(start, i);
		}
	}
	throw new Error('CSS 花括号不配对');
}

/** 取出指定 `@media` 查询的样式块（折叠空白） */
function mediaBlock(query: string): string {
	const index = css.indexOf(`@media ${query} {`);
	if (index < 0)
		throw new Error(`未找到 @media ${query}`);
	return flat(blockAt(css.indexOf('{', index)));
}

/** 取出不含空白的规则体（基础样式，不含媒体查询） */
const baseCss = css.slice(0, css.indexOf('@media'));

describe('响应式样式：窄屏表格', () => {
	const narrow = mediaBlock('(max-width: 620px)');

	it('主机名允许换行，避免撑出横向滚动', () => {
		expect(flat(baseCss)).toContain(
			'.data-table.hops td.hop-host { white-space: normal; overflow-wrap: anywhere; }',
		);
		expect(narrow).toContain('.data-table.hops td.hop-host { flex: 1 1 100%;');
	});

	it('数值列在窄屏保持单行取值', () => {
		expect(narrow).toContain('.data-table.hops td.hop-stat { display: flex;');
		expect(narrow).toContain('flex-direction: column;');
		expect(narrow).toContain('flex: 1 1 18%;');
	});

	it('窄屏用 data-label 代替表头，且表头对读屏仍可见', () => {
		expect(narrow).toContain('td[data-label]::before');
		expect(narrow).toContain('content: attr(data-label);');
		expect(narrow).toContain('.data-table thead { position: absolute;');
		expect(narrow).toContain('clip-path: inset(50%);');
	});

	it('DNS / HTTP 明细表在窄屏堆叠为属性值', () => {
		expect(narrow).toContain('.data-table.dns-answers td.dns-value');
		expect(narrow).toContain('.data-table.http-headers td.hdr-value');
		expect(narrow).toContain('.data-table.dns-answers td.dns-meta { display: inline-block;');
	});

	it('长内容不会撑破容器', () => {
		expect(narrow).toContain('.kv dd { overflow-wrap: anywhere; }');
		expect(narrow).toContain('.footer-meta { overflow-wrap: anywhere; }');
		expect(flat(baseCss)).toContain('.table-wrap { overflow-x: auto;');
	});

	it('窄屏放大触控目标', () => {
		expect(narrow).toContain('.btn { min-height: 42px; }');
		expect(narrow).toContain('.btn.small { min-height: 42px; }');
		expect(narrow).toContain('.icon-btn { width: 42px; height: 42px; }');
		expect(narrow).toContain('.select-sm { min-height: 42px; }');
		expect(narrow).toContain('.check { min-height: 42px; }');
		expect(narrow).toContain('.probe-list-link { min-height: 44px; }');
	});

	it('触屏设备（不限宽度）同样放大可点按区域', () => {
		const touch = mediaBlock('(hover: none) and (pointer: coarse)');
		expect(touch).toContain('.type-tab span');
		expect(touch).toContain('.btn.small');
		expect(touch).toContain('.icon-btn { width: 42px; height: 42px; }');
		expect(touch).toContain('min-height: 42px;');
	});
});

/**
 * 回归护栏：窄屏下顶栏与页脚必须保留纵向留白
 *
 * `.topbar-inner` 与 `.footer-inner` 同时带有 `container` 类。窄屏断点里那条
 * `.container` 规则若用简写 `padding`，因为它位于样式表末尾、特异性又和这两个
 * 选择器相同（都是单个类），会把它们的 padding-top / padding-bottom 一并清零，
 * 结果是顶栏与页脚的文字直接贴到上下边沿。只写横向（padding-inline）时，
 * 纵向留白由各自的规则决定。
 */
describe('窄屏：顶栏与页脚的纵向留白', () => {
	const narrow = mediaBlock('(max-width: 620px)');
	const containerRule = narrow.slice(narrow.indexOf('.container {'), narrow.indexOf('.container {') + 160);

	it('窄屏的 .container 只改横向间距，不用简写 padding', () => {
		expect(containerRule).toContain('padding-inline: 12px;');
		// 简写会连带清零 topbar-inner / footer-inner 的纵向内边距
		expect(containerRule).not.toMatch(/padding: 0 12px/);
	});

	it('两个共用 container 类的元素在基础样式里声明了纵向留白', () => {
		expect(flat(baseCss)).toContain('.topbar-inner {');
		expect(flat(baseCss)).toMatch(/\.topbar-inner \{[^}]*padding-top: 6px;[^}]*padding-bottom: 6px;/);
		expect(flat(baseCss)).toContain('.footer-inner {');
		expect(flat(baseCss)).toMatch(/\.footer-inner \{[^}]*padding-top: 10px;[^}]*padding-bottom: 10px;/);
	});

	it('窄屏放宽顶栏留白，容纳放大后的 42px 控件', () => {
		const topbar = narrow.slice(narrow.indexOf('.topbar-inner {'), narrow.indexOf('.topbar-inner {') + 220);
		expect(topbar).toContain('padding-block: 10px;');
	});

	it('页脚沿用基础样式的 10px，不在窄屏重复声明', () => {
		const footer = narrow.slice(narrow.indexOf('.footer-inner {'), narrow.indexOf('.footer-inner {') + 120);
		expect(footer).toContain('gap: 10px;');
		expect(footer).not.toContain('padding');
	});
});
