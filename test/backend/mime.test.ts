import { describe, expect, it } from '@jest/globals';
import { extOf, mimeType } from '../../src/utils/mime';

describe('mimeType', () => {
	it('返回已知扩展名的 Content-Type', () => {
		expect(mimeType('.html')).toBe('text/html; charset=utf-8');
		expect(mimeType('.js')).toBe('text/javascript; charset=utf-8');
		expect(mimeType('.css')).toBe('text/css; charset=utf-8');
		expect(mimeType('.json')).toBe('application/json; charset=utf-8');
		expect(mimeType('.webmanifest')).toBe('application/manifest+json; charset=utf-8');
		expect(mimeType('.svg')).toBe('image/svg+xml');
		expect(mimeType('.png')).toBe('image/png');
	});

	it('大小写不敏感', () => {
		expect(mimeType('.HTML')).toBe('text/html; charset=utf-8');
		expect(mimeType('.PnG')).toBe('image/png');
	});

	it('未知扩展名回退到 application/octet-stream', () => {
		expect(mimeType('.unknown')).toBe('application/octet-stream');
		expect(mimeType('')).toBe('application/octet-stream');
	});
});

describe('extOf', () => {
	it('提取最后一个点之后的扩展名并小写化', () => {
		expect(extOf('/assets/main-B4Q3LGM4.JS')).toBe('.js');
		expect(extOf('style.css')).toBe('.css');
	});

	it('没有点时返回空字符串', () => {
		expect(extOf('/api/v1/limits')).toBe('');
		expect(extOf('')).toBe('');
	});

	it('忽略查询串', () => {
		expect(extOf('/a/b.js?x=1')).toBe('.js');
	});

	it('点开头且无扩展名的文件名按“最后一段”处理', () => {
		expect(extOf('/.well-known')).toBe('.well-known');
	});

	it('多段扩展名只取最后一段', () => {
		expect(extOf('/archive.tar.gz')).toBe('.gz');
	});
});
