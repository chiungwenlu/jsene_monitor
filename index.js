const express = require("express");
const puppeteer = require("puppeteer");     // 引入 Puppeteer，用於自動化控制瀏覽器，主要用來抓取PM10數據
const moment = require('moment-timezone');
const axios = require('axios');     // 引入 Axios，用來處理HTTP請求，例如與外部API溝通. 主要用於查詢LINE帳戶的訊息發送配額和已使用的訊息數量
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const fs = require('fs');   // 引入內建的檔案系統（fs）和路徑（path）模組，用來處理檔案存取、路徑操作（例如保存Cookie、生成檔案下載路徑）
const path = require('path');
require("dotenv").config(); // 引入並載入 .env 環境變數文件，用來保存敏感資料（如API金鑰）

const app = express();  // 創建Express應用實例，提供路由及中介軟體的支援
const PORT = process.env.PORT || 4000;

// 設置台灣時區
moment.tz.setDefault("Asia/Taipei");

// 解析 JSON 請求
app.use(express.json()); //  LINE Webhook 或其他 API 請求，如pinger

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
const db = admin.database(); // 建立 Firebase Database 物件

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

    // 如果沒有設置值，默認為 10 分鐘，並寫回 Firebase
    if (intervalMinutes === null) {
        intervalMinutes = 10;
        await intervalRef.set(intervalMinutes);
        console.log(`SCRAPE_INTERVAL 不存在，已自動設為預設值: ${intervalMinutes} 分鐘`);
    } else {
        console.log(`從 Firebase 獲取的 SCRAPE_INTERVAL: ${intervalMinutes} 分鐘`);
    }

    // 讀取警告間隔
    const alertIntervalRef = db.ref('settings/ALERT_INTERVAL');
    const alertIntervalSnapshot = await alertIntervalRef.once('value');
    let alertInterval = alertIntervalSnapshot.val();

    // 如果沒有設置值，默認為 60 分鐘，並寫回 Firebase
    if (alertInterval === null) {
        alertInterval = 60;
        await alertIntervalRef.set(alertInterval);
        console.log(`SCRAPE_INTERVAL 不存在，已自動設為預設值: ${alertInterval} 分鐘`);
    } else {
        console.log(`從 Firebase 獲取的 ALERT_INTERVAL: ${alertInterval} 分鐘`);
    }

    // 讀取www.jsene.com的帳號
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

    // 讀取www.jsene.com的密碼
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

    // 回傳所有設置
    return {
        intervalMinutes: parseInt(intervalMinutes),
        threshold: parseInt(threshold),
        alertInterval: parseInt(alertInterval),
        accountName: accountName,
        accountPassword: accountPassword
    };
}

// 從 Firebase 取得上次發出警告的時間
async function getLastAlertTime() {
    const alertTimeRef = db.ref('settings/LAST_ALERT_TIME');
    const snapshot = await alertTimeRef.once('value');
    return snapshot.val();
}

// 更新上次發出警告的時間
async function updateLastAlertTime(now) {
    const alertTimeRef = db.ref('settings/LAST_ALERT_TIME');
    await alertTimeRef.set(now.valueOf());
}

