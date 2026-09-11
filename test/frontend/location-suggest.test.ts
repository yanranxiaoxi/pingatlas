/**
 * @jest-environment jsdom
 */
import type { ProbeIndex, ProbeIndexKind, SuggestCandidate } from '../../src/frontend/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// ui 模块的确定性替身：真实 countryName 依赖运行环境语言（本地为中文），
// 会让断言随机器变化，这里锁定为固定英文名。
jest.unstable_mockModule('../../src/frontend/ui', () => {
	const NAMES: Record<string, string> = { CN: 'China', DE: 'Germany', US: 'United States' };
	return {
		countryName: (code: string) => NAMES[code] ?? code,
		flagEmoji: (code: string) => (/^[A-Z]{2}$/i.test(code)
			? String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1A5 + c.charCodeAt(0)))
			: ''),
		el: (tag: string, attrs: Record<string, string> = {}, children: Array<HTMLElement | string> = []) => {
			const node = document.createElement(tag);
			for (const [key, value] of Object.entries(attrs)) {
				node.setAttribute(key, value);
			}
			for (const child of children) {
				node.append(child);
			}
			return node;
		},
	};
});

const INDEX_URL = '/api/probes';
const STORAGE_KEY = 'pa-probe-index';
const INDEX_VERSION = 1;

/** 一份小而全的索引样本，取值刻意包含「Fuzhou / Fuzho」这类跳字场景 */
function makeIndex(overrides: Partial<ProbeIndex> = {}): ProbeIndex {
	return {
		version: INDEX_VERSION,
		generatedAt: Date.now(),
		total: 12,
		countries: [['CN', 6], ['DE', 3], ['US', 2]],
		regions: [['Eastern Asia', 6], ['Western Europe', 3]],
		cities: [['Fuzhou', 'CN', 4], ['Fuzhou', 'US', 1], ['Frankfurt', 'DE', 3]],
		networks: [['Chinanet', 4134, 4], ['China Telecom', 4134, 2], ['Google LLC', 15169, 5]],
		tags: [['datacenter-network', 6], ['eyeball-network', 4], ['u-zGato', 3]],
		...overrides,
	};
}

/** 造一条候选（默认 label = text，count 相同，仅用于打分排序测试） */
function candidate(text: string, extra: Partial<SuggestCandidate> = {}): SuggestCandidate {
	return { kind: 'city', text, label: text, count: 1, score: 0, ...extra };
}

// 被测模块：每个 describe 前重新导入以便重置模块级缓存
let suggest!: typeof import('../../src/frontend/location-suggest');
let fetchMock: jest.MockedFunction<typeof fetch>;

/** jsdom 环境没有 Response，用一个最小替身承载 JSON 响应 */
function fakeResponse(payload: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers({ 'content-type': 'application/json' }),
		json: async () => payload,
	} as unknown as Response;
}

/** 让 /api/probes 返回给定索引（`index` 为 null 时返回非 2xx） */
function respondWith(index: ProbeIndex | null, status = 200): void {
	fetchMock.mockImplementation(async () =>
		(index === null
			? fakeResponse({}, status === 200 ? 502 : status)
			: fakeResponse(index, status)
		) as unknown as never);
}

beforeEach(async () => {
	jest.useFakeTimers();
	localStorage.clear();
	document.body.replaceChildren();
	fetchMock = jest.fn<typeof fetch>();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	await jest.isolateModulesAsync(async () => {
		suggest = await import('../../src/frontend/location-suggest');
	});
	suggest.resetProbeIndexCache();
});

afterEach(() => {
	suggest.resetProbeIndexCache();
	localStorage.clear();
	jest.useRealTimers();
});

// ===================== 候选构建 =====================

