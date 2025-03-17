const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const admin = require('firebase-admin');
const axios = require('axios');
const line = require('@line/bot-sdk');
const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

let scrapeInterval = 10 * 60 * 1000; // 預設為 10 分鐘
let pm10Threshold = 126; // 預設為 126
let fetchInterval = null; // 記錄 setInterval 的 ID
let alertInterval = 60; // 預設為 60 分鐘

// 從環境變量讀取 Firebase Admin SDK配置
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://env-monitor-7167f-default-rtdb.firebaseio.com'
});
const db = admin.database();

// **🔹 取得 Firebase 設定**
async function getFirebaseSettings() {
    const snapshot = await db.ref('settings').once('value');
    return snapshot.val() || {};
}

// **🔹 取得 Firebase 記錄的上次警告時間**
async function getLastAlertTime() {
    const snapshot = await db.ref('settings/last_alert_time').once('value');
    return snapshot.val() || null;
}

// **🔹 更新 Firebase 的上次警告時間**
async function updateLastAlertTime(timestamp) {
    await db.ref('settings/last_alert_time').set(timestamp);
}

// **🔹 取得 Firebase 記錄的上次抓取時間**
async function getLastFetchTime() {
    const snapshot = await db.ref('settings/last_fetch_time').once('value');
    return snapshot.val() || null;
}

// **🔹 更新 Firebase 的上次抓取時間**
async function updateLastFetchTime(timestamp) {
    await db.ref('settings/last_fetch_time').set(timestamp);
}

// **🔹 取得 Firebase 記錄的上次抓取失敗警示時間**
async function getLastFetchAlertTime() {
    const snapshot = await db.ref('settings/last_fetch_alert_time').once('value');
    return snapshot.val() || null;
}

// **🔹 更新 Firebase 的上次抓取失敗警示時間**
async function updateLastFetchAlertTime(timestamp) {
    await db.ref('settings/last_fetch_alert_time').set(timestamp);
}

// **🔹 監聽 SCRAPE_INTERVAL 變更**
function monitorScrapeInterval() {
    db.ref('settings/SCRAPE_INTERVAL').on('value', (snapshot) => {
        const newInterval = snapshot.val() * 60 * 1000;
        if (newInterval !== scrapeInterval) {
            console.log(`🔄 SCRAPE_INTERVAL 變更: ${newInterval / 60000} 分鐘`);
            scrapeInterval = newInterval;
            restartFetchInterval();
        }
    });
}

// 監聽 PM10_THRESHOLD 變更
function monitorPM10Threshold() {
    db.ref('settings/PM10_THRESHOLD').on('value', (snapshot) => {
        const newThreshold = snapshot.val();
        if (newThreshold !== pm10Threshold) {
            console.log(`🔄 PM10_THRESHOLD 變更: ${newThreshold}`);
            pm10Threshold = newThreshold;
        }
    });
}

// 監聽 ALERT_INTERVAL 變更
function monitorAlertInterval() {
    db.ref('settings/ALERT_INTERVAL').on('value', (snapshot) => {
        const newInterval = snapshot.val();
        if (newInterval !== alertInterval) {
            console.log(`🔄 ALERT_INTERVAL 變更: ${newInterval} 分鐘`);
            alertInterval = newInterval;
        }
    });
}

// **🔹 重新啟動 setInterval**
function restartFetchInterval() {
    if (fetchInterval) {
        clearInterval(fetchInterval);
        console.log('🛑 重新啟動數據抓取定時器...');
    }
    fetchInterval = setInterval(loginAndFetchPM10Data, scrapeInterval);
    console.log(`✅ 設定新抓取間隔: 每 ${scrapeInterval / 60000} 分鐘執行一次`);
}

