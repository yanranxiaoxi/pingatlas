import type {
	DnsAnswer,
	MeasurementRequest,
	MeasurementResponse,
	MeasurementResultItem,
	MeasurementType,
	MtrHop,
	PingStats,
	TestResult,
	TracerouteHop,
} from './types';
import { t } from './i18n';
import {
	buildTimingBars,
	copyText,
	countryName,
	el,
	flagEmoji,
	formatBytes,
	formatClock,
	formatMs,
	toast,
} from './ui';

const TYPE_LABEL_KEY: Record<MeasurementType, string> = {
	ping: 'typePing',
	traceroute: 'typeTraceroute',
	dns: 'typeDns',
	mtr: 'typeMtr',
	http: 'typeHttp',
};

function typeLabel(type: MeasurementType): string {
	return t(TYPE_LABEL_KEY[type] ?? type);
}

/** 定义列表（键值对表格），值为 null/undefined 时显示 `—` */
function definitionList(rows: Array<[string, string | number | null | undefined]>, className = ''): HTMLElement {
	const list = el('dl', { class: `kv ${className}`.trim() });
	for (const [label, value] of rows) {
		list.append(el('dt', {}, [label]));
		const text = value === null || value === undefined || value === '' ? '—' : String(value);
		list.append(el('dd', {}, [text]));
	}
	return list;
}

/** 结果卡片中的小标题 */
function sectionTitle(key: string): HTMLElement {
	return el('h4', { class: 'result-section-title' }, [t(key)]);
}

/** 原始输出折叠块 */
function rawOutputBlock(raw: string, key: string): HTMLElement {
	const details = el('details', { 'class': 'raw-output', 'data-key': key });
	details.append(el('summary', {}, [t('rawOutput')]));
	details.append(el('pre', { class: 'raw-text' }, [raw || '—']));
	return details;
}

/** 探测点标签：🇩🇪 Frankfurt, Germany */
function probeTitle(probe: MeasurementResultItem['probe']): string {
	const parts: string[] = [];
	if (probe.city) {
		parts.push(probe.city);
	}
	if (probe.country) {
		parts.push(countryName(probe.country));
	}
	return parts.join(', ') || probe.network;
}

interface StatusMeta {
	text: string;
	tone: string;
}

function resultStatus(result: TestResult): StatusMeta {
	const map: Record<string, StatusMeta> = {
		'finished': { text: t('statusFinished'), tone: 'ok' },
		'in-progress': { text: t('statusInProgress'), tone: 'pending' },
		'failed': { text: t('statusFailed'), tone: 'bad' },
		'offline': { text: t('statusOffline'), tone: 'warn' },
	};
	const meta = map[result.status] ?? { text: String(result.status), tone: '' };
	if (result.status === 'failed' && result.failureSource) {
		return { text: `${meta.text} (${result.failureSource})`, tone: meta.tone };
	}
	return meta;
}

function pingStatsPairs(stats: PingStats): Array<[string, string]> {
	return [
		[t('statMin'), formatMs(stats.min)],
		[t('statAvg'), formatMs(stats.avg)],
		[t('statMax'), formatMs(stats.max)],
		[t('statLoss'), `${stats.loss}%`],
		[t('statRcv'), `${stats.rcv} / ${stats.total}`],
		[t('statDrop'), String(stats.drop)],
	];
}

function renderPing(result: TestResult): HTMLElement {
	const wrap = el('div', { class: 'result-body' });
	wrap.append(definitionList([
		[t('resolvedAddress'), result.resolvedAddress],
		[t('resolvedHostname'), result.resolvedHostname],
	]));
	if (result.stats) {
		wrap.append(definitionList(pingStatsPairs(result.stats), 'kv-inline'));
	}
	if (Array.isArray(result.timings) && result.timings.length) {
		wrap.append(sectionTitle('timings'));
		wrap.append(buildTimingBars(result.timings));
	}
	return wrap;
}

/** 表格外层容器：窄屏下横向滚动，避免长内容撑破页面 */
function tableWrap(table: HTMLElement): HTMLElement {
	return el('div', { class: 'table-wrap' }, [table]);
}