describe('buildCandidates', () => {
	it('国家候选回填 ISO 码，展示本地化国名与国旗', () => {
		const [cn] = suggest.buildCandidates(makeIndex(), 'country');

		expect(cn.text).toBe('CN');
		expect(cn.meta).toBe('CN');
		expect(cn.label.length).toBeGreaterThan(0);
		expect(cn.badge).toBe('🇨🇳');
		expect(cn.count).toBe(6);
	});

	it('国家候选可以按英文名搜索（界面语言非英文时也成立）', () => {
		const countries = suggest.buildCandidates(makeIndex(), 'country');

		expect(countries[0].keywords).toBe('China');
		// 展示用的是本地化国名，但用户往往直接敲英文名
		expect(suggest.matchCandidates(countries, 'Chin').map(c => c.text)).toEqual(['CN']);
		expect(suggest.matchCandidates(countries, 'Germ').map(c => c.text)).toEqual(['DE']);
		// 跳字子序列同样能命中英文名
		expect(suggest.matchCandidates(countries, 'Grmny').map(c => c.text)).toEqual(['DE']);
	});

	it('地区候选直接回填地区名', () => {
		const [first] = suggest.buildCandidates(makeIndex(), 'region');

		expect(first.text).toBe('Eastern Asia');
		expect(first.count).toBe(6);
	});

	it('城市候选带上国家用于消歧', () => {
		const cities = suggest.buildCandidates(makeIndex(), 'city');

		expect(cities.map(c => c.text)).toEqual(['Fuzhou', 'Fuzhou', 'Frankfurt']);
		expect(cities[0].meta).toBe('🇨🇳 China');
		expect(cities[1].meta).toBe('🇺🇸 United States');
	});

	it('网络候选展示 ASN', () => {
		const networks = suggest.buildCandidates(makeIndex(), 'network');
		const google = networks.find(c => c.text === 'Google LLC');

		expect(networks.map(c => c.text)).toEqual(['Chinanet', 'China Telecom', 'Google LLC']);
		expect(google?.meta).toBe('AS15169');
	});

	it('标签候选保留原始标签', () => {
		expect(suggest.buildCandidates(makeIndex(), 'tag').map(c => c.text))
			.toEqual(['datacenter-network', 'eyeball-network', 'u-zGato']);
	});

	it('ASN 候选合并同一 ASN 的多个网络名', () => {
		const asns = suggest.buildCandidates(makeIndex(), 'asn');

		expect(asns.map(c => c.text)).toEqual(['4134', '15169']);
		// 4134 有 4 + 2 = 6 个探针，超过 15169 的 5 个
		expect(asns[0].count).toBe(6);
		expect(asns[0].label).toBe('AS4134');
		expect(asns[0].meta).toBe('Chinanet');
		expect(asns[1].label).toBe('AS15169');
	});

	it('索引缺字段时不报错', () => {
		const empty = makeIndex({ countries: [], regions: [], cities: [], networks: [], tags: [] });
		for (const kind of ['country', 'region', 'city', 'asn', 'network', 'tag'] as ProbeIndexKind[]) {
			expect(suggest.buildCandidates(empty, kind)).toEqual([]);
		}
	});
});

describe('buildMixedCandidates', () => {
	it('混合全部来源并标出类型', () => {
		const mixed = suggest.buildMixedCandidates(makeIndex());
		const kinds = new Set(mixed.map(c => c.kind));

		expect(kinds).toEqual(new Set(['country', 'region', 'city', 'asn', 'network', 'tag']));
		// i18n 未初始化时 t() 原样返回 key，正好用来断言用的是哪个 key
		expect(mixed.find(c => c.kind === 'city')?.badge).toBe('suggestKindCity');
		expect(mixed.find(c => c.kind === 'asn')?.badge).toBe('suggestKindAsn');
	});

	it('混合候选数量等于各来源之和', () => {
		const mixed = suggest.buildMixedCandidates(makeIndex());

		// 3 国家 + 2 地区 + 3 城市 + 2 ASN + 3 网络 + 3 标签
		expect(mixed).toHaveLength(16);
	});
});

// ===================== 模糊匹配 =====================