// **🔹 取得動態時間範圍**
async function getDynamicDataURL(stationId) {
    const now = moment().tz('Asia/Taipei');
    const endTime = now.format('YYYY/MM/DD HH:mm');

    let lastFetchTime = await getLastFetchTime();
    if (!lastFetchTime) {
        lastFetchTime = now
            .clone()
            .subtract(scrapeInterval / 60000, 'minutes')
            .format('YYYY/MM/DD HH:mm');
    } else {
        lastFetchTime = moment(lastFetchTime)
            .tz('Asia/Taipei')
            .format('YYYY/MM/DD HH:mm');
    }

    console.log(`🕒 測站 ${stationId} 目標時間範圍 (UTC+8): ${lastFetchTime} ~ ${endTime}`);

    return {
        url: `https://www.jsene.com/juno/jGrid.aspx?PJ=200209&ST=${stationId}&d1=${encodeURIComponent(
            lastFetchTime
        )}&d2=${encodeURIComponent(endTime)}&tt=T01&f=0&col=1,2,3,9,10,11`,
        endTimeTimestamp: now.valueOf()
    };
}

// **🔹 抓取特定測站的數據**
async function fetchStationData(page, stationId) {
    console.log(`📊 嘗試抓取測站 ${stationId} 的數據...`);

    const { url, endTimeTimestamp } = await getDynamicDataURL(stationId);
    await page.goto(url, { waitUntil: 'networkidle2' });

    await page.waitForSelector('#CP_CPn_JQGrid2 tbody tr', { timeout: 15000 });

    console.log(`✅ 測站 ${stationId} 的資料表已加載，開始抓取數據...`);

    const html = await page.content();
    const $ = cheerio.load(html);

    let pm10Data = {};

    $('#CP_CPn_JQGrid2 tbody tr').each((_, row) => {
        const time = $(row).find('td[aria-describedby="CP_CPn_JQGrid2_Date_Time"]').text().trim();
        const pm10 = $(row).find('td[aria-describedby="CP_CPn_JQGrid2_Value3"]').text().trim();

        if (time && pm10) {
            pm10Data[time] = parseFloat(pm10);
        }
    });

    return { data: pm10Data, endTimeTimestamp };
}

// **🔹 檢查並刪除超過 24 小時的舊資料**
async function pruneOldData() {
    const cutoff = moment().subtract(24, 'hours').valueOf();
    const dataRef = db.ref('pm10_records');

    // 因為您把 timestamp 當作 key（字串形式），可用 orderByKey 搭配 endAt
    // 若確認資料庫中有額外欄位可排序，也可考慮改用 orderByChild('timestamp')
    const snapshot = await dataRef.orderByKey().endAt(cutoff.toString()).once('value');
    snapshot.forEach((childSnapshot) => {
        childSnapshot.ref.remove();
    });

    console.log(`✅ 已刪除超過 24 小時前的舊資料（截止時間戳：${cutoff}）。`);
}

// **🔹 存入 Firebase**
async function saveToFirebase(mergedData, lastTimestamp) {
    const dataRef = db.ref('pm10_records');

    for (const entry of mergedData) {
        const timestampKey = entry.timestamp.toString();
        await dataRef.child(timestampKey).set({
            time: entry.time,
            station_184: entry.station_184 || null,
            station_185: entry.station_185 || null
        });
        console.log(`✅ 已存入 Firebase: ${entry.time} (timestamp: ${entry.timestamp})`);
    }

    await updateLastFetchTime(lastTimestamp);

    // 存完資料後，刪除舊資料
    await pruneOldData();
}

