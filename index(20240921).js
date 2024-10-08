const express = require("express");
const puppeteer = require("puppeteer");
const axios = require('axios');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
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

async function generateRecordFile(dailyRecords, sortedDates) {
  let fileContent = '';

  for (const date of sortedDates) {
    const sortedHours = Object.keys(dailyRecords[date]).sort((a, b) => parseInt(b) - parseInt(a));
    for (const hour of sortedHours) {
      fileContent += `${date} ${hour}:00 - ${hour}:59\n${dailyRecords[date][hour]}\n`;
    }
  }

  const filePath = path.join(__dirname, 'records', '24hr_record.txt');

  // 檢查並創建 records 目錄
  const dir = path.join(__dirname, 'records');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true }); // 創建目錄，{ recursive: true } 保證多層目錄可以被創建
  }

  fs.writeFileSync(filePath, fileContent, 'utf8');
  return filePath;
}

let lastAlertTime = 0;  // 記錄上一次警告的時間
const ALERT_INTERVAL = 60 * 60 * 1000;  // 1 小時的警告間隔

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

  let result = { station_184: null, station_185: null, alertSent: false }; // 新增 alertSent 標誌

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

    // 保存到 Firebase
    if (result.station_184 || result.station_185) {
      const currentTime = getCurrentDateTime();
      const dataRef = db.ref('pm10_records').push();
      await dataRef.set({
        timestamp: currentTime,
        station_184: result.station_184 || null,
        station_185: result.station_185 || null
      });
      console.log('數據已保存到 Firebase:', result);
      console.log('閾值:', PM10_THRESHOLD);
    }

    // 檢查是否超過閾值，並發送警告及廣播
    let alertMessages = [];
    const now = Date.now();
    if (now - lastAlertTime > ALERT_INTERVAL) {  // 確保至少1小時才發一次廣播
      if (result.station_184 && parseInt(result.station_184) >= PM10_THRESHOLD) {
        const alertMessage184 = `理虹(184) PM10 濃度即時數據為 ${result.station_184} μg/m³，已超過 ${PM10_THRESHOLD} μg/m³，請立即啟動抑制措施！`;
        console.log('自動抓取超過閾值 (184) 發送警告:', alertMessage184);
        alertMessages.push(alertMessage184);
      }

      if (result.station_185 && parseInt(result.station_185) >= PM10_THRESHOLD) {
        const alertMessage185 = `理虹(185) PM10 濃度即時數據為 ${result.station_185} μg/m³，已超過 ${PM10_THRESHOLD} μg/m³，請立即啟動抑制措施！`;
        console.log('自動抓取超過閾值 (185) 發送警告:', alertMessage185);
        alertMessages.push(alertMessage185);
      }

      // 如果有任何警告訊息，則進行廣播
      if (alertMessages.length > 0) {
        const combinedAlertMessage = alertMessages.join('\n');
        await broadcastMessage(combinedAlertMessage);
        result.alertSent = true;
        lastAlertTime = now;  // 更新上次廣播的時間
      }
    } else {
      console.log('1小時內已發送過警告，跳過廣播。');
    }

  } catch (error) {
    console.error('抓取數據時出錯:', error);
  } finally {
    await browser.close();
    return result;  // 返回抓取到的數據
  }
}

// 廣播訊息給所有使用者，包含指數退避和抖動重試機制
async function broadcastMessage(message, retries = 5) {
  console.log(`廣播發送中: ${message}`);
  let delay = 1000;  // 初始等待時間 1 秒

  for (let i = 0; i < retries; i++) {
    try {
      await client.broadcast({
        type: 'text',
        text: message
      });
      console.log('廣播訊息已成功發送');
      return;  // 成功發送後結束函數
    } catch (err) {
      if (err.statusCode === 429 && i < retries - 1) {
        // 429 錯誤，開始重試
        console.log(`限流錯誤，重試第 ${i + 1} 次...`);

        // 加入抖動，隨機化等待時間
        const jitter = Math.random() * delay;
        await new Promise(resolve => setTimeout(resolve, delay + jitter));

        // 指數退避，等待時間加倍
        delay *= 2;
      } else {
        // 若非 429 錯誤，或重試次數已達上限，則報告錯誤
        console.error('發送廣播訊息時發生錯誤:', err);
        break;  // 終止重試
      }
    }
  }
}


