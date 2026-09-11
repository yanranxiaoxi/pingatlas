import type { SessionUser } from '../../src/utils/session';
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import {
	sessionEnabled,
	signSession,
	signTransientToken,
	verifySession,
	verifyTransientToken,
} from '../../src/utils/session';
import { resetEnv, TEST_SESSION_SECRET } from '../helpers/env';

const user: SessionUser = { sub: 'user-1', username: 'alice' };

afterAll(() => resetEnv());

describe('sessionEnabled', () => {
	it('配置了 SESSION_SECRET 时为 true', () => {
		expect(sessionEnabled()).toBe(true);
	});

	it('SESSION_SECRET 为空时为 false', async () => {
		resetEnv({ SESSION_SECRET: '' });
		await jest.isolateModulesAsync(async () => {
			const mod = await import('../../src/utils/session');
			expect(mod.sessionEnabled()).toBe(false);
		});
	});
});

describe('signSession / verifySession', () => {
	it('签发并校验往返一致', async () => {
		const token = await signSession(user);
		expect(token.split('.')).toHaveLength(3);
		await expect(verifySession(token)).resolves.toEqual(user);
	});

	it('签发的是 HS256 JWT', async () => {
		const token = await signSession(user);
		const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
		expect(header).toEqual({ alg: 'HS256' });
	});

	it('载荷包含 sub / username / iat / exp', async () => {
		const token = await signSession(user, 60);
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
		expect(payload.sub).toBe('user-1');
		expect(payload.username).toBe('alice');
		expect(payload.exp - payload.iat).toBe(60);
	});

	it('被篡改的 token 校验失败', async () => {
		const token = await signSession(user);
		const [header, , signature] = token.split('.');
		const tampered = `${header}.${Buffer.from(JSON.stringify({ sub: 'user-2', username: 'bob' })).toString('base64url')}.${signature}`;
		await expect(verifySession(tampered)).resolves.toBeNull();
	});

	it('换掉签名的 token 校验失败', async () => {
		const [header, payload] = (await signSession(user)).split('.');
		await expect(verifySession(`${header}.${payload}.AAAA`)).resolves.toBeNull();
	});

	it('过期 token 校验失败', async () => {
		const token = await signSession(user, -10);
		await expect(verifySession(token)).resolves.toBeNull();
	});

	it('空 token 返回 null', async () => {
		await expect(verifySession('')).resolves.toBeNull();
	});

	it('非 JWT 字符串返回 null', async () => {
		await expect(verifySession('not-a-jwt')).resolves.toBeNull();
	});

	it('缺少 username 的 token 返回 null', async () => {
		const { SignJWT } = await import('jose');
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject('user-1')
			.setIssuedAt()
			.setExpirationTime('60s')
			.sign(new TextEncoder().encode(TEST_SESSION_SECRET));
		await expect(verifySession(token)).resolves.toBeNull();
	});

	it('username 非字符串的 token 返回 null', async () => {
		const { SignJWT } = await import('jose');
		const token = await new SignJWT({ username: 42 })
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject('user-1')
			.setIssuedAt()
			.setExpirationTime('60s')
			.sign(new TextEncoder().encode(TEST_SESSION_SECRET));
		await expect(verifySession(token)).resolves.toBeNull();
	});

	it('用错误密钥签发的 token 返回 null', async () => {
		const { SignJWT } = await import('jose');
		const token = await new SignJWT({ username: 'mallory' })
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject('user-9')
			.setIssuedAt()
			.setExpirationTime('60s')
			.sign(new TextEncoder().encode('a-completely-different-secret'));
		await expect(verifySession(token)).resolves.toBeNull();
	});

	it('缺少 sub 的短期 token 无法当会话使用', async () => {
		const token = await signTransientToken({ username: 'alice' }, 60);
		await expect(verifySession(token)).resolves.toBeNull();
	});

	it('未配置 SESSION_SECRET 时签发抛错', async () => {
		resetEnv({ SESSION_SECRET: '' });
		await jest.isolateModulesAsync(async () => {
			const mod = await import('../../src/utils/session');
			await expect(mod.signSession(user)).rejects.toThrow('SESSION_SECRET is not configured');
			await expect(mod.signTransientToken({}, 60)).rejects.toThrow('SESSION_SECRET is not configured');
			await expect(mod.verifySession('whatever')).resolves.toBeNull();
			await expect(mod.verifyTransientToken('whatever')).resolves.toBeNull();
		});
	});
});

describe('signTransientToken / verifyTransientToken', () => {
	it('往返一致', async () => {
		const token = await signTransientToken({ state: 'abc', nonce: 'n1', codeVerifier: 'v1' }, 300);
		const payload = await verifyTransientToken(token);
		expect(payload).toMatchObject({ state: 'abc', nonce: 'n1', codeVerifier: 'v1' });
		expect(typeof payload?.iat).toBe('number');
		expect(typeof payload?.exp).toBe('number');
	});

	it('过期后校验失败', async () => {
		const token = await signTransientToken({ state: 'abc' }, -10);
		await expect(verifyTransientToken(token)).resolves.toBeNull();
	});

	it('篡改后校验失败', async () => {
		const [header, payload] = (await signTransientToken({ state: 'abc' }, 300)).split('.');
		await expect(verifyTransientToken(`${header}.${payload}.nope`)).resolves.toBeNull();
	});

	it('空 token 返回 null', async () => {
		await expect(verifyTransientToken('')).resolves.toBeNull();
	});

	it('会话 token 也能被解析为载荷', async () => {
		const token = await signSession(user, 60);
		await expect(verifyTransientToken(token)).resolves.toMatchObject({ sub: 'user-1', username: 'alice' });
	});
});
