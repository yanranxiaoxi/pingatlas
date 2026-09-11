import { describe, expect, it } from '@jest/globals';
import { parseCookies, serializeCookie } from '../../src/utils/cookie';

describe('parseCookies', () => {
	it('无 Cookie 头时返回空对象', () => {
		expect(parseCookies(undefined)).toEqual({});
		expect(parseCookies('')).toEqual({});
	});

	it('解析多个 cookie 并去除两侧空白', () => {
		expect(parseCookies(' a = 1 ; b=2')).toEqual({ a: '1', b: '2' });
	});

	it('保留值中的等号', () => {
		expect(parseCookies('token=a=b=c')).toEqual({ token: 'a=b=c' });
	});

	it('跳过没有等号或名字为空的片段', () => {
		expect(parseCookies('novalue; =empty; ok=1')).toEqual({ ok: '1' });
	});

	it('忽略连续分号产生的空片段', () => {
		expect(parseCookies('a=1;;b=2;')).toEqual({ a: '1', b: '2' });
	});

	it('对值做百分号解码', () => {
		expect(parseCookies(`name=${encodeURIComponent('中文 value')}`)).toEqual({ name: '中文 value' });
	});

	it('畸形百分号编码只跳过该 cookie，不抛错', () => {
		expect(parseCookies('bad=%zz; alsobad=%E4%B8%; good=1')).toEqual({ good: '1' });
		expect(parseCookies('incomplete=%E4%B8; good=1')).toEqual({ good: '1' });
	});

	it('合法的转义序列可解码', () => {
		expect(parseCookies('escaped=%41%2F%20; good=1')).toEqual({ escaped: 'A/ ', good: '1' });
	});

	it('同名 cookie 后者覆盖前者', () => {
		expect(parseCookies('a=1; a=2')).toEqual({ a: '2' });
	});

	it('空值会被解析为空字符串', () => {
		expect(parseCookies('a=')).toEqual({ a: '' });
	});
});

describe('serializeCookie', () => {
	it('仅输出键值对', () => {
		expect(serializeCookie('a', 'b')).toBe('a=b');
	});

	it('对值做百分号编码', () => {
		expect(serializeCookie('n', 'a b;c')).toBe('n=a%20b%3Bc');
	});

	it('按固定顺序输出全部属性', () => {
		expect(serializeCookie('n', 'v', {
			maxAge: 60,
			path: '/',
			domain: 'example.com',
			secure: true,
			httpOnly: true,
			sameSite: 'Lax',
		})).toBe('n=v; Max-Age=60; Path=/; Domain=example.com; Secure; HttpOnly; SameSite=Lax');
	});

	it('maxAge 向下取整', () => {
		expect(serializeCookie('n', 'v', { maxAge: 1.9 })).toBe('n=v; Max-Age=1');
		expect(serializeCookie('n', 'v', { maxAge: 0 })).toBe('n=v; Max-Age=0');
	});

	it('maxAge 为 0 时仍然输出（用于删除 cookie）', () => {
		expect(serializeCookie('n', '', { maxAge: 0 })).toBe('n=; Max-Age=0');
	});

	it('不输出未提供的可选属性', () => {
		expect(serializeCookie('n', 'v', { sameSite: 'None' })).toBe('n=v; SameSite=None');
	});

	it('secure/httpOnly 为 false 时不输出', () => {
		expect(serializeCookie('n', 'v', { secure: false, httpOnly: false })).toBe('n=v');
	});
});