function renderHopsTable(hops: Array<TracerouteHop | MtrHop>, withStats: boolean): HTMLElement {
	const table = el('table', { class: 'data-table hops' });
	const head = el('tr', {}, [
		el('th', {}, ['#']),
		el('th', {}, [t('hopAddress')]),
		el('th', {}, [t('hopHostname')]),
	]);
	if (withStats) {
		head.append(
			el('th', {}, [t('hopLoss')]),
			el('th', {}, [t('statAvg')]),
			el('th', {}, [t('statMin')]),
			el('th', {}, [t('statMax')]),
		);
	}
	else {
		head.append(el('th', {}, [t('hopRtt')]));
	}
	table.append(el('thead', {}, [head]));

	const body = el('tbody');
	hops.forEach((hop, index) => {
		const row = el('tr', {}, [
			el('td', { class: 'hop-idx num' }, [String(index + 1)]),
			el('td', { class: 'hop-addr mono' }, [hop.resolvedAddress ?? '*']),
			el('td', { class: 'hop-host mono dim' }, [hop.resolvedHostname ?? '—']),
		]);
		if (withStats) {
			const stats = (hop as MtrHop).stats;
			row.append(
				el('td', { 'class': 'hop-stat num', 'data-label': t('hopLoss') }, [`${stats?.loss ?? 0}%`]),
				el('td', { 'class': 'hop-stat num', 'data-label': t('statAvg') }, [formatMs(stats?.avg)]),
				el('td', { 'class': 'hop-stat num', 'data-label': t('statMin') }, [formatMs(stats?.min)]),
				el('td', { 'class': 'hop-stat num', 'data-label': t('statMax') }, [formatMs(stats?.max)]),
			);
		}
		else {
			const timings = hop.timings ?? [];
			const rttText = timings.length ? timings.map(tm => formatMs(tm.rtt)).join(' / ') : '*';
			row.append(el('td', { 'class': 'hop-rtt num', 'data-label': t('hopRtt') }, [rttText]));
		}
		body.append(row);
	});
	table.append(body);
	return tableWrap(table);
}

function renderTraceroute(result: TestResult): HTMLElement {
	const wrap = el('div', { class: 'result-body' });
	wrap.append(definitionList([
		[t('resolvedAddress'), result.resolvedAddress],
		[t('resolvedHostname'), result.resolvedHostname],
	]));
	const hops = (result.hops ?? []) as TracerouteHop[];
	if (hops.length) {
		wrap.append(renderHopsTable(hops, false));
	}
	return wrap;
}

function renderMtr(result: TestResult): HTMLElement {
	const wrap = el('div', { class: 'result-body' });
	const hops = (result.hops ?? []) as MtrHop[];
	if (hops.length) {
		wrap.append(renderHopsTable(hops, true));
	}
	return wrap;
}

function renderDnsAnswers(answers: DnsAnswer[]): HTMLElement {
	const table = el('table', { class: 'data-table dns-answers' });
	table.append(el('thead', {}, [el('tr', {}, [
		el('th', {}, [t('dnsName')]),
		el('th', {}, [t('dnsType')]),
		el('th', {}, [t('dnsTtl')]),
		el('th', {}, [t('dnsClass')]),
		el('th', {}, [t('dnsValue')]),
	])]));
	const body = el('tbody');
	for (const answer of answers) {
		body.append(el('tr', {}, [
			el('td', { 'class': 'mono dns-name', 'data-label': t('dnsName') }, [answer.name]),
			el('td', { 'class': 'num dns-meta', 'data-label': t('dnsType') }, [answer.type]),
			el('td', { 'class': 'num dns-meta', 'data-label': t('dnsTtl') }, [String(answer.ttl)]),
			el('td', { 'class': 'num dns-meta', 'data-label': t('dnsClass') }, [answer.class]),
			el('td', { 'class': 'mono break dns-value', 'data-label': t('dnsValue') }, [answer.value]),
		]));
	}
	table.append(body);
	return tableWrap(table);
}

