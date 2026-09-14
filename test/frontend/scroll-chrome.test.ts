/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { publicDir } from '../helpers/paths';

type ScrollChromeModule = typeof import('../../src/frontend/scroll-chrome');
type Handle = ReturnType<ScrollChromeModule['initScrollChrome']>;

/** matchMedia 的最小替身：只实现本模块用到的 matches 与 change 事件 */
interface MediaStub {
	setMatches: (value: boolean) => void;
}

let topbar: HTMLElement;
let footer: HTMLElement;
/**
 * 用例创建的句柄。
 *
 * 模块把监听器注册在 `window` 上，而区域的 class 是全局状态；不在用例之间 destroy，
 * 前一个用例的监听器会继续响应后续的 scroll 事件，把断言弄脏。
 */
const handles: Handle[] = [];

function stubMatchMedia(initialMatches: boolean): MediaStub {
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	let matches = initialMatches;
	window.matchMedia = jest.fn((query: string) => ({
		get matches() {
			return matches;
		},
		media: query,
		addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
			listeners.delete(listener);
		},
	})) as unknown as typeof window.matchMedia;
	return {
		setMatches: (value: boolean) => {
			matches = value;
			for (const listener of listeners) {
				listener({ matches: value } as MediaQueryListEvent);
			}
		},
	};
}

/** jsdom 的 scrollY 是只读取值器，这里直接改写以便模拟滚动 */
function setScrollY(value: number): void {
	Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
}

/**
 * jsdom 不做布局：`scrollHeight` / `offsetHeight` 恒为 0，底部区域的保底规则会因此
 * 永远判定为「下方没有空间」。这里显式给出布局数值，让它像真实浏览器一样可判定。
 *
 * `scrollHeight` 用 getter：真实浏览器里底部区域被 transform 推出视口时会被算进
 * 滚动溢出，文档高度因而变大一个自身高度——这一点正是保底规则要处理的前提，
 * 静态数值无法覆盖。
 */
function stubLayout(options: { docHeight?: number; topHeight?: number; bottomHeight?: number } = {}): void {
	const baseHeight = options.docHeight ?? 10_000;
	const bottomHeight = options.bottomHeight ?? 170;
	Object.defineProperty(document.documentElement, 'scrollHeight', {
		get: () => baseHeight + (footer.classList.contains('chrome-hidden') ? bottomHeight : 0),
		configurable: true,
	});
	Object.defineProperty(topbar, 'offsetHeight', { value: options.topHeight ?? 80, configurable: true });
	Object.defineProperty(footer, 'offsetHeight', { value: bottomHeight, configurable: true });
}

/** 模拟一次滚动：改位置 + 派发 scroll + 让 requestAnimationFrame 回调同步执行 */
function scrollTo(y: number): void {
	setScrollY(y);
	window.dispatchEvent(new Event('scroll'));
}

async function freshModule(): Promise<ScrollChromeModule> {
	return import('../../src/frontend/scroll-chrome');
}

/** 初始化并登记句柄，afterEach 统一解除监听 */
async function init(options: Parameters<ScrollChromeModule['initScrollChrome']>[0]): Promise<Handle> {
	const { initScrollChrome } = await freshModule();
	const handle = initScrollChrome(options);
	handles.push(handle);
	return handle;
}

function isHidden(el: HTMLElement): boolean {
	return el.classList.contains('chrome-hidden');
}

/** 两个区域的收起状态与 inert，便于整体断言 */
function state(): { top: boolean; bottom: boolean; topInert: boolean; bottomInert: boolean } {
	return {
		top: isHidden(topbar),
		bottom: isHidden(footer),
		topInert: topbar.hasAttribute('inert'),
		bottomInert: footer.hasAttribute('inert'),
	};
}