// 處理所有事件
app.post('/webhook', async (req, res) => {
  const events = req.body.events;

  if (!events || events.length === 0) {
    return res.status(200).send("No events to process.");
  }

  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const userMessage = event.message.text.trim();

      // 24小時記錄
      if (userMessage === '24小時記錄' || userMessage === '24') {
        console.log('準備生成24小時記錄檔案');

        // 先刪除超過24小時的記錄
        await deleteOldRecords();

        const now = new Date();
        const last24Hours = now.getTime() - (24 * 60 * 60 * 1000); // 計算24小時前的時間戳

        // 從 Firebase 查詢過去24小時的記錄
        const recentRecordsRef = db.ref('pm10_records').orderByChild('timestamp');
        const snapshot = await recentRecordsRef.once('value');
        const records = [];

        snapshot.forEach((childSnapshot) => {
          const record = childSnapshot.val();
          const timestamp = record.timestamp;

          const [datePart, timePart] = timestamp.split(' ');
          const [month, day] = datePart.split('/').map(Number);
          const [hours, minutes] = timePart.split(':').map(Number);

          const recordDate = new Date();
          recordDate.setFullYear(now.getFullYear());
          recordDate.setMonth(month - 1);
          recordDate.setDate(day);
          recordDate.setHours(hours);
          recordDate.setMinutes(minutes);

          if (recordDate.getTime() >= last24Hours) {
            records.push(record);
          }
        });

        // 整理記錄，並找出超過閾值的記錄
        let dailyRecords = {};
        let highThresholdRecords = ''; // 超過閾值的記錄
        let highestLowestRecords = ''; // 記錄最高和最低值
        const PM10_THRESHOLD = parseInt(process.env.PM10_THRESHOLD);

        let highest184 = { value: -Infinity, timestamp: '' };
        let lowest184 = { value: Infinity, timestamp: '' };
        let highest185 = { value: -Infinity, timestamp: '' };
        let lowest185 = { value: Infinity, timestamp: '' };

        records.reverse().forEach((record) => {
          const timestamp = record.timestamp;
          const [date, time] = timestamp.split(' ');
          const hour = time.split(':')[0];

          if (!dailyRecords[date]) {
            dailyRecords[date] = {};
          }
          if (!dailyRecords[date][hour]) {
            dailyRecords[date][hour] = '';
          }

          dailyRecords[date][hour] += `${timestamp} - `;
          if (record.station_184) {
            const pm10Value184 = parseInt(record.station_184);
            dailyRecords[date][hour] += `理虹(184): ${record.station_184}`;
            if (pm10Value184 >= PM10_THRESHOLD) {
              highThresholdRecords += `${timestamp} - 理虹(184): ${record.station_184} μg/m³\n`;
            }
            // 更新最高和最低值
            if (pm10Value184 > highest184.value) {
              highest184.value = pm10Value184;
              highest184.timestamp = timestamp;
            }
            if (pm10Value184 < lowest184.value) {
              lowest184.value = pm10Value184;
              lowest184.timestamp = timestamp;
            }
          }
          if (record.station_185) {
            const pm10Value185 = parseInt(record.station_185);
            if (record.station_184) {
              dailyRecords[date][hour] += ' / ';
            }
            dailyRecords[date][hour] += `理虹(185): ${record.station_185}`;
            if (pm10Value185 >= PM10_THRESHOLD) {
              highThresholdRecords += `${timestamp} - 理虹(185): ${record.station_185} μg/m³\n`;
            }
            // 更新最高和最低值
            if (pm10Value185 > highest185.value) {
              highest185.value = pm10Value185;
              highest185.timestamp = timestamp;
            }
            if (pm10Value185 < lowest185.value) {
              lowest185.value = pm10Value185;
              lowest185.timestamp = timestamp;
            }
          }
          dailyRecords[date][hour] += '\n';
        });

        // 添加最高和最低值到回覆訊息
        highestLowestRecords += `理虹(184) 最高值: ${highest184.value} μg/m³ (發生於: ${highest184.timestamp})\n`;
        highestLowestRecords += `理虹(185) 最高值: ${highest185.value} μg/m³ (發生於: ${highest185.timestamp})\n`;
        highestLowestRecords += `理虹(184) 最低值: ${lowest184.value} μg/m³ (發生於: ${lowest184.timestamp})\n`;        
        highestLowestRecords += `理虹(185) 最低值: ${lowest185.value} μg/m³ (發生於: ${lowest185.timestamp})\n`;

        const sortedDates = Object.keys(dailyRecords).sort((a, b) => new Date(b) - new Date(a));
        
        // 生成記錄檔案
        let fileContent = '';
        for (const date of sortedDates) {
          const sortedHours = Object.keys(dailyRecords[date]).sort((a, b) => parseInt(b) - parseInt(a));
          for (const hour of sortedHours) {
            fileContent += `${date} ${hour}:00 - ${hour}:59\n${dailyRecords[date][hour]}\n`;
          }
        }

        // 確保 records 資料夾存在
        const dir = path.join(__dirname, 'records');
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const filePath = path.join(dir, '24hr_record.txt');
        fs.writeFileSync(filePath, fileContent, 'utf8');

        // 提供下載連結
        const downloadLink = `https://puppeteer-render-f857.onrender.com/download?file=24hr_record.txt`;

        // 準備回覆訊息
        let replyMessage = highestLowestRecords; // 加入最高和最低值
        if (highThresholdRecords) {
          replyMessage = `以下為24小時內超過 ${PM10_THRESHOLD} μg/m³ 的記錄：\n${highThresholdRecords}\n\n` + replyMessage;
        } else {
          replyMessage = `24小時內沒有超過 ${PM10_THRESHOLD} μg/m³ 的記錄。\n\n` + replyMessage;
        }

        // 檢查訊息字數是否超過 300 字
        const MAX_LENGTH = 300;
        if (replyMessage.length > MAX_LENGTH) {
          replyMessage = replyMessage.slice(0, MAX_LENGTH) + "...資料過多，請點擊24小時記錄查詢。";
        }

        // 發送訊息包含超過閾值的記錄及下載連結
        await client.replyMessage(event.replyToken, [
          {
            type: 'text',
            text: replyMessage
          },
          {
            type: 'text',
            text: `24小時內的記錄已生成，請點擊下方鏈接下載：\n${downloadLink}`
          }
        ]);
      }

      // 即時查詢 PM10 數據
      if (userMessage === '即時查詢') {
        console.log('執行即時查詢');
      
        // 調用 scrapeData 函數進行即時查詢
        const currentData = await scrapeData();
      
        // 檢查是否已經發送了警示
        if (currentData.alertSent) {
          console.log('已發送警示，跳過訊息回覆');
        } else {
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
      
          // 回覆訊息給用戶
          await client.replyMessage(event.replyToken, {
            type: 'text',
            text: messageText
          });
      
          console.log('即時查詢結果已發送');
        }
      }

      // 檢查是否以 "廣播" 開頭
      if (userMessage.startsWith('廣播')) {
        const broadcastMessageText = userMessage;
        console.log('收到廣播請求，訊息內容:', broadcastMessageText);

        // 廣播訊息
        await broadcastMessage(broadcastMessageText);

        // 回覆使用者廣播已發送
        await client.replyMessage(event.replyToken, {
          type: 'text',
          text: '廣播訊息已發送給所有使用者。'
        });
        continue;
      }

    }
  }
  res.status(200).end();
});