function renderDns(result: TestResult): HTMLElement {
	const wrap = el('div', { class: 'result-body' });
	wrap.append(definitionList([
		[t('dnsStatusCode'), result.statusCodeName ?? result.statusCode],
		[t('dnsResolver'), result.resolver],
	]));
	if (result.answers?.length) {
		wrap.append(sectionTitle('dnsAnswers'));
		wrap.append(renderDnsAnswers(result.answers));
	}
	// trace: true 时返回逐跳结果而非扁平 answers
	const hops = (result.hops ?? []) as Array<{ resolver: string; answers: DnsAnswer[]; timings: { total: number } }>;
	const traceHops = hops.filter(hop => Array.isArray(hop.answers));
	if (traceHops.length) {
		wrap.append(sectionTitle('dnsTrace'));
		for (const hop of traceHops) {
			const block = el('div', { class: 'dns-hop' });
			block.append(el('p', { class: 'dns-hop-title mono' }, [`${hop.resolver} · ${formatMs(hop.timings?.total)}`]));
			if (hop.answers.length) {
				block.append(renderDnsAnswers(hop.answers));
			}
			wrap.append(block);
		}
	}
	return wrap;
}

function renderHttp(result: TestResult): HTMLElement {
	const wrap = el('div', { class: 'result-body' });
	wrap.append(definitionList([
		[t('httpStatus'), `${result.statusCode ?? '—'} ${result.statusCodeName ?? ''}`.trim()],
		[t('resolvedAddress'), result.resolvedAddress],
	]));
	const tm = result.timings;
	if (tm && !Array.isArray(tm)) {
		wrap.append(sectionTitle('httpTimings'));
		wrap.append(definitionList([
			[t('timingTotal'), formatMs(tm.total)],
			[t('timingDns'), tm.dns === null ? '—' : formatMs(tm.dns)],
			[t('timingTcp'), formatMs(tm.tcp)],
			[t('timingTls'), tm.tls === null ? '—' : formatMs(tm.tls)],
			[t('timingFirstByte'), formatMs(tm.firstByte)],
			[t('timingDownload'), formatMs(tm.download)],
		], 'kv-inline'));
	}
	if (result.tls) {
		const tls = result.tls;
		wrap.append(sectionTitle('httpTls'));
		wrap.append(definitionList([
			[t('tlsProtocol'), tls.protocol],
			[t('tlsCipher'), tls.cipherName],
			[t('tlsAuthorized'), tls.authorized ? t('yes') : `${t('no')}${tls.error ? ` (${tls.error})` : ''}`],
			[t('tlsSubject'), tls.subject?.CN ?? tls.subject?.alt ?? '—'],
			[t('tlsIssuer'), [tls.issuer?.O, tls.issuer?.CN].filter(Boolean).join(' / ') || '—'],
			[t('tlsExpires'), tls.expiresAt],
		], 'kv-inline'));
	}
	const headers = result.headers ?? {};
	const headerNames = Object.keys(headers);
	if (headerNames.length) {
		wrap.append(sectionTitle('httpResponseHeaders'));
		const table = el('table', { class: 'data-table http-headers' });
		const body = el('tbody');
		for (const name of headerNames) {
			const raw = headers[name];
			const value = Array.isArray(raw) ? raw.join(', ') : String(raw);
			body.append(el('tr', {}, [
				el('td', { class: 'mono hdr-name' }, [name]),
				el('td', { class: 'mono break hdr-value' }, [value]),
			]));
		}
		table.append(body);
		wrap.append(tableWrap(table));
	}
	if (result.rawBody) {
		wrap.append(sectionTitle('httpBody'));
		if (result.truncated) {
			wrap.append(el('p', { class: 'result-note' }, [t('httpBodyTruncated')]));
		}
		const size = new Blob([result.rawBody]).size;
		wrap.append(el('p', { class: 'result-note' }, [formatBytes(size)]));
		wrap.append(el('pre', { class: 'raw-text' }, [result.rawBody]));
	}
	return wrap;
}

function renderResultBody(type: MeasurementType, result: TestResult): HTMLElement | null {
	if (result.status === 'in-progress') {
		return el('p', { class: 'result-note' }, [t('resultPending')]);
	}
	if (result.status === 'offline') {
		return el('p', { class: 'result-note' }, [t('resultOffline')]);
	}
	if (result.status === 'failed') {
		const wrap = el('div', { class: 'result-body' });
		wrap.append(el('p', { class: 'result-note error' }, [t('resultFailed')]));
		return wrap;
	}
	switch (type) {
		case 'ping': return renderPing(result);
		case 'traceroute': return renderTraceroute(result);
		case 'mtr': return renderMtr(result);
		case 'dns': return renderDns(result);
		case 'http': return renderHttp(result);
		default: return el('div', { class: 'result-body' });
	}
}

