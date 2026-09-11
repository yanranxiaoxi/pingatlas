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

	it('额度条不再使用整句形式的说明文案', () => {
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
