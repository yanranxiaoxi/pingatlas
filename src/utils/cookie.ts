export interface CookieSerializeOptions {
	/** 有效期（秒），不传则仅本次会话 */
	maxAge?: number;
	path?: string;
	domain?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: 'Lax' | 'Strict' | 'None';
}

/**
 * 解析 Cookie 请求头
 * @param header - Cookie 头原始值
 * @returns name → value 映射（已解码）
 */
export function parseCookies(header: string | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!header) {
		return result;
	}
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index < 0) {
			continue;
		}
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name) {
			try {
				result[name] = decodeURIComponent(value);
			}
			catch {
				// 畸形百分号编码（如 %zz、孤立 %）：跳过该 cookie，避免整个请求 500
			}
		}
	}
	return result;
}

/**
 * 序列化 Set-Cookie 值
 */
export function serializeCookie(name: string, value: string, options: CookieSerializeOptions = {}): string {
	const parts = [`${name}=${encodeURIComponent(value)}`];
	if (options.maxAge !== undefined) {
		parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
	}
	if (options.path !== undefined) {
		parts.push(`Path=${options.path}`);
	}
	if (options.domain !== undefined) {
		parts.push(`Domain=${options.domain}`);
	}
	if (options.secure) {
		parts.push('Secure');
	}
	if (options.httpOnly) {
		parts.push('HttpOnly');
	}
	if (options.sameSite) {
		parts.push(`SameSite=${options.sameSite}`);
	}
	return parts.join('; ');
}