// 儲存使用者資料到 Firebase
function saveUserProfile(userId, userName) {
  db.ref(`users/${userId}`).update({
    id: userId,
    name: userName
  }).catch(error => {
    console.error('儲存使用者資料發生錯誤:', error);
  });
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

// 保存新資料到 Firebase
async function savePM10DataAndCleanup(pm10Data) {
    const dataRef = db.ref('pm10_records').push();
    
    // 保存新資料
    await dataRef.set({
        timestamp: moment().valueOf(),
        station_184: pm10Data.station_184 || null,
        station_185: pm10Data.station_185 || null
    });

    console.log('新數據已保存到 Firebase:', pm10Data);

    // 呼叫清理函數刪除超過 24 小時的舊資料
    await cleanupOldPM10Records();
}

// 刪除超過 24 小時的 PM10 資料
async function cleanupOldPM10Records() {
    const currentTime = moment().valueOf(); // 取得當前時間的時間戳
    const twentyFourHoursAgo = currentTime - (24 * 60 * 60 * 1000);

    const recordsRef = db.ref('pm10_records');

    // 查詢 24 小時前的紀錄
    const oldRecordsSnapshot = await recordsRef.orderByChild('timestamp').endAt(twentyFourHoursAgo).once('value');

    const updates = {};

    oldRecordsSnapshot.forEach((childSnapshot) => {
        const recordData = childSnapshot.val();
        const recordTimestamp = recordData.timestamp;
        const formattedTime = moment(recordTimestamp).format('YYYY年MM月DD日 HH:mm');

        updates[childSnapshot.key] = null;

        console.log(`刪除記錄: ${formattedTime}\n${childSnapshot.key} `);
    });

    await recordsRef.update(updates);
    console.log('已刪除超過 24 小時的記錄');
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
        console.log('iframe184: ', iframe184);
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
            // 保存新資料並清理舊的資料
            await savePM10DataAndCleanup(result);
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
app.post('/webhook', async (req, res) => {
    const events = req.body.events;

    if (!events || events.length === 0) {
        return res.status(200).send("No events to process.");
    }

    for (const event of events) {
        if (event.type === 'message' && event.message.type === 'text') {
            const userMessage = event.message.text.trim();

            if (userMessage === '即時查詢') {
                console.log('執行即時查詢');
                try {
                    // 1. 從 Firebase 取得最近一筆資料的時間
                    const recentPM10Data = await getLatestPM10Data();
                    const lastEntryTime = recentPM10Data ? recentPM10Data.timestamp : null;
                    const currentTime = moment().valueOf();  // 當前時間

                    // 2. 計算時間差，若超過1分鐘則抓取新資料
                    if (lastEntryTime && (currentTime - lastEntryTime > 1 * 60 * 1000)) {
                        console.log('最近資料超過1分鐘，抓取新資料...');

                        // 3. 設定抓取範圍，從 Firebase 最新資料的下一筆開始
                        const startTime = moment(lastEntryTime).add(1, 'minute');
                        const endTime = moment();  // 當前時間
                        const startDate = startTime.format('YYYY/MM/DD HH:mm');
                        const endDate = endTime.format('YYYY/MM/DD HH:mm');
                        console.log(`資料抓取區間${startDate} ~ ${endDate}`);

                        // 4. 抓取時間間隔內的資料
                        const station184Data = await scrapeStationData('3100184', startDate, endDate);
                        const station185Data = await scrapeStationData('3100185', startDate, endDate);

                        // 保存抓取的資料到 Firebase
                        await savePM10DataToFirebase(station184Data, station185Data);

                        // 5. 檢查抓取到的資料是否超過閾值
                        const exceedAlert = checkExceedThresholdInRange(station184Data, station185Data);
                        if (exceedAlert) {
                            console.log('超過閾值：', exceedAlert);
                        } else {
                            console.log('未超過閾值：');
                        }
                        
                        // 6. 回應最新一筆資料，並提示是否有超過閾值
                        const latestData = station184Data.length ? station184Data[station184Data.length - 1] : recentPM10Data;
                        const replyMessage = formatPM10ReplyMessage(latestData);

                        // 回應使用者最新資料
                        await client.replyMessage(event.replyToken, {
                            type: 'text',
                            text: replyMessage
                        });

                        // // 如果有超過閾值的資料，也回應
                        // if (exceedAlert) {
                        //     await client.replyMessage(event.replyToken, {
                        //         type: 'text',
                        //         text: exceedAlert
                        //     });
                        // }

                    } else {
                        console.log('資料在1分鐘內，直接回應 Firebase 資料...');
                        const replyMessage = formatPM10ReplyMessage(recentPM10Data);

                        // 回應使用者 Firebase 中的最新資料
                        await client.replyMessage(event.replyToken, {
                            type: 'text',
                            text: replyMessage
                        });

                        // 檢查是否超過閾值
                        const exceedAlert = checkExceedThreshold([recentPM10Data]);
                        if (exceedAlert) {
                            await client.replyMessage(event.replyToken, {
                                type: 'text',
                                text: exceedAlert
                            });
                        }
                    }

                } catch (error) {
                    console.error('即時查詢過程中發生錯誤:', error);
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '抱歉，無法取得最新的 PM10 資料，請稍後再試。'
                    });
                }
            }

            // 當使用者發送 "24小時記錄" 訊息時
            if (userMessage === '24小時記錄') {
                console.log('執行 24 小時記錄查詢');
                try {
                    // 從 Firebase 取得 24 小時內的記錄
                    const records = await get24HourRecords();

                    // 取得設定中的 PM10 閾值
                    const { threshold: PM10_THRESHOLD } = await getSettings();
                    
                    // 生成文字檔 24hr_record.txt
                    const filePath = await generateRecordFile(records);
                    
                    // 將超過閾值的記錄發送給使用者
                    const exceedingRecords = getExceedingRecords(records, PM10_THRESHOLD);
                    let exceedMessage = exceedingRecords.length > 0 
                        ? `24 小時內PM10超過閾值 ${PM10_THRESHOLD} 的記錄如下：\n${exceedingRecords.join('\n')}` 
                        : `24 小時內PM10沒有超過閾值 ${PM10_THRESHOLD} 的記錄。`;

                    // 回應使用者並提供下載連結
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `${exceedMessage}\n\n點擊以下連結下載 24 小時記錄：\n${req.protocol}://${req.get('host')}/download/24hr_record.txt`
                    });
                } catch (error) {
                    console.error('取得 24 小時記錄時發生錯誤:', error);
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '抱歉，無法取得 24 小時記錄，請稍後再試。'
                    });
                }
            }
        }
    }
    res.status(200).end();
});

