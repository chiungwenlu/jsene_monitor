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

// --- 設定變數 ---
let scrapeInterval = 10 * 60 * 1000; // 預設 10 分鐘
let pm10Threshold = 126; // 預設 126
let fetchInterval = null; 
let alertInterval = 60; // 預設 60 分鐘

// 新增：時段與間隔常數
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

// 從環境變量讀取 Firebase Admin SDK 配置
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://env-monitor-7167f-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ----------------------- Firebase 設定與狀態存取 -----------------------

async function getFirebaseSettings() {
    const snapshot = await db.ref('settings').once('value');
    return snapshot.val() || {};
}

// 通用的取得最後警報時間
async function getLastAlertTimeForStation(stationId) {
    // 統一處理 key 名稱，global 用於 PM10 超標警報
    let key = (stationId === 'global') ? 'last_alert_time_global' : `last_alert_time_${stationId}`;
    const snapshot = await db.ref('settings/' + key).once('value');
    return snapshot.val() || null;
}

async function updateLastAlertTimeForStation(stationId, timestamp) {
    let key = (stationId === 'global') ? 'last_alert_time_global' : `last_alert_time_${stationId}`;
    await db.ref('settings/' + key).set(timestamp);
}

// [修改] 將最後成功抓取時間存入 Firebase，避免 Render 重啟後遺失
async function getLastSuccessTime(stationId) {
    const snapshot = await db.ref(`status/last_success_${stationId}`).once('value');
    return snapshot.val() || null;
}

async function updateLastSuccessTime(stationId, timestamp) {
    await db.ref(`status/last_success_${stationId}`).set(timestamp);
}

async function getLastFetchTime() {
    const snapshot = await db.ref('settings/last_fetch_time').once('value');
    return snapshot.val() || null;
}

async function updateLastFetchTime(timestamp) {
    await db.ref('settings/last_fetch_time').set(timestamp);
}

// ----------------------- 設定監聽與排程 -----------------------

function monitorScrapeInterval() {
    db.ref('settings/SCRAPE_INTERVAL').on('value', (snapshot) => {
        const val = snapshot.val();
        if (val) {
            const newInterval = Number(val) * 60 * 1000;
            if (newInterval !== scrapeInterval) {
                console.log(`🔄 SCRAPE_INTERVAL 變更: ${newInterval / 60000} 分鐘`);
                scrapeInterval = newInterval;
                restartFetchInterval();
            }
        }
    });
}

function monitorPM10Threshold() {
    db.ref('settings/PM10_THRESHOLD').on('value', (snapshot) => {
        const val = snapshot.val();
        if (val) {
            const newThreshold = Number(val);
            if (newThreshold !== pm10Threshold) {
                console.log(`🔄 PM10_THRESHOLD 變更: ${newThreshold}`);
                pm10Threshold = newThreshold;
            }
        }
    });
}

function monitorAlertInterval() {
    db.ref('settings/ALERT_INTERVAL').on('value', (snapshot) => {
        const val = snapshot.val();
        if (val) {
            const newInterval = Number(val); // 強制轉為數字
            if (newInterval !== alertInterval) {
                console.log(`🔄 ALERT_INTERVAL 變更: ${newInterval} 分鐘`);
                alertInterval = newInterval;
            }
        }
    });
}

function restartFetchInterval() {
    if (fetchInterval) {
        clearInterval(fetchInterval);
    }
    fetchInterval = setInterval(loginAndFetchPM10Data, scrapeInterval);
    console.log(`✅ 設定新抓取間隔: 每 ${scrapeInterval / 60000} 分鐘執行一次`);
}

function scheduleDailyNightCheck() {
    const now = moment().tz('Asia/Taipei');
    let next8AM = now.clone().hour(8).minute(0).second(0);
    if (now.isAfter(next8AM)) {
        next8AM.add(1, 'day');
    }
    const delay = next8AM.diff(now);
    console.log(`⏰ 夜間檢查排程將在 ${moment.duration(delay).humanize()} 後啟動`);

    setTimeout(() => {
        checkNightTimeThresholds();
        setInterval(checkNightTimeThresholds, 24 * 60 * 60 * 1000);
    }, delay);
}

