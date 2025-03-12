const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const admin = require('firebase-admin');

const line = require('@line/bot-sdk');
const express = require('express');
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

    for (const entry of mergedData) {
        if (entry.station_184 && entry.station_184 > pm10Threshold) {
            console.log(
                `🚨 警告！時間: ${entry.time}，測站 184 PM10 值 ${entry.station_184} 超過閾值 ${pm10Threshold}！`
            );
            await updateLastAlertTime(now);
        }
        if (entry.station_185 && entry.station_185 > pm10Threshold) {
            console.log(
                `🚨 警告！時間: ${entry.time}，測站 185 PM10 值 ${entry.station_185} 超過閾值 ${pm10Threshold}！`
            );
            await updateLastAlertTime(now);
        }
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

// 處理收到的 LINE 訊息
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const receivedMessage = event.message.text;
    let replyMessage = '';

    if (receivedMessage === '即時查詢') {
        console.log('執行即時查詢');
        // 從 Firebase 取得最新 PM10 數據
        const snapshot = await db.ref('pm10_records').limitToLast(1).once('value');
        const latestData = snapshot.val();
        if (latestData) {
            const latestTime = Object.keys(latestData)[0];
            const latestPM10 = latestData[latestTime];
            replyMessage = ` 📅 時間: ${latestPM10.time}
🌍 184測站：${latestPM10.station_184 || 'N/A'} µg/m³
🌍 185測站：${latestPM10.station_185 || 'N/A'} µg/m³`;
        } else {
            replyMessage = '⚠️ 目前沒有可用的 PM10 數據。';
        }
    }

    return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
}

// 啟動 Web 服務（Render 需要這個來監聽 HTTP 請求）
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🌐 LINE Bot webhook 監聽中... 端口: ${PORT}`);
});

// **🔹 啟動流程 **
loginAndFetchPM10Data();
monitorScrapeInterval(); // 監聽 SCRAPE_INTERVAL 變化
monitorPM10Threshold(); // 監聽 PM10 閾值變化
monitorAlertInterval(); // 監聽 ALERT_INTERVAL 變化
restartFetchInterval();
