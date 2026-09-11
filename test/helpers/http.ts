import type { IncomingMessage } from 'node:http';
import type { IContext } from '../../src/utils/interface';
import type { IResponse } from '../../src/utils/venation/transport';
import { Readable } from 'node:stream';

/** 记录写入内容的假响应对象（鸭子类型等价于 IResponse） */
export interface MockResponse {
	statusCode: number;
	headersSent: boolean;
	writableEnded: boolean;
	destroyed: boolean;
	headers: Map<string, string | string[]>;
	body: string;
	setHeader: (name: string, value: string | string[]) => void;
	addHeader: (name: string, value: string) => void;
	getHeader: (name: string) => string | string[] | undefined;
	write: (chunk: unknown) => void;
	end: (chunk?: unknown) => void;
	destroy: () => void;
}

/**
 * 创建假响应对象
 *
 * 行为要点与 Node ServerResponse 保持一致：
 * - 首次 `write()` 后 `headersSent` 变为 true（`Venation` 依赖它判断收尾）
 * - `end()` 后 `writableEnded` 变为 true
 */
export function createMockResponse(): MockResponse {
	const response: MockResponse = {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		destroyed: false,
		headers: new Map(),
		body: '',
		setHeader(name, value) {
			response.headers.set(name.toLowerCase(), value);
		},
		addHeader(name, value) {
			const key = name.toLowerCase();
			const existing = response.headers.get(key);
			if (existing === undefined) {
				response.headers.set(key, value);
				return;
			}
			const list = Array.isArray(existing) ? existing : [existing];
			list.push(value);
			response.headers.set(key, list);
		},
		getHeader(name) {
			return response.headers.get(name.toLowerCase());
		},
		write(chunk) {
			response.headersSent = true;
			if (chunk !== undefined && chunk !== null) {
				response.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
			}
		},
		end(chunk) {
			response.headersSent = true;
			if (chunk !== undefined && chunk !== null) {
				response.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
			}
			response.writableEnded = true;
		},
		destroy() {
			response.destroyed = true;
		},
	};
	return response;
}

export interface MockRequestOptions {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	/** 请求体原文（会作为单个 chunk 流入异步迭代器） */
	body?: string;
}

/** 创建假请求对象：可异步迭代（供 readJsonBody 使用）+ 带 headers */
export function createMockRequest(options: MockRequestOptions = {}): IncomingMessage {
	const chunks = options.body === undefined || options.body === '' ? [] : [Buffer.from(options.body, 'utf8')];
	const stream = Readable.from(chunks) as unknown as IncomingMessage;
	stream.url = options.url ?? '/';
	stream.method = options.method ?? 'GET';
	stream.headers = { ...(options.headers ?? {}) };
	return stream;
}

export interface MockLogger {
	child: () => MockLogger;
	debug: () => void;
	error: () => void;
	info: () => void;
	warn: () => void;
}

/** 静默 logger（避免测试输出与 logs/ 目录写入） */
export function createMockLogger(): MockLogger {
	const logger: MockLogger = {
		child: () => logger,
		debug: () => {},
		error: () => {},
		info: () => {},
		warn: () => {},
	};
	return logger;
}

/** 组装控制器所需的 ctx */
export function createMockContext(options: MockRequestOptions & {
	routerParams?: Record<string, unknown>;
	user?: unknown;
} = {}) {
	const res = createMockResponse();
	const ctx = {
		req: createMockRequest(options),
		res: res as unknown as IResponse,
		method: options.method ?? 'GET',
		requestParams: {},
		requestFiles: {},
		getQuery: new URLSearchParams((options.url ?? '/').split('?')[1] ?? ''),
		routerParams: options.routerParams ?? {},
		logger: createMockLogger() as never,
		body: undefined,
		user: options.user ?? null,
		code: 0,
	} satisfies IContext;
	return { ctx, res };
}