async function triggerRenderRestart() {
    try {
        const renderHookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
        if (renderHookUrl) {
            const res = await axios.post(renderHookUrl);
            console.log('✅ 已觸發 Render 重啟：', res.status);
        }
    } catch (err) {
        console.error('❌ 無法觸發 Render 重啟：', err.message);
    }
}

// ----------------------- 數據抓取邏輯 -----------------------

async function getDynamicDataURL(stationId) {
    const now = moment().tz('Asia/Taipei');
    const endTime = now.format('YYYY/MM/DD HH:mm');

    let lastFetch = await getLastFetchTime();
    let d1Moment;

    if (lastFetch) {
        d1Moment = moment(lastFetch).tz('Asia/Taipei');
        // [優化] 防止若 lastFetch 太久以前 (例如停機一天)，一次抓太多資料導致超時
        // 設定最大回溯時間為 3 小時
        const threeHoursAgo = now.clone().subtract(3, 'hours');
        if (d1Moment.isBefore(threeHoursAgo)) {
            console.log('⚠️ 上次抓取時間過久，重置為 3 小時前開始抓取');
            d1Moment = threeHoursAgo;
        }
    } else {
        d1Moment = now.clone().subtract(scrapeInterval / 60000, 'minutes');
    }

    d1Moment = d1Moment.subtract(1, 'minute');
    const startTime = d1Moment.format('YYYY/MM/DD HH:mm');

    console.log(`🕒 測站 ${stationId} 目標時間範圍: ${startTime} ~ ${endTime}`);

    return {
        url: `https://www.jsene.com/juno/jGrid.aspx?PJ=200209&ST=${stationId}` +
             `&d1=${encodeURIComponent(startTime)}` +
             `&d2=${encodeURIComponent(endTime)}` +
             `&tt=T01&f=0&col=1,2,3,9,10,11`,
        endTimeTimestamp: now.valueOf()
    };
}

async function fetchStationData(page, stationId) {
    console.log(`📊 嘗試抓取測站 ${stationId} 的數據...`);
    const { url, endTimeTimestamp } = await getDynamicDataURL(stationId);
    
    await page.goto(url, { waitUntil: 'networkidle2' });
    try {
        await page.waitForSelector('#CP_CPn_JQGrid2 tbody tr', { timeout: 15000 });
    } catch (e) {
        throw new Error(`測站 ${stationId} 載入超時或無資料表`);
    }

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

    if (Object.keys(pm10Data).length === 0) {
        throw new Error(`測站 ${stationId} 抓取成功但 0 筆資料`);
    }

    // 更新該測站最後成功時間到 Firebase
    await updateLastSuccessTime(stationId, Date.now());

    return { data: pm10Data, endTimeTimestamp };
}

// 抓取大城站
async function fetchPM10FromDacheng() {
    console.log('📊 嘗試抓取大城測站的數據...');
    // [優化] Render 環境建議加上 --no-sandbox 參數
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);

    try {
        await page.goto('https://airtw.moenv.gov.tw/', { waitUntil: 'domcontentloaded' });
        await page.select('#ddl_county', 'Changhua');
        
        await page.waitForFunction(() => {
            const ddl = document.querySelector('#ddl_site');
            return ddl && Array.from(ddl.options).some(o => o.value === '136');
        }, { timeout: 15000 });

        await page.select('#ddl_site', '136');
        await page.waitForSelector('#PM10', { timeout: 15000 });

        const txt = await page.$eval('#PM10', el => el.textContent.trim());
        const value = parseInt(txt, 10);
        if (isNaN(value)) throw new Error(`解析 PM10 失敗: "${txt}"`);

        const dateTime = await page.$eval('.date', el => el.childNodes[0].textContent.trim());
        const timestamp = moment.tz(dateTime, 'YYYY/MM/DD HH:mm', 'Asia/Taipei').valueOf();

        // 更新大城成功時間
        await updateLastSuccessTime('dacheng', Date.now());

        console.log(`✅ 大城測站時間：${dateTime}，PM10：${value}`);
        return { time: dateTime, timestamp, value };
    } catch (err) {
        throw err;
    } finally {
        await browser.close();
    }
}

