FROM ghcr.io/puppeteer/puppeteer:19.7.2

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# 設置 LINE Bot 的環境變量
ENV LINE_CHANNEL_SECRET=1d19cffe1095c7402b9c5ea498da3781 \
    LINE_CHANNEL_ACCESS_TOKEN=SbPThgkx60U6+eEFUDd8z2AqJkUbXeS211M0bs6z5GVpWR4oX+dWMYZuB0HiMKMVl/0HO6IVnnomNSY8DXlauUK7BlNyWnpf5mxdtJ7la4GADywEC0XqJBpZuXxsCkxtOd7BoyYQX1+YrSbQPMN7FwdB04t89/1O/w1cDnyilFU=

# 設置 PM10 閾值
ENV PM10_THRESHOLD=6

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci
COPY . .

CMD [ "node", "index.js" ]
