/**
 * @jest-environment jsdom
 */
import type { LocationFilters, ProbeRecord } from '../../src/frontend/types';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PROBE_LIST_LIMIT } from '../../src/frontend/probes';

type ProbeListModule = typeof import('../../src/frontend/probe-list');
type PanelModule = typeof import('../../src/frontend/panel');
type ProbesModule = typeof import('../../src/frontend/probes');

const toastMock = jest.fn();

jest.unstable_mockModule('../../src/frontend/ui', () => ({
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
	countryName: (code: string) => ({ FI: 'Finland', DE: 'Germany', CN: 'China' })[code] ?? code,
	flagEmoji: () => '',
	toast: toastMock,
}));

jest.unstable_mockModule('../../src/frontend/i18n', () => ({
	t: (key: string, params?: Record<string, string | number>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

function probe(
	city: string,
	country: string,
	asn: number,
	network: string,
	tags: string[] = [],
	continent = 'EU',
	region = 'Western Europe',
): ProbeRecord {
	return [city, country, continent, region, asn, network, tags];
}

const HELSINKI = probe('Helsinki', 'FI', 24940, 'Hetzner Online', ['datacenter-network'], 'EU', 'Northern Europe');
const FRANKFURT = probe('Frankfurt', 'DE', 15169, 'Google LLC', ['datacenter-network']);
const BERLIN = probe('Berlin', 'DE', 3320, 'Deutsche Telekom AG', ['eyeball-network']);
const FUZHOU = probe('Fuzhou', 'CN', 4134, 'Chinanet', ['eyeball-network'], 'AS', 'Eastern Asia');
const ALL = [HELSINKI, FRANKFURT, BERLIN, FUZHOU];

let fetchMock: jest.Mock;

/** 表单骨架：magic textarea + 结构化筛选字段 */
function setupDom(): void {
	document.body.innerHTML = `
		<section class="panel result-panel">
			<div id="result-tabs" class="panel-tabs">
				<button id="tab-probes" class="panel-tab" type="button" data-tab="probes" aria-selected="false" tabindex="-1">Probes</button>
				<button id="tab-matched" class="panel-tab" type="button" data-tab="matched" aria-selected="false" tabindex="-1">Matched</button>
				<button id="tab-results" class="panel-tab" type="button" data-tab="results" aria-selected="true">Results</button>
			</div>
			<div id="panel-probes" class="panel-pane" hidden></div>
			<div id="panel-matched" class="panel-pane" hidden></div>
			<div id="results" class="results panel-pane"></div>
		</section>
		<form id="measure-form">
			<textarea id="loc-magic"></textarea>
			<input id="loc-continent" />
			<input id="loc-country" />
			<input id="loc-city" />
			<input id="loc-asn" />
			<input id="loc-network" />
			<input id="loc-tags" />
			<button id="reset-btn" type="button">reset</button>
		</form>`;
}

function field(id: string): HTMLInputElement | HTMLTextAreaElement {
	return document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
}

function pane(id: string): HTMLElement {
	return document.getElementById(id) as HTMLElement;
}

/** 探针行的位置列文本 */
function rowCities(root: HTMLElement): string[] {
	return [...root.querySelectorAll('tbody tr')].map(row => row.querySelector('.probe-loc-text')?.textContent ?? '');
}

function readFilters(): LocationFilters {
	const tags = field('loc-tags').value.trim();
	return {
		continent: field('loc-continent').value.trim(),
		country: field('loc-country').value.trim(),
		city: field('loc-city').value.trim(),
		asn: field('loc-asn').value.trim() ? Number(field('loc-asn').value) : null,
		network: field('loc-network').value.trim(),
		tags: tags ? tags.split(/\s+/).filter(Boolean) : [],
		magic: field('loc-magic').value.replace(/[\r\n]+/g, ', ').trim(),
	};
}

function writeMagic(value: string): void {
	field('loc-magic').value = value;
}

interface Harness {
	probeList: ProbeListModule;
	panel: PanelModule;
	probes: ProbesModule;
}

async function boot(list: ProbeRecord[] | null = ALL): Promise<Harness> {
	const probes = await import('../../src/frontend/probes');
	probes.resetProbeListCache();
	fetchMock.mockResolvedValue({
		ok: list !== null,
		status: list === null ? 502 : 200,
		json: async () => list ?? {},
	} as unknown as Response);

	const panel = await import('../../src/frontend/panel');
	const probeList = await import('../../src/frontend/probe-list');
	panel.initPanelTabs();
	probeList.initProbeLists({
		probesRoot: pane('panel-probes'),
		matchedRoot: pane('panel-matched'),
		readFilters,
		writeMagic,
	});
	return { probeList, panel, probes };
}

/** 等一轮微任务，让列表完成渲染 */
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
	jest.resetModules();
	setupDom();
	toastMock.mockClear();
	fetchMock = jest.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	document.body.replaceChildren();
});

describe('Probes 列表', () => {
	it('默认标签页是「测试结果」时不加载探针列表', async () => {
		await boot();

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('切到 Probes 标签并等待渲染后列出全部探针', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		expect(fetchMock.mock.calls[0][0]).toBe('/api/probe-list');
		expect(rowCities(pane('panel-probes'))).toEqual(['Helsinki, Finland', 'Frankfurt, Germany', 'Berlin, Germany', 'Fuzhou, China']);
	});

	it('只显示结构化筛选命中的探针（不含 magic）', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		field('loc-country').value = 'DE';
		field('loc-country').dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		expect(rowCities(pane('panel-probes'))).toEqual(['Frankfurt, Germany', 'Berlin, Germany']);
	});

	it('点 + 不会让 Probes 列表缩水（magic 不参与该列表筛选）', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		(pane('panel-probes').querySelector('.probe-add') as HTMLButtonElement).click();
		await flush();

		expect(field('loc-magic').value).toBe('Helsinki+FI+AS24940+datacenter-network');
		// 依旧列出全部四条：点 + 不应把候选集收窄到刚选中的那条
		expect(rowCities(pane('panel-probes'))).toHaveLength(4);
	});

	it('表格列出 ASN / 网络 / 标签', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		const row = pane('panel-probes').querySelector('tbody tr') as HTMLElement;
		const cells = [...row.querySelectorAll('td')].map(cell => cell.textContent ?? '');

		// 列顺序：位置 / ASN / 网络 / 标签 / 操作
		expect(cells).toHaveLength(5);
		expect(cells[1]).toBe('AS24940');
		expect(cells[2]).toBe('Hetzner Online');
		expect(cells[3]).toBe('datacenter-network');
	});

	it('次区域与大洲不占列，改为位置单元格的悬浮提示', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		const first = pane('panel-probes').querySelector('tbody tr .probe-loc') as HTMLElement;
		const second = pane('panel-probes').querySelectorAll('tbody tr')[1].querySelector('.probe-loc') as HTMLElement;

		// 大洲只作为次区域缺失时的兜底：并列会输出 `Eastern Asia · AS`，
		// 那个 AS 容易被误读成被截断的 ASN
		expect(first.getAttribute('title')).toBe('Helsinki, Finland · Northern Europe');
		expect(second.getAttribute('title')).toBe('Frankfurt, Germany · Western Europe');
		expect(pane('panel-probes').querySelectorAll('.probe-region')).toHaveLength(0);
	});

	it('次区域缺失时悬浮提示退回大洲', async () => {
		const noRegion: ProbeRecord[] = [probe('Nowhere', 'DE', 3320, 'Deutsche Telekom AG', [], 'EU', '')];
		const { panel } = await boot(noRegion);
		panel.setActiveTab('probes');
		await flush();

		const cell = pane('panel-probes').querySelector('tbody tr .probe-loc') as HTMLElement;

		expect(cell.getAttribute('title')).toBe('Nowhere, Germany · EU');
	});

	it('数据不可用时给出说明而不是空白', async () => {
		const { panel } = await boot(null);
		panel.setActiveTab('probes');
		await flush();

		expect(pane('panel-probes').textContent).toBe('probeListUnavailable');
		expect(pane('panel-matched').textContent).toBe('probeListUnavailable');
	});

	it('无命中时给出空状态说明', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		field('loc-country').value = 'ZZ';
		field('loc-country').dispatchEvent(new Event('change', { bubbles: true }));
		await flush();

		expect(pane('panel-probes').querySelector('.probe-summary')?.textContent)
			.toBe('probeListSummary:{"total":0}');
		expect(pane('panel-probes').querySelectorAll('tbody tr')).toHaveLength(0);
		// 无命中时不重复输出：顶部那行与空表头本来就同屏可见
		expect(pane('panel-probes').querySelector('.probe-summary-bottom')).toBeNull();
		// 表头仍在，便于用户对照列含义
		expect(pane('panel-probes').querySelectorAll('thead th')).toHaveLength(5);
	});
});

