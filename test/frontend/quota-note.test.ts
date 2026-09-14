/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { publicDir } from '../helpers/paths';

const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8').replace(/\s+/g, ' ');

function locale(name: string): Record<string, string> {
	return JSON.parse(readFileSync(join(publicDir, 'locales', name), 'utf8')) as Record<string, string>;
}

const zh = locale('zh-Hans.json');
const en = locale('en.json');

describe('额度条副标题排版', () => {
	it('副标题是允许换行的 flex 容器', () => {
		expect(css).toContain('.quota-meter-note { display: flex; flex-wrap: wrap; align-items: baseline;');
	});

	it('片段之间留出明确间距，避免相邻文案连成一片', () => {
		// 水平间距要明显大于行间距，换行后仍能看出片段边界
		expect(css).toContain('.quota-meter-note { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px;');
	});

	it('不靠伪元素标点分隔，避免行首行尾出现孤立符号', () => {
		expect(css).not.toContain('.quota-meter-note > span:not(:last-child)::after');
		expect(css).not.toContain('.quota-meter-note > span + span::before');
	});

	it('数字片段保持等宽数字，倒计时跳动不抖动', () => {
		expect(css).toContain('.quota-meter-reset, .quota-meter-credits { font-variant-numeric: tabular-nums; }');
	});
});

/**
 * 小屏并列布局
 *
 * 两条额度条平分一行。页脚是 sticky 的，它们占的高度直接从内容区里扣，
 * 因此不能让每条各占一整行。
 */
describe('额度条小屏并列', () => {
	/** 取出 `@media (max-width: 620px)` 的规则体（已折叠空白） */
	function narrowBlock(): string {
		const at = css.indexOf('@media (max-width: 620px) {');
		expect(at).toBeGreaterThan(-1);
		let depth = 0;
		let start = -1;
		for (let i = css.indexOf('{', at); i < css.length; i += 1) {
			if (css[i] === '{') {
				if (depth === 0)
					start = i + 1;
				depth += 1;
			}
			else if (css[i] === '}') {
				depth -= 1;
				if (depth === 0)
					return css.slice(start, i);
			}
		}
		throw new Error('样式表花括号不配对');
	}

	it('额度条平分一行，而不是各自占满宽度', () => {
		const narrow = narrowBlock();

		expect(narrow).toContain('.quota-meter { flex: 1 1 0;');
		// 简写 width 会覆盖 flex-basis，必须显式写回 auto
		expect(narrow).toContain('width: auto;');
		// 每条占满整行的写法会让两条各占一行
		expect(narrow).not.toMatch(/\.quota-meter, \.quota-meters \{ width: 100%; \}/);
	});

	it('容器占满宽度，两条才能正好铺满一行', () => {
		// 容器若收缩到内容宽度，两条的一半就只有半个页脚宽
		expect(narrowBlock()).toContain('.quota-meters { width: 100%;');
	});

	it('允许收缩到内容宽度以下，否则长标签会把宽度顶开又变回两行', () => {
		// flex 项默认最小尺寸是 min-content，英文标签更长，必须显式归零
		expect(narrowBlock()).toContain('min-width: 0;');
	});

	it('窄列里表头允许换行，避免把标签从词中间挤断', () => {
		expect(narrowBlock()).toContain('.quota-meter-head { flex-wrap: wrap;');
	});

	it('缩小内边距，把宽度让给文案与进度条', () => {
		expect(narrowBlock()).toContain('padding: 7px 8px;');
	});
});

describe('额度条副标题文案', () => {
	const keys = ['quotaModeDirect', 'quotaModeProxy'];

	it('中英文都提供模式标签', () => {
		for (const key of keys) {
			expect(typeof zh[key]).toBe('string');
			expect(typeof en[key]).toBe('string');
		}
	});

	it('模式标签是简短短语，不带句末标点', () => {
		for (const key of keys) {
			expect(zh[key].length).toBeLessThanOrEqual(16);
			expect(en[key].length).toBeLessThanOrEqual(28);
			expect(zh[key]).not.toMatch(/[。.!?！？]$/);
			expect(en[key]).not.toMatch(/[.!?]$/);
		}
	});

	it('额度条使用简短模式标签，而不是整句说明', () => {
		expect(zh.quotaModeDirect).not.toBe(zh.viaDirect);
		expect(en.quotaModeDirect).not.toBe(en.viaDirect);
		expect(zh.quotaModeProxy).not.toBe(zh.viaProxy);
		expect(en.quotaModeProxy).not.toBe(en.viaProxy);
	});

	it('重置与生效文案同样是不带标点的短语', () => {
		for (const key of ['quotaResetIn', 'quotaResetHint', 'quotaActive', 'quotaStandby', 'quotaExhausted', 'quotaCredits']) {
			expect(zh[key]).not.toMatch(/[。.!?！？]$/);
			expect(en[key]).not.toMatch(/[.!?]$/);
		}
	});
});
