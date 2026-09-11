/** 前端配置（来自 `/api/config`，不含任何机密） */
export interface AppConfig {
	apiUrl: string;
	/** 后端是否已配置服务端代币（决定是否提供代理降级与第二条额度条） */
	proxyAvailable: boolean;
	maxProbes: {
		/** 直连（匿名）单次上限 */
		direct: number;
		/** 代理（服务端代币）单次上限 */
		proxy: number;
	};
}

export interface AuthUser {
	username: string;
}

export interface AuthStatus {
	loggedIn: boolean;
	authEnabled: boolean;
	providerName?: string;
	user: AuthUser | null;
}

/** Globalping 报错体（`{ error: { type, message, params? }, links? }`） */
export interface UpstreamErrorBody {
	error?: {
		type?: string;
		message?: string;
		params?: Record<string, string>;
	};
	links?: {
		documentation?: string;
	};
}

/** 统一的 API 异常：保留上游状态码、错误类型与字段级参数提示 */
export class ApiError extends Error {
	public readonly status: number;
	public readonly type: string;
	public readonly params: Record<string, string>;
	/** 上游响应头（即使失败也可能带有额度信息，需要用于更新额度条） */
	public readonly headers: Headers;

	public constructor(
		message: string,
		status = 0,
		type = '',
		params: Record<string, string> = {},
		headers: Headers = new Headers(),
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.type = type;
		this.params = params;
		this.headers = headers;
	}
}

// ===================== Globalping API 类型 =====================

export type MeasurementType = 'ping' | 'traceroute' | 'dns' | 'mtr' | 'http';

export type PingProtocol = 'ICMP' | 'TCP';
export type TracerouteProtocol = 'ICMP' | 'TCP' | 'UDP';
export type DnsProtocol = 'TCP' | 'UDP';
export type HttpProtocol = 'HTTP' | 'HTTPS' | 'HTTP2';
export type HttpRequestMethod = 'HEAD' | 'GET' | 'OPTIONS';
export type IpVersion = 4 | 6;

export const DNS_QUERY_TYPES = [
	'A',
	'AAAA',
	'ANY',
	'CNAME',
	'DNSKEY',
	'DS',
	'HTTPS',
	'MX',
	'NS',
	'NSEC',
	'PTR',
	'RRSIG',
	'SOA',
	'TXT',
	'SRV',
	'SVCB',
] as const;
export type DnsQueryType = (typeof DNS_QUERY_TYPES)[number];

export interface LocationOption {
	magic?: string;
	continent?: string;
	region?: string;
	country?: string;
	state?: string;
	city?: string;
	asn?: number;
	network?: string;
	tags?: string[];
	limit?: number;
}

// ===================== 探针位置索引（自动补全数据源）=====================

export type ProbeIndexKind = 'country' | 'region' | 'city' | 'asn' | 'network' | 'tag';

/** 去重后的探针位置索引，字段均为 `[..., 探针数量]`，按数量降序排列 */
export interface ProbeIndex {
	version: number;
	generatedAt: number;
	total: number;
	countries: Array<[string, number]>;
	regions: Array<[string, number]>;
	cities: Array<[string, string, number]>;
	networks: Array<[string, number, number]>;
	tags: Array<[string, number]>;
}

/** 一条补全候选：`text` 回填到输入框，`label`/`meta`/`badge` 仅用于展示 */
export interface SuggestCandidate {
	kind: ProbeIndexKind;
	text: string;
	label: string;
	meta?: string;
	badge?: string;
	/** 额外的可匹配文本（不展示），例如城市候选附带的 ISO 国家码 */
	keywords?: string;
	count: number;
	/** 子序列匹配得分，越高越靠前 */
	score: number;
}

export interface PingOptions {
	packets?: number;
	protocol?: PingProtocol;
	port?: number;
	ipVersion?: IpVersion;
}

export interface TracerouteOptions {
	protocol?: TracerouteProtocol;
	port?: number;
	ipVersion?: IpVersion;
}

export interface MtrOptions {
	packets?: number;
	protocol?: TracerouteProtocol;
	port?: number;
	ipVersion?: IpVersion;
}

export interface DnsOptions {
	query?: { type?: DnsQueryType };
	resolver?: string;
	protocol?: DnsProtocol;
	port?: number;
	ipVersion?: IpVersion;
	trace?: boolean;
}

export interface HttpOptions {
	request?: {
		host?: string;
		path?: string;
		query?: string;
		method?: HttpRequestMethod;
		headers?: Record<string, string>;
	};
	resolver?: string;
	protocol?: HttpProtocol;
	port?: number;
	ipVersion?: IpVersion;
}

export type MeasurementOptions = PingOptions | TracerouteOptions | MtrOptions | DnsOptions | HttpOptions;

