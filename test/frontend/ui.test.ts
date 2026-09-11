/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	buildTimingBars,
	copyText,
	countryName,
	el,
	flagEmoji,
	formatAgo,
	formatBytes,
	formatClock,
	formatCountdown,
	formatMs,
	textWithLinks,
	toast,
} from '../../src/frontend/ui';

beforeEach(() => {
	document.body.replaceChildren();
	jest.useRealTimers();
});

describe('toast', () => {
	it('首次调用创建 toast-box 并插入消息', () => {
		toast('hello');
		const box = document.getElementById('toast-box');
		expect(box).not.toBeNull();
		expect(box!.querySelectorAll('.toast')).toHaveLength(1);
		expect(box!.querySelector('.toast')!.textContent).toBe('hello');
		expect(box!.querySelector('.toast')!.className).toBe('toast toast-info');
	});

	it('按类型追加 className', () => {
		toast('a', 'error');
		toast('b', 'success');
		const items = document.querySelectorAll('#toast-box .toast');
		expect(items[0].className).toBe('toast toast-error');
		expect(items[1].className).toBe('toast toast-success');
	});

	it('超过时长后清空提示', () => {
		jest.useFakeTimers();
		toast('temp');
		expect(document.querySelectorAll('#toast-box .toast')).toHaveLength(1);
		jest.advanceTimersByTime(3500);
		expect(document.querySelectorAll('#toast-box .toast')).toHaveLength(0);
	});

	it('多次调用会重置计时器（只保留到最后一刻）', () => {
		jest.useFakeTimers();
		toast('first');
		jest.advanceTimersByTime(3000);
		toast('second');
		jest.advanceTimersByTime(3000);
		// 第一条的计时器应已被清除
		expect(document.querySelectorAll('#toast-box .toast')).toHaveLength(2);
		jest.advanceTimersByTime(500);
		expect(document.querySelectorAll('#toast-box .toast')).toHaveLength(0);
	});

	it('复用已存在的 toast-box', () => {
		toast('one');
		toast('two');
		expect(document.querySelectorAll('#toast-box')).toHaveLength(1);
	});
});

describe('el', () => {
	it('创建元素并应用属性与子节点', () => {
		const node = el('div', { class: 'x', id: 'y' }, ['text', el('span', {}, ['child'])]);
		expect(node.tagName).toBe('DIV');
		expect(node.getAttribute('class')).toBe('x');
		expect(node.getAttribute('id')).toBe('y');
		expect(node.childNodes).toHaveLength(2);
		expect(node.childNodes[0].textContent).toBe('text');
		expect((node.childNodes[1] as HTMLElement).tagName).toBe('SPAN');
	});

	it('无属性无子节点时创建空元素', () => {
		const node = el('br');
		expect(node.outerHTML).toBe('<br>');
	});
});

describe('textWithLinks', () => {
	it('把 http 链接渲染为 a 标签', () => {
		const nodes = textWithLinks('see [docs](https://example.com/a) now');
		expect(nodes).toHaveLength(3);
		expect(nodes[0]).toBe('see ');
		const link = nodes[1] as HTMLAnchorElement;
		expect(link.tagName).toBe('A');
		expect(link.textContent).toBe('docs');
		expect(link.getAttribute('href')).toBe('https://example.com/a');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
		expect(nodes[2]).toBe(' now');
	});

	it('接受 http（非 https）链接', () => {
		const nodes = textWithLinks('[x](http://example.com)');
		expect((nodes[0] as HTMLAnchorElement).tagName).toBe('A');
	});

	it('拒绝 javascript: 等危险协议，保留原文', () => {
		const nodes = textWithLinks('[evil](javascript:alert)');
		expect(nodes).toEqual(['[evil](javascript:alert)']);
	});

	it('拒绝相对路径', () => {
		const nodes = textWithLinks('[x](/local/path)');
		expect(nodes).toEqual(['[x](/local/path)']);
	});

	it('无链接时原样返回单段文本', () => {
		expect(textWithLinks('plain text')).toEqual(['plain text']);
	});

	it('支持多个链接', () => {
		const nodes = textWithLinks('[a](https://a.com) and [b](https://b.com)');
		expect(nodes.filter(n => typeof n !== 'string')).toHaveLength(2);
		expect(nodes[1]).toBe(' and ');
	});

	it('空字符串返回单段空文本', () => {
		expect(textWithLinks('')).toEqual(['']);
	});

	it('链接在末尾时不追加多余文本节点', () => {
		const nodes = textWithLinks('[a](https://a.com)');
		expect(nodes).toHaveLength(1);
	});

	it('匹配结果缺少 index 时按 0 处理', () => {
		const fakeMatch = Object.assign(['[a](https://a.com)', 'a', 'https://a.com'], { index: undefined });
		const fakeText = {
			length: 10,
			matchAll: () => [fakeMatch],
			slice: () => '',
		} as unknown as string;

		const nodes = textWithLinks(fakeText);

		expect(nodes).toHaveLength(1);
		expect((nodes[0] as HTMLAnchorElement).getAttribute('href')).toBe('https://a.com');
	});
});

