const express = require("express");
const puppeteer = require("puppeteer");
const axios = require('axios');
const line = require('@line/bot-sdk');
require("dotenv").config();

const app = express();
const PORT = 4000;

// 讀取 PM10 閾值
const PM10_THRESHOLD = parseInt(process.env.PM10_THRESHOLD);
console.log(`PM10_THRESHOLD: ${PM10_THRESHOLD}`);

// 設置LINE Messaging API客戶端
const client = new line.Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
});

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

    // 1. 前往登入頁面
    await page.goto('https://www.jsene.com/juno/Login.aspx');

    // 2. 填入帳號和密碼
    await page.type('#T_Account', 'ExcelTek');  // 帳號
    await page.type('#T_Password', 'ExcelTek');  // 密碼

    // 3. 點擊登入按鈕並等待導航完成
    await Promise.all([
      page.click('#Btn_Login'),
      page.waitForNavigation({ waitUntil: 'networkidle0' }) // 等待頁面完全載入
    ]);

    // 4. 抓取 PM10 數據（第一個站點）
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100184');
    const iframeElement184 = await page.waitForSelector('iframe#ifs');
    const iframe184 = await iframeElement184.contentFrame();
    const pm10Data184 = await iframe184.evaluate(() => {
      const pm10Element184 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element184 ? pm10Element184.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(184) PM10 數據:', pm10Data184);

    // 抓取 PM10 數據（第二個站點）
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100185');
    const iframeElement185 = await page.$('iframe#ifs');
    const iframe185 = await iframeElement185.contentFrame();
    const pm10Data185 = await iframe185.evaluate(() => {
      const pm10Element185 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element185 ? pm10Element185.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(185) PM10 數據:', pm10Data185);

    // 廣播通知
    if (parseInt(pm10Data184) >= PM10_THRESHOLD) {
      console.log('發送廣播理虹(184) PM10 數據:', pm10Data184);
      broadcastMessage(`警告：理虹站 184 PM10 數據達到 ${pm10Data184}，超過安全閾值 ${PM10_THRESHOLD}。`);
    }
    if (parseInt(pm10Data185) >= PM10_THRESHOLD) {
      console.log('發送廣播理虹(185) PM10 數據:', pm10Data185);
      broadcastMessage(`警告：理虹站 185 PM10 數據達到 ${pm10Data184}，超過安全閾值 ${PM10_THRESHOLD}。`);
    }

  } catch (error) {
    console.error('抓取數據時出錯:', error);
  } finally {
    await browser.close(); // 確保瀏覽器正常關閉
  }
}

// 廣播訊息給所有使用者
async function broadcastMessage(message) {
  console.log(`廣播發送中: ${message}`);
  client.broadcast({
    type: 'text',
    text: message
  })
  .then(() => {
    console.log('廣播訊息已成功發送');
  })
  .catch((err) => {
    console.error('發送廣播訊息時發生錯誤:', err);
  });
};

// 設置 ping 路由接收 pinger-app 的請求
app.post('/ping', (req, res) => {
  console.log('來自 pinger-app 的訊息:', req.body);
  res.json({ message: 'pong' });
});

// 發送 ping 請求到 pinger-app
function sendPing() {
  axios.post('https://pinger-app-m1tm.onrender.com/ping', { message: 'ping' })
    .then(response => {
      console.log('來自 pinger-app 的回應:', response.data);
    })
    .catch(error => {
      console.error('Error pinging pinger-app:', error);
    });
}

// 每5分鐘發送一次請求
setInterval(sendPing, 5 * 60 * 1000);

// 每5分鐘執行一次抓取任務
setInterval(scrapeData, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  scrapeData(); // 啟動伺服器後抓取數據
});
