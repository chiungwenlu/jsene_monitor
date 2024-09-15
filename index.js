const express = require("express");
const puppeteer = require("puppeteer");
const axios = require('axios');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
require("dotenv").config();

const app = express();
const PORT = 4000;

// 解析 JSON 請求
app.use(express.json());

// 讀取 PM10 閾值
const PM10_THRESHOLD = parseInt(process.env.PM10_THRESHOLD);
console.log(`PM10_THRESHOLD: ${PM10_THRESHOLD}`);

// 設置LINE Messaging API客戶端的配置
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// 設置 LINE 客戶端
const client = new line.Client(config);

// 從環境變量讀取Firebase Admin SDK配置
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://env-monitor-7167f-default-rtdb.firebaseio.com'
});
const db = admin.database();


function getCurrentDateTime() {
  const now = new Date();
  
  // 台灣時區的 UTC+8 時差
  const taiwanOffset = 8 * 60; // 8 小時轉換為分鐘
  const localOffset = now.getTimezoneOffset(); // 當前時區的時差
  const taiwanTime = new Date(now.getTime() + (taiwanOffset - localOffset) * 60000); // 調整到台灣時區
  
  const year = taiwanTime.getFullYear();
  const month = (taiwanTime.getMonth() + 1).toString().padStart(2, '0'); // 月份從 0 開始，所以要加 1
  const day = taiwanTime.getDate().toString().padStart(2, '0');
  const hours = taiwanTime.getHours().toString().padStart(2, '0');
  const minutes = taiwanTime.getMinutes().toString().padStart(2, '0');
  
  return `${year}年${month}月${day}日${hours}時${minutes}分`;
}

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
    await page.type('#T_Account', process.env.ACCOUNT_NAME);  // 帳號
    await page.type('#T_Password', process.env.ACCOUNT_PASSWORD);  // 密碼


    // 3. 點擊登入按鈕並等待導航完成
    await Promise.all([
      page.click('#Btn_Login'),
      page.waitForNavigation({ waitUntil: 'networkidle0' }) // 等待頁面完全載入
    ]);

    // 4-1. 抓取 PM10 數據（第一個站點）
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100184');
      const iframeElement184 = await page.waitForSelector('iframe#ifs');
      const iframe184 = await iframeElement184.contentFrame();
      const pm10Data184 = await iframe184.evaluate(() => {
      const pm10Element184 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element184 ? pm10Element184.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(184) PM10 數據:', pm10Data184);

    // 4-2. 抓取 PM10 數據（第二個站點）
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100185');
      const iframeElement185 = await page.$('iframe#ifs');
      const iframe185 = await iframeElement185.contentFrame();
      const pm10Data185 = await iframe185.evaluate(() => {
      const pm10Element185 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element185 ? pm10Element185.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(185) PM10 數據:', pm10Data185);

    // 5. 儲存24小時記錄
    const currentTime = getCurrentDateTime();
    if (pm10Data184 || pm10Data185) {
      // 保存數據到 Firebase
      const dataRef = db.ref('pm10_records').push();
      await dataRef.set({
        timestamp: currentTime,
        station_184: pm10Data184 || null,
        station_185: pm10Data185 || null
      });
      console.log('數據已保存到 Firebase:', { pm10Data184, pm10Data185 });

      // 6. 廣播通知
      if (parseInt(pm10Data184) >= PM10_THRESHOLD) {
        console.log('發送廣播理虹(184) PM10 數據:', pm10Data184);
        broadcastMessage(`184堤外PM10濃度於${currentTime}達到 ${pm10Data184}≧${PM10_THRESHOLD} μg/m3，請啟動水線抑制揚塵`);
      }
      if (parseInt(pm10Data185) >= PM10_THRESHOLD) {
        console.log('發送廣播理虹(185) PM10 數據:', pm10Data185);
        broadcastMessage(`185堤上PM10濃度於${currentTime}達到 ${pm10Data185}≧${PM10_THRESHOLD} μg/m3，請啟動水線抑制揚塵`);
      }
    };

    // 自動刪除超過24小時的數據
    const thresholdDate = new Date(Date.now() - 24 * 60 * 60 * 1000).getTime();
    const oldRecordsRef = db.ref('pm10_records').orderByChild('timestamp').endAt(thresholdDate);
    oldRecordsRef.once('value', (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        childSnapshot.ref.remove();
        console.log(`已刪除過期數據: ${childSnapshot.key}`);
      });
    });

  } catch (error) {
    console.error('抓取數據時出錯:', error);
  } finally {
    await browser.close(); // 瀏覽器關閉
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

// 過去 24 小時的數據
app.post('/webhook', (req, res) => {
  const events = req.body.events;

  // 確認有事件發生
  if (!events || events.length === 0) {
    return res.status(200).send("No events to process.");
  }

  // 處理所有事件
  events.forEach(async (event) => {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text.trim();

        // 如果用戶發送 "24小時記錄" 或 "24"
        if (userMessage === '24小時記錄' || userMessage === '24') {
          console.log('準備列出24小時記錄');

          // 查詢 Firebase 過去 24 小時的數據
          const recentRecordsRef = db.ref('pm10_records').orderByChild('timestamp');
          const snapshot = await recentRecordsRef.once('value');
          const records = [];
          snapshot.forEach((childSnapshot) => {
            const record = childSnapshot.val();
            records.push(record);
          });

          // 如果沒有記錄
          if (records.length === 0) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '過去24小時沒有記錄' });
          }

          // 生成回應訊息
          let replyText = '';
          records.reverse().forEach((record) => {
            replyText += `${record.timestamp}\n`;
            if (record.station_184) {
              replyText += `    理虹(184) PM10 數據: ${record.station_184}\n`;
            }
            if (record.station_185) {
              replyText += `    理虹(185) PM10 數據: ${record.station_185}\n`;
            }
          });

          // 回應用戶
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: replyText
          });
          console.log('24小時記錄已發送');
        }
      }
    } catch (err) {
      console.error('處理訊息時出現錯誤:', err);
      // 回應錯誤訊息給用戶
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '抱歉，發生了一些錯誤，請稍後再試。'
      });
    }
  });

  // 回應 LINE 的伺服器，告知請求已收到
  res.status(200).end();
});

// 設置 ping 路由接收 pinger-app 的請求
app.post('/ping', (req, res) => {
  console.log('來自 pinger-app 的訊息:', req.body);
  res.json({ message: 'pong' });
});

// 每5分鐘發送一次請求給pinger-app
function sendPing() {
  axios.post('https://pinger-app-m1tm.onrender.com/ping', { message: 'ping' })
    .then(response => {
      console.log('來自 pinger-app 的回應:', response.data);
    })
    .catch(error => {
      console.error('Error pinging pinger-app:', error);
    });
}
setInterval(sendPing, 5 * 60 * 1000);

// 每5分鐘( 0, 5, 10, 15, ... 55)執行一次抓取任務
function scheduleTaskAtIntervals(task, intervalMinutes) {
  const now = new Date();
  const minutes = now.getMinutes();
  const nextMinute = Math.ceil(minutes / intervalMinutes) * intervalMinutes;
  const delay = ((nextMinute - minutes) * 60 - now.getSeconds()) * 1000;

  setTimeout(() => {
    task();
    setInterval(task, intervalMinutes * 60 * 1000); 
  }, delay);
}
scheduleTaskAtIntervals(scrapeData, 5);

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  scrapeData(); // 啟動伺服器後抓取數據
});