async function pruneOldData() {
    const cutoff = moment().subtract(24, 'hours').valueOf();
    const dataRef = db.ref('pm10_records');
    const snapshot = await dataRef.orderByKey().endAt(cutoff.toString()).once('value');
    if (snapshot.exists()) {
        const updates = {};
        snapshot.forEach((child) => { updates[child.key] = null; });
        await dataRef.update(updates);
        console.log(`✅ 已刪除過期資料，共 ${Object.keys(updates).length} 筆`);
    }
}

async function saveToFirebase(mergedData, lastTimestamp) {
    const dataRef = db.ref('pm10_records');
    // 為了效能，可以考慮使用 update 一次寫入多筆，這裡維持原本邏輯但加強 Log
    for (const entry of mergedData) {
        const tsKey = entry.timestamp.toString();
        const recordRef = dataRef.child(tsKey);
        const snap = await recordRef.once('value');
        
        if (snap.exists()) {
            await recordRef.update({ station_dacheng: entry.station_dacheng || null });
        } else {
            await recordRef.set({
                time: entry.time,
                station_184: entry.station_184 || null,
                station_185: entry.station_185 || null,
                station_dacheng: entry.station_dacheng || null
            });
        }
    }
    await updateLastFetchTime(lastTimestamp);
    await pruneOldData();
}

async function checkNightTimeThresholds() {
    const now = moment().tz('Asia/Taipei');
    const start = now.clone().subtract(1, 'day').hour(17).minute(0).second(0); // 昨天17:00
    const end = now.clone().hour(8).minute(0).second(0); // 今天08:00

    // 若現在時間剛好是早上8點多，檢查範圍就是 昨天17:00 ~ 今天08:00
    // 此邏輯假設此函式每天早上執行一次

    const snapshot = await db.ref('pm10_records')
        .orderByKey()
        .startAt(start.valueOf().toString())
        .endAt(end.valueOf().toString())
        .once('value');

    const records = snapshot.val();
    if (!records) return;

    let alertMessages = [];
    for (const [timestamp, data] of Object.entries(records)) {
        let alerts = [];
        if (data.station_184 && data.station_184 > pm10Threshold) alerts.push(`🌍 測站184: ${data.station_184}`);
        if (data.station_185 && data.station_185 > pm10Threshold) alerts.push(`🌍 測站185: ${data.station_185}`);
        if (data.station_dacheng && data.station_dacheng > pm10Threshold) alerts.push(`🌍 測站大城: ${data.station_dacheng}`);
        
        if (alerts.length > 0) {
            alertMessages.push(`📅 ${data.time} - ${alerts.join(', ')}`);
        }
    }

    if (alertMessages.length > 0) {
        let msg = `🌙 夜間 PM10 超標記錄彙整\n(昨晚17:00～今日08:00)\n\n${alertMessages.join('\n')}`;
        msg = await appendQuotaInfo(msg);
        await client.broadcast({ type: 'text', text: msg });
    }
}

// ----------------------- 核心：閾值檢查與警報 -----------------------

