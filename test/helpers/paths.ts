import { fileURLToPath } from 'node:url';

/** 仓库根目录（测试文件位于 test/helpers/ 下） */
export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 前端静态资源目录 */
export const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
