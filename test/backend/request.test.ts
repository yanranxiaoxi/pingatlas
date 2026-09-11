import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, expect, it } from '@jest/globals';
import {
	exceedsContentLength,
	fieldString,
	MAX_JSON_BODY,
	pickFile,
	readJsonBody,
	UPSTREAM_TIMEOUT,
	upstreamFetchTimeout,
	writeUpstreamResponse,
} from '../../src/utils/request';
import { createMockResponse } from '../helpers/http';

function mockRequest(chunks: (string | Buffer)[], headers: Record<string, string> = {}): IncomingMessage {
	const req = Readable.from(chunks.map(chunk => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))) as unknown as IncomingMessage;
	req.headers = headers;
	return req;
}

describe('exceedsContentLength', () => {
	it('没有 Content-Length 时不超限', () => {
		expect(exceedsContentLength(mockRequest([]))).toBe(false);
	});

	it('超过上限时返回 true', () => {
		expect(exceedsContentLength(mockRequest([], { 'content-length': '11' }), 10)).toBe(true);
	});

	it('等于上限时不超限', () => {
		expect(exceedsContentLength(mockRequest([], { 'content-length': '10' }), 10)).toBe(false);
	});

	it('非数字值不超限（交给后续解析处理）', () => {
		expect(exceedsContentLength(mockRequest([], { 'content-length': 'abc' }), 10)).toBe(false);
		expect(exceedsContentLength(mockRequest([], { 'content-length': 'Infinity' }), 10)).toBe(false);
	});

	it('负数不超限', () => {
		expect(exceedsContentLength(mockRequest([], { 'content-length': '-1' }), 10)).toBe(false);
	});

	it('默认上限为 2 MiB', () => {
		expect(MAX_JSON_BODY).toBe(2 * 1024 * 1024);
	});
});

describe('readJsonBody', () => {
	it('解析 JSON 请求体', async () => {
		await expect(readJsonBody(mockRequest(['{"type":"ping"}']))).resolves.toEqual({ type: 'ping' });
	});

	it('空 body 返回空对象', async () => {
		await expect(readJsonBody(mockRequest([]))).resolves.toEqual({});
		await expect(readJsonBody(mockRequest(['   ']))).resolves.toEqual({});
	});

	it('非法 JSON 抛错', async () => {
		await expect(readJsonBody(mockRequest(['{oops']))).rejects.toBeInstanceOf(SyntaxError);
	});

	it('多分片拼接后解析', async () => {
		await expect(readJsonBody(mockRequest(['{"a":', '1', '}']))).resolves.toEqual({ a: 1 });
	});

	it('非 Buffer 分片（objectMode 流）同样能解析', async () => {
		// Node 的字节流永远给出 Buffer，这里用 objectMode 流模拟第三方驱动直接推字符串的场景
		const req = new Readable({ objectMode: true, read() {} }) as unknown as IncomingMessage;
		req.headers = {};
		req.push('{"a":');
		req.push('1}');
		req.push(null);

		await expect(readJsonBody(req)).resolves.toEqual({ a: 1 });
	});

	it('超过上限时抛错', async () => {
		const req = mockRequest([Buffer.alloc(MAX_JSON_BODY + 1, 0x61)]);
		await expect(readJsonBody(req)).rejects.toThrow('Request body too large');
	});
});

describe('upstreamFetchTimeout', () => {
	it('返回 AbortSignal 且每次都是新实例', () => {
		const first = upstreamFetchTimeout();
		const second = upstreamFetchTimeout();
		expect(first).toBeInstanceOf(AbortSignal);
		expect(first).not.toBe(second);
		expect(first.aborted).toBe(false);
	});

	it('超时为 30 秒', () => {
		expect(UPSTREAM_TIMEOUT).toBe(30_000);
	});
});

describe('fieldString', () => {
	it('字段缺失时返回默认值', () => {
		expect(fieldString(undefined, 'a')).toBe('');
		expect(fieldString({}, 'a', 'fallback')).toBe('fallback');
	});

	it('null 视为缺失', () => {
		expect(fieldString({ a: null }, 'a', 'fallback')).toBe('fallback');
	});

	it('数组取第一个元素', () => {
		expect(fieldString({ a: ['x', 'y'] }, 'a')).toBe('x');
	});

	it('空数组返回默认值', () => {
		expect(fieldString({ a: [] }, 'a', 'fallback')).toBe('fallback');
	});

	it('数字与布尔值转字符串', () => {
		expect(fieldString({ a: 5 }, 'a')).toBe('5');
		expect(fieldString({ a: 0 }, 'a')).toBe('0');
		expect(fieldString({ a: false }, 'a')).toBe('false');
	});

	it('空字符串保持空字符串（不回落默认值）', () => {
		expect(fieldString({ a: '' }, 'a', 'fallback')).toBe('');
	});
});

