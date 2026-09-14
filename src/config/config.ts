import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as packageJson from '../../package.json';
import 'dotenv/config';

/**
 * 验证必需的环境变量
 * @param name - 环境变量名称
 * @param value - 环境变量值
 * @param defaultValue - 默认值
 * @returns 验证后的环境变量值
 */
function validateEnvVar(name: string, value: string | undefined, defaultValue?: string): string {
	if (!value && defaultValue === undefined) {
		throw new Error(`Required environment variable ${name} is not set`);
	}
	return value || defaultValue!;
}

/**
 * 验证端口号
 * @param port - 端口号字符串
 * @param defaultPort - 默认端口号
 * @returns 验证后的端口号
 */
function validatePort(port: string | undefined, defaultPort: number): number {
	const portNum = port ? Number(port) : defaultPort;
	if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
		throw new Error(`Invalid port number: ${port}. Must be between 1 and 65535`);
	}
	return portNum;
}

function validateOptionalEnvVar(name: string, value: string | undefined, defaultValue = ''): string {
	return value || defaultValue;
}

function validateNumberEnvVar(name: string, value: string | undefined, defaultValue: number): number {
	if (!value) {
		return defaultValue;
	}
	const num = Number(value);
	if (Number.isNaN(num) || num < 1) {
		throw new Error(`Invalid environment variable ${name}: ${value}`);
	}
	return num;
}

/**
 * 解析 RP-initiated logout 的回跳地址
 *
 * 显式配置 OIDC_POST_LOGOUT_REDIRECT_URI 优先；否则取 OIDC_REDIRECT_URI 的站点根
 * （如 https://example.com/api/auth/callback → https://example.com/）。
 * 两者都不可用时返回空串，此时登出仅清本地会话、不跳 IdP。
 */
function resolvePostLogoutRedirectUri(): string {
	const explicit = validateOptionalEnvVar('OIDC_POST_LOGOUT_REDIRECT_URI', process.env.OIDC_POST_LOGOUT_REDIRECT_URI);
	if (explicit) {
		return explicit;
	}
	const redirectUri = process.env.OIDC_REDIRECT_URI;
	if (!redirectUri) {
		return '';
	}
	try {
		return `${new URL(redirectUri).origin}/`;
	}
	catch {
		// 畸形 URL：交由后续 OIDC discovery 报错，这里退化为不跳 IdP
		return '';
	}
}

/**
 * 解析 SSO 用户中心地址
 *
 * 配置后前端把用户名渲染成指向该地址的链接，用于跳转到 IdP 的用户中心。
 *
 * 只接受 http/https：该值会作为 `<a href>` 下发到页面，若误配成 `javascript:`
 * 之类的协议，点击用户名就会执行脚本，因此直接丢弃而不是原样透传。
 * 留空或非法时返回空串，此时用户名保持为纯文本。
 */
function resolveAccountUrl(): string {
	const raw = validateOptionalEnvVar('OIDC_ACCOUNT_URL', process.env.OIDC_ACCOUNT_URL);
	if (!raw) {
		return '';
	}
	try {
		const { protocol } = new URL(raw);
		return protocol === 'http:' || protocol === 'https:' ? raw : '';
	}
	catch {
		return '';
	}
}

