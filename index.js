const express = require("express");
const puppeteer = require("puppeteer");
const moment = require('moment-timezone');
const axios = require('axios');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
require("dotenv").config();

const app = express();
const PORT = 4000;

// 設置台灣時區
moment.tz.setDefault("Asia/Taipei");

// 解析 JSON 請求
app.use(express.json());

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

// 從 Firebase 讀取設定，包含 PM10 閾值、SCRAPE_INTERVAL，以及帳號密碼
async function getSettings() {
    // 讀取 PM10 閾值
    const thresholdRef = db.ref('settings/PM10_THRESHOLD');
    const thresholdSnapshot = await thresholdRef.once('value');
    let threshold = thresholdSnapshot.val();

    // 若 PM10 閾值不存在，則設為 126 並寫回 Firebase
    if (threshold === null) {
        threshold = 126;
        await thresholdRef.set(threshold);
        console.log(`PM10_THRESHOLD 不存在，已自動設為預設值: ${threshold}`);
    } else {
        console.log(`從 Firebase 獲取的 PM10_THRESHOLD: ${threshold}`);
    }

    // 讀取 SCRAPE_INTERVAL
    const intervalRef = db.ref('settings/SCRAPE_INTERVAL');
    const intervalSnapshot = await intervalRef.once('value');
    let intervalMinutes = intervalSnapshot.val();

    // 如果沒有設置值，默認為 1 分鐘，並寫回 Firebase
    if (intervalMinutes === null) {
        intervalMinutes = 1;
        await intervalRef.set(intervalMinutes);
        console.log(`SCRAPE_INTERVAL 不存在，已自動設為預設值: ${intervalMinutes} 分鐘`);
    } else {
        console.log(`從 Firebase 獲取的 SCRAPE_INTERVAL: ${intervalMinutes} 分鐘`);
    }

    // 讀取帳號
    const accountRef = db.ref('settings/ACCOUNT_NAME');
    const accountSnapshot = await accountRef.once('value');
    let accountName = accountSnapshot.val();

    // 若帳號不存在，則設為「ExcelTek」並寫回 Firebase
    if (accountName === null) {
        accountName = 'ExcelTek';
        await accountRef.set(accountName);
        console.log(`ACCOUNT_NAME 不存在，已自動設為預設值: ${accountName}`);
    } else {
        console.log(`從 Firebase 獲取的 ACCOUNT_NAME: ${accountName}`);
    }

    // 讀取密碼
    const passwordRef = db.ref('settings/ACCOUNT_PASSWORD');
    const passwordSnapshot = await passwordRef.once('value');
    let accountPassword = passwordSnapshot.val();

    // 若密碼不存在，則設為「ExcelTek」並寫回 Firebase
    if (accountPassword === null) {
        accountPassword = 'ExcelTek';
        await passwordRef.set(accountPassword);
        console.log(`ACCOUNT_PASSWORD 不存在，已自動設為預設值: ${accountPassword}`);
    } else {
        console.log(`從 Firebase 獲取的 ACCOUNT_PASSWORD: ${accountPassword}`);
    }

    // 確保 pm10_records 節點存在
    const recordsRef = db.ref('pm10_records');
    const snapshot = await recordsRef.once('value');

    // 檢查節點是否存在，若不存在則建立
    if (!snapshot.exists()) {
        console.log('pm10_records 節點不存在，將自動創建');
        await recordsRef.set({});
        console.log('pm10_records 節點已創建');
    } else {
        console.log('pm10_records 節點已存在');
    }

    // 回傳所有設置
    return {
        intervalMinutes: parseInt(intervalMinutes),
        threshold: parseInt(threshold),
        accountName: accountName,
        accountPassword: accountPassword
    };
}

// 保存登入會話 cookies
async function loginAndSaveCookies(page, accountName, accountPassword, isReLogin = false) {
    await page.goto('https://www.jsene.com/juno/Login.aspx');
    await page.type('#T_Account', accountName);  // 使用從 Firebase 讀取的帳號
    await page.type('#T_Password', accountPassword);  // 使用從 Firebase 讀取的密碼
    await Promise.all([
        page.click('#Btn_Login'),
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
    ]);

    const cookies = await page.cookies();
    fs.writeFileSync('cookies.json', JSON.stringify(cookies, null, 2));

    if (isReLogin) {
        console.log("已重新登入https://www.jsene.com/juno/");
    } else {
        console.log("登入成功，Cookies已保存");
    }
}

// 加載 cookies 並重用登入會話
async function loadCookies(page) {
    const cookies = JSON.parse(fs.readFileSync('cookies.json'));
    await page.setCookie(...cookies);
    console.log("Cookies loaded for session reuse.");
}

// 確保已登入，若會話過期則重新登入
async function ensureLogin(page, accountName, accountPassword) {
    const currentUrl = page.url();
    if (currentUrl.includes('Login.aspx')) {
        console.log("Session expired, re-logging in...");
        await loginAndSaveCookies(page, accountName, accountPassword); // 重新登入並保存新的 cookies
    }
}

// 構建警報訊息
function formatAlertMessage(station, stationName, pm10Value, threshold) {
    const currentTime = moment().format('YYYY年MM月DD日HH時mm分');
    return `【${stationName}PM10濃度於${currentTime}達到${pm10Value}≧${threshold}μg/m3，請啟動水線抑制揚塵】`;
}