async function checkPM10Threshold(mergedData, pm10Threshold, alertInterval) {
    const nowMoment = moment().tz('Asia/Taipei');
    const currentHour = nowMoment.hour();
    const nowTs = nowMoment.valueOf();

    // 1. 時間檢查 (08:00 ~ 17:00)
    if (currentHour < 8 || currentHour >= 17) {
        console.log('🕗 非警示時間段，略過即時警示。');
        return;
    }

    // 2. 警報間隔檢查
    // 必須確保 alertInterval 是數字
    const safeIntervalMs = (Number(alertInterval) || 60) * 60 * 1000;
    const lastAlertTime = await getLastAlertTimeForStation('global');
    
    if (lastAlertTime) {
        const diff = nowTs - lastAlertTime;
        const diffMinutes = Math.floor(diff / 60000);
        if (diff < safeIntervalMs) {
            console.log(`⚠️ 警告間隔內 (已過 ${diffMinutes} 分鐘 / 設定 ${alertInterval} 分鐘)，不發送新警告。`);
            return;
        }
    }

    let alertMessages = [];
    let alertHeader = "🚨 PM10 超標警報！\n\n";

    // 為了避免重複對同一筆舊資料報警，這裡可以考慮只檢查「最新」的一筆，
    // 或者我們假設 mergedData 都是最近一次抓取的區間。
    // 這裡維持檢查 mergedData 全部，但通常 mergedData 只有最近 10~20 分鐘的資料。

    for (const entry of mergedData) {
        let stationAlerts = [];
        // [修正] 確保數值是數字再比較
        if (entry.station_184 !== null && Number(entry.station_184) > pm10Threshold) {
            stationAlerts.push(`🌍 測站184堤外: ${entry.station_184} µg/m³`);
        }
        if (entry.station_185 !== null && Number(entry.station_185) > pm10Threshold) {
            stationAlerts.push(`🌍 測站185堤上: ${entry.station_185} µg/m³`);
        }
        if (entry.station_dacheng !== null && Number(entry.station_dacheng) > pm10Threshold) {
            stationAlerts.push(`🌍 測站大城: ${entry.station_dacheng} µg/m³`);
        }

        if (stationAlerts.length > 0) {
            alertMessages.push(`📅 時間: ${entry.time}\n${stationAlerts.join("\n")}`);
        }
    }

    if (alertMessages.length > 0) {
        let finalAlertMessage = `${alertHeader}${alertMessages.join("\n\n")}\n\n⚠️ **PM10濃度≧${pm10Threshold} µg/m³，請啟動水線抑制揚塵**`;
        finalAlertMessage = await appendQuotaInfo(finalAlertMessage);
        
        console.log("🚀 準備發送 LINE 警報...");
        try {
            await client.broadcast({ type: 'text', text: finalAlertMessage });
            
            // [關鍵修正] 只有在發送成功後才更新時間，並且加上 try-catch 確保執行
            await updateLastAlertTimeForStation('global', nowTs);
            console.log(`✅ 警報已發送，更新最後警報時間為: ${moment(nowTs).format('HH:mm:ss')}`);
            
        } catch (error) {
            console.error('❌ LINE 警報發送失敗:', error.message);
            // 發送失敗時不更新時間，這樣下次抓取時會再次嘗試
        }
    }
}

// ----------------------- 主流程：登入並抓取 -----------------------