// 下載路由
app.get('/download', (req, res) => {
  const file = path.join(__dirname, 'records', req.query.file);
  res.download(file, (err) => {
    if (err) {
      console.error('下載文件時出錯:', err);
      res.status(500).send('文件下載失敗');
    }
  });
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

// 刪除超過24小時記錄的函數
async function deleteOldRecords() {
  const now = new Date(); // 獲取當前時間
  const last24Hours = now.getTime() - 24 * 60 * 60 * 1000; // 24小時前的時間戳

  // 查詢所有記錄
  const recordsRef = db.ref('pm10_records').orderByChild('timestamp');
  const snapshot = await recordsRef.once('value');

  // 遍歷所有記錄，刪除超過24小時的
  snapshot.forEach((childSnapshot) => {
    const record = childSnapshot.val();
    const timestamp = record.timestamp; // 假設格式為 "MM/DD HH:MM"

    // 手動解析日期和時間
    const [datePart, timePart] = timestamp.split(' ');
    const [month, day] = datePart.split('/').map(Number); // 解析月份和日期
    const [hours, minutes] = timePart.split(':').map(Number); // 解析小時和分鐘

    // 使用當前年份來創建 Date 對象
    const recordDate = new Date();
    recordDate.setFullYear(now.getFullYear()); // 使用當前年份
    recordDate.setMonth(month - 1); // 月份從0開始
    recordDate.setDate(day);
    recordDate.setHours(hours, minutes, 0, 0); // 設置小時、分鐘，並清零秒和毫秒

    // 比較日期是否超過24小時
    if (recordDate.getTime() < last24Hours) {
      // 刪除這條舊記錄
      db.ref(`pm10_records/${childSnapshot.key}`).remove()
        .then(() => {
          console.log(`刪除了超過24小時的記錄: ${childSnapshot.key}`);
        })
        .catch((error) => {
          console.error(`刪除記錄時出錯: ${error}`);
        });
    }
  });
}


// 每小時執行一次刪除任務
setInterval(deleteOldRecords, 60 * 60 * 1000); // 每小時執行一次

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
