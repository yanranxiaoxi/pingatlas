import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';

/** JSON 请求体最大字节数（超限拒绝，防内存 DoS） */
export const MAX_JSON_BODY = 2 * 1024 * 1024;
/** 上游代理请求超时（毫秒） */
export const UPSTREAM_TIMEOUT = 30 * 1000;

/**
 * 校验请求 Content-Length 是否超过上限；超限返回 true
 */
export function exceedsContentLength(req: IncomingMessage, max = MAX_JSON_BODY): boolean {
	const declared = Number(req.headers['content-length']);
	return Number.isFinite(declared) && declared > max;
}

/**
 * 读取 JSON 请求体（带大小上限）
 * @param req - 请求对象
 * @returns 解析后的对象，空 body 返回 {}
 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > MAX_JSON_BODY) {
			throw new Error('Request body too large');
		}
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString('utf8').trim();
	if (!raw) {
		return {};
	}
	return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * 返回带超时且异常时不抛的 fetch 控制器
 */
export function upstreamFetchTimeout(): AbortSignal {
	return AbortSignal.timeout(UPSTREAM_TIMEOUT);
}

/**
 * 解析 multipart/form-data 请求（formidable）
 */
export async function parseMultipart(req: IncomingMessage): Promise<Record<string, unknown>> {
	const { default: formidable } = await import('formidable');
	const form = formidable({
		multiples: false,
		maxFileSize: 20 * 1024 * 1024,
		maxFields: 20,
	});
	return await new Promise((resolve, reject) => {
		form.parse(req, (err, fields, files) => {
			if (err) {
				reject(err);
				return;
			}
			resolve({ fields, files });
		});
	});
}

/**
 * 从 formidable 解析结果中提取字符串字段（兼容 string | string[]）
 */
export function fieldString(fields: Record<string, unknown> | undefined, name: string, defaultValue = ''): string {
	const value = fields?.[name];
	if (value === undefined || value === null) {
		return defaultValue;
	}
	if (Array.isArray(value)) {
		return value.length ? String(value[0]) : defaultValue;
	}
	return String(value);
}

/**
 * 从 formidable 解析结果中提取上传的文件
 */
export function pickFile(files: Record<string, unknown> | undefined): { filepath: string; originalFilename: string | null; size: number } | null {
	const value = files?.file;
	if (!value) {
		return null;
	}
	const file = Array.isArray(value) ? value[0] : value;
	if (!file || typeof file !== 'object') {
		return null;
	}
	const f = file as { filepath?: string; originalFilename?: string | null; size?: number };
	if (!f.filepath) {
		return null;
	}
	return {
		filepath: f.filepath,
		originalFilename: f.originalFilename ?? null,
		size: f.size ?? 0,
	};
}

/**
 * 透传上游响应：复制状态码、Content-Type 与 body
 * @param res - 下游响应
 * @param status - 上游状态码
 * @param body - 上游响应体
 * @param upstreamContentType - 上游 Content-Type
 */
export function writeUpstreamResponse(
	res: ServerResponse,
	status: number,
	body: string,
	upstreamContentType: string | null,
): void {
	res.statusCode = status;
	res.setHeader('Content-Type', upstreamContentType || 'application/json; charset=utf-8');
	res.write(body);
}