async function loginAndFetchPM10Data() {
    console.log('🔑 啟動 Juno 爬蟲...');
    // [優化] Render 環境參數
    const browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    const settings = await getFirebaseSettings();
    const username = settings.ACCOUNT_NAME || 'ExcelTek';
    const password = settings.ACCOUNT_PASSWORD || 'ExcelTek';

    console.log(`🔹 參數檢查 - 間隔: ${scrapeInterval/60000}m, 警報間隔: ${alertInterval}m, 閾值: ${pm10Threshold}`);

    try {
        await page.goto('https://www.jsene.com/juno/Login.aspx', { waitUntil: 'networkidle2', timeout: 60000 });
        await page.type('#T_Account', username);
        await page.type('#T_Password', password);
        await Promise.all([
            page.click('#Btn_Login'),
            page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);
        console.log('✅ Juno 登入成功');

        let station184Data = {}, station185Data = {};
        let endTimeTimestamp = null;
        const now = Date.now();

        // 184
        try {
            const res184 = await fetchStationData(page, '3100184');
            station184Data = res184.data;
            endTimeTimestamp = res184.endTimeTimestamp;
            console.log(`✅ 184 取得 ${Object.keys(station184Data).length} 筆`);
        } catch (err) {
            console.error('❌ 184 抓取失敗:', err.message);
            await broadcastNoDataWarning('184');
        }

        // 185
        try {
            const res185 = await fetchStationData(page, '3100185');
            station185Data = res185.data;
            if (!endTimeTimestamp) endTimeTimestamp = res185.endTimeTimestamp;
            console.log(`✅ 185 取得 ${Object.keys(station185Data).length} 筆`);
        } catch (err) {
            console.error('❌ 185 抓取失敗:', err.message);
            await broadcastNoDataWarning('185');
        }

        // 大城
        let stationDachengData = {};
        try {
            const resultD = await fetchPM10FromDacheng();
            stationDachengData[resultD.time] = resultD.value;
            if (!endTimeTimestamp || resultD.timestamp > endTimeTimestamp) {
                endTimeTimestamp = resultD.timestamp;
            }
            console.log(`✅ 大城取得資料: ${resultD.value}`);
        } catch (err) {
            console.error('❌ 大城抓取失敗:', err.message);
            await broadcastNoDataWarning('dacheng');
        }

        // 合併資料
        const allTimeKeys = new Set([
            ...Object.keys(station184Data),
            ...Object.keys(station185Data),
            ...Object.keys(stationDachengData)
        ]);

        const mergedData = Array.from(allTimeKeys).map(time => ({
            time,
            timestamp: moment.tz(time, 'YYYY/MM/DD HH:mm', 'Asia/Taipei').valueOf(),
            station_184: station184Data[time] || null,
            station_185: station185Data[time] || null,
            station_dacheng: stationDachengData[time] || null
        }));

        // 排序
        mergedData.sort((a, b) => a.timestamp - b.timestamp);

        // 填補大城空值 (若需要)
        let lastDacheng = null;
        for (const entry of mergedData) {
            if (entry.station_dacheng !== null) lastDacheng = entry.station_dacheng;
            else entry.station_dacheng = lastDacheng;
        }

        if (mergedData.length > 0) {
            // [修正] 傳遞變數時確保是數字
            await checkPM10Threshold(mergedData, Number(pm10Threshold), Number(alertInterval));
            await saveToFirebase(mergedData, endTimeTimestamp);
        } else {
            console.warn('⚠️ 本次無有效資料可儲存');
        }

        // 檢查 12 小時無資料 (使用 Firebase 儲存的時間)
        await checkMissingDataAlert('184', '184');
        await checkMissingDataAlert('185', '185');
        await checkMissingDataAlert('dacheng', '大城');

    } catch (err) {
        console.error('❌ 總流程錯誤:', err.message);
        
        // Render Reset 邏輯
        const lastSuccess184 = await getLastSuccessTime('3100184'); // 取 DB
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;
        
        if (lastSuccess184 && (now - lastSuccess184 > ONE_HOUR)) {
            const snapshot = await db.ref('settings/last_reset_time').once('value');
            const lastReset = snapshot.val() || 0;
            if (now - lastReset > ONE_HOUR) {
                console.warn('⚠️ 184 超過 1 小時無數據，觸發重啟');
                await db.ref('settings/last_reset_time').set(now);
                await triggerRenderRestart();
            }
        }
    } finally {
        await browser.close();
    }
}

// 通用的無資料檢查 (12小時)
async function checkMissingDataAlert(stationKey, stationName) {
    // 這裡 stationKey 對應到 updateLastSuccessTime 使用的 ID (例如 '3100184' 或 'dacheng')
    // 但在呼叫端我用了 '184'，這裡做個對應修正
    let dbKey = stationKey;
    if (stationKey === '184') dbKey = '3100184';
    if (stationKey === '185') dbKey = '3100185';

    const lastSuccess = await getLastSuccessTime(dbKey);
    if (!lastSuccess) return; // 從來沒成功過，先不報警

    const now = Date.now();
    const lastAlert = await getLastAlertTimeForStation(stationKey); // 這裡用簡短代碼做 key

    if ((now - lastSuccess > TWELVE_HOURS) && (!lastAlert || now - lastAlert > TWELVE_HOURS)) {
        let msg = `⚠️ 警告：測站 ${stationName} 已失去數據超過 12 小時，請檢查系統狀態！`;
        msg = await appendQuotaInfo(msg);
        console.log(msg);
        try {
            await client.broadcast({ type: 'text', text: msg });
            await updateLastAlertTimeForStation(stationKey, now);
        } catch (e) {
            console.error('無資料警報發送失敗', e);
        }
    }
}

// 這是原本邏輯中的 "抓取失敗當下檢查"
// 修正：現在主要依賴 checkMissingDataAlert 來做 12hr 檢查，這裡僅作 log 或短時效處理
async function broadcastNoDataWarning(stationId) {
    // 可以在這裡加一些 log，實際 12 小時警報交給 checkMissingDataAlert 統一處理
    console.log(`⚠️ 測站 ${stationId} 本次抓取失敗`);
}

// ----------------------- LINE 配額與使用者相關 -----------------------

async function getMessageQuota() {
    try {
        const response = await axios.get('https://api.line.me/v2/bot/message/quota', {
            headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        return response.data;
    } catch (error) {
        return null;
    }
}

async function getMessageQuotaConsumption() {
    try {
        const response = await axios.get('https://api.line.me/v2/bot/message/quota/consumption', {
            headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
        });
        return response.data;
    } catch (error) {
        return null;
    }
}

async function appendQuotaInfo(messageText) {
    const quota = await getMessageQuota();
    const consumption = await getMessageQuotaConsumption();
    if (quota && consumption && quota.value !== -1) {
        const remaining = quota.value - consumption.totalUsage;
        if (remaining <= 50) { // 提高警示門檻到 50
            messageText += `\n\n⚠️ 訊息額度剩餘: ${remaining} (總量 ${quota.value})`;
        }
    }
    return messageText;
}

// 使用者互動追蹤
async function checkAndUpdateUserProfile(userId, interactionItem) {
    const now = moment().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss');
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    
    if (!snapshot.exists()) {
        try {
            const profile = await client.getProfile(userId);
            await userRef.set({
                displayName: profile.displayName || '未知',
                pictureUrl: profile.pictureUrl || '',
                statusMessage: profile.statusMessage || '',
                createdAt: now,
                lastInteractionTime: now,
                lastInteractionItem: interactionItem
            });
        } catch (e) { console.error(e); }
    } else {
        await userRef.update({
            lastInteractionTime: now,
            lastInteractionItem: interactionItem
        });
    }
}

async function handleFollowEvent(event) {
    return handleEvent({ 
        type: 'message', 
        source: event.source, 
        replyToken: event.replyToken,
        message: { type: 'text', text: '使用者' } // 模擬互動以建立資料
    });
}

async function updateAllUserProfiles() {
    // 略，保持原樣即可，或是為了節省資源可移除
    console.log('🔄 更新使用者資料 (排程執行)');
}

// ----------------------- LINE Webhook 處理 -----------------------

const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(lineConfig);

async function handleEvent(event) {
    if (event.type === 'follow') return handleFollowEvent(event);
    if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

    const userId = event.source.userId;
    const text = event.message.text.trim();
    await checkAndUpdateUserProfile(userId, text);

    // 簡單指令處理
    if (text === '取消') {
        await db.ref(`users/${userId}/waitingForSetting`).remove();
        return client.replyMessage(event.replyToken, { type: 'text', text: '已取消設定。' });
    }

    // 檢查是否有等待中的設定
    const waitSnap = await db.ref(`users/${userId}/waitingForSetting`).once('value');
    const waitingFor = waitSnap.val();

    if (waitingFor) {
        const numVal = Number(text);
        if (waitingFor === 'PM10_THRESHOLD') {
            if (isNaN(numVal)) return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入數字。' });
            await db.ref('settings/PM10_THRESHOLD').set(numVal);
            await db.ref(`users/${userId}/waitingForSetting`).remove();
            return client.replyMessage(event.replyToken, { type: 'text', text: `✅ PM10 閾值已設為 ${numVal}` });
        }
        if (waitingFor === 'ALERT_INTERVAL') {
            if (isNaN(numVal) || numVal < 10) return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入大於 10 的數字。' });
            await db.ref('settings/ALERT_INTERVAL').set(numVal);
            await db.ref(`users/${userId}/waitingForSetting`).remove();
            return client.replyMessage(event.replyToken, { type: 'text', text: `✅ 警報間隔已設為 ${numVal} 分鐘` });
        }
    }

    // 一般指令
    if (text.includes('即時查詢')) {
        // 直接從 Firebase 拿最後一筆，不再重爬 (除非太舊)
        const snap = await db.ref('pm10_records').limitToLast(1).once('value');
        const data = snap.val();
        let msg = '⚠️ 暫無數據';
        
        if (data) {
            const entry = Object.values(data)[0];
            const timeDiff = moment().tz('Asia/Taipei').diff(moment(entry.time, 'YYYY/MM/DD HH:mm'), 'minutes');
            
            msg = `📡 PM10 即時查詢\n📅 時間: ${entry.time}\n` +
                  `🌍 184: ${entry.station_184 || '-'} | 185: ${entry.station_185 || '-'} | 大城: ${entry.station_dacheng || '-'}\n` +
                  `⚠️ 閾值: ${pm10Threshold} | 資料延遲: ${timeDiff} 分鐘`;
            
            if (timeDiff > 20) msg += '\n⚠️ 數據可能延遲，系統正在嘗試抓取中...';
        }
        msg = await appendQuotaInfo(msg);
        return client.replyMessage(event.replyToken, { type: 'text', text: msg });
    }
    
    if (text === '24小時記錄') {
        const url = 'https://mobile-env-monitor.onrender.com/download/24hr_record.txt';
        let msg = `📥 下載 24 小時記錄:\n${url}`;
        
        // 觸發生成檔案 (實際上 saveToFirebase 已經持續在做，這裡只需確保檔案存在)
        // 為了簡化，建議由 saveToFirebase 或另外的排程產生檔案，這裡只給連結
        // 或是即時生成檔案字串
        const cutoff = moment().subtract(24, 'hours').valueOf();
        const snap = await db.ref('pm10_records').orderByKey().startAt(cutoff.toString()).once('value');
        let fileContent = 'Time,184,185,Dacheng\n';
        snap.forEach(child => {
            const d = child.val();
            fileContent += `${d.time},${d.station_184||''},${d.station_185||''},${d.station_dacheng||''}\n`;
        });
        fs.writeFileSync(path.join(__dirname, 'records/24hr_record.txt'), fileContent);
        
        return client.replyMessage(event.replyToken, { type: 'text', text: msg });
    }

    if (text === '設定PM10閾值') {
        await db.ref(`users/${userId}/waitingForSetting`).set("PM10_THRESHOLD");
        return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入新的 PM10 閾值 (數字):' });
    }

    if (text === '超標警報間隔(分鐘)') {
        await db.ref(`users/${userId}/waitingForSetting`).set("ALERT_INTERVAL");
        return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入新的間隔分鐘數 (例如 60):' });
    }

    if (text === '查詢訊息配額') {
        const q = await getMessageQuota();
        const c = await getMessageQuotaConsumption();
        if (q && c) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `📊 配額狀態\n總量: ${q.value}\n已用: ${c.totalUsage}\n剩餘: ${q.value - c.totalUsage}` 
            });
        }
    }

    if (text === '顯示常用指令') {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '請選擇指令',
            quickReply: {
                items: [
                    { type: 'action', action: { type: 'message', label: '即時查詢', text: '即時查詢' } },
                    { type: 'action', action: { type: 'message', label: '24小時記錄', text: '24小時記錄' } },
                    { type: 'action', action: { type: 'message', label: '設定PM10閾值', text: '設定PM10閾值' } },
                    { type: 'action', action: { type: 'message', label: '設定警報間隔', text: '超標警報間隔(分鐘)' } }
                ]
            }
        });
    }

    return Promise.resolve(null);
}

