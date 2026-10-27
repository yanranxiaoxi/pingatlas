FROM docker.io/library/node:24-alpine
LABEL maintainer="XiaoXi <admin@soraharu.com>"
ENV ENV_PRODUCT=true
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=3001
ENV LOG_LEVEL=info
ENV PROJECT_NAME=pingatlas
ENV GP_API_URL=https://api.globalping.io
WORKDIR /home/node/app
# 安装生产依赖（后端以 ESM 方式 external 这些运行时依赖，由 Node 直接加载）
# 显式指定 pnpm 版本，避免 corepack 解析偏差
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate && pnpm install --prod --frozen-lockfile
# dist/ 内含 index.js（后端）与 public/（前端静态资源）
COPY ./dist/ ./
# 只把日志目录交给非 root 用户：应用代码保持 root 所有，
# 即使出现文件写入类缺陷也无法改写 index.js 在容器内持久化
RUN mkdir -p ./logs && chown node:node ./logs
# 以非 root 运行：任何文件写入类缺陷都不再等同于容器内 root 权限
USER node
EXPOSE 3001/tcp
ENTRYPOINT [ "node", "/home/node/app/index.js" ]