export interface MeasurementRequest {
	type: MeasurementType;
	target: string;
	inProgressUpdates?: boolean;
	locations?: LocationOption[] | string;
	/** 全局上限：在多个位置间均摊；与逐位置 `limit` 互斥 */
	limit?: number;
	timeout?: number;
	measurementOptions?: MeasurementOptions;
}

export interface CreateMeasurementResponse {
	id: string;
	probesCount: number;
}

export type MeasurementStatus = 'in-progress' | 'finished';

export interface ProbeLocation {
	continent: string;
	region: string;
	country: string;
	state: string | null;
	city: string;
	asn: number;
	network: string;
	latitude: number;
	longitude: number;
}

export interface ResultProbe extends ProbeLocation {
	tags: string[];
	resolvers: string[];
}

export interface PingStats {
	min: number | null;
	avg: number | null;
	max: number | null;
	total: number;
	rcv: number;
	drop: number;
	loss: number;
}

export interface MtrStats extends PingStats {
	stDev: number | null;
	jMin: number | null;
	jAvg: number | null;
	jMax: number | null;
}

export interface PingTiming {
	rtt: number;
	ttl?: number;
}

export interface TracerouteHop {
	resolvedAddress: string | null;
	resolvedHostname: string | null;
	timings: PingTiming[];
}

export interface MtrHop {
	resolvedAddress: string | null;
	resolvedHostname: string | null;
	asn: number[];
	timings: PingTiming[];
	stats: MtrStats;
}

export interface DnsAnswer {
	name: string;
	type: string;
	ttl: number;
	class: string;
	value: string;
}

export interface DnsHop {
	resolver: string;
	answers: DnsAnswer[];
	timings: { total: number };
}

export interface HttpTimings {
	total: number;
	dns: number | null;
	tcp: number;
	tls: number | null;
	firstByte: number;
	download: number;
}

export interface TlsCertificate {
	authorized: boolean;
	error?: string;
	protocol: string;
	cipherName: string;
	createdAt: string;
	expiresAt: string;
	subject: { CN?: string; alt?: string };
	issuer: { C?: string; O?: string; CN?: string };
	keyType: string | null;
	keyBits: number | null;
	serialNumber: string;
	fingerprint256: string;
	publicKey: string | null;
}

export interface HttpTimings {
	total: number;
	dns: number | null;
	tcp: number;
	tls: number | null;
	firstByte: number;
	download: number;
}

/** 结果条目（按 `status` 与测量类型取用不同字段，故用宽类型 + 收窄读取） */
export interface TestResult {
	status: 'in-progress' | 'finished' | 'failed' | 'offline';
	failureSource?: 'target' | 'resolver' | 'internal';
	rawOutput: string;
	// ping / traceroute / mtr 共用
	resolvedAddress?: string | null;
	resolvedHostname?: string | null;
	// ping
	stats?: PingStats;
	// ping / mtr：逐包时序数组；http：单一汇总对象
	timings?: PingTiming[] | HttpTimings;
	// traceroute / mtr
	hops?: Array<TracerouteHop | MtrHop | DnsHop>;
	// dns
	statusCode?: number;
	statusCodeName?: string;
	resolver?: string;
	answers?: DnsAnswer[];
	// http
	rawHeaders?: string;
	rawBody?: string | null;
	truncated?: boolean;
	headers?: Record<string, string | string[]>;
	tls?: TlsCertificate | null;
}

export interface MeasurementResultItem {
	probe: ResultProbe;
	result: TestResult;
}

export interface MeasurementResponse {
	id: string;
	type: MeasurementType;
	target: string;
	status: MeasurementStatus;
	createdAt: string;
	updatedAt: string;
	probesCount: number;
	locations?: LocationOption[];
	limit?: number;
	timeout?: number;
	measurementOptions?: MeasurementOptions;
	results: MeasurementResultItem[];
}

export interface RateLimitDetails {
	type: 'ip' | 'user';
	limit: number;
	remaining: number;
	reset: number;
}

export interface LimitsResponse {
	rateLimit: {
		measurements: {
			create: RateLimitDetails;
		};
	};
	credits?: {
		remaining: number;
	};
}

// ===================== 额度状态 =====================

export type QuotaStatus = 'loading' | 'ready' | 'unavailable';
export type QuotaActor = 'ip' | 'user';

/** 一份额度快照（本地匿名额度 / 服务端代币额度结构一致） */
export interface QuotaSnapshot {
	status: QuotaStatus;
	actor: QuotaActor;
	limit: number;
	remaining: number;
	/** 距离重置的秒数（上游权威值） */
	reset: number;
	/** 认证请求超额时才有 */
	creditsRemaining?: number;
	/** 本地记录该快照的时刻（ms），用于推算 reset 剩余时间 */
	updatedAt: number;
}

/** 用户可持久化的额度偏好；`auto` 表示「本地优先，耗尽自动降级」 */
export type QuotaPreference = 'auto' | 'proxy';

/** 一次请求的生效路径判定结果 */
export type QuotaMode = 'direct' | 'proxy' | 'exhausted' | 'unreachable';
