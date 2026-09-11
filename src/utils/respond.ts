import type { SessionUser } from './session';
import type { IResponse } from './venation/transport';
import { CONFIG } from '../config/config';
import { serializeCookie } from './cookie';

/**
 * 写 JSON 响应（由驱动在路由执行完后统一 end）
 */
export function sendJson(res: IResponse, status: number, data: unknown): void {
	if (!res.headersSent) {
		res.setHeader('Content-Type', 'application/json; charset=utf-8');
	}
	res.statusCode = status;
	res.write(JSON.stringify(data));
}

export interface CookieOptions {
	maxAge?: number;
	secure?: boolean;
}

/**
 * 判断生产环境（Secure Cookie 依据）
 *
 * 语义：ENV_PRODUCT 为 true/1/production 或 CONFIG.env === 'production' 视为生产。
 */
export function isSecure(): boolean {
	return CONFIG.envProduct === 'true' || CONFIG.envProduct === '1' || CONFIG.envProduct === 'production' || CONFIG.env === 'production';
}

/**
 * 清除 Cookie（属性与 setCookie 保持一致，确保能覆盖删除）
 */
export function clearCookie(res: IResponse, name: string): void {
	res.addHeader(
		'Set-Cookie',
		serializeCookie(name, '', {
			path: '/',
			maxAge: 0,
			httpOnly: true,
			sameSite: 'Lax',
			secure: isSecure(),
		}),
	);
}

/**
 * 写入会话 Cookie
 */
export function setCookie(res: IResponse, name: string, value: string, options: CookieOptions = {}): void {
	res.addHeader(
		'Set-Cookie',
		serializeCookie(name, value, {
			path: '/',
			maxAge: options.maxAge,
			httpOnly: true,
			sameSite: 'Lax',
			secure: options.secure ?? isSecure(),
		}),
	);
}

/**
 * 302 跳转
 */
export function redirect(res: IResponse, location: string): void {
	res.statusCode = 302;
	res.setHeader('Location', location);
}

/**
 * 从 ctx.user 获取会话用户（避免 unknown 类型问题）
 */
export function getSessionUser(user: unknown): SessionUser | null {
	if (user && typeof user === 'object') {
		const u = user as Partial<SessionUser>;
		if (typeof u.sub === 'string' && typeof u.username === 'string') {
			return { sub: u.sub, username: u.username };
		}
	}
	return null;
}