describe('copyText', () => {
	it('写入剪贴板成功时返回 true', async () => {
		const writeText = jest.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
		await expect(copyText('abc')).resolves.toBe(true);
		expect(writeText).toHaveBeenCalledWith('abc');
	});

	it('写入失败时返回 false', async () => {
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: jest.fn(async () => { throw new Error('denied'); }) },
		});
		await expect(copyText('abc')).resolves.toBe(false);
	});
});

describe('formatMs', () => {
	it('null / undefined / 非有限值返回破折号', () => {
		expect(formatMs(null)).toBe('—');
		expect(formatMs(undefined)).toBe('—');
		expect(formatMs(Number.NaN)).toBe('—');
		expect(formatMs(Number.POSITIVE_INFINITY)).toBe('—');
	});

	it('小于 10ms 保留两位小数', () => {
		expect(formatMs(0)).toBe('0.00 ms');
		expect(formatMs(9.876)).toBe('9.88 ms');
	});

	it('大于等于 10ms 保留一位小数', () => {
		expect(formatMs(10)).toBe('10.0 ms');
		expect(formatMs(999.94)).toBe('999.9 ms');
	});

	it('大于等于 1000ms 转为秒', () => {
		expect(formatMs(1000)).toBe('1.00 s');
		expect(formatMs(1234.5)).toBe('1.23 s');
	});
});

describe('formatCountdown', () => {
	it('输出 mm:ss', () => {
		expect(formatCountdown(0)).toBe('00:00');
		expect(formatCountdown(59)).toBe('00:59');
		expect(formatCountdown(60)).toBe('01:00');
		expect(formatCountdown(3599)).toBe('59:59');
		expect(formatCountdown(3600)).toBe('60:00');
	});

	it('负数与小数被钳制', () => {
		expect(formatCountdown(-10)).toBe('00:00');
		expect(formatCountdown(61.9)).toBe('01:01');
	});
});

describe('formatClock', () => {
	it('ISO 时间转本地时间字符串', () => {
		const iso = new Date(2024, 0, 2, 3, 4, 5).toISOString();
		expect(formatClock(iso)).toBe(new Date(iso).toLocaleTimeString(undefined, { hour12: false }));
	});

	it('非法时间原样返回', () => {
		expect(formatClock('not-a-date')).toBe('not-a-date');
	});
});

describe('formatAgo', () => {
	it('返回秒差并保留一位小数', () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2024-01-01T00:00:10.000Z'));
		expect(formatAgo('2024-01-01T00:00:06.800Z')).toBe('3.2s');
	});

	it('未来时间钳制为 0', () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
		expect(formatAgo('2024-01-01T00:00:10.000Z')).toBe('0.0s');
	});

	it('非法时间返回空串', () => {
		expect(formatAgo('nope')).toBe('');
	});
});

describe('formatBytes', () => {
	it('小于 1KiB 显示 B', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1023)).toBe('1023 B');
	});

	it('KiB 区间保留一位小数', () => {
		expect(formatBytes(1024)).toBe('1.0 KiB');
		expect(formatBytes(1536)).toBe('1.5 KiB');
	});

	it('MiB 及以上保留两位小数', () => {
		expect(formatBytes(1024 * 1024)).toBe('1.00 MiB');
		expect(formatBytes(1024 * 1024 * 3.456)).toBe('3.46 MiB');
	});
});