// 檢查資料範圍內是否有超過閾值，並判斷是否應發送警告
async function checkExceedThresholdInRange(station184Data, station185Data) {
    const { threshold: PM10_THRESHOLD, alertInterval: ALERT_INTERVAL } = await getSettings();
    let exceedMessages = [];

    // 取得上次發出警告的時間
    const lastAlertTime = await getLastAlertTime();
    const currentTime = moment().valueOf();
    
    // 計算上次警告的時間間隔
    const timeSinceLastAlert = lastAlertTime ? (currentTime - lastAlertTime) / (60 * 1000) : ALERT_INTERVAL + 1; // 轉換為分鐘

    console.log('checkExceedThresholdInRange: ');
    console.log(`PM10_THRESHOLD: ${PM10_THRESHOLD}`);    
    console.log(`ALERT_INTERVAL: ${ALERT_INTERVAL}`);    
    console.log(`lastAlertTime: ${lastAlertTime}`);    
    console.log(`currentTime: ${currentTime}`);    
    console.log(`timeSinceLastAlert: ${timeSinceLastAlert}`);
        
    // 若未超過警告間隔，跳過警告
    if (timeSinceLastAlert < ALERT_INTERVAL) {
        console.log(`距離上次警告時間不足 ${ALERT_INTERVAL} 分鐘，跳過警告。`);
        return null;
    }

    // 若超過警告間隔，檢查 PM10 是否超過閾值
    station184Data.forEach((entry) => {
        if (entry.pm10 && parseInt(entry.pm10) >= PM10_THRESHOLD) {
            exceedMessages.push(`184站點 ${entry.time} PM10 數據: ${entry.pm10} μg/m³，超過閾值`);
        }
    });

    station185Data.forEach((entry) => {
        if (entry.pm10 && parseInt(entry.pm10) >= PM10_THRESHOLD) {
            exceedMessages.push(`185站點 ${entry.time} PM10 數據: ${entry.pm10} μg/m³，超過閾值`);
        }
    });

    // 若有超過閾值的記錄，更新警告時間並發送警告
    if (exceedMessages.length > 0) {
        await updateLastAlertTime(currentTime);
        return exceedMessages.join('\n');
    }

    return null;
}