export const CONFIG = {
	env: validateEnvVar('ENV_PRODUCT', process.env.ENV_PRODUCT, 'development'),
	host: validateEnvVar('SERVER_HOST', process.env.SERVER_HOST, '0.0.0.0'),
	port: validatePort(process.env.SERVER_PORT, 80),
	serverName: validateEnvVar('SERVER_NAME', process.env.SERVER_NAME, 'server'),

	envProduct: validateEnvVar('ENV_PRODUCT', process.env.ENV_PRODUCT, 'development'),
	projectName: validateEnvVar('PROJECT_NAME', process.env.PROJECT_NAME, packageJson.name),
	logLevel: validateEnvVar('LOG_LEVEL', process.env.LOG_LEVEL, 'info'),

	/** Globalping API 配置 */
	gp: {
		/** Globalping API 根地址（不带 /v1） */
		apiUrl: validateEnvVar('GP_API_URL', process.env.GP_API_URL, 'https://api.globalping.io'),
		/** 内置 access token：登录用户代理请求时注入（绝不下发前端） */
		token: validateOptionalEnvVar('GP_TOKEN', process.env.GP_TOKEN),
		/** 上游请求超时（毫秒） */
		timeout: validateNumberEnvVar('GP_TIMEOUT', process.env.GP_TIMEOUT, 30000),
	},

	/** OpenID Connect 登录配置（全部配置后才启用登录） */
	oidc: {
		issuer: validateOptionalEnvVar('OIDC_ISSUER', process.env.OIDC_ISSUER),
		clientId: validateOptionalEnvVar('OIDC_CLIENT_ID', process.env.OIDC_CLIENT_ID),
		clientSecret: validateOptionalEnvVar('OIDC_CLIENT_SECRET', process.env.OIDC_CLIENT_SECRET),
		redirectUri: validateOptionalEnvVar('OIDC_REDIRECT_URI', process.env.OIDC_REDIRECT_URI),
		scope: validateOptionalEnvVar('OIDC_SCOPE', process.env.OIDC_SCOPE, 'openid profile email'),
		/** 用户名取自 userinfo 的哪个 claim（Keycloak 为 preferred_username） */
		usernameClaim: validateOptionalEnvVar('OIDC_USERNAME_CLAIM', process.env.OIDC_USERNAME_CLAIM, 'preferred_username'),
		/** SSO 提供商名称，显示在登录弹窗按钮上；留空时前端使用本地化默认文案 */
		providerName: validateOptionalEnvVar('OIDC_PROVIDER_NAME', process.env.OIDC_PROVIDER_NAME),
		/** 登出 SSO 时 IdP 回跳地址；留空则自动取 OIDC_REDIRECT_URI 的站点根 */
		postLogoutRedirectUri: resolvePostLogoutRedirectUri(),
		/** SSO 用户中心地址；配置后登录时用户名变为可点击链接 */
		accountUrl: resolveAccountUrl(),
	},

	/** 会话配置 */
	session: {
		/** 会话签名密钥（必填，建议 32+ 随机字节） */
		secret: validateOptionalEnvVar('SESSION_SECRET', process.env.SESSION_SECRET),
		cookieName: validateOptionalEnvVar('SESSION_COOKIE_NAME', process.env.SESSION_COOKIE_NAME, 'pa_session'),
		ttl: validateNumberEnvVar('SESSION_TTL', process.env.SESSION_TTL, 7 * 24 * 60 * 60),
	},

	/** 静态资源目录：默认为空时自动解析（构建产物 dist/public 或源码 public） */
	staticDir: validateOptionalEnvVar('STATIC_DIR', process.env.STATIC_DIR),
} as const;

/**
 * 解析前端静态资源目录
 *
 * 优先级：STATIC_DIR 环境变量 > 运行入口同级的 public/（生产构建产物 dist/public）
 * > 向上逐级查找项目根下的 public/（开发时 tsx 运行）。
 */
export function resolveStaticDir(): string {
	if (CONFIG.staticDir) {
		return path.resolve(CONFIG.staticDir);
	}

	// 构建产物（esbuild 单文件）位于 dist/index.js；tsx 开发时位于 src/controller/*.ts
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const sibling = path.join(moduleDir, 'public');
	if (existsSync(sibling)) {
		return sibling;
	}

	// 逐级向上查找 package.json 所在目录下的 public/
	let current = moduleDir;
	while (current !== path.dirname(current)) {
		const candidate = path.join(current, 'public');
		if (existsSync(candidate)) {
			return candidate;
		}
		const pkg = path.join(current, 'package.json');
		if (existsSync(pkg)) {
			break;
		}
		current = path.dirname(current);
	}
	throw new Error('Cannot resolve static directory. Set STATIC_DIR explicitly.');
}
