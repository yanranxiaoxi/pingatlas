/**
 * 测试基线环境变量
 *
 * `src/config/config.ts` 在模块顶层求值 `process.env`，任何（间接）导入它的模块
 * 都会在 import 时冻结配置。这里在测试文件加载前写入基线值，
 * 需要自定义的用例应在 `await import(...)` 之前改写 `process.env`。
 *
 * 这些变量全部来自测试内的假上游，不含任何真实凭据。
 */
process.env.ENV_PRODUCT = 'test';
process.env.SERVER_HOST = '127.0.0.1';
process.env.SERVER_PORT = '3001';
process.env.SERVER_NAME = 'pingatlas-test';
process.env.LOG_LEVEL = 'error';
process.env.GP_API_URL = 'http://127.0.0.1:1';
process.env.GP_TOKEN = '';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.SESSION_COOKIE_NAME = 'pa_session';
process.env.OIDC_ISSUER = '';
process.env.OIDC_CLIENT_ID = '';
process.env.OIDC_CLIENT_SECRET = '';
process.env.OIDC_REDIRECT_URI = '';
process.env.STATIC_DIR = '';