// 從 Firebase 取得最新的 PM10 資料
async function getLatestPM10Data() {
    const recordsRef = db.ref('pm10_records').orderByChild('timestamp').limitToLast(1);
    const snapshot = await recordsRef.once('value');
    
    let latestData = null;
    snapshot.forEach((childSnapshot) => {
        latestData = childSnapshot.val();
    });

    return latestData;
}

// 抓取指定時間範圍內的數據
async function scrapeStationData(stationId, startDate, endDate) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const url = `https://www.jsene.com/juno/jGrid.aspx?PJ=200209&ST=${stationId}&d1=${encodeURIComponent(startDate)}&d2=${encodeURIComponent(endDate)}&tt=T01&f=0&col=1,2,3,9,10,11`;

    await page.goto(url);

    // 抓取資料
    const pm10Data = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#CP_CPn_JQGrid2 tbody tr'));
        return rows.map(row => {
            const siteTime  = row.querySelector('td[aria-describedby="CP_CPn_JQGrid2_Date_Time"]').textContent.trim();
            const pm10Value = row.querySelector('td[aria-describedby="CP_CPn_JQGrid2_Value3"]').textContent.trim();
            console.log('siteTime: ', siteTime);
            return { siteTime , pm10: pm10Value };
        });
    });

    await browser.close();
    return pm10Data;
}

// 保存新資料到 Firebase
async function savePM10DataToFirebase(station184Data, station185Data) {
    const dataRef = db.ref('pm10_records');
    
    station184Data.forEach((entry, index) => {
        const station185Entry = station185Data[index] || {};
        const entryRef = dataRef.push();
        
        entryRef.set({
            timestamp: moment(entry.time, 'YYYY/MM/DD HH:mm').valueOf(),
            siteTime: entry.siteTime, // 網站登錄的時間
            station_184: entry.pm10,
            station_185: station185Entry.pm10 || null
        });
    });

    console.log('新數據已保存到 Firebase');
}

// 格式化回傳的 PM10 訊息
function formatPM10ReplyMessage(pm10Data) {
    if (!pm10Data) {
        return '目前沒有可用的 PM10 資料。';
    }

    const timestamp = moment(pm10Data.timestamp).format('YYYY年MM月DD日 HH:mm');
    const station184 = pm10Data.station_184 || '無資料';
    const station185 = pm10Data.station_185 || '無資料';

    return `${timestamp}\n` +
           `184測站 PM10：${station184} μg/m³\n` +
           `185測站 PM10：${station185} μg/m³`;
}

// 發送廣播訊息
async function broadcastMessage(message) {
    try {
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val();

        // 查詢當前帳戶剩餘的訊息發送配額
        await getMessageQuota();

        // 查詢當前帳戶已經使用的訊息發送數量，監控發送速率
        await getMessageQuotaConsumption();

        if (!users) {
            console.log('沒有找到任何使用者資料。');
            return;
        }

        const userIds = Object.keys(users);
        console.log(`正在向 ${userIds.length} 位使用者發送訊息`);

        for (const userId of userIds) {
            await client.pushMessage(userId, { type: 'text', text: message });
            console.log(`已發送訊息給使用者: ${userId}`);
        }

        console.log('廣播訊息已成功發送給所有使用者。');
    } catch (error) {
        console.error('發送廣播訊息時發生錯誤:', error);
    }
}

// 查詢當前帳戶剩餘的訊息發送配額
async function getMessageQuota() {
    try {
        const response = await axios.get('https://api.line.me/v2/bot/message/quota', {
            headers: {
                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
            }
        });
        console.log('帳戶剩餘的訊息發送配額:', response.data);
    } catch (error) {
        console.error('查詢訊息配額失敗:', error);
    }
}