// **🔹 檢查 PM10 是否超過閾值**
async function checkPM10Threshold(mergedData, pm10Threshold, alertInterval) {
    const now = moment().tz('Asia/Taipei').valueOf();
    const lastAlertTime = await getLastAlertTime();

    if (lastAlertTime && now - lastAlertTime < alertInterval * 60 * 1000) {
        console.log('⚠️ 警告間隔內，不發送新的警告。');
        return;
    }

    let alertMessages = [];
    let alertHeader = "🚨 PM10 超標警報！\n\n";

    for (const entry of mergedData) {
        let stationAlerts = [];

        if (entry.station_184 && entry.station_184 > pm10Threshold) {
            stationAlerts.push(`🌍 測站184堤外PM10值：${entry.station_184} µg/m³`);
        }
        if (entry.station_185 && entry.station_185 > pm10Threshold) {
            stationAlerts.push(`🌍 測站185堤上PM10值：${entry.station_185} µg/m³`);
        }

        if (stationAlerts.length > 0) {
            alertMessages.push(`📅 時間: ${entry.time}\n${stationAlerts.join("\n")}`);
        }
    }

    if (alertMessages.length > 0) {
        const finalAlertMessage = `${alertHeader}${alertMessages.join("\n\n")}\n\n⚠️ **PM10濃度≧${pm10Threshold} µg/m³，請啟動水線抑制揚塵**`;
        console.log(finalAlertMessage);

        await updateLastAlertTime(now); // 更新警告時間

        // 發送合併後的警報訊息到 LINE
        await client.broadcast({ type: 'text', text: finalAlertMessage });
    }
}

// **🔹 登入並抓取數據**
async function loginAndFetchPM10Data() {
    console.log('🔑 啟動瀏覽器並登入...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const settings = await getFirebaseSettings();
    const username = settings.ACCOUNT_NAME || 'ExcelTek';
    const password = settings.ACCOUNT_PASSWORD || 'ExcelTek';

    console.log(
        `🔹 設定 - 抓取間隔: ${scrapeInterval / 60000} 分鐘, 警告間隔: ${alertInterval} 分鐘, PM10 閾值: ${pm10Threshold}`
    );

    await page.goto('https://www.jsene.com/juno/Login.aspx', { waitUntil: 'networkidle2' });

    await page.type('#T_Account', username);
    await page.type('#T_Password', password);

    await Promise.all([
        page.click('#Btn_Login'),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
    ]);

    console.log('✅ 成功登入，開始抓取數據...');

    const { data: station184Data, endTimeTimestamp } = await fetchStationData(page, '3100184');
    const { data: station185Data } = await fetchStationData(page, '3100185');

    await browser.close();

    const mergedData = Object.keys(station184Data).map((time) => ({
        time,
        timestamp: moment.tz(time, 'YYYY/MM/DD HH:mm', 'Asia/Taipei').valueOf(),
        station_184: station184Data[time] || null,
        station_185: station185Data[time] || null
    }));

    await checkPM10Threshold(mergedData, pm10Threshold, alertInterval);
    await saveToFirebase(mergedData, endTimeTimestamp);
}

// **🔹 檢查抓取狀態，若失敗超過12小時則發出警示**
async function checkFetchStatus() {
    const now = moment().tz('Asia/Taipei').valueOf();
    const lastFetchTime = await getLastFetchTime();

    // 若上次抓取時間不存在或超過12小時未更新
    if (!lastFetchTime || now - lastFetchTime > 12 * 60 * 60 * 1000) {
        const lastFetchAlertTime = await getLastFetchAlertTime();
        // 檢查是否在12小時內已發送過抓取失敗的警示
        if (!lastFetchAlertTime || now - lastFetchAlertTime > 12 * 60 * 60 * 1000) {
            const alertMessage = "⚠️ 警告：數據抓取失敗已超過12小時，請檢查系統狀態！";
            console.log(alertMessage);
            await client.broadcast({ type: 'text', text: alertMessage });
            await updateLastFetchAlertTime(now);
        } else {
            console.log("在最近12小時內已發送過抓取失敗警示。");
        }
    } else {
        console.log("數據抓取狀態正常。");
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
        return response.data;
    } catch (error) {
        console.error('❌ 查詢訊息配額失敗:', error.response ? error.response.data : error.message);
        return null;
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
        return response.data;
    } catch (error) {
        console.error('❌ 查詢訊息消耗失敗:', error.response ? error.response.data : error.message);
        return null;
    }
}

// 設置LINE Messaging API客戶端的配置
const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

// 設定 Webhook 路由
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => console.error(err));
});

// 確保 `records` 資料夾存在
const recordsDir = path.join(__dirname, 'records');
if (!fs.existsSync(recordsDir)) {
    fs.mkdirSync(recordsDir);
}

