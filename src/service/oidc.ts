import type { Configuration, TokenEndpointResponse } from 'openid-client';
import {
	authorizationCodeGrant,
	buildAuthorizationUrl,
	buildEndSessionUrl,
	calculatePKCECodeChallenge,

	discovery,
	fetchUserInfo,
	randomPKCECodeVerifier,
	randomState,
	skipSubjectCheck,

} from 'openid-client';
import { CONFIG } from '../config/config';

/**
 * OIDC 是否已完整配置（可用于登录）
 */
export function oidcEnabled(): boolean {
	return Boolean(CONFIG.oidc.issuer && CONFIG.oidc.clientId && CONFIG.oidc.clientSecret && CONFIG.oidc.redirectUri);
}

let cachedConfig: Configuration | null = null;

/**
 * 获取 OIDC Configuration（缓存，内部做一次 issuer discovery）
 */
export async function getOidcConfig(): Promise<Configuration> {
	if (cachedConfig) {
		return cachedConfig;
	}
	// metadata 简写传 client_secret，客户端认证默认 client_secret_post（Keycloak/Authentik 等均支持）
	cachedConfig = await discovery(new URL(CONFIG.oidc.issuer), CONFIG.oidc.clientId, CONFIG.oidc.clientSecret);
	return cachedConfig;
}

export interface OidcParams {
	state: string;
	codeVerifier: string;
	codeChallenge: string;
}

/**
 * 生成一次登录所需的安全随机参数（state + PKCE S256）
 */
export async function generateOidcParams(): Promise<OidcParams> {
	const state = randomState();
	const codeVerifier = randomPKCECodeVerifier();
	const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
	return { state, codeVerifier, codeChallenge };
}

/**
 * 构建跳转到 IdP 的授权地址（标准授权码流 + S256 PKCE）
 */
export async function buildAuthorizationUrlFromParams(params: OidcParams): Promise<string> {
	const config = await getOidcConfig();
	const url = buildAuthorizationUrl(config, {
		redirect_uri: CONFIG.oidc.redirectUri,
		scope: CONFIG.oidc.scope,
		code_challenge: params.codeChallenge,
		code_challenge_method: 'S256',
		state: params.state,
	});
	return url.href;
}

/**
 * 用当前回调 URL 换取 Token（内部校验 state 与 PKCE code_verifier）
 * @param currentUrl - IdP 回跳本服务的完整 URL
 * @param params - 登录发起时保存的 state/codeVerifier
 */
export async function exchangeCodeAtCallback(currentUrl: URL, params: OidcParams): Promise<TokenEndpointResponse> {
	const config = await getOidcConfig();
	return await authorizationCodeGrant(config, currentUrl, {
		pkceCodeVerifier: params.codeVerifier,
		expectedState: params.state,
	});
}

/**
 * 从 Token 中提取用户名（优先调 userinfo，失败时回退 id_token claims）
 *
 * claim 选择链：OIDC_USERNAME_CLAIM（默认 preferred_username）→ preferred_username → name → nickname → sub
 */
export async function fetchUsername(tokens: TokenEndpointResponse): Promise<{ sub: string; username: string }> {
	const tokenWithClaims = tokens as TokenEndpointResponse & { claims?: () => Record<string, unknown> | undefined };
	const claims = tokenWithClaims.claims?.();
	const sub = (claims?.sub as string | undefined) ?? '';

	const pick = (source: Record<string, unknown> | undefined): string => {
		if (!source) {
			return '';
		}
		const chain = [CONFIG.oidc.usernameClaim, 'preferred_username', 'name', 'nickname'];
		for (const key of chain) {
			const value = source[key];
			if (typeof value === 'string' && value.trim()) {
				return value;
			}
		}
		return '';
	};

	let username = '';
	try {
		const accessToken = tokens.access_token;
		if (accessToken) {
			const config = await getOidcConfig();
			const userinfo = await fetchUserInfo(config, accessToken, sub || skipSubjectCheck);
			username = pick(userinfo as unknown as Record<string, unknown>);
		}
	}
	catch {
		// userinfo 端点不可用时回退到 id_token claims
	}
	if (!username) {
		username = pick(claims);
	}

	return { sub: sub || username || 'unknown', username: username || sub || 'unknown' };
}

/**
 * 构建 RP-initiated logout 地址（同时登出 IdP 会话）
 *
 * IdP 未提供 end_session_endpoint（如部分简化实现）时返回 null，
 * 调用方应退化为仅清除本地会话。
 */
export async function buildEndSessionUrlForLogout(): Promise<string | null> {
	const config = await getOidcConfig();
	if (!config.serverMetadata().end_session_endpoint) {
		return null;
	}
	const params = CONFIG.oidc.postLogoutRedirectUri
		? { post_logout_redirect_uri: CONFIG.oidc.postLogoutRedirectUri }
		: undefined;
	return buildEndSessionUrl(config, params).href;
}
