import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `package.json` 的测试垫片
 *
 * Jest 的 ESM 链接器只给 JSON 模块提供 `default` 导出，
 * 而源码使用 `import * as packageJson from '../../package.json'` 读取 `name` / `version`。
 * 这里读真实文件并同时提供具名导出，保证测试与 esbuild 构建产物行为一致。
 */
const data = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'),
) as Record<string, unknown>;

/**
 * `TEST_PACKAGE_NAME` 可覆盖包名；设为 `-` 时模拟读取不到包名，
 * 用于覆盖「必需环境变量既无值也无默认值」的校验分支。
 */
const override = process.env.TEST_PACKAGE_NAME;
export const name = (override === '-' ? undefined : (override ?? data.name)) as string;
export const version = data.version as string;
export default data;
