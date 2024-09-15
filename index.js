const express = require("express");
const puppeteer = require("puppeteer");
const axios = require('axios');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const moment = require('moment-timezone');

// 設置台灣時區
moment.tz.setDefault("Asia/Taipei");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

// 讀取 PM10 閾值
const PM10_THRESHOLD = parseInt(process.env.PM10_THRESHOLD) || 126;

// LINE BOT 配置
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'SbPThgkx60U6+eEFUDd8z2AqJkUbXeS211M0bs6z5GVpWR4oX+dWMYZuB0HiMKMVl/0HO6IVnnomNSY8DXlauUK7BlNyWnpf5mxdtJ7la4GADywEC0XqJBpZuXxsCkxtOd7BoyYQX1+YrSbQPMN7FwdB04t89/1O/w1cDnyilFU=',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '1d19cffe1095c7402b9c5ea498da3781'
};

const client = new line.Client(lineConfig);

// 從環境變量讀取服務帳戶憑證
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://env-monitor-7167f-default-rtdb.firebaseio.com/'
});

const db = admin.database();

// 抓取 PM10 數據
async function scrapeData() {
  const browser = await puppeteer.launch({
    args: [
      "--disable-setuid-sandbox",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
    ],
    executablePath:
      process.env.NODE_ENV === "production"
        ? process.env.PUPPETEER_EXECUTABLE_PATH
        : puppeteer.executablePath(),
  });

  try {
    const page = await browser.newPage();
    console.log('Target page loaded');

    // 抓取理虹站點 184 的 PM10 數據
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100184');
    const iframeElement184 = await page.waitForSelector('iframe#ifs');
    const iframe184 = await iframeElement184.contentFrame();
    const pm10Data184 = await iframe184.evaluate(() => {
      const pm10Element184 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element184 ? pm10Element184.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(184) PM10 數據:', pm10Data184);

    // 抓取理虹站點 185 的 PM10 數據
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100185');
    const iframeElement185 = await page.waitForSelector('iframe#ifs');
    const iframe185 = await iframeElement185.contentFrame();
    const pm10Data185 = await iframe185.evaluate(() => {
      const pm10Element185 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element185 ? pm10Element185.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(185) PM10 數據:', pm10Data185);

    // 使用從 ENV 中讀取的 PM10 閾值來判斷是否廣播通知
    if (parseInt(pm10Data184) >= PM10_THRESHOLD) {
      broadcastMessage(`警告：理虹站 184 PM10 數據達到 ${pm10Data184}，超過安全閾值 ${PM10_THRESHOLD}。`);
    }
    if (parseInt(pm10Data185) >= PM10_THRESHOLD) {
      broadcastMessage(`警告：理虹站 185 PM10 數據達到 ${pm10Data185}，超過安全閾值 ${PM10_THRESHOLD}。`);
    }

  } catch (error) {
    console.error('抓取數據時出錯:', error);
  } finally {
    await browser.close();
  }
}

// 廣播訊息給所有使用者
async function broadcastMessage(message) {
  const usersRef = db.ref('users');
  usersRef.once('value', snapshot => {
    const users = snapshot.val();
    if (users) {
      Object.keys(users).forEach(userId => {
        client.pushMessage(userId, { type: 'text', text: message });
      });
    }
  });
}

// 定期任務
setInterval(scrapeData, 5 * 60 * 1000); // 每 5 分鐘執行一次抓取數據

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  scrapeData();  // 啟動伺服器後立即抓取數據
});
