/**
 * 小屏滚动时收起顶部与底部的固定区域
 *
 * 向下滚动超过阈值后收起，向上滚动或回到页面顶部时展开；仅在给定的媒体查询匹配
 * 时生效，桌面端保持常显。
 *
 * 四个容易踩到的点：
 * 1. 收起用 `transform`（由 CSS 定义），不用高度或 `display`：sticky 元素仍占据
 *    它在布局中的空间，页面不会重排，正文也不会跳动。
 * 2. 收起时给区域加 `inert`：元素只是移出视口、仍在可聚焦序列里，不加的话键盘
 *    用户按 Tab 会把焦点送到看不见的按钮上。
 * 3. 焦点已经落在区域内时拒绝收起，否则正在操作的元素会突然跑掉。
 * 4. 底部区域额外要求「下方还有超过自身高度的空间」才收起，原因见 {@link hasRoomBelow}。
 */

/**
 * 触发收起行为的视口条件
 *
 * 必须与 `public/css/style.css` 里定义收起动作的媒体查询完全一致，
 * `test/frontend/scroll-chrome.test.ts` 会对照样式表校验两者相同。
 */
export const MOBILE_QUERY = '(max-width: 620px)';

/** 至少滚过这么远才允许收起，避免刚滚动一点点就触发 */
const HIDE_AFTER_PX = 80;
/** 方向判定阈值：位移小于该值就当作抖动，累计到阈值后再判断 */
const DELTA_PX = 6;
/** 距页面顶部这个范围内始终展开 */
const SHOW_NEAR_TOP_PX = 8;
/** 施加在区域上的类名，CSS 据此收起 */
const HIDDEN_CLASS = 'chrome-hidden';

export interface ScrollChromeOptions {
	/** 顶部固定区域 */
	top?: HTMLElement | null;
	/** 底部固定区域 */
	bottom?: HTMLElement | null;
}

export interface ScrollChromeHandle {
	/** 立即展开（外部需要临时显示时使用） */
	show: () => void;
	/** 解除全部监听 */
	destroy: () => void;
}

interface Bar {
	el: HTMLElement;
	/** 顶部区域向上移出，底部区域向下移出 */
	edge: 'top' | 'bottom';
	hidden: boolean;
}

const NOOP: ScrollChromeHandle = { show: () => {}, destroy: () => {} };

/**
 * 绑定滚动收起行为
 *
 * 找不到任何目标区域、或环境没有 `matchMedia` 时返回空操作句柄，
 * 调用方无需判空（也是渐进增强：不支持时两个区域保持常显）。
 */
export function initScrollChrome(options: ScrollChromeOptions): ScrollChromeHandle {
	const bars: Bar[] = [];
	if (options.top) {
		bars.push({ el: options.top, edge: 'top', hidden: false });
	}
	if (options.bottom) {
		bars.push({ el: options.bottom, edge: 'bottom', hidden: false });
	}
	if (!bars.length || typeof window.matchMedia !== 'function') {
		return NOOP;
	}

	const query = window.matchMedia(MOBILE_QUERY);
	let enabled = query.matches;
	let lastY = Math.max(0, window.scrollY);
	/**
	 * 是否已排队等待下一帧。
	 *
	 * 用布尔量而不是 rAF 返回的 id 做门控：`frame = requestAnimationFrame(cb)` 的赋值
	 * 发生在调用之后，若回调先执行（例如测试里把 rAF 换成同步实现）并在其中把 `frame`
	 * 置空，赋值会再把它写回一个非空 id，门控就永远关上了。
	 */
	let scheduled = false;
	let frame: number | null = null;
	/** destroy 后为 false，用于丢弃已经排队的帧 */
	let active = true;

	function setBarHidden(bar: Bar, next: boolean): void {
		if (next === bar.hidden) {
			return;
		}
		bar.hidden = next;
		bar.el.classList.toggle(HIDDEN_CLASS, next);
		if (next) {
			// inert 让收起的区域从可聚焦序列与无障碍树中一并移除
			bar.el.setAttribute('inert', '');
		}
		else {
			bar.el.removeAttribute('inert');
		}
	}

	function showAll(): void {
		for (const bar of bars) {
			setBarHidden(bar, false);
		}
	}

	/** 有焦点位于区域内时，收起会把正在操作的元素移走 */
	function holdsFocus(): boolean {
		const activeEl = document.activeElement;
		return Boolean(activeEl) && bars.some(bar => bar.el.contains(activeEl));
	}

	/**
	 * 下方是否还有超过一个自身高度的可滚动空间
	 *
	 * 底部区域是被 `transform` 推出视口的，而 transform 之后的盒子会算进滚动溢出：
	 * 文档会因此变高一个自身高度。若此时已接近页面底部，多出来的那段就是一片空白，
	 * 而且它重新出现时文档会变矮、可能把滚动位置往回拽。所以要求「还剩足够的可滚动
	 * 距离」才收起，滚到底部附近就保持可见。
	 */
	function hasRoomBelow(bar: Bar): boolean {
		const height = bar.el.offsetHeight;
		if (height <= 0) {
			return false;
		}
		// 已收起时文档高度被撑高了 height，这里折算回「它还在流内」时的高度
		const heightWhenShown = document.documentElement.scrollHeight - (bar.hidden ? height : 0);
		return window.scrollY + window.innerHeight < heightWhenShown - height;
	}

	function update(): void {
		const y = Math.max(0, window.scrollY);
		const delta = y - lastY;
		if (Math.abs(delta) < DELTA_PX) {
			// 抖动或微小位移：保留基线，等累计超过阈值再判断方向
			return;
		}
		lastY = y;
		if (y <= SHOW_NEAR_TOP_PX || delta < 0) {
			showAll();
			return;
		}
		if (y <= HIDE_AFTER_PX || holdsFocus()) {
			return;
		}
		for (const bar of bars) {
			if (bar.edge === 'bottom' && !hasRoomBelow(bar)) {
				// 下方已没有足够空间：保持、或重新恢复可见，否则会露出被 transform 撑出的空白
				setBarHidden(bar, false);
				continue;
			}
			setBarHidden(bar, true);
		}
	}

	function onScroll(): void {
		if (!active || !enabled || scheduled) {
			return;
		}
		// 滚动事件比帧密集得多，每帧最多判断一次
		scheduled = true;
		frame = window.requestAnimationFrame(() => {
			scheduled = false;
			frame = null;
			if (active) {
				update();
			}
		});
	}

	/** 视口条件变化：无论进入还是离开小屏，都回到展开状态并重置判定基线 */
	function onMediaChange(event: MediaQueryListEvent): void {
		enabled = event.matches;
		showAll();
		lastY = Math.max(0, window.scrollY);
	}

	window.addEventListener('scroll', onScroll, { passive: true });
	query.addEventListener('change', onMediaChange);

	return {
		show: () => {
			showAll();
			lastY = Math.max(0, window.scrollY);
		},
		destroy: () => {
			active = false;
			window.removeEventListener('scroll', onScroll);
			query.removeEventListener('change', onMediaChange);
			if (frame !== null) {
				window.cancelAnimationFrame(frame);
				frame = null;
			}
			showAll();
		},
	};
}