// 查詢已使用的訊息發送數量
async function getMessageQuotaConsumption() {
    try {
        const response = await axios.get('https://api.line.me/v2/bot/message/quota/consumption', {
            headers: {
                'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
            }
        });
        console.log('帳戶已經使用的訊息發送數量:', response.data);
    } catch (error) {
        console.error('查詢訊息消耗失敗:', error);
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

// 從 Firebase 取得 24 小時內的記錄
async function get24HourRecords() {
    const currentTime = moment().valueOf(); // 取得當前時間戳
    const twentyFourHoursAgo = currentTime - (24 * 60 * 60 * 1000); // 計算 24 小時前的時間戳

    const recordsRef = db.ref('pm10_records');
    const snapshot = await recordsRef.orderByChild('timestamp').startAt(twentyFourHoursAgo).once('value');

    let records = [];
    snapshot.forEach(childSnapshot => {
        records.push({
            key: childSnapshot.key,
            ...childSnapshot.val()
        });
    });

    return records;
}

// 生成 24hr_record.txt 並返回檔案路徑
async function generateRecordFile(records) {    
    records.sort((a, b) => b.timestamp - a.timestamp);  // 先對記錄按照時間戳從新到舊排序
    let fileContent = ''; // 初始化內容

    records.forEach(record => {
        const timestamp = moment(record.timestamp).format('YYYY/MM/DD HH:mm');
        const station184 = record.station_184 ? `${record.station_184} μg/m³` : '無資料';
        const station185 = record.station_185 ? `${record.station_185} μg/m³` : '無資料';
        
        // 每一行的格式為 "時間 - 理虹(184): station_184數值 / 理虹(185): station_185數值"
        fileContent += `${timestamp} - 184堤外: ${station184} / 185堤上: ${station185}\n`;
    });

    // 檢查 records 目錄是否存在，不存在則創建
    const dir = path.join(__dirname, 'records');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    // 寫入檔案
    const filePath = path.join(dir, '24hr_record.txt');
    fs.writeFileSync(filePath, fileContent, 'utf8');

    return filePath; // 返回檔案路徑
}

// 查詢超過閾值的記錄
function getExceedingRecords(records, PM10_THRESHOLD) {
    let exceedingRecords = [];

    records.forEach(record => {
        const timestamp = moment(record.timestamp).format('MM/DD HH:mm'); // 格式化時間戳
    
        if (record.station_184 && parseInt(record.station_184) > PM10_THRESHOLD) {
            exceedingRecords.push(`${timestamp} - 184堤外: ${record.station_184} μg/m³`);
        }
        if (record.station_185 && parseInt(record.station_185) > PM10_THRESHOLD) {
            exceedingRecords.push(`${timestamp} - 185堤上: ${record.station_185} μg/m³`);
        }
    });

    return exceedingRecords;
}


// 設置提供下載文字檔的路由
app.get('/download/24hr_record.txt', (req, res) => {
    const filePath = path.join(__dirname, 'records', '24hr_record.txt');
    res.download(filePath);
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

// 提供 Mobile 即時查詢的 API
app.get('/api/real-time-query', async (req, res) => {
    try {
        // 使用現有的 getLatestPM10Data 函數
        const recentPM10Data = await getLatestPM10Data();
        
        // 返回獲取的即時數據給前端
        res.json(recentPM10Data);
    } catch (error) {
        console.error('取得即時查詢資料時發生錯誤:', error);
        res.status(500).json({ error: '無法取得即時查詢資料' });
    }
});

// 提供 Mobile 24 小時記錄的 API
app.get('/api/records', async (req, res) => {
    try {
        // 使用現有的 get24HourRecords 函數
        const records = await get24HourRecords();
        
        // 返回獲取的 24 小時數據給前端
        res.json(records);
    } catch (error) {
        console.error('取得 24 小時記錄時發生錯誤:', error);
        res.status(500).json({ error: '無法取得 24 小時記錄' });
    }
});

app.listen(PORT, () => {
    console.log(`Listening on port ${PORT}`);
});