beforeEach(() => {
	jest.resetModules();
	handles.length = 0;
	document.body.innerHTML = '<header class="topbar"></header><footer class="footer"></footer>';
	topbar = document.querySelector('.topbar') as HTMLElement;
	footer = document.querySelector('.footer') as HTMLElement;
	setScrollY(0);
	stubMatchMedia(true);
	stubLayout();
	// rAF 改为同步执行：避免用例依赖帧时序，行为断言仍然有效
	window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		callback(0);
		return 1;
	}) as typeof window.requestAnimationFrame;
	window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
});

afterEach(() => {
	while (handles.length) {
		handles.pop()?.destroy();
	}
	document.body.replaceChildren();
	Reflect.deleteProperty(window, 'matchMedia');
});

describe('断点一致性', () => {
	it('MOBILE_QUERY 与样式表里的收起断点一致', async () => {
		const { MOBILE_QUERY } = await freshModule();
		const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8');
		// 两侧必须一致：JS 判定小屏、CSS 才会在同一个断点里应用 transform，
		// 不一致就会出现「类名已加上但收不起来」或「大屏也被收起」
		const query = /@media \(max-width: (\d+)px\)[^@]*\.topbar\.chrome-hidden/.exec(css);

		expect(MOBILE_QUERY).toBe('(max-width: 620px)');
		expect(query?.[1]).toBe('620');
	});

	it('样式表定义了顶栏与页脚的收起动作', () => {
		const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8');
		const block = css.slice(css.indexOf('.topbar.chrome-hidden'));

		expect(css).toContain('.topbar.chrome-hidden');
		expect(block).toContain('transform: translateY(-100%)');
		expect(block).toContain('.footer.chrome-hidden');
		expect(block).toContain('transform: translateY(100%)');
	});

	it('收起用 transform，不使用高度或 display（避免重排与内容跳动）', () => {
		const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8');
		const start = css.indexOf('.topbar.chrome-hidden');
		const end = css.indexOf('}', css.indexOf('.footer.chrome-hidden {'));
		const block = css.slice(start, end);

		expect(block).toContain('transform:');
		expect(block).not.toContain('display:');
		expect(block).not.toContain('max-height');
	});

	it('类名加在区域自身而不是 <html> 上（两个区域需要独立收起）', () => {
		const css = readFileSync(join(publicDir, 'css', 'style.css'), 'utf8');

		expect(css).not.toContain('.chrome-hidden .topbar');
		expect(css).not.toContain(':root.chrome-hidden');
	});
});

