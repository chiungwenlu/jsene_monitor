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
  
  const month = (taiwanTime.getMonth() + 1).toString().padStart(2, '0'); // 月份從 0 開始，所以要加 1
  const day = taiwanTime.getDate().toString().padStart(2, '0');
  const hours = taiwanTime.getHours().toString().padStart(2, '0');
  const minutes = taiwanTime.getMinutes().toString().padStart(2, '0');
  
  return `${month}/${day} ${hours}:${minutes}`;
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

  let result = { station_184: null, station_185: null };

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
    result.station_184 = await iframe184.evaluate(() => {
      const pm10Element184 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element184 ? pm10Element184.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(184) PM10 數據:', result.station_184);

    // 4-2. 抓取 PM10 數據（第二個站點）
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100185');
    const iframeElement185 = await page.$('iframe#ifs');
    const iframe185 = await iframeElement185.contentFrame();
    result.station_185 = await iframe185.evaluate(() => {
      const pm10Element185 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
      return pm10Element185 ? pm10Element185.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
    });
    console.log('理虹(185) PM10 數據:', result.station_185);

    // 保存數據到 Firebase
    if (result.station_184 || result.station_185) {
      const currentTime = getCurrentDateTime();

      // 查詢是否已有相同 timestamp 的記錄
      const existingRecordRef = db.ref('pm10_records').orderByChild('timestamp').equalTo(currentTime);
      const snapshot = await existingRecordRef.once('value');
      // 如果沒有相同的 timestamp，則保存數據
      if (!snapshot.exists()) {
        const dataRef = db.ref('pm10_records').push();
        await dataRef.set({
          timestamp: currentTime,
          station_184: result.station_1844 || null,
          station_185: result.station_185 || null
        });
        console.log('數據已保存到 Firebase(位置E):', result);
      } else {
        console.log('已存在相同時間的數據，不進行保存。');
      }
    }

  } catch (error) {
    console.error('抓取數據時出錯:', error);
  } finally {
    await browser.close();
    return result;  // 返回抓取到的數據
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

// 處理所有事件
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
        
          if (records.length === 0) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '過去24小時沒有記錄' });
          }
        
          let highThresholdRecords = ''; // 超過閾值的記錄
          let hourlyRecords = {};         // 按每小時分組的記錄
        
          // 分組記錄，按每個小時來分
          records.reverse().forEach((record) => {
            const timestamp = record.timestamp;
            const hour = timestamp.split(' ')[1].split(':')[0]; // 獲取小時部分
        
            // 初始化小時分組
            if (!hourlyRecords[hour]) {
              hourlyRecords[hour] = '';
            }
        
            // 超過閾值的記錄
            if (record.station_184 && parseInt(record.station_184) >= PM10_THRESHOLD) {
              highThresholdRecords += `${timestamp} - 理虹(184): ${record.station_184}\n`;
            }
            if (record.station_185 && parseInt(record.station_185) >= PM10_THRESHOLD) {
              highThresholdRecords += `${timestamp} - 理虹(185): ${record.station_185}\n`;
            }
        
            // 將記錄添加到對應小時
            hourlyRecords[hour] += `${timestamp} - `;
            if (record.station_184) {
              hourlyRecords[hour] += `理虹(184): ${record.station_184}`;
            }
            if (record.station_185) {
              if (record.station_184) {
                hourlyRecords[hour] += ' / ';
              }
              hourlyRecords[hour] += `理虹(185): ${record.station_185}`;
            }
            hourlyRecords[hour] += '\n';
          });
        
          // 發送超過閾值的記錄
          if (highThresholdRecords) {
            await client.replyMessage(event.replyToken, [
              {
                type: 'text',
                text: `以下為超過 ${PM10_THRESHOLD} 的記錄：`
              },
              {
                type: 'text',
                text: `${highThresholdRecords}`
              },
              {
                type: 'text',
                text: `以下為24小時內的記錄：`
              }
            ]);
          } else {
            await client.replyMessage(event.replyToken, [
              {
                type: 'text',
                text: `在24小時內，沒有超過 ${PM10_THRESHOLD} 的記錄`
              },
              {
                type: 'text',
                text: `以下為24小時內的記錄：`
              }
            ]);
          }
        
          // 發送每小時的記錄，分別作為不同的訊息
          const sendHourlyMessages = Object.keys(hourlyRecords).map(async (hour) => {
            const message = {
              type: 'text',
              text: `${hourlyRecords[hour]}`
            };
            return client.pushMessage(event.source.userId, message);
          });
        
          // 確保所有訊息依次發送
          await Promise.all(sendHourlyMessages);
        
          console.log('24小時記錄已發送');
        }

        // 新增：即時查詢 PM10 數據
        if (userMessage === '即時查詢') {
          console.log('執行即時查詢');

          // 先回覆用戶查詢中的訊息
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: '查詢中，請稍待…'
          });

          // 調用 scrapeData 函數進行即時查詢
          const currentData = await scrapeData();

          // 構建查詢結果的回覆訊息
          let messageText = '即時 PM10 數據：\n';
          if (currentData.station_184) {
            messageText += `理虹(184): ${currentData.station_184} μg/m³\n`;
          } else {
            messageText += '理虹(184): 無法取得數據\n';
          }
          if (currentData.station_185) {
            messageText += `理虹(185): ${currentData.station_185} μg/m³\n`;
          } else {
            messageText += '理虹(185): 無法取得數據\n';
          }

          // 保存數據到 Firebase
          if (currentData.station_184 || currentData.station_185) {
            const currentTime = getCurrentDateTime();

            // 查詢是否已有相同 timestamp 的記錄
            const existingRecordRef = db.ref('pm10_records').orderByChild('timestamp').equalTo(currentTime);
            const snapshot = await existingRecordRef.once('value');
            // 如果沒有相同的 timestamp，則保存數據
            if (!snapshot.exists()) {
              const dataRef = db.ref('pm10_records').push();
              await dataRef.set({
                timestamp: currentTime,
                station_184: currentData.station_184 || null,
                station_185: currentData.station_185 || null
              });
              console.log('數據已保存到 Firebase(位置E):', currentData);
            } else {
              console.log('已存在相同時間的數據，不進行保存。');
            }
          }

          // 回覆訊息給用戶
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: messageText
          });

          // 檢查是否超過閾值，並發送警告及廣播
          if (currentData.station_184 && parseInt(currentData.station_184) >= PM10_THRESHOLD) {
            const currentTime = getCurrentDateTime();
            const alertMessage184 = `理虹(184)堤外 PM10 濃度於${currentTime}達到${currentData.station_184} μg/m³≧${PM10_THRESHOLD} μg/m³，請啟動水線抑制揚塵`;
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: alertMessage184
            });
            console.log('即時查詢超過閾值 (184) 發送警告:', alertMessage184);
            
            // 廣播警告訊息
            await broadcastMessage(alertMessage184);
          }

          if (currentData.station_185 && parseInt(currentData.station_185) >= PM10_THRESHOLD) {
            const currentTime = getCurrentDateTime();
            const alertMessage185 = `理虹(185)堤上 PM10 濃度於${currentTime}達到${currentData.station_185} μg/m³≧${PM10_THRESHOLD} μg/m³，請啟動水線抑制揚塵`;
            await client.replyMessage(event.replyToken, {
              type: 'text',
              text: alertMessage185
            });
            console.log('即時查詢超過閾值 (185) 發送警告:', alertMessage185);
            
            // 廣播警告訊息
            await broadcastMessage(alertMessage185);
          }

          console.log('即時查詢結果已發送');
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