describe('pickFile', () => {
	it('无文件时返回 null', () => {
		expect(pickFile(undefined)).toBeNull();
		expect(pickFile({})).toBeNull();
	});

	it('提取文件信息', () => {
		expect(pickFile({ file: { filepath: '/tmp/a', originalFilename: 'a.txt', size: 3 } }))
			.toEqual({ filepath: '/tmp/a', originalFilename: 'a.txt', size: 3 });
	});

	it('数组取第一个', () => {
		expect(pickFile({ file: [{ filepath: '/tmp/a' }] })).toEqual({ filepath: '/tmp/a', originalFilename: null, size: 0 });
	});

	it('空数组返回 null', () => {
		expect(pickFile({ file: [] })).toBeNull();
	});

	it('缺少 filepath 时返回 null', () => {
		expect(pickFile({ file: { originalFilename: 'a.txt' } })).toBeNull();
	});

	it('非对象文件描述返回 null', () => {
		expect(pickFile({ file: 'nope' })).toBeNull();
	});
});

describe('writeUpstreamResponse', () => {
	it('透传状态码、Content-Type 与 body', () => {
		const res = createMockResponse();
		writeUpstreamResponse(res as unknown as ServerResponse, 429, '{"error":{}}', 'application/problem+json');

		expect(res.statusCode).toBe(429);
		expect(res.getHeader('content-type')).toBe('application/problem+json');
		expect(res.body).toBe('{"error":{}}');
	});

	it('上游没有 Content-Type 时回退 JSON', () => {
		const res = createMockResponse();
		writeUpstreamResponse(res as unknown as ServerResponse, 200, '{}', null);
		expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
	});

	it('写入后 headersSent 为 true', () => {
		const res = createMockResponse();
		writeUpstreamResponse(res as unknown as ServerResponse, 200, '{}', null);
		expect(res.headersSent).toBe(true);
	});
});

describe('parseMultipart', () => {
	it('解析表单字段与上传文件', async () => {
		const boundary = '----paBoundary';
		const body = [
			`--${boundary}`,
			'Content-Disposition: form-data; name="name"',
			'',
			'alice',
			`--${boundary}`,
			'Content-Disposition: form-data; name="file"; filename="hello.txt"',
			'Content-Type: text/plain',
			'',
			'hello world',
			`--${boundary}--`,
			'',
		].join('\r\n');
		const payload = Buffer.from(body);
		const req = mockRequest([payload], {
			'content-type': `multipart/form-data; boundary=${boundary}`,
			'content-length': String(payload.byteLength),
		});

		const { parseMultipart } = await import('../../src/utils/request');
		const result = await parseMultipart(req);

		expect(fieldString(result.fields as Record<string, unknown>, 'name')).toBe('alice');
		const file = pickFile(result.files as Record<string, unknown>);
		expect(file?.originalFilename).toBe('hello.txt');
		expect(file?.size).toBe('hello world'.length);
		expect(readFileSync(file!.filepath, 'utf8')).toBe('hello world');
		rmSync(file!.filepath, { force: true });
	});

	it('Content-Length 为 0 时返回空字段与空文件', async () => {
		const req = mockRequest([], {
			'content-type': 'multipart/form-data; boundary=x',
			'content-length': '0',
		});
		const { parseMultipart } = await import('../../src/utils/request');
		const result = await parseMultipart(req);
		expect(result.fields).toEqual({});
		expect(result.files).toEqual({});
	});

	it('畸形 multipart 请求会被拒绝', async () => {
		const payload = Buffer.from('not a multipart body');
		const req = mockRequest([payload], {
			'content-type': 'multipart/form-data; boundary=x',
			'content-length': String(payload.byteLength),
		});
		const { parseMultipart } = await import('../../src/utils/request');
		await expect(parseMultipart(req)).rejects.toBeDefined();
	});
});