describe('初始状态', () => {
	it('未提供任何区域时是空操作', async () => {
		const handle = await init({});

		expect(() => handle.show()).not.toThrow();
		scrollTo(500);
		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('缺少 matchMedia 时静默降级为常显', async () => {
		// jsdom 默认没有 matchMedia；删除后不应抛错
		Reflect.deleteProperty(window, 'matchMedia');
		const handle = await init({ top: topbar, bottom: footer });

		expect(() => {
			scrollTo(500);
			handle.destroy();
		}).not.toThrow();
		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('目标区域尚未渲染时也不抛错', async () => {
		document.body.replaceChildren();
		document.body.innerHTML = '<header class="topbar"></header>';
		topbar = document.querySelector('.topbar') as HTMLElement;
		stubLayout();
		const handle = await init({
			top: topbar,
			bottom: document.querySelector<HTMLElement>('.footer'),
		});

		expect(() => scrollTo(500)).not.toThrow();
		expect(handle).toBeDefined();
	});
});

describe('滚动收起与展开', () => {
	it('向下滚动超过阈值后收起两个区域并加 inert', async () => {
		await init({ top: topbar, bottom: footer });

		scrollTo(200);

		expect(state()).toEqual({ top: true, bottom: true, topInert: true, bottomInert: true });
	});

	it('向上滚动时立即展开并移除 inert', async () => {
		await init({ top: topbar, bottom: footer });
		scrollTo(300);
		expect(isHidden(topbar)).toBe(true);

		scrollTo(280);

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('未达到收起阈值时即使一直向下也不收起', async () => {
		await init({ top: topbar, bottom: footer });

		// 累计位移已超过方向阈值，但位置仍在 HIDE_AFTER_PX 以内
		scrollTo(10);
		scrollTo(40);
		scrollTo(70);

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('位移小于方向阈值时不改变状态（抖动过滤）', async () => {
		await init({ top: topbar, bottom: footer });
		scrollTo(300);
		expect(isHidden(topbar)).toBe(true);

		// 单次向上 3px 不足以判定为「上滑」
		scrollTo(297);

		expect(isHidden(topbar)).toBe(true);
	});

	it('微小位移会累计到阈值后再判定方向', async () => {
		await init({ top: topbar, bottom: footer });
		scrollTo(300);
		expect(isHidden(topbar)).toBe(true);

		scrollTo(297);
		scrollTo(294);
		scrollTo(291);

		expect(isHidden(topbar)).toBe(false);
	});

	it('回到页面顶部时展开', async () => {
		await init({ top: topbar, bottom: footer });
		scrollTo(300);
		expect(isHidden(topbar)).toBe(true);

		scrollTo(4);

		expect(isHidden(topbar)).toBe(false);
	});

	it('只提供顶栏时只影响顶栏', async () => {
		await init({ top: topbar });

		scrollTo(300);

		expect(isHidden(topbar)).toBe(true);
		expect(topbar.hasAttribute('inert')).toBe(true);
		expect(isHidden(footer)).toBe(false);
		expect(footer.hasAttribute('inert')).toBe(false);
	});

	it('已收起时继续向下滚动不重复写状态', async () => {
		await init({ top: topbar, bottom: footer });
		scrollTo(200);
		expect(isHidden(topbar)).toBe(true);

		const toggle = jest.spyOn(topbar.classList, 'toggle');
		scrollTo(400);
		scrollTo(600);

		expect(toggle).not.toHaveBeenCalled();
		expect(isHidden(topbar)).toBe(true);
	});
});

describe('底部区域的保底规则', () => {
	/*
	 * 底部区域是被 transform 推出视口的，而 transform 后的盒子会算进滚动溢出：文档
	 * 会因此变高一个自身高度。若已经接近页面底部，多出来的那段就是空白，所以要求
	 * 「下方还有超过自身高度的空间」才收起。
	 */
	it('下方空间不足时底部区域保持可见，顶栏照常收起', async () => {
		// 文档高 900、视口 768、页脚 170：滚动到 200 时下方只剩 900-200-768 < 170
		stubLayout({ docHeight: 900, bottomHeight: 170 });
		await init({ top: topbar, bottom: footer });

		scrollTo(200);

		expect(isHidden(topbar)).toBe(true);
		expect(isHidden(footer)).toBe(false);
		expect(footer.hasAttribute('inert')).toBe(false);
	});

	it('下方空间充足时底部区域收起', async () => {
		stubLayout({ docHeight: 4000, bottomHeight: 170 });
		await init({ top: topbar, bottom: footer });

		scrollTo(200);

		expect(isHidden(footer)).toBe(true);
	});

	it('已收起后滚到接近底部会重新恢复可见', async () => {
		stubLayout({ docHeight: 4000, bottomHeight: 170 });
		await init({ top: topbar, bottom: footer });
		scrollTo(200);
		expect(isHidden(footer)).toBe(true);

		// 4000 - 3200 - 768 = 32 < 170：下方已无足够空间
		scrollTo(3200);

		expect(isHidden(footer)).toBe(false);
		expect(footer.hasAttribute('inert')).toBe(false);
		// 顶栏不受该规则影响，仍然收起
		expect(isHidden(topbar)).toBe(true);
	});

	it('高度为 0 的底部区域不会被收起', async () => {
		stubLayout({ docHeight: 4000, bottomHeight: 0 });
		await init({ top: topbar, bottom: footer });

		scrollTo(200);

		expect(isHidden(footer)).toBe(false);
	});

	it('已收起时按「折算后」的文档高度判定，不会因为自身撑高而误判', async () => {
		/*
		 * 文档基准高 4000、页脚 170、视口 768。
		 * 判定条件：scrollY + 768 < 折算高(4000) - 170 = 3830，即 scrollY < 3062。
		 * 若不折算（直接用膨胀后的 4170），边界会错到 3232。
		 */
		stubLayout({ docHeight: 4000, bottomHeight: 170 });
		await init({ top: topbar, bottom: footer });
		scrollTo(200);
		expect(isHidden(footer)).toBe(true);

		// 步长要超过 DELTA_PX，否则属于「抖动过滤」不会重新判定
		scrollTo(3000);
		expect(isHidden(footer)).toBe(true);

		scrollTo(3062);
		expect(isHidden(footer)).toBe(false);
	});
});

describe('生效范围与焦点', () => {
	it('媒体查询不匹配（大屏）时滚动不收起', async () => {
		stubMatchMedia(false);
		await init({ top: topbar, bottom: footer });

		scrollTo(600);

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('焦点位于区域内时拒绝收起', async () => {
		const button = document.createElement('button');
		topbar.append(button);
		button.focus();
		await init({ top: topbar, bottom: footer });

		scrollTo(400);

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('焦点在底部区域内时同样拒绝收起', async () => {
		const button = document.createElement('button');
		footer.append(button);
		button.focus();
		await init({ top: topbar, bottom: footer });

		scrollTo(400);

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('焦点不在区域内时正常收起', async () => {
		const outside = document.createElement('button');
		document.body.append(outside);
		outside.focus();
		await init({ top: topbar, bottom: footer });

		scrollTo(400);

		expect(isHidden(topbar)).toBe(true);
	});

	it('视口条件变化时回到展开状态', async () => {
		const media = stubMatchMedia(true);
		await init({ top: topbar, bottom: footer });
		scrollTo(400);
		expect(isHidden(topbar)).toBe(true);

		// 旋转到横屏 / 放大窗口：收起动作不再适用，必须立刻展开
		media.setMatches(false);

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});
});

describe('句柄', () => {
	it('show 立即展开', async () => {
		const handle = await init({ top: topbar, bottom: footer });
		scrollTo(400);
		expect(isHidden(topbar)).toBe(true);

		handle.show();

		expect(state()).toEqual({ top: false, bottom: false, topInert: false, bottomInert: false });
	});

	it('destroy 后不再响应滚动，并回到展开状态', async () => {
		const handle = await init({ top: topbar, bottom: footer });
		scrollTo(400);
		expect(isHidden(topbar)).toBe(true);

		handle.destroy();
		expect(isHidden(topbar)).toBe(false);

		scrollTo(800);

		expect(isHidden(topbar)).toBe(false);
	});

	it('destroy 会取消尚未执行的帧回调', async () => {
		// 只记录回调、不立即执行，模拟「事件已派发但帧尚未执行」
		const pending: FrameRequestCallback[] = [];
		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			pending.push(callback);
			return pending.length;
		}) as typeof window.requestAnimationFrame;
		const cancel = jest.fn();
		window.cancelAnimationFrame = cancel as unknown as typeof window.cancelAnimationFrame;

		const handle = await init({ top: topbar, bottom: footer });
		window.dispatchEvent(new Event('scroll'));
		expect(pending).toHaveLength(1);

		handle.destroy();

		expect(cancel).toHaveBeenCalledWith(1);
		// 取消后即使事件再次派发也不会再排帧
		window.dispatchEvent(new Event('scroll'));
		expect(pending).toHaveLength(1);
	});

	it('destroy 后重复调用其它方法不报错', async () => {
		const handle = await init({ top: topbar, bottom: footer });

		handle.destroy();

		expect(() => {
			handle.show();
			handle.destroy();
		}).not.toThrow();
	});
});
