/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { textWithLinks } from '../../src/frontend/ui';
import { projectRoot, publicDir } from '../helpers/paths';

const EXPECTED_LINKS: Array<{ label: string; href: string }> = [
	{ label: '小汐', href: 'https://soraharu.com/' },
	{ label: 'Leader User', href: 'https://globalping.io/leaderboard' },
	{ label: '探针节点', href: 'https://globalping.io/users/yanranxiaoxi' },
];

function locale(name: string): Record<string, string> {
	return JSON.parse(readFileSync(join(publicDir, 'locales', name), 'utf8')) as Record<string, string>;
}

/** 渲染后的锚点（标签 + href） */
function anchorsOf(source: string): Array<{ label: string; href: string }> {
	return textWithLinks(source)
		.filter((node): node is HTMLAnchorElement => typeof node !== 'string')
		.map(node => ({ label: node.textContent ?? '', href: node.getAttribute('href') ?? '' }));
}

const zh = locale('zh-Hans.json');
const en = locale('en.json');

describe('页脚署名', () => {
	it('中英文都提供署名文案', () => {
		expect(typeof zh.footerCredit).toBe('string');
		expect(typeof en.footerCredit).toBe('string');
	});

	it('中文文案与约定字面一致', () => {
		expect(zh.footerCredit).toBe(
			'[小汐](https://soraharu.com/) 为 Globalping 的 [Leader User](https://globalping.io/leaderboard)，持续为项目贡献 [探针节点](https://globalping.io/users/yanranxiaoxi)。',
		);
	});

	it('渲染出三个外链，指向站主主页、Leader 榜与探针账号', () => {
		expect(anchorsOf(zh.footerCredit)).toEqual(EXPECTED_LINKS);
		expect(anchorsOf(en.footerCredit).map(link => link.href)).toEqual(EXPECTED_LINKS.map(link => link.href));
	});

	it('链接带 target=_blank 与 noopener noreferrer', () => {
		const nodes = textWithLinks(zh.footerCredit).filter(
			(node): node is HTMLAnchorElement => typeof node !== 'string',
		);
		expect(nodes).toHaveLength(3);
		for (const node of nodes) {
			expect(node.getAttribute('target')).toBe('_blank');
			expect(node.getAttribute('rel')).toBe('noopener noreferrer');
		}
	});

	it('除链接外的文字被保留，不残留 Markdown 语法', () => {
		const text = textWithLinks(zh.footerCredit)
			.filter((node): node is string => typeof node === 'string')
			.join('');
		expect(text).toBe(' 为 Globalping 的 ，持续为项目贡献 。');
		expect(text).not.toContain('](');
	});

	it('英文文案同样不残留 Markdown 语法', () => {
		const text = textWithLinks(en.footerCredit)
			.filter((node): node is string => typeof node === 'string')
			.join('');
		expect(text).toContain('Globalping');
		expect(text).not.toContain('](');
	});
});

describe('页脚署名接线', () => {
	const html = readFileSync(join(publicDir, 'index.html'), 'utf8');

	it('index.html 在页脚右侧提供挂载点', () => {
		expect(html).toContain('<p id="footer-credit" class="footer-credit"></p>');
		const meta = html.slice(html.indexOf('class="footer-meta"'), html.indexOf('</footer>'));
		expect(meta).toContain('id="footer-note"');
		expect(meta).toContain('id="footer-version"');
		expect(meta).toContain('id="footer-credit"');
		// 署名紧跟说明，版本号排在最后一行
		expect(meta.indexOf('id="footer-credit"')).toBeGreaterThan(meta.indexOf('id="footer-note"'));
		expect(meta.indexOf('id="footer-credit"')).toBeLessThan(meta.indexOf('id="footer-version"'));
	});

	it('main.ts 用 textWithLinks 渲染署名（不使用 innerHTML）', () => {
		const main = readFileSync(join(projectRoot, 'src', 'frontend', 'main.ts'), 'utf8');
		expect(main).toContain('getElementById(\'footer-credit\')');
		expect(main).toContain('replaceChildren(...textWithLinks(t(\'footerCredit\')))');
		expect(main).not.toContain('innerHTML');
	});

	it('样式表为署名与其中链接提供规则', () => {
		const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8').replace(/\s+/g, ' ');
		expect(css).toContain('.footer-credit {');
		expect(css).toContain('.footer-credit a {');
		expect(css).toContain('.footer-credit a:hover {');
		expect(css).toContain('overflow-wrap: anywhere;');
	});
});