describe('matchCandidates', () => {
	it('跳字子序列也能命中：Fuzho → Fuzhou', () => {
		const cities = suggest.buildCandidates(makeIndex(), 'city');
		const matches = suggest.matchCandidates(cities, 'Fuzho');

		expect(matches.map(c => c.text)).toContain('Fuzhou');
	});

	it('同为子序列匹配时跳得越多分越低', () => {
		// fuzxho 跨度 6、跳过 1 个字符；fuzxxho 跨度 7、跳过 2 个字符
		const pool = [candidate('fuzxxho'), candidate('fuzxho')];
		const order = suggest.matchCandidates(pool, 'fuzho').map(c => c.text);

		expect(order).toEqual(['fuzxho', 'fuzxxho']);
	});

	it('精确 > 前缀 > 包含 > 子序列', () => {
		const pool = [
			candidate('zzz'),
			candidate('fuzxxho'),
			candidate('xfuzhou'),
			candidate('fuzhou'),
			candidate('fuzho'),
		];
		const order = suggest.matchCandidates(pool, 'fuzho').map(c => c.text);

		expect(order).toEqual(['fuzho', 'fuzhou', 'xfuzhou', 'fuzxxho']);
		expect(order).not.toContain('zzz');
	});

	it('忽略大小写', () => {
		const matches = suggest.matchCandidates([candidate('Fuzhou')], 'FUZHO');

		expect(matches).toHaveLength(1);
	});

	it('忽略变音符号', () => {
		expect(suggest.matchCandidates([candidate('Zürich')], 'zurich')).toHaveLength(1);
		expect(suggest.matchCandidates([candidate('Zurich')], 'zürich')).toHaveLength(1);
	});

	it('空查询或纯空白查询不返回任何候选', () => {
		const pool = suggest.buildCandidates(makeIndex(), 'city');

		expect(suggest.matchCandidates(pool, '')).toEqual([]);
		expect(suggest.matchCandidates(pool, '   ')).toEqual([]);
	});

	it('多个关键词之间是 AND 关系', () => {
		const cities = suggest.buildCandidates(makeIndex(), 'city');

		expect(suggest.matchCandidates(cities, 'fuzhou china')).toHaveLength(1);
		expect(suggest.matchCandidates(cities, 'frankfurt china')).toEqual([]);
	});

	it('子序列完全不成立时不命中', () => {
		expect(suggest.matchCandidates([candidate('Fuzhou')], 'zzz')).toEqual([]);
	});

	it('得分相同时探针多的排前面', () => {
		const pool = [candidate('xfoo', { count: 1 }), candidate('yfoo', { count: 99 })];
		const order = suggest.matchCandidates(pool, 'foo').map(c => c.text);

		expect(order).toEqual(['yfoo', 'xfoo']);
	});

	it('得分与数量都相同时短标签排前面', () => {
		const pool = [candidate('xTokyo Bay'), candidate('xTokyo')];
		const order = suggest.matchCandidates(pool, 'tokyo').map(c => c.text);

		expect(order).toEqual(['xTokyo', 'xTokyo Bay']);
	});

	it('个人标签 u-* 降权，但仍可被搜到', () => {
		const pool = [
			candidate('u-tokyo', { kind: 'tag', count: 100 }),
			candidate('my-tokyo', { kind: 'tag', count: 1 }),
		];
		const order = suggest.matchCandidates(pool, 'tokyo').map(c => c.text);

		expect(order).toEqual(['my-tokyo', 'u-tokyo']);
		expect(suggest.matchCandidates([candidate('u-zGato', { kind: 'tag' })], 'gato')).toHaveLength(1);
	});

	it('遵守 limit 上限', () => {
		const pool = suggest.buildCandidates(makeIndex(), 'city');

		expect(suggest.matchCandidates(pool, 'fu', 1)).toHaveLength(1);
		expect(suggest.matchCandidates(pool, 'fu', 0)).toHaveLength(0);
	});

	it('不修改传入的候选对象', () => {
		const pool = [candidate('Fuzhou', { score: 0 })];
		suggest.matchCandidates(pool, 'fuzhou');

		expect(pool[0].score).toBe(0);
	});

	it('国名只出现在说明里也能匹配到城市', () => {
		const cities = suggest.buildCandidates(makeIndex(), 'city');
		// 「China」只出现在 meta 里，不在城市名里
		const byCountry = suggest.matchCandidates(cities, 'china');

		expect(byCountry.map(c => c.text)).toEqual(['Fuzhou']);
	});

	it('城市候选附带隐藏的 ISO 国家码，便于直接按代码过滤', () => {
		const cities = suggest.buildCandidates(makeIndex(), 'city');

		expect(cities[0].keywords).toBe('CN China');
		expect(suggest.matchCandidates(cities, 'cn').map(c => `${c.text} ${c.meta}`))
			.toEqual(['Fuzhou 🇨🇳 China']);
	});
});

// ===================== 索引加载 =====================