// 設置提供下載文字檔的路由
app.get('/download/24hr_record.txt', (req, res) => {
    const filePath = path.join(__dirname, 'records', '24hr_record.txt');
    res.download(filePath);
});

// 處理收到的 LINE 訊息
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const receivedMessage = event.message.text;
    let replyMessage = '';

    if (receivedMessage === '即時查詢') {
        console.log('執行即時查詢');
        
        // 取得 Firebase 最新 PM10 數據
        const snapshot = await db.ref('pm10_records').limitToLast(1).once('value');
        const latestData = snapshot.val();
    
        // 取得 Firebase 內的當前 PM10 閾值
        const thresholdSnapshot = await db.ref('settings/PM10_THRESHOLD').once('value');
        const pm10Threshold = thresholdSnapshot.val() || 126; // 預設為 126
    
        const nowTime = moment().tz('Asia/Taipei'); // 取得現在時間
        
        if (latestData) {
            const latestPM10 = Object.values(latestData)[0]; // 取得最新一筆數據
            const latestTime = moment.tz(latestPM10.time, "YYYY/MM/DD HH:mm", "Asia/Taipei"); // 確保格式正確
    
            const timeDiff = Math.abs(nowTime.diff(latestTime, 'minutes')); // 計算時間差
            console.log(`🔍 Firebase 最新數據時間: ${latestPM10.time}, 與現在時間相差: ${timeDiff} 分鐘`);
    
            // 如果最新資料的時間與現在時間相符（允許 ±1 分鐘）
            if (timeDiff <= 1) {
                replyMessage = `📡 PM10即時查詢結果
    📅 時間: ${latestPM10.time}
    🌍 測站184堤外: ${latestPM10.station_184 || 'N/A'} µg/m³
    🌍 測站185堤上: ${latestPM10.station_185 || 'N/A'} µg/m³
    ⚠️ PM10 閾值: ${pm10Threshold} µg/m³`;
    
                return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
            }
        }
    
        // 若 Firebase 資料不是最新，則執行網頁爬取
        console.log('⚠️ Firebase 資料已過時，重新爬取 PM10 數據...');
        
        // 取得上次抓取的時間
        let lastFetchTime = await getLastFetchTime();
        if (!lastFetchTime) {
            lastFetchTime = moment().tz('Asia/Taipei').subtract(scrapeInterval / 60000, 'minutes').format('YYYY/MM/DD HH:mm');
        } else {
            lastFetchTime = moment(lastFetchTime).tz('Asia/Taipei').format('YYYY/MM/DD HH:mm');
        }
    
        console.log(`🕒 重新抓取時間範圍: ${lastFetchTime} ~ ${nowTime.format('YYYY/MM/DD HH:mm')}`);
    
        // 執行爬取
        await loginAndFetchPM10Data();
    
        // 再次從 Firebase 取得最新一筆數據
        const newSnapshot = await db.ref('pm10_records').limitToLast(1).once('value');
        const newLatestData = newSnapshot.val();
    
        if (newLatestData) {
            const latestPM10 = Object.values(newLatestData)[0];
    
            replyMessage = `📡 PM10即時查詢結果
    📅 時間: ${latestPM10.time}
    🌍 測站184堤外: ${latestPM10.station_184 || 'N/A'} µg/m³
    🌍 測站185堤上: ${latestPM10.station_185 || 'N/A'} µg/m³
    ⚠️ PM10 閾值: ${pm10Threshold} µg/m³`;
        } else {
            replyMessage = '⚠️ 目前無法獲取最新的 PM10 數據，請稍後再試。';
        }
    
        return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
    }      

    if (receivedMessage === '24小時記錄') {
        console.log('📥 取得 24 小時記錄');

        // 取得 24 小時內的資料
        const cutoff = moment().subtract(24, 'hours').valueOf();
        const snapshot = await db.ref('pm10_records').orderByKey().startAt(cutoff.toString()).once('value');
        const records = snapshot.val();

        if (!records) {
            replyMessage = '⚠️ 目前沒有可用的 24 小時記錄。';
            return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
        }

        let recordText = '📡 PM10 24 小時記錄\n\n';
        let alertRecords = [];

        // 生成 24hr_record.txt 檔案內容
        let fileContent = '時間, 測站184(PM10), 測站185(PM10)\n';
        for (const [timestamp, data] of Object.entries(records)) {
            const time = data.time;
            const station184 = data.station_184 || 'N/A';
            const station185 = data.station_185 || 'N/A';

            fileContent += `${time}, ${station184}, ${station185}\n`;

            let alertText = `📅 時間: ${time}`;
            let hasAlert = false;

            if (station184 !== 'N/A' && station184 > pm10Threshold) {
                alertText += `\n🌍 測站184: ${station184} µg/m³`;
                hasAlert = true;
            }
            if (station185 !== 'N/A' && station185 > pm10Threshold) {
                alertText += `\n🌍 測站185: ${station185} µg/m³`;
                hasAlert = true;
            }

            // 只有當至少一個測站超標時，才加入記錄
            if (hasAlert) {
                alertRecords.push(alertText);
            }
        }

        // 存檔至 /records/24hr_record.txt
        const filePath = path.join(__dirname, 'records', '24hr_record.txt');
        fs.writeFileSync(filePath, fileContent, 'utf8');

        // 構建訊息
        if (alertRecords.length > 0) {
            recordText += '⚠️ 以下為超過 PM10 閾值的部分:\n\n' + alertRecords.join('\n\n') + '\n\n';
        } else {
            recordText += '✅ 過去 24 小時內無數據超過 PM10 閾值。\n\n';
        }
        recordText += `📥 下載完整 24 小時記錄: \n👉 [點擊下載](https://mobile-env-monitor.onrender.com/download/24hr_record.txt)`;

        return client.replyMessage(event.replyToken, { type: 'text', text: recordText });
    }

    if (receivedMessage === '訊息配額') {
        console.log('📡 查詢 LINE 訊息發送配額...');
        
        const quota = await getMessageQuota();
        const consumption = await getMessageQuotaConsumption();

        if (!quota || !consumption) {
            replyMessage = '⚠️ 無法查詢 LINE 訊息配額，請稍後再試。';
        } else {
            replyMessage = `📊 **LINE 訊息發送狀態**\n\n` +
                           `📩 剩餘訊息數量: **${quota.value === -1 ? '無限' : quota.value}**\n` +
                           `📤 已使用訊息數量: **${consumption.totalUsage}**`;
        }

        return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
    }

    return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
}

