FROM ghcr.io/puppeteer/puppeteer:19.7.2

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci
COPY . .

CMD [ "node", "index.js" ]