describe('匹配 Probes 列表', () => {
	it('按 magic 列出命中的探针', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Frankfurt+DE, Berlin+DE';
		panel.setActiveTab('matched');
		await flush();

		expect(rowCities(pane('panel-matched'))).toEqual(['Frankfurt, Germany', 'Berlin, Germany']);
	});

	it('X 从 magic 中移除对应片段', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Frankfurt+DE+AS15169, Berlin+DE+AS3320';
		panel.setActiveTab('matched');
		await flush();

		const removeButton = pane('panel-matched').querySelector('.probe-remove') as HTMLButtonElement;
		removeButton.click();
		await flush();

		expect(field('loc-magic').value).toBe('Berlin+DE+AS3320');
		expect(rowCities(pane('panel-matched'))).toEqual(['Berlin, Germany']);
	});

	it('宽泛条件带进来的探针不提供 X', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'DE';
		panel.setActiveTab('matched');
		await flush();

		expect(pane('panel-matched').querySelectorAll('.probe-remove')).toHaveLength(0);
		expect(pane('panel-matched').querySelectorAll('.probe-broad')).toHaveLength(2);
	});

	it('有结构化筛选时按结构化条件匹配，且不提供 X', async () => {
		const { panel } = await boot();
		field('loc-country').value = 'DE';
		field('loc-magic').value = 'Frankfurt+DE+AS15169';
		panel.setActiveTab('matched');
		await flush();

		expect(rowCities(pane('panel-matched'))).toEqual(['Frankfurt, Germany', 'Berlin, Germany']);
		expect(pane('panel-matched').querySelectorAll('.probe-remove')).toHaveLength(0);
	});

	it('无命中时给出空状态说明', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Nowhere+ZZ';
		panel.setActiveTab('matched');
		await flush();

		expect(pane('panel-matched').textContent).toBe('probeMatchEmpty');
	});

	it('空 magic 时列出全部探针（不限）', async () => {
		const { panel } = await boot();
		panel.setActiveTab('matched');
		await flush();

		expect(rowCities(pane('panel-matched'))).toHaveLength(4);
	});
});