// 抓取PM10數據
async function scrapeData() {
    // 從 Firebase 獲取設置
    const { threshold: PM10_THRESHOLD, accountName, accountPassword } = await getSettings();

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

    const page = await browser.newPage();

    // 加載已保存的 cookies
    if (fs.existsSync('cookies.json')) {
        await loadCookies(page);
    } else {
        await loginAndSaveCookies(page, accountName, accountPassword);
    }

    // 前往第一個站點頁面，確認是否需要重新登入
    await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100184');
    await ensureLogin(page, accountName, accountPassword);

    let result = { station_184: null, station_185: null };

    try {
        const iframeElement184 = await page.waitForSelector('iframe#ifs');
        const iframe184 = await iframeElement184.contentFrame();
        result.station_184 = await iframe184.evaluate(() => {
            const pm10Element184 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
            return pm10Element184 ? pm10Element184.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
        });
        console.log('理虹(184) PM10 數據:', result.station_184);

        await page.goto('https://www.jsene.com/juno/Station.aspx?PJ=200209&ST=3100185');
        const iframeElement185 = await page.$('iframe#ifs');
        const iframe185 = await iframeElement185.contentFrame();
        result.station_185 = await iframe185.evaluate(() => {
            const pm10Element185 = Array.from(document.querySelectorAll('.list-group-item')).find(el => el.textContent.includes('PM10'));
            return pm10Element185 ? pm10Element185.querySelector('span.pull-right[style*="right:60px"]').textContent.trim() : null;
        });
        console.log('理虹(185) PM10 數據:', result.station_185);

        if (result.station_184 || result.station_185) {
            const dataRef = db.ref('pm10_records').push();
            await dataRef.set({
                timestamp: moment().valueOf(),
                station_184: result.station_184 || null,
                station_185: result.station_185 || null
            });
            console.log('數據已保存到 Firebase:', result);
        }

        let alertMessages = [];
        if (result.station_184 && parseInt(result.station_184) >= PM10_THRESHOLD) {
            const alertMessage184 = formatAlertMessage('184堤外', '184堤外', result.station_184, PM10_THRESHOLD);
            console.log('自動抓取超過閾值 (184) 發送警告:', alertMessage184);
            alertMessages.push(alertMessage184);
        }

        if (result.station_185 && parseInt(result.station_185) >= PM10_THRESHOLD) {
            const alertMessage185 = formatAlertMessage('185堤上', '185堤上', result.station_185, PM10_THRESHOLD);
            console.log('自動抓取超過閾值 (185) 發送警告:', alertMessage185);
            alertMessages.push(alertMessage185);
        }

        if (alertMessages.length > 0) {
            const combinedAlertMessage = alertMessages.join('\n');
            await broadcastMessage(combinedAlertMessage);
            result.alertSent = true;
        }

    } catch (error) {
        console.error('抓取數據時出錯:', error);
    } finally {
        await browser.close();
        return result;
    }
}

// Webhook 接收事件處理
app.post('/webhook', line.middleware(config), async (req, res) => {
    const events = req.body.events;

    // 處理所有接收到的事件
    events.forEach(async (event) => {
        // 確認事件類型為 message 且訊息為文字
        if (event.type === 'message' && event.message.type === 'text') {
            const userMessage = event.message.text;

            // 當使用者發送 "即時查詢" 訊息時
            if (userMessage === '即時查詢') {
                try {
                    // 從 Firebase 取得最近的 PM10 資料
                    const recentPM10Data = await getLatestPM10Data();
                    const replyMessage = formatPM10ReplyMessage(recentPM10Data);

                    // 回應使用者
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: replyMessage
                    });
                } catch (error) {
                    console.error('取得 PM10 資料時發生錯誤:', error);
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '抱歉，無法取得最新的 PM10 資料，請稍後再試。'
                    });
                }
            }
        }
    });

    // 回應 200 狀態碼，告知 LINE 接收成功
    res.status(200).end();
});

// 從 Firebase 取得最新的 PM10 資料
async function getLatestPM10Data() {
    const recordsRef = db.ref('pm10_records');
    const snapshot = await recordsRef.orderByKey().limitToLast(1).once('value');
    
    let latestData = null;
    snapshot.forEach((childSnapshot) => {
        latestData = childSnapshot.val();
    });

    return latestData;
}

// 格式化回傳的 PM10 訊息
function formatPM10ReplyMessage(pm10Data) {
    if (!pm10Data) {
        return '目前沒有可用的 PM10 資料。';
    }

    const timestamp = moment(pm10Data.timestamp).format('YYYY年MM月DD日 HH:mm');
    const station184 = pm10Data.station_184 || '無資料';
    const station185 = pm10Data.station_185 || '無資料';

    return `最近的 PM10 資料：\n` +
           `時間：${timestamp}\n` +
           `184堤外 PM10：${station184} μg/m³\n` +
           `185堤上 PM10：${station185} μg/m³`;
}

// 發送廣播訊息
async function broadcastMessage(message) {
    try {
        await client.broadcast({
            type: 'text',
            text: message
        });
        console.log('廣播訊息成功發送:', message);
    } catch (error) {
        console.error('廣播訊息發送失敗:', error);
    }
}

// 定時抓取任務
async function scheduleTaskAtIntervals(task) {
    const { intervalMinutes } = await getSettings();
    const now = new Date();
    const minutes = now.getMinutes();
    const nextMinute = Math.ceil(minutes / intervalMinutes) * intervalMinutes;
    const delay = ((nextMinute - minutes) * 60 - now.getSeconds()) * 1000;

    setTimeout(() => {
        task();
        setInterval(task, intervalMinutes * 60 * 1000);
    }, delay);
}

scheduleTaskAtIntervals(scrapeData);

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

app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