describe('loadProbeIndex', () => {
	it('首次调用从 /api/probes 拉取并写入 localStorage', async () => {
		respondWith(makeIndex());
		const index = await suggest.loadProbeIndex();

		expect(index?.total).toBe(12);
		expect(fetchMock).toHaveBeenCalledWith(INDEX_URL, { headers: { Accept: 'application/json' } });
		expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy();
	});

	it('第二次调用直接用内存缓存，不再发请求', async () => {
		respondWith(makeIndex());
		await suggest.loadProbeIndex();
		await suggest.loadProbeIndex();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('优先使用未过期的本地缓存，不发请求', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), index: makeIndex() }));

		const index = await suggest.loadProbeIndex();

		expect(index?.total).toBe(12);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('缓存超过 TTL 时先用旧数据，同时后台刷新', async () => {
		const stale = makeIndex({ generatedAt: Date.now() - suggest.INDEX_TTL - 1, total: 7 });
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), index: stale }));
		respondWith(makeIndex({ total: 20 }));

		const index = await suggest.loadProbeIndex();
		expect(index?.total).toBe(7);

		await jest.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 刷新写回内存后，下一次读取就是新数据
		expect((await suggest.loadProbeIndex())?.total).toBe(20);
	});

	it('缓存超过最大保留期时直接丢弃', async () => {
		const ancient = makeIndex();
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now() - 4 * 24 * 60 * 60 * 1000, index: ancient }));
		respondWith(makeIndex({ total: 33 }));

		expect((await suggest.loadProbeIndex())?.total).toBe(33);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('索引版本不匹配时丢弃缓存', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), index: makeIndex({ version: 99 }) }));
		respondWith(makeIndex({ total: 42 }));

		expect((await suggest.loadProbeIndex())?.total).toBe(42);
	});

	it('缓存结构损坏（cities 不是数组）时丢弃', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({
			savedAt: Date.now(),
			index: { ...makeIndex(), cities: null },
		}));
		respondWith(makeIndex({ total: 11 }));

		expect((await suggest.loadProbeIndex())?.total).toBe(11);
	});

	it('缓存内容不是合法 JSON 时降级到网络', async () => {
		localStorage.setItem(STORAGE_KEY, '{ not json');
		respondWith(makeIndex({ total: 5 }));

		expect((await suggest.loadProbeIndex())?.total).toBe(5);
	});

	it('上游返回非 2xx 时返回 null', async () => {
		respondWith(null);

		expect(await suggest.loadProbeIndex()).toBeNull();
	});

	it('网络异常时返回 null（补全静默失效但页面可用）', async () => {
		fetchMock.mockImplementation(async () => {
			throw new Error('offline');
		});

		expect(await suggest.loadProbeIndex()).toBeNull();
	});

	it('上游返回的索引版本不匹配时返回 null', async () => {
		respondWith(makeIndex({ version: 99 }));

		expect(await suggest.loadProbeIndex()).toBeNull();
	});

	it('并发调用只发一次请求', async () => {
		respondWith(makeIndex());
		const [a, b] = await Promise.all([suggest.loadProbeIndex(), suggest.loadProbeIndex()]);

		expect(a?.total).toBe(12);
		expect(b?.total).toBe(12);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

// ===================== 输入框绑定 =====================

/** 造一个真实的输入框挂到 body 上 */
function mountInput(id: string): HTMLInputElement {
	const input = document.createElement('input');
	input.id = id;
	input.type = 'text';
	document.body.append(input);
	return input;
}

/** 模拟用户输入并等待防抖 */
async function typeValue(input: HTMLInputElement, value: string, wait = 200): Promise<void> {
	input.focus();
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await jest.advanceTimersByTimeAsync(wait);
}

function panel(): HTMLElement | null {
	return document.querySelector('.suggest-panel:not([hidden])');
}

function items(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('.suggest-item')];
}

describe('下拉面板', () => {
	it('输入 Fuzho 时弹出包含 Fuzhou 的候选', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input: 'loc-city', source: 'city' });

		await typeValue(input, 'Fuzho');

		expect(panel()).not.toBeNull();
		expect(items().map(n => n.querySelector('.suggest-label')?.textContent)).toContain('Fuzhou');
	});

	it('面板挂在 body 上，不会被表单滚动容器裁掉', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');

		expect(panel()?.parentElement).toBe(document.body);
	});

	it('输入框被标记为 combobox 并关联面板', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');

		expect(input.getAttribute('role')).toBe('combobox');
		expect(input.getAttribute('aria-autocomplete')).toBe('list');
		expect(input.getAttribute('aria-expanded')).toBe('true');
		expect(input.getAttribute('aria-controls')).toBe(document.querySelector('.suggest-list')?.id);
		expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
	});

	it('候选项带类型、说明与探针数量', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzhou');
		const first = items()[0];

		expect(first.querySelector('.suggest-count')?.textContent).toBe('suggestProbes');
		expect(first.getAttribute('role')).toBe('option');
	});

	it('无匹配时显示空态提示', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'zzzzz');

		expect(document.querySelector('.suggest-empty')?.textContent).toBe('suggestEmpty');
		expect(items()).toHaveLength(0);
	});

	it('清空输入后关闭面板', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzhou');
		expect(panel()).not.toBeNull();

		await typeValue(input, '');
		expect(panel()).toBeNull();
	});

	it('点击候选项回填输入框并关闭面板', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');
		items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(input.value).toBe('Fuzhou');
		expect(panel()).toBeNull();
	});

	it('方向键切换高亮项', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'fuzhou');
		expect(items()[0].classList.contains('is-active')).toBe(true);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(items()[1].classList.contains('is-active')).toBe(true);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		expect(items()[0].classList.contains('is-active')).toBe(true);

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		expect(items()[items().length - 1].classList.contains('is-active')).toBe(true);
	});

	it('回车选中高亮项并阻止表单提交', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');
		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(input.value).toBe('Fuzhou');
		expect(panel()).toBeNull();
	});

	it('面板未打开时回车不拦截，交给表单提交', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
	});

	it('Esc 关闭面板', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzhou');
		const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(panel()).toBeNull();
	});

	it('Tab 关闭面板但不拦截默认行为', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzhou');
		const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
		input.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(panel()).toBeNull();
	});

	it('输入框失焦后关闭面板', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzhou');
		input.blur();
		await jest.advanceTimersByTimeAsync(200);

		expect(panel()).toBeNull();
	});

	it('聚焦已有内容时重新弹出候选', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		input.value = 'Fuzhou';
		input.focus();
		await jest.advanceTimersByTimeAsync(50);

		expect(panel()).not.toBeNull();
	});

	it('聚焦空输入框时不弹面板', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		input.focus();
		await jest.advanceTimersByTimeAsync(50);

		expect(panel()).toBeNull();
	});

	it('回填后不立刻重新弹出（避免自我匹配回弹）', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');
		items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// applyCandidate 会派发 input 事件，紧接着的防抖窗口内不应弹回
		await jest.advanceTimersByTimeAsync(200);

		expect(panel()).toBeNull();
	});

	it('索引不可用时静默关闭，不抛异常', async () => {
		fetchMock.mockImplementation(async () => {
			throw new Error('offline');
		});
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzhou');

		expect(panel()).toBeNull();
	});

	it('magic 字段使用混合来源', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-magic');
		suggest.attachSuggest({ input, source: 'mixed' });

		await typeValue(input, 'gato');
		expect(items().length).toBeGreaterThan(0);

		const kinds = new Set(items().map(n => n.querySelector('.suggest-badge')?.textContent));
		expect(kinds.has('suggestKindTag')).toBe(true);
	});

	it('目标输入框不存在时不创建面板', () => {
		suggest.attachSuggest({ input: 'not-here', source: 'city' });

		expect(document.querySelector('.suggest-panel')).toBeNull();
	});

	it('重复绑定同一输入框不会留下多余面板', () => {
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });
		suggest.attachSuggest({ input, source: 'city' });

		expect(document.querySelectorAll('.suggest-panel')).toHaveLength(1);
	});

	it('initLocationSuggests 一次挂载全部位置字段', () => {
		respondWith(makeIndex());
		for (const id of ['loc-magic', 'loc-country', 'loc-city', 'loc-asn', 'loc-network', 'loc-tags']) {
			mountInput(id);
		}

		suggest.initLocationSuggests([
			{ input: 'loc-magic', source: 'mixed' },
			{ input: 'loc-country', source: 'country' },
			{ input: 'loc-city', source: 'city' },
			{ input: 'loc-asn', source: 'asn' },
			{ input: 'loc-network', source: 'network' },
			{ input: 'loc-tags', source: 'tag', multiple: true },
		]);

		expect(document.querySelectorAll('.suggest-panel')).toHaveLength(6);
		expect(document.querySelectorAll('.suggest-panel[hidden]')).toHaveLength(6);
	});

	it('closeAllSuggests 关闭全部面板', async () => {
		respondWith(makeIndex());
		const city = mountInput('loc-city');
		const network = mountInput('loc-network');
		suggest.initLocationSuggests([
			{ input: city, source: 'city' },
			{ input: network, source: 'network' },
		]);

		await typeValue(city, 'Fuzhou');
		expect(document.querySelectorAll('.suggest-panel:not([hidden])')).toHaveLength(1);

		// 切到另一个字段时前一个面板会因失焦自动收起
		await typeValue(network, 'Google');
		const open = document.querySelectorAll<HTMLElement>('.suggest-panel:not([hidden])');
		expect(open).toHaveLength(1);
		expect(open[0].dataset.wrap).toBe('loc-network');

		suggest.closeAllSuggests();
		expect(document.querySelectorAll('.suggest-panel:not([hidden])')).toHaveLength(0);
		expect(city.getAttribute('aria-expanded')).toBe('false');
		expect(network.getAttribute('aria-expanded')).toBe('false');
	});
});