describe('flagEmoji', () => {
	it('两位字母代码转国旗', () => {
		expect(flagEmoji('cn')).toBe('🇨🇳');
		expect(flagEmoji('US')).toBe('🇺🇸');
		expect(flagEmoji('de')).toBe('🇩🇪');
	});

	it('非法输入返回空串', () => {
		expect(flagEmoji(null)).toBe('');
		expect(flagEmoji(undefined)).toBe('');
		expect(flagEmoji('')).toBe('');
		expect(flagEmoji('C')).toBe('');
		expect(flagEmoji('CHN')).toBe('');
		expect(flagEmoji('C1')).toBe('');
	});
});

describe('countryName', () => {
	it('空输入返回空串', () => {
		expect(countryName('')).toBe('');
	});

	it('已知代码返回非空本地化名称', () => {
		const name = countryName('CN');
		expect(typeof name).toBe('string');
		expect(name.length).toBeGreaterThan(0);
		// 大小写不敏感
		expect(countryName('cn')).toBe(name);
	});

	it('未知但合法的两位代码返回本地化占位名', () => {
		const name = countryName('ZZ');
		expect(typeof name).toBe('string');
		expect(name).toBe('未知地区');
	});

	it('非法代码回退为原输入（Intl 抛错路径）', () => {
		expect(countryName('ZZZ')).toBe('ZZZ');
	});

	it('Intl 无法解析时回退为原始代码', () => {
		jest.spyOn(Intl.DisplayNames.prototype, 'of').mockReturnValue(undefined);
		expect(countryName('JP')).toBe('JP');
	});

	it('环境不支持 Intl.DisplayNames 时回退为原始代码', async () => {
		const original = Intl.DisplayNames;
		Reflect.deleteProperty(Intl, 'DisplayNames');
		try {
			await jest.isolateModulesAsync(async () => {
				const fresh = await import('../../src/frontend/ui');
				expect(fresh.countryName('JP')).toBe('JP');
			});
		}
		finally {
			Intl.DisplayNames = original;
		}
	});
});

describe('buildTimingBars', () => {
	it('按 rtt 归一化高度，最大值 100%', () => {
		const wrap = buildTimingBars([{ rtt: 10 }, { rtt: 20 }]);
		const bars = wrap.querySelectorAll<HTMLElement>('.timing-bar');
		expect(bars).toHaveLength(2);
		expect(Number.parseFloat(bars[0].style.height)).toBeCloseTo(56);
		expect(Number.parseFloat(bars[1].style.height)).toBeCloseTo(100);
		expect(bars[0].getAttribute('title')).toBe('10.0 ms');
	});

	it('最小值仍有 12% 高度', () => {
		const wrap = buildTimingBars([{ rtt: 0 }, { rtt: 100 }]);
		const bars = wrap.querySelectorAll<HTMLElement>('.timing-bar');
		expect(Number.parseFloat(bars[0].style.height)).toBeCloseTo(12);
	});

	it('空数组只产生容器', () => {
		const wrap = buildTimingBars([]);
		expect(wrap.className).toBe('timing-bars');
		expect(wrap.children).toHaveLength(0);
	});

	it('超过 maxBars 时截断并显示剩余数量', () => {
		const timings = Array.from({ length: 40 }, (_, index) => ({ rtt: index + 1 }));
		const wrap = buildTimingBars(timings, 32);
		expect(wrap.querySelectorAll('.timing-bar')).toHaveLength(32);
		expect(wrap.querySelector('.timing-bar-more')!.textContent).toBe('+8');
	});

	it('恰好等于 maxBars 时不显示剩余', () => {
		const timings = Array.from({ length: 3 }, () => ({ rtt: 1 }));
		const wrap = buildTimingBars(timings, 3);
		expect(wrap.querySelector('.timing-bar-more')).toBeNull();
	});

	it('全部 rtt 为 0 时不会除以零', () => {
		const wrap = buildTimingBars([{ rtt: 0 }, { rtt: 0 }]);
		const bars = wrap.querySelectorAll<HTMLElement>('.timing-bar');
		expect(Number.parseFloat(bars[0].style.height)).toBeCloseTo(12);
		expect(Number.parseFloat(bars[1].style.height)).toBeCloseTo(12);
	});
});
