# 收藏夹考古 —— 公网部署镜像
# 适用于 Zeabur / Railway / 自建服务器；Render 也可选用 Docker 模式。

FROM node:20-slim

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 再拷贝源码
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