// 啟動 Web 服務（Render 需要這個來監聽 HTTP 請求）
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🌐 LINE Bot webhook 監聽中... 端口: ${PORT}`);
});

// 設置 ping 路由接收 pinger-app 的請求
app.post('/ping', (req, res) => {
    console.log('來自 pinger-app 的訊息:', req.body);
    res.json({ message: 'pong' });
});

// 每10分鐘發送一次請求給 pinger-app
function sendPing() {
    axios.post('https://pinger-app-m1tm.onrender.com/ping', { message: 'ping' })
        .then(response => {
            if (response.data && response.data.message) {
                console.log('✅ 來自 pinger-app 的回應:', response.data.message);
            } else {
                console.log('⚠️ 來自 pinger-app 的回應沒有包含 message 欄位:', response.data);
            }
        })
        .catch(error => {
            console.error('❌ 無法 ping pinger-app:', error.message);
        });
}
setInterval(sendPing, 10 * 60 * 1000);

// 設置抓取狀態檢查，每60分鐘執行一次
setInterval(checkFetchStatus, 60 * 60 * 1000);

// **🔹 啟動流程 **
loginAndFetchPM10Data();
monitorScrapeInterval(); // 監聽 SCRAPE_INTERVAL 變化
monitorPM10Threshold(); // 監聽 PM10 閾值變化
monitorAlertInterval(); // 監聽 ALERT_INTERVAL 變化
restartFetchInterval();