/** 该结果的一行摘要指标（用于节点列表） */
function resultSummary(type: MeasurementType, result: TestResult): string {
	if (result.status !== 'finished') {
		return resultStatus(result).text;
	}
	switch (type) {
		case 'ping': return result.stats ? formatMs(result.stats.avg) : '—';
		case 'dns': return result.statusCodeName ?? '—';
		case 'http': return String(result.statusCode ?? '—');
		case 'traceroute': return `${result.hops?.length ?? 0} ${t('hopsUnit')}`;
		case 'mtr': return `${result.hops?.length ?? 0} ${t('hopsUnit')}`;
		default: return '—';
	}
}

function renderProbeCard(measurement: MeasurementResponse, item: MeasurementResultItem, index: number): HTMLElement {
	const { probe, result } = item;
	const card = el('article', { class: 'result-card', id: `result-${index}` });

	const header = el('header', { class: 'result-card-head' });
	const title = el('div', { class: 'result-card-title' });
	title.append(el('span', { class: 'probe-flag' }, [flagEmoji(probe.country)]));
	title.append(el('span', { class: 'probe-name' }, [probeTitle(probe)]));
	title.append(el('span', { class: 'probe-meta mono' }, [`AS${probe.asn} · ${probe.network}`]));
	header.append(title);

	const status = resultStatus(result);
	header.append(el('span', { class: `badge status-${status.tone}` }, [status.text]));

	const summary = resultSummary(measurement.type, result);
	if (summary) {
		header.append(el('span', { class: 'result-card-metric mono' }, [summary]));
	}
	card.append(header);

	const metaParts = [probe.continent, probe.region].filter(Boolean).join(' / ');
	const metaLine = el('p', { class: 'result-card-sub' }, [metaParts]);
	if (probe.tags?.length) {
		metaLine.append(el('span', { class: 'probe-tags' }, [probe.tags.join(', ')]));
	}
	if (probe.resolvers?.length) {
		metaLine.append(el('span', { class: 'probe-resolvers mono' }, [probe.resolvers.join(', ')]));
	}
	card.append(metaLine);

	const body = renderResultBody(measurement.type, result);
	if (body) {
		card.append(body);
	}
	card.append(rawOutputBlock(result.rawOutput, `raw-${index}`));
	return card;
}

/** 节点列表：测试用到的全部 probe 概览 */
function renderProbeList(measurement: MeasurementResponse): HTMLElement {
	const section = el('section', { class: 'probe-section' });
	section.append(el('h3', { class: 'section-heading' }, [`${t('probeList')} (${measurement.results.length})`]));

	const list = el('ul', { class: 'probe-list' });
	for (const [index, item] of measurement.results.entries()) {
		const { probe, result } = item;
		const status = resultStatus(result);
		const li = el('li', { class: 'probe-list-item' });
		const link = el('a', { class: 'probe-list-link', href: `#result-${index}` });
		link.append(el('span', { class: 'probe-flag' }, [flagEmoji(probe.country)]));
		link.append(el('span', { class: 'probe-list-name' }, [probeTitle(probe)]));
		link.append(el('span', { class: 'probe-list-network mono' }, [`AS${probe.asn} ${probe.network}`]));
		link.append(el('span', { class: `badge status-${status.tone}` }, [status.text]));
		link.append(el('span', { class: 'probe-list-metric mono' }, [resultSummary(measurement.type, result)]));
		li.append(link);
		list.append(li);
	}
	section.append(list);
	return section;
}