describe('多值字段（标签）', () => {
	it('只替换光标所在的片段，并追加分隔符', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-tags');
		suggest.attachSuggest({ input, source: 'tag', multiple: true });

		input.focus();
		input.value = 'datacenter-network, eyeb';
		input.setSelectionRange(input.value.length, input.value.length);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(200);

		expect(items()[0].querySelector('.suggest-label')?.textContent).toBe('eyeball-network');
		items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(input.value).toBe('datacenter-network, eyeball-network, ');
	});

	it('光标在中间片段时只替换该片段，不追加分隔符', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-tags');
		suggest.attachSuggest({ input, source: 'tag', multiple: true });

		input.focus();
		input.value = 'eyeb, datacenter-network';
		// 光标停在第一段末尾
		input.setSelectionRange(4, 4);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(200);

		items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(input.value).toBe('eyeball-network, datacenter-network');
	});

	it('单值字段整体替换', async () => {
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		suggest.attachSuggest({ input, source: 'city' });

		input.focus();
		input.value = 'Fuz';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await jest.advanceTimersByTimeAsync(200);

		items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

		expect(input.value).toBe('Fuzhou');
	});
});

// ===================== 面板定位 =====================

describe('面板定位', () => {
	/** jsdom 不做布局，这里手动给输入框一个视口内矩形，并锁定视口高度 */
	function stubRect(input: HTMLInputElement, top: number, height = 40): void {
		input.getBoundingClientRect = () => ({
			top,
			bottom: top + height,
			left: 20,
			right: 220,
			width: 200,
			height,
			x: 20,
			y: top,
			toJSON: () => ({}),
		}) as DOMRect;
	}

	function stubViewportHeight(height: number): void {
		Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
		Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
	}

	const originalInnerHeight = window.innerHeight;
	const originalInnerWidth = window.innerWidth;

	afterEach(() => {
		stubViewportHeight(originalInnerHeight);
		Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
	});

	it('上方中间位置时向下展开，贴在输入框下方', async () => {
		stubViewportHeight(800);
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		stubRect(input, 100);
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');

		const root = panel()!;
		expect(root.style.top).toBe('144px');
		expect(root.style.bottom).toBe('auto');
		expect(root.style.maxHeight).toBe('280px');
	});

	it('输入框贴近视口底部时翻到上方展开，不溢出视口', async () => {
		stubViewportHeight(400);
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		// 输入框底边已经贴到视口底部
		stubRect(input, 350);
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');

		const root = panel()!;
		expect(root.style.top).toBe('auto');
		expect(root.style.bottom).toBe('54px');
		expect(root.style.maxHeight).toBe('280px');
	});

	it('上下空间都不足时，面板高度收缩到不超过可用空间', async () => {
		stubViewportHeight(180);
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		// 上方 100px、下方 28px
		stubRect(input, 100);
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');

		const maxHeight = Number.parseFloat(panel()!.style.maxHeight);
		// 下方只剩 180 - 140 - 16 = 24px，撑不到最小高度，于是翻到上方
		expect(panel()!.style.top).toBe('auto');
		expect(maxHeight).toBeLessThanOrEqual(280);
		expect(maxHeight).toBeGreaterThan(0);
	});

	it('窗口滚动时跟随输入框重新定位', async () => {
		stubViewportHeight(800);
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		stubRect(input, 100);
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');
		stubRect(input, 300);
		window.dispatchEvent(new Event('scroll'));

		expect(panel()!.style.top).toBe('344px');
	});

	it('输入框被滚出视口时仍然跟随锚定，不抛异常', async () => {
		stubViewportHeight(400);
		respondWith(makeIndex());
		const input = mountInput('loc-city');
		stubRect(input, 380);
		suggest.attachSuggest({ input, source: 'city' });

		await typeValue(input, 'Fuzho');
		// 输入框整体落在视口下方，面板跟随到输入框上方（同样在视口外，滚回来后会自动归位）
		stubRect(input, 500);
		expect(() => window.dispatchEvent(new Event('scroll'))).not.toThrow();

		const root = panel()!;
		expect(root.style.bottom).toBe('-96px');
		expect(root.style.top).toBe('auto');
	});
});