// ----------------------- Express & Init -----------------------

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(result => res.json(result))
        .catch(err => {
            console.error(err);
            res.status(500).end();
        });
});

app.get('/download/24hr_record.txt', (req, res) => {
    const file = path.join(__dirname, 'records/24hr_record.txt');
    if (fs.existsSync(file)) res.download(file);
    else res.status(404).send('Record not found');
});

app.post('/ping', (req, res) => res.send('pong'));

// 啟動排程
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`🌐 Server running on port ${PORT}`);
    
    // 初始化設定
    const s = await getFirebaseSettings();
    if (s.SCRAPE_INTERVAL) scrapeInterval = Number(s.SCRAPE_INTERVAL) * 60 * 1000;
    if (s.PM10_THRESHOLD) pm10Threshold = Number(s.PM10_THRESHOLD);
    if (s.ALERT_INTERVAL) alertInterval = Number(s.ALERT_INTERVAL);

    // 建立資料夾
    if (!fs.existsSync(path.join(__dirname, 'records'))) fs.mkdirSync(path.join(__dirname, 'records'));

    monitorScrapeInterval();
    monitorPM10Threshold();
    monitorAlertInterval();
    
    loginAndFetchPM10Data(); // 立即執行一次
    restartFetchInterval();
    scheduleDailyNightCheck();
    
    // 自我 Ping 防止休眠 (Render Free Tier 適用)
    setInterval(() => {
        axios.post(`https://pinger-app-m1tm.onrender.com/ping`, { msg: 'keepalive' }).catch(() => {});
    }, 10 * 60 * 1000);
});