/** 测量头部：目标、类型、进度与耗时 */
function renderMeasurementHeader(measurement: MeasurementResponse, elapsedMs: number): HTMLElement {
	const header = el('section', { class: 'measure-head' });

	const row = el('div', { class: 'measure-head-row' });
	row.append(el('span', { class: 'badge type-badge' }, [typeLabel(measurement.type)]));
	row.append(el('h2', { class: 'measure-target mono' }, [measurement.target]));
	const running = measurement.status === 'in-progress';
	row.append(el('span', { class: `badge status-${running ? 'pending' : 'ok'}` }, [
		running ? t('statusInProgress') : t('statusFinished'),
	]));
	header.append(row);

	const meta = el('div', { class: 'measure-meta' });
	const finishedCount = measurement.results.filter(item => item.result.status === 'finished').length;
	meta.append(el('span', {}, [`${t('probesCount')}: ${measurement.results.length} / ${measurement.probesCount}`]));
	meta.append(el('span', {}, [`${t('finishedCount')}: ${finishedCount}`]));
	meta.append(el('span', {}, [`${t('elapsed')}: ${(elapsedMs / 1000).toFixed(1)}s`]));
	meta.append(el('span', {}, [`${t('createdAt')}: ${formatClock(measurement.createdAt)}`]));
	meta.append(el('span', { class: 'mono dim' }, [`id: ${measurement.id}`]));
	header.append(meta);

	const actions = el('div', { class: 'measure-actions' });
	const copyId = el('button', { class: 'btn ghost small', type: 'button' }, [t('copyId')]);
	copyId.addEventListener('click', async () => {
		const ok = await copyText(measurement.id);
		toast(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error');
	});
	const copyJson = el('button', { class: 'btn ghost small', type: 'button' }, [t('copyJson')]);
	copyJson.addEventListener('click', async () => {
		const ok = await copyText(JSON.stringify(measurement, null, 2));
		toast(ok ? t('copied') : t('copyFailed'), ok ? 'success' : 'error');
	});
	actions.append(copyId, copyJson);
	header.append(actions);

	return header;
}

export function renderResultsPlaceholder(root: HTMLElement): void {
	const box = el('div', { class: 'placeholder' });
	box.append(el('p', {}, [t('resultsPlaceholder')]));
	root.replaceChildren(box);
}

export function renderResultsError(root: HTMLElement, message: string): void {
	const box = el('div', { class: 'placeholder error' });
	box.append(el('p', {}, [t('resultsError')]));
	box.append(el('pre', { class: 'raw-text' }, [message]));
	root.replaceChildren(box);
}

/** 测量已提交、上游尚未返回或正在派发 probe 时的过渡态 */
export function renderResultsRunning(root: HTMLElement, request: MeasurementRequest, usedProxy: boolean): void {
	const box = el('div', { class: 'placeholder' });
	const row = el('div', { class: 'measure-head-row' });
	row.append(el('span', { class: 'badge type-badge' }, [typeLabel(request.type)]));
	row.append(el('h2', { class: 'measure-target mono' }, [request.target]));
	row.append(el('span', { class: 'badge status-pending' }, [t('statusInProgress')]));
	box.append(row);
	box.append(el('p', { class: 'spinner-line' }, [t('dispatchingProbes')]));
	box.append(el('p', { class: 'result-note' }, [usedProxy ? t('viaProxy') : t('viaDirect')]));
	root.replaceChildren(box);
}

/** 渲染一次测量的完整结果（轮询过程中会被反复调用） */
export function renderMeasurement(root: HTMLElement, measurement: MeasurementResponse, elapsedMs: number): void {
	// 轮询会整体重建 DOM，先记住用户展开的折叠块，重建后还原
	const openKeys = new Set<string>();
	for (const node of root.querySelectorAll<HTMLDetailsElement>('details[data-key][open]')) {
		if (node.dataset.key) {
			openKeys.add(node.dataset.key);
		}
	}

	const fragment = document.createDocumentFragment();
	fragment.append(renderMeasurementHeader(measurement, elapsedMs));
	if (measurement.results.length) {
		fragment.append(renderProbeList(measurement));
	}
	for (const [index, item] of measurement.results.entries()) {
		fragment.append(renderProbeCard(measurement, item, index));
	}
	root.replaceChildren(fragment);

	for (const node of root.querySelectorAll<HTMLDetailsElement>('details[data-key]')) {
		if (node.dataset.key && openKeys.has(node.dataset.key)) {
			node.open = true;
		}
	}
}
