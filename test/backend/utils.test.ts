import { describe, expect, it, jest } from '@jest/globals';
import { getOrInitMap, getUuid, getUuidStr, instanceValue, traceId } from '../../src/utils/utils';

describe('instanceValue', () => {
	it('初始化函数只执行一次并返回同一引用', () => {
		const initializer = jest.fn(() => ({ id: Math.random() }));
		const value = instanceValue(initializer);

		const first = value();
		const second = value();

		expect(initializer).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
	});
});

describe('getOrInitMap', () => {
	it('键不存在时调用初始化函数并写入', () => {
		const map = new Map<string, number>();
		const initializer = jest.fn(() => 42);

		expect(getOrInitMap(map, 'a', initializer)).toBe(42);
		expect(initializer).toHaveBeenCalledWith('a');
		expect(map.get('a')).toBe(42);
	});

	it('键已存在时直接返回缓存值', () => {
		const map = new Map<string, number>([['a', 7]]);
		const initializer = jest.fn(() => 42);

		expect(getOrInitMap(map, 'a', initializer)).toBe(7);
		expect(initializer).not.toHaveBeenCalled();
	});

	it('与框架一致：值为 falsy 时会重新初始化', () => {
		const map = new Map<string, number>([['zero', 0]]);
		expect(getOrInitMap(map, 'zero', () => 9)).toBe(9);
	});
});

describe('getUuid', () => {
	it('返回 32 位十六进制字符串（无连字符）', () => {
		const uuid = getUuid();
		expect(uuid).toMatch(/^[0-9a-f]{32}$/);
	});

	it('每次调用都不同', () => {
		expect(getUuid()).not.toBe(getUuid());
	});
});

describe('getUuidStr', () => {
	it('每两个十六进制字符映射为一个 base62 字符', () => {
		// 0x00 → 索引 0 → 'A'；0xff % 62 = 7 → 'H'
		expect(getUuidStr('00')).toBe('A');
		expect(getUuidStr('ff')).toBe('H');
		expect(getUuidStr('0000')).toBe('AA');
	});

	it('长度为 uuid 长度的一半（向上取整）', () => {
		expect(getUuidStr(getUuid())).toHaveLength(16);
		expect(getUuidStr('abc')).toHaveLength(2);
	});

	it('不传参数时使用随机 uuid', () => {
		expect(getUuidStr()).toHaveLength(16);
	});

	it('只使用 base62 字符集', () => {
		expect(getUuidStr(getUuid())).toMatch(/^[A-Z0-9]{16}$/i);
	});
});

describe('traceId', () => {
	it('以 TraceId: 为前缀', () => {
		const id = traceId();
		expect(id.startsWith('TraceId:')).toBe(true);
		expect(id.slice('TraceId:'.length)).toHaveLength(16);
	});

	it('每次调用都不同', () => {
		expect(traceId()).not.toBe(traceId());
	});
});
