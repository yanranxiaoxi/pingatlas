import { describe, expect, it, jest } from '@jest/globals';
import { parseCookies } from '../../src/utils/cookie';
import {
	clearCookie,
	getSessionUser,
	redirect,
	sendJson,
	setCookie,
} from '../../src/utils/respond';
import { createMockResponse } from '../helpers/http';

describe('sendJson', () => {
	it('设置 Content-Type、状态码与序列化 body', () => {
		const res = createMockResponse();
		sendJson(res as never, 201, { ok: true });

		expect(res.statusCode).toBe(201);
		expect(res.getHeader('content-type')).toBe('application/json; charset=utf-8');
		expect(res.body).toBe('{"ok":true}');
	});

	it('响应头已经发出时不再覆盖 Content-Type', () => {
		const res = createMockResponse();
		res.setHeader('Content-Type', 'text/plain');
		res.headersSent = true;
		sendJson(res as never, 200, { ok: true });

		expect(res.getHeader('content-type')).toBe('text/plain');
	});

	it('序列化 null 与数组', () => {
		const res = createMockResponse();
		sendJson(res as never, 200, null);
		expect(res.body).toBe('null');

		const arrayRes = createMockResponse();
		sendJson(arrayRes as never, 200, [1, 2]);
		expect(arrayRes.body).toBe('[1,2]');
	});
});

describe('isSecure', () => {
	it('ENV_PRODUCT 为 production / true / 1 时为 true', async () => {
		for (const value of ['production', 'true', '1']) {
			process.env.ENV_PRODUCT = value;
			await jest.isolateModulesAsync(async () => {
				const mod = await import('../../src/utils/respond');
				expect(mod.isSecure()).toBe(true);
			});
		}
	});

	it('其他值（含默认 development）为 false', async () => {
		for (const value of ['development', 'false', '0', 'staging']) {
			process.env.ENV_PRODUCT = value;
			await jest.isolateModulesAsync(async () => {
				const mod = await import('../../src/utils/respond');
				expect(mod.isSecure()).toBe(false);
			});
		}
	});

	afterAll(() => {
		process.env.ENV_PRODUCT = 'test';
	});
});

describe('setCookie / clearCookie', () => {
	it('写入会话 Cookie（HttpOnly + SameSite=Lax + Path=/）', () => {
		const res = createMockResponse();
		setCookie(res as never, 'pa_session', 'token-value');

		const header = res.getHeader('set-cookie') as string;
		expect(header).toContain('pa_session=token-value');
		expect(header).toContain('Path=/');
		expect(header).toContain('HttpOnly');
		expect(header).toContain('SameSite=Lax');
		expect(header).not.toContain('Secure');
	});

	it('支持自定义 maxAge 与 secure', () => {
		const res = createMockResponse();
		setCookie(res as never, 'pa_session', 'v', { maxAge: 3600, secure: true });

		const parsed = parseCookies((res.getHeader('set-cookie') as string).replace(/; /g, '; '));
		expect(parsed.pa_session).toBe('v');
		expect(res.getHeader('set-cookie')).toContain('Max-Age=3600');
		expect(res.getHeader('set-cookie')).toContain('Secure');
	});

	it('对 Cookie 值做 URL 编码', () => {
		const res = createMockResponse();
		setCookie(res as never, 'pa_session', 'a b');
		expect(res.getHeader('set-cookie')).toContain('pa_session=a%20b');
	});

	it('clearCookie 使用 Max-Age=0 覆盖删除', () => {
		const res = createMockResponse();
		clearCookie(res as never, 'pa_session');

		const header = res.getHeader('set-cookie') as string;
		expect(header).toContain('pa_session=;');
		expect(header).toContain('Max-Age=0');
		expect(header).toContain('Path=/');
		expect(header).toContain('HttpOnly');
	});
});

describe('redirect', () => {
	it('返回 302 并带 Location 头', () => {
		const res = createMockResponse();
		redirect(res as never, '/?login=failed');

		expect(res.statusCode).toBe(302);
		expect(res.getHeader('location')).toBe('/?login=failed');
	});
});

describe('getSessionUser', () => {
	it('返回合法的会话用户', () => {
		expect(getSessionUser({ sub: 's', username: 'u', extra: 1 })).toEqual({ sub: 's', username: 'u' });
	});

	it('非对象或 null 返回 null', () => {
		expect(getSessionUser(null)).toBeNull();
		expect(getSessionUser(undefined)).toBeNull();
		expect(getSessionUser('user')).toBeNull();
		expect(getSessionUser(42)).toBeNull();
	});

	it('字段类型不合法返回 null', () => {
		expect(getSessionUser({ sub: 's' })).toBeNull();
		expect(getSessionUser({ username: 'u' })).toBeNull();
		expect(getSessionUser({ sub: 1, username: 'u' })).toBeNull();
		expect(getSessionUser({ sub: 's', username: null })).toBeNull();
	});

	it('空字符串字段仍然可用', () => {
		expect(getSessionUser({ sub: '', username: '' })).toEqual({ sub: '', username: '' });
	});
});
