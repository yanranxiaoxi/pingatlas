import type { OidcParams } from '../service/oidc';
import type { IContext } from '../utils/interface';
import { CONFIG } from '../config/config';
import { buildAuthorizationUrlFromParams, buildEndSessionUrlForLogout, exchangeCodeAtCallback, fetchUsername, generateOidcParams, oidcEnabled } from '../service/oidc';
import { parseCookies } from '../utils/cookie';
import { clearCookie, getSessionUser, redirect, sendJson, setCookie } from '../utils/respond';
import { signSession, signTransientToken, verifyTransientToken } from '../utils/session';
import { Controller } from './controller';

/** OIDC 登录状态临时 Cookie 名（state/code_verifier） */
const OIDC_STATE_COOKIE = 'pa_oidc_state';
/** 状态 Cookie 有效期（秒） */
const OIDC_STATE_TTL = 600;

/**
 * 认证控制器：OIDC 登录状态、登录、回调、登出
 */
class Auth extends Controller {
	/** GET /api/auth/status */
	public async status(ctx: IContext) {
		const user = getSessionUser(ctx.user);
		const enabled = oidcEnabled();
		sendJson(ctx.res, 200, {
			loggedIn: Boolean(user),
			authEnabled: enabled,
			// 未启用登录时不暴露提供商名称；未配置时前端使用本地化默认文案
			...(enabled && CONFIG.oidc.providerName ? { providerName: CONFIG.oidc.providerName } : {}),
			// 未配置时前端把用户名渲染为纯文本
			...(enabled && CONFIG.oidc.accountUrl ? { accountUrl: CONFIG.oidc.accountUrl } : {}),
			user: user ? { username: user.username } : null,
		});
	}

	/** GET /api/auth/login：302 跳转 IdP */
	public async login(ctx: IContext) {
		if (!oidcEnabled()) {
			sendJson(ctx.res, 503, { error: 'OIDC is not configured on this server' });
			return;
		}
		try {
			const params = await generateOidcParams();
			const authorizationUrl = await buildAuthorizationUrlFromParams(params);
			const token = await signTransientToken({ ...params }, OIDC_STATE_TTL);
			setCookie(ctx.res, OIDC_STATE_COOKIE, token, { maxAge: OIDC_STATE_TTL });
			redirect(ctx.res, authorizationUrl);
		}
		catch (ex) {
			ctx.logger.error('oidc login failed', ex);
			sendJson(ctx.res, 500, { error: 'Failed to start OIDC login' });
		}
	}

	/** GET /api/auth/callback：IdP 回调，换取会话 */
	public async callback(ctx: IContext) {
		const res = ctx.res;
		const fail = () => {
			clearCookie(res, OIDC_STATE_COOKIE);
			redirect(res, '/?login=failed');
		};

		const cookies = parseCookies(ctx.req.headers.cookie);
		const storedToken = cookies[OIDC_STATE_COOKIE];
		const stored = storedToken ? await verifyTransientToken(storedToken) : null;
		if (!stored || typeof stored.state !== 'string' || typeof stored.codeVerifier !== 'string') {
			fail();
			return;
		}

		try {
			const currentUrl = new URL(ctx.req.url ?? '/', CONFIG.oidc.redirectUri);
			const params: OidcParams = {
				state: stored.state,
				codeVerifier: stored.codeVerifier,
				codeChallenge: '',
			};
			const tokens = await exchangeCodeAtCallback(currentUrl, params);
			const { sub, username } = await fetchUsername(tokens);
			const sessionToken = await signSession({ sub, username });
			setCookie(res, CONFIG.session.cookieName, sessionToken, { maxAge: CONFIG.session.ttl });
			clearCookie(res, OIDC_STATE_COOKIE);
			redirect(res, '/');
		}
		catch (ex) {
			ctx.logger.error('oidc callback failed', ex);
			fail();
		}
	}

	/** GET /api/auth/logout：清除本地会话；?sso=1 时继续跳 IdP 登出（RP-initiated logout） */
	public async logout(ctx: IContext) {
		clearCookie(ctx.res, CONFIG.session.cookieName);

		const url = new URL(ctx.req.url ?? '/', 'http://localhost');
		if (url.searchParams.get('sso') === '1' && oidcEnabled()) {
			try {
				const endSessionUrl = await buildEndSessionUrlForLogout();
				if (endSessionUrl) {
					redirect(ctx.res, endSessionUrl);
					return;
				}
			}
			catch (ex) {
				// IdP discovery 失败：本地会话已清除，退化为直接回首页而非报错
				ctx.logger.error('oidc end session failed', ex);
			}
		}

		redirect(ctx.res, '/');
	}
}

const auth = new Auth();
export default auth;
