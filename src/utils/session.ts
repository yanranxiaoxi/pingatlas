import { jwtVerify, SignJWT } from 'jose';
import { CONFIG } from '../config/config';

export interface SessionUser {
	/** 用户在 IdP 的唯一标识（sub） */
	sub: string;
	/** 用户名（preferred_username） */
	username: string;
}

export interface SessionPayload extends SessionUser {
	/** 签发时间（秒） */
	iat?: number;
	/** 过期时间（秒） */
	exp?: number;
}

const encoder = new TextEncoder();

/**
 * 会话是否可用
 *
 * `SESSION_SECRET` 在配置加载时已强制校验（必填且不少于 32 字节），
 * 因此服务启动后本判断恒为真；保留它是为了让签发/校验路径在配置被
 * 绕过时仍然 fail closed。
 */
export function sessionEnabled(): boolean {
	return CONFIG.session.secret.length > 0;
}

/**
 * 签发会话 JWT（无状态，HMAC-SHA256 签名）
 * @param user - 会话用户
 * @param ttlSeconds - 有效期（秒）
 * @returns 签发的 JWT 字符串
 */
export async function signSession(user: SessionUser, ttlSeconds = CONFIG.session.ttl): Promise<string> {
	if (!sessionEnabled()) {
		throw new Error('SESSION_SECRET is not configured');
	}
	return await new SignJWT({ username: user.username })
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(user.sub)
		.setIssuedAt()
		.setExpirationTime(`${ttlSeconds}s`)
		.sign(encoder.encode(CONFIG.session.secret));
}

/**
 * 校验并解析会话 JWT
 * @param token - JWT 字符串
 * @returns 会话用户，无效或过期返回 null
 */
export async function verifySession(token: string): Promise<SessionUser | null> {
	if (!sessionEnabled() || !token) {
		return null;
	}
	try {
		const { payload } = await jwtVerify(token, encoder.encode(CONFIG.session.secret), {
			algorithms: ['HS256'],
		});
		const sub = payload.sub;
		const username = payload.username as string | undefined;
		if (!sub || typeof username !== 'string') {
			return null;
		}
		return { sub, username };
	}
	catch {
		return null;
	}
}

/**
 * 签发短期一次性 JWT（用于 OIDC state/nonce/code_verifier 暂存）
 * @param data - 附加数据
 * @param ttlSeconds - 有效期（秒）
 * @returns JWT 字符串
 */
export async function signTransientToken(data: Record<string, unknown>, ttlSeconds: number): Promise<string> {
	if (!sessionEnabled()) {
		throw new Error('SESSION_SECRET is not configured');
	}
	return await new SignJWT(data)
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${ttlSeconds}s`)
		.sign(encoder.encode(CONFIG.session.secret));
}

/**
 * 校验并解析短期一次性 JWT
 * @param token - JWT 字符串
 * @returns 载荷数据，无效或过期返回 null
 */
export async function verifyTransientToken(token: string): Promise<Record<string, unknown> | null> {
	if (!sessionEnabled() || !token) {
		return null;
	}
	try {
		const { payload } = await jwtVerify(token, encoder.encode(CONFIG.session.secret), {
			algorithms: ['HS256'],
		});
		return payload;
	}
	catch {
		return null;
	}
}
