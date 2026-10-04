# TestBench —— 一体化镜像：Node 服务 + EvalScope + Locust + JMeter
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    HOST=0.0.0.0 \
    PORT=4399 \
    TESTBENCH_DATA=/app/data

# JMeter 依赖 JRE；EvalScope / Locust 依赖 Python
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip \
      openjdk-17-jre-headless \
      curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG JMETER_VERSION=5.6.3
RUN curl -fsSL "https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-${JMETER_VERSION}.tgz" -o /tmp/jmeter.tgz \
 && tar -xzf /tmp/jmeter.tgz -C /opt \
 && ln -s "/opt/apache-jmeter-${JMETER_VERSION}" /opt/jmeter \
 && rm -f /tmp/jmeter.tgz
ENV PATH="/opt/jmeter/bin:${PATH}"

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY install.sh ./

# 项目内虚拟环境：服务启动时会自动优先使用 .venv/bin 下的可执行文件
RUN python3 -m venv /app/.venv \
 && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
 && /app/.venv/bin/pip install --no-cache-dir locust "evalscope[perf]"

RUN mkdir -p /app/data/runs /app/data/datasets

VOLUME ["/app/data"]
EXPOSE 4399

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4399)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