describe('自动切换标签页', () => {
	it('改动结构化筛选字段时切到 Probes 列表', async () => {
		const { panel } = await boot();
		expect(panel.getActiveTab()).toBe('results');

		field('loc-country').value = 'DE';
		field('loc-country').dispatchEvent(new Event('change', { bubbles: true }));

		expect(panel.getActiveTab()).toBe('probes');
	});

	it('改动 magic 时切到匹配 Probes 列表', async () => {
		const { panel } = await boot();

		field('loc-magic').value = 'Frankfurt+DE';
		field('loc-magic').dispatchEvent(new Event('input', { bubbles: true }));

		expect(panel.getActiveTab()).toBe('matched');
	});

	it('改动与位置无关的字段不会切换标签页', async () => {
		const { panel } = await boot();
		const target = document.createElement('input');
		target.id = 'target';
		document.getElementById('measure-form')?.append(target);

		target.dispatchEvent(new Event('input', { bubbles: true }));

		expect(panel.getActiveTab()).toBe('results');
	});
});

describe('探针列表交互细节', () => {
	it('重复点 + 会提示已在匹配中，且不重复写入', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Helsinki+FI+AS24940+datacenter-network';
		panel.setActiveTab('probes');
		await flush();

		(pane('panel-probes').querySelector('.probe-add') as HTMLButtonElement).click();
		await flush();

		expect(field('loc-magic').value).toBe('Helsinki+FI+AS24940+datacenter-network');
		expect(toastMock).toHaveBeenCalledWith('probeAlreadyAdded', 'info');
	});

	it('+ 按钮带可访问名称与目标片段', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		const button = pane('panel-probes').querySelector('.probe-add') as HTMLButtonElement;

		expect(button.getAttribute('aria-label')).toBe('probeAddTitle');
		expect(button.getAttribute('data-fragment')).toBe('Helsinki+FI+AS24940+datacenter-network');
	});

	it('+ 保留已有条件，只追加新片段', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Berlin+DE+AS3320';
		panel.setActiveTab('probes');
		await flush();

		(pane('panel-probes').querySelector('.probe-add') as HTMLButtonElement).click();
		await flush();

		expect(field('loc-magic').value).toBe('Berlin+DE+AS3320, Helsinki+FI+AS24940+datacenter-network');
	});

	it('+ 会去掉占位用的 world', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'world';
		panel.setActiveTab('probes');
		await flush();

		(pane('panel-probes').querySelector('.probe-add') as HTMLButtonElement).click();
		await flush();

		expect(field('loc-magic').value).toBe('Helsinki+FI+AS24940+datacenter-network');
	});

	it('+ / X 会派发 input 事件，让自动补全与筛选逻辑感知变化', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		const seen: string[] = [];
		field('loc-magic').addEventListener('input', () => seen.push('input'));

		(pane('panel-probes').querySelector('.probe-add') as HTMLButtonElement).click();
		await flush();

		expect(seen).toEqual(['input']);
	});

	it('X 按钮带片段说明', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Helsinki+FI+AS24940';
		panel.setActiveTab('matched');
		await flush();

		const button = pane('panel-matched').querySelector('.probe-remove') as HTMLButtonElement;

		expect(button.getAttribute('aria-label')).toBe('probeRemoveTitle:{"fragment":"Helsinki+FI+AS24940"}');
	});

	it('展示匹配总数与显示条数（顶部与底部各一处）', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		const summaries = pane('panel-probes').querySelectorAll('.probe-summary');

		expect(summaries).toHaveLength(2);
		for (const node of summaries) {
			// 4 条全部列出，不提「显示前 M 个」
			expect(node.textContent).toBe('probeListSummary:{"total":4}');
		}
	});

	it('命中数超过上限时才说明只显示了前 M 个', async () => {
		const many: ProbeRecord[] = Array.from(
			{ length: PROBE_LIST_LIMIT + 3 },
			(_, index) => probe(`City${index}`, 'DE', 3320, 'Deutsche Telekom AG'),
		);
		const { panel } = await boot(many);
		panel.setActiveTab('probes');
		await flush();

		const root = pane('panel-probes');
		expect(root.querySelectorAll('tbody tr')).toHaveLength(PROBE_LIST_LIMIT);
		for (const node of root.querySelectorAll('.probe-summary')) {
			expect(node.textContent).toBe(`probeListSummaryTruncated:{"shown":${PROBE_LIST_LIMIT},"total":${PROBE_LIST_LIMIT + 3}}`);
		}
	});

	it('命中数恰好等于上限时仍算全部显示，不提「显示前 M 个」', async () => {
		const exact: ProbeRecord[] = Array.from(
			{ length: PROBE_LIST_LIMIT },
			(_, index) => probe(`City${index}`, 'DE', 3320, 'Deutsche Telekom AG'),
		);
		const { panel } = await boot(exact);
		panel.setActiveTab('probes');
		await flush();

		const root = pane('panel-probes');
		expect(root.querySelectorAll('tbody tr')).toHaveLength(PROBE_LIST_LIMIT);
		for (const node of root.querySelectorAll('.probe-summary')) {
			expect(node.textContent).toBe(`probeListSummary:{"total":${PROBE_LIST_LIMIT}}`);
		}
	});

	it('底部汇总位于表格之后、且对读屏隐藏', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		const root = pane('panel-probes');
		const bottom = root.querySelector('.probe-summary-bottom');

		expect(bottom).not.toBeNull();
		// 顺序：顶部汇总 → 表格 → 底部汇总
		expect([...root.children].map(node => node.className.split(' ')[0] ?? node.tagName.toLowerCase()))
			.toEqual(['probe-summary', 'table-wrap', 'probe-summary']);
		expect(root.lastElementChild).toBe(bottom);
		// 同一区域内重复同一句话，标为 aria-hidden 避免读两遍
		expect(bottom?.getAttribute('aria-hidden')).toBe('true');
		expect(root.querySelector('.probe-summary:not(.probe-summary-bottom)')?.getAttribute('aria-hidden')).toBeNull();
	});

	it('匹配 Probes 列表同样在底部给出汇总', async () => {
		const { panel } = await boot();
		field('loc-magic').value = 'Frankfurt+DE, Berlin+DE';
		panel.setActiveTab('matched');
		await flush();

		const summaries = pane('panel-matched').querySelectorAll('.probe-summary');

		expect(summaries).toHaveLength(2);
		for (const node of summaries) {
			expect(node.textContent).toBe('probeListSummary:{"total":2}');
		}
	});

	it('重置表单后列表回到全量', async () => {
		const { panel } = await boot();
		panel.setActiveTab('probes');
		await flush();

		field('loc-country').value = 'DE';
		field('loc-country').dispatchEvent(new Event('change', { bubbles: true }));
		await flush();
		expect(rowCities(pane('panel-probes'))).toHaveLength(2);

		// 表单 reset 会把控件恢复为默认值（这里都是空）
		(field('loc-country') as HTMLInputElement).value = '';
		document.getElementById('reset-btn')?.click();
		await new Promise(resolve => setTimeout(resolve, 5));

		expect(rowCities(pane('panel-probes'))).toHaveLength(4);
	});

	it('未初始化时直接调用 render 不报错', async () => {
		const probeList = await import('../../src/frontend/probe-list');

		expect(() => probeList.render()).not.toThrow();
	});

	it('重复初始化只绑定一次（避免重复渲染）', async () => {
		const { panel } = await boot();
		const probeList = await import('../../src/frontend/probe-list');

		probeList.initProbeLists({
			probesRoot: pane('panel-probes'),
			matchedRoot: pane('panel-matched'),
			readFilters,
			writeMagic,
		});
		panel.setActiveTab('probes');
		await flush();

		expect(pane('panel-probes').querySelectorAll('table')).toHaveLength(1);
	});
});
