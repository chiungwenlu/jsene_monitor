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

// 從環境變量讀取 Firebase Admin SDK 配置
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://env-monitor-7167f-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ----------------------- Firebase 設定相關函式 -----------------------

async function getFirebaseSettings() {
    const snapshot = await db.ref('settings').once('value');
    return snapshot.val() || {};
}

async function getLastAlertTime() {
    const snapshot = await db.ref('settings/last_alert_time').once('value');
    return snapshot.val() || null;
}

async function updateLastAlertTime(timestamp) {
    await db.ref('settings/last_alert_time').set(timestamp);
}

async function getLastFetchTime() {
    const snapshot = await db.ref('settings/last_fetch_time').once('value');
    return snapshot.val() || null;
}

async function updateLastFetchTime(timestamp) {
    await db.ref('settings/last_fetch_time').set(timestamp);
}

async function getLastFetchAlertTime() {
    const snapshot = await db.ref('settings/last_fetch_alert_time').once('value');
    return snapshot.val() || null;
}

async function updateLastFetchAlertTime(timestamp) {
    await db.ref('settings/last_fetch_alert_time').set(timestamp);
}

// ----------------------- 設定監聽與排程相關函式 -----------------------

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

function monitorPM10Threshold() {
    db.ref('settings/PM10_THRESHOLD').on('value', (snapshot) => {
        const newThreshold = snapshot.val();
        if (newThreshold !== pm10Threshold) {
            console.log(`🔄 PM10_THRESHOLD 變更: ${newThreshold}`);
            pm10Threshold = newThreshold;
        }
    });
}

function monitorAlertInterval() {
    db.ref('settings/ALERT_INTERVAL').on('value', (snapshot) => {
        const newInterval = snapshot.val();
        if (newInterval !== alertInterval) {
            console.log(`🔄 ALERT_INTERVAL 變更: ${newInterval} 分鐘`);
            alertInterval = newInterval;
        }
    });
}

function restartFetchInterval() {
    if (fetchInterval) {
        clearInterval(fetchInterval);
        console.log('🛑 重新啟動數據抓取定時器...');
    }
    fetchInterval = setInterval(loginAndFetchPM10Data, scrapeInterval);
    console.log(`✅ 設定新抓取間隔: 每 ${scrapeInterval / 60000} 分鐘執行一次`);
}

// ----------------------- PM10 數據抓取與處理相關函式 -----------------------

async function getDynamicDataURL(stationId) {
    const now = moment().tz('Asia/Taipei');
    const endTime = now.format('YYYY/MM/DD HH:mm');
    let lastFetchTime = await getLastFetchTime();
    if (!lastFetchTime) {
        lastFetchTime = now.clone().subtract(scrapeInterval / 60000, 'minutes').format('YYYY/MM/DD HH:mm');
    } else {
        lastFetchTime = moment(lastFetchTime).tz('Asia/Taipei').format('YYYY/MM/DD HH:mm');
    }
    console.log(`🕒 測站 ${stationId} 目標時間範圍 (UTC+8): ${lastFetchTime} ~ ${endTime}`);
    return {
        url: `https://www.jsene.com/juno/jGrid.aspx?PJ=200209&ST=${stationId}&d1=${encodeURIComponent(lastFetchTime)}&d2=${encodeURIComponent(endTime)}&tt=T01&f=0&col=1,2,3,9,10,11`,
        endTimeTimestamp: now.valueOf()
    };
}

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

async function pruneOldData() {
    const cutoff = moment().subtract(24, 'hours').valueOf();
    const dataRef = db.ref('pm10_records');
    const snapshot = await dataRef.orderByKey().endAt(cutoff.toString()).once('value');
    snapshot.forEach((childSnapshot) => {
        childSnapshot.ref.remove();
    });
    console.log(`✅ 已刪除超過 24 小時前的舊資料（截止時間戳：${cutoff}）。`);
}

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
    await pruneOldData();
}

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
        let finalAlertMessage = `${alertHeader}${alertMessages.join("\n\n")}\n\n⚠️ **PM10濃度≧${pm10Threshold} µg/m³，請啟動水線抑制揚塵**`;
        finalAlertMessage = await appendQuotaInfo(finalAlertMessage);
        console.log(finalAlertMessage);
        await updateLastAlertTime(now);
        await client.broadcast({ type: 'text', text: finalAlertMessage });
    }
}

async function loginAndFetchPM10Data() {
    console.log('🔑 啟動瀏覽器並登入...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    const settings = await getFirebaseSettings();
    const username = settings.ACCOUNT_NAME || 'ExcelTek';
    const password = settings.ACCOUNT_PASSWORD || 'ExcelTek';
    console.log(`🔹 設定 - 抓取間隔: ${scrapeInterval / 60000} 分鐘, 警告間隔: ${alertInterval} 分鐘, PM10 閾值: ${pm10Threshold}`);
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

async function checkFetchStatus() {
    const now = moment().tz('Asia/Taipei').valueOf();
    const lastFetchTime = await getLastFetchTime();
    if (!lastFetchTime || now - lastFetchTime > 12 * 60 * 60 * 1000) {
        const lastFetchAlertTime = await getLastFetchAlertTime();
        if (!lastFetchAlertTime || now - lastFetchAlertTime > 12 * 60 * 60 * 1000) {
            let alertMessage = "⚠️ 警告：數據抓取失敗已超過12小時，請檢查系統狀態！";
            alertMessage = await appendQuotaInfo(alertMessage);
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

async function appendQuotaInfo(messageText) {
    const quota = await getMessageQuota();
    const consumption = await getMessageQuotaConsumption();
    if (quota && consumption && quota.value !== -1) {
        const remaining = quota.value - consumption.totalUsage;
        if (remaining <= 10) {
            messageText += `\n\n免費廣播訊息數量: **${quota.value}**\n`;
            messageText += `已使用訊息數量: **${consumption.totalUsage}**\n`;
            messageText += `剩餘免費訊息數量: **${remaining}**\n`;
            messageText += `免費訊息數量使用完畢後，系統將無法主動發出警告訊息。請自行查詢24小時記錄，以取得PM10數據超過閾值之記錄。`;
        }
    }
    return messageText;
}

// ----------------------- 使用者資料相關功能 -----------------------

async function handleFollowEvent(event) {
    const userId = event.source.userId;
    try {
        const profile = await client.getProfile(userId);
        const displayName = profile.displayName || '未知用戶';
        await db.ref(`users/${userId}`).set({
            displayName: displayName,
            pictureUrl: profile.pictureUrl || '',
            statusMessage: profile.statusMessage || '',
            createdAt: moment().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss')
        });
        console.log(`✅ 新使用者加入：${displayName} (userId: ${userId})`);
    } catch (error) {
        console.error(`❌ 無法取得使用者 ${userId} 資訊：`, error);
    }
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `感謝您加入！`
    });
}

async function updateAllUserProfiles() {
    try {
        const snapshot = await db.ref('users').once('value');
        const users = snapshot.val() || {};
        for (const userId of Object.keys(users)) {
            try {
                const profile = await client.getProfile(userId);
                const displayName = profile.displayName || '未知用戶';
                await db.ref(`users/${userId}`).update({
                    displayName: displayName,
                    pictureUrl: profile.pictureUrl || '',
                    statusMessage: profile.statusMessage || '',
                    updatedAt: moment().tz('Asia/Taipei').format('YYYY-MM-DD HH:mm:ss')
                });
                console.log(`✅ 已更新使用者資料：${displayName} (userId: ${userId})`);
            } catch (err) {
                console.error(`❌ 無法更新使用者 ${userId}：`, err);
            }
        }
        console.log('✅ 所有使用者資料更新完成。');
    } catch (error) {
        console.error('❌ 更新所有使用者資料失敗：', error);
    }
}

// ----------------------- LINE Bot 事件處理 -----------------------

const lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

const client = new line.Client(lineConfig);

async function handleEvent(event) {
    if (event.type === 'follow') {
        return handleFollowEvent(event);
    }
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }
    const receivedMessage = event.message.text;
    let replyMessage = '';
    const userId = event.source.userId;

    // 檢查使用者等待設定狀態（存於 Firebase users/{userId}/waitingForSetting）
    let waitingSnapshot = await db.ref(`users/${userId}/waitingForSetting`).once('value');
    let waitingForSetting = waitingSnapshot.val() || null;
    const recognizedCommands = ["即時查詢", "24小時記錄", "查詢訊息配額", "設定PM10閾值", "超閾值警報間隔(分鐘)", "顯示常用指令", "取消", "使用者"];

    if (waitingForSetting !== null) {
        if (receivedMessage === "取消") {
            await db.ref(`users/${userId}/waitingForSetting`).remove();
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: '已取消設定。'
            });
        } else if (recognizedCommands.includes(receivedMessage)) {
            // 若收到其他預設指令，先清除等待狀態，再進入新指令流程
            await db.ref(`users/${userId}/waitingForSetting`).remove();
        } else {
            if (waitingForSetting === "PM10_THRESHOLD") {
                const newValue = Number(receivedMessage);
                if (isNaN(newValue)) {
                    await db.ref(`users/${userId}/waitingForSetting`).remove();
                    return client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '輸入錯誤，PM10 閾值必須為數字，維持原設定並離開。'
                    });
                }
                await db.ref('settings/PM10_THRESHOLD').set(newValue);
                await db.ref(`users/${userId}/waitingForSetting`).remove();
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `已將 PM10 閾值設定為 ${newValue}`
                });
            } else if (waitingForSetting === "ALERT_INTERVAL") {
                const newValue = Number(receivedMessage);
                if (isNaN(newValue) || newValue < 30 || newValue > 240) {
                    await db.ref(`users/${userId}/waitingForSetting`).remove();
                    return client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: '輸入錯誤，超閾值警報間隔必須為 30~240 之間的數字，維持原設定並離開。'
                    });
                }
                await db.ref('settings/ALERT_INTERVAL').set(newValue);
                await db.ref(`users/${userId}/waitingForSetting`).remove();
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `已將超閾值警報間隔設定為 ${newValue} 分鐘`
                });
            }
        }
    }

    // 處理一般指令
    if (receivedMessage === '即時查詢') {
        console.log('執行即時查詢');
        const snapshot = await db.ref('pm10_records').limitToLast(1).once('value');
        const latestData = snapshot.val();
        const nowTime = moment().tz('Asia/Taipei');
        if (latestData) {
            const latestPM10 = Object.values(latestData)[0];
            const latestTime = moment.tz(latestPM10.time, "YYYY/MM/DD HH:mm", "Asia/Taipei");
            const timeDiff = Math.abs(nowTime.diff(latestTime, 'minutes'));
            console.log(`🔍 Firebase 最新數據時間: ${latestPM10.time}, 與現在時間相差: ${timeDiff} 分鐘`);
            if (timeDiff <= 1) {
                replyMessage = `📡 PM10即時查詢結果
📅 時間: ${latestPM10.time}
🌍 測站184堤外: ${latestPM10.station_184 || 'N/A'} µg/m³
🌍 測站185堤上: ${latestPM10.station_185 || 'N/A'} µg/m³
⚠️ PM10 閾值: ${pm10Threshold} µg/m³`;
                
                const cutoff = moment().subtract(24, 'hours').valueOf();
                const snapshot24 = await db.ref('pm10_records')
                                            .orderByKey()
                                            .startAt(cutoff.toString())
                                            .once('value');
                const records = snapshot24.val();
                let alertRecords = [];
                if (records) {
                    for (const [timestamp, data] of Object.entries(records)) {
                        let alertText = `📅 時間: ${data.time}`;
                        let hasAlert = false;
                        if (data.station_184 && data.station_184 > pm10Threshold) {
                            alertText += `\n🌍 測站184: ${data.station_184} µg/m³`;
                            hasAlert = true;
                        }
                        if (data.station_185 && data.station_185 > pm10Threshold) {
                            alertText += `\n🌍 測站185: ${data.station_185} µg/m³`;
                            hasAlert = true;
                        }
                        if (hasAlert) {
                            alertRecords.push(alertText);
                        }
                    }
                }
                if (alertRecords.length > 0) {
                    replyMessage += `\n\n⚠️ 24小時內超過閾值記錄:\n${alertRecords.join("\n\n")}`;
                } else {
                    replyMessage += `\n\n✅ 24小時內無超過閾值記錄。`;
                }
                
                replyMessage = await appendQuotaInfo(replyMessage);
                return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
            }
        }
        console.log('⚠️ Firebase 資料已過時，重新爬取 PM10 數據...');
        await loginAndFetchPM10Data();
        const newSnapshot = await db.ref('pm10_records').limitToLast(1).once('value');
        const newLatestData = newSnapshot.val();
        if (newLatestData) {
            const latestPM10 = Object.values(newLatestData)[0];
            replyMessage = `📡 PM10即時查詢結果
📅 時間: ${latestPM10.time}
🌍 測站184堤外: ${latestPM10.station_184 || 'N/A'} µg/m³
🌍 測站185堤上: ${latestPM10.station_185 || 'N/A'} µg/m³
⚠️ PM10 閾值: ${pm10Threshold} µg/m³`;
            
            const cutoff = moment().subtract(24, 'hours').valueOf();
            const snapshot24 = await db.ref('pm10_records')
                                        .orderByKey()
                                        .startAt(cutoff.toString())
                                        .once('value');
            const records = snapshot24.val();
            let alertRecords = [];
            if (records) {
                for (const [timestamp, data] of Object.entries(records)) {
                    let alertText = `📅 時間: ${data.time}`;
                    let hasAlert = false;
                    if (data.station_184 && data.station_184 > pm10Threshold) {
                        alertText += `\n🌍 測站184: ${data.station_184} µg/m³`;
                        hasAlert = true;
                    }
                    if (data.station_185 && data.station_185 > pm10Threshold) {
                        alertText += `\n🌍 測站185: ${data.station_185} µg/m³`;
                        hasAlert = true;
                    }
                    if (hasAlert) {
                        alertRecords.push(alertText);
                    }
                }
            }
            if (alertRecords.length > 0) {
                replyMessage += `\n\n⚠️ 24小時內超過閾值記錄:\n${alertRecords.join("\n\n")}`;
            } else {
                replyMessage += `\n\n✅ 24小時內無超過閾值記錄。`;
            }
        } else {
            replyMessage = '⚠️ 目前無法獲取最新的 PM10 數據，請稍後再試。';
        }
        replyMessage = await appendQuotaInfo(replyMessage);
        return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
    }
    else if (receivedMessage === '24小時記錄') {
        console.log('📥 取得 24 小時記錄');
        const cutoff = moment().subtract(24, 'hours').valueOf();
        const snapshot = await db.ref('pm10_records').orderByKey().startAt(cutoff.toString()).once('value');
        const records = snapshot.val();
        if (!records) {
            replyMessage = '⚠️ 目前沒有可用的 24 小時記錄。';
            replyMessage = await appendQuotaInfo(replyMessage);
            return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
        }
        let recordText = '📡 PM10 24 小時記錄\n\n';
        let alertRecords = [];
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
            if (hasAlert) {
                alertRecords.push(alertText);
            }
        }
        const filePath = path.join(__dirname, 'records', '24hr_record.txt');
        fs.writeFileSync(filePath, fileContent, 'utf8');
        if (alertRecords.length > 0) {
            recordText += '⚠️ 以下為超過 PM10 閾值的部分:\n\n' + alertRecords.join('\n\n') + '\n\n';
        } else {
            recordText += '✅ 過去 24 小時內無數據超過 PM10 閾值。\n\n';
        }
        recordText += `📥 下載完整 24 小時記錄: \n👉 [點擊下載](https://mobile-env-monitor.onrender.com/download/24hr_record.txt)`;
        recordText = await appendQuotaInfo(recordText);
        return client.replyMessage(event.replyToken, { type: 'text', text: recordText });
    }
    else if (receivedMessage === '查詢訊息配額') {
        console.log('📡 查詢 LINE 訊息發送配額...');
        const quota = await getMessageQuota();
        const consumption = await getMessageQuotaConsumption();
        if (!quota || !consumption) {
            replyMessage = '⚠️ 無法查詢 LINE 訊息配額，請稍後再試。';
        } else {
            replyMessage = `📊 LINE 訊息發送狀態\n\n` +
                           `📩 免費廣播訊息數量: ${quota.value === -1 ? '無限' : quota.value}\n` +
                           `📤 已使用訊息數量: ${consumption.totalUsage}\n\n` +
                           `免費訊息數量使用完畢後，系統將無法主動發出警告訊息。請自行查詢24小時記錄，以取得PM10數據超過閾值之記錄。`;
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
    }
    else if (receivedMessage === '設定PM10閾值') {
        await db.ref(`users/${userId}/waitingForSetting`).set("PM10_THRESHOLD");
        return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入新的 PM10 閾值 (數字)：' });
    }
    else if (receivedMessage === '超閾值警報間隔(分鐘)') {
        await db.ref(`users/${userId}/waitingForSetting`).set("ALERT_INTERVAL");
        return client.replyMessage(event.replyToken, { type: 'text', text: '請輸入新的超閾值警報間隔 (30~240 分鐘)：' });
    }
    else if (receivedMessage === '顯示常用指令') {
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '請選擇要執行的功能：',
            quickReply: {
                items: [
                    {
                        type: 'action',
                        action: {
                            type: 'message',
                            label: '設定PM10閾值',
                            text: '設定PM10閾值'
                        }
                    },
                    {
                        type: 'action',
                        action: {
                            type: 'message',
                            label: '超閾值警報間隔(分鐘)',
                            text: '超閾值警報間隔(分鐘)'
                        }
                    },
                    {
                        type: 'action',
                        action: {
                            type: 'message',
                            label: '查詢訊息配額',
                            text: '查詢訊息配額'
                        }
                    },                    
                    {
                        type: 'action',
                        action: {
                            type: 'message',
                            label: '查詢使用者',
                            text: '使用者'
                        }
                    },                    
                    {
                        type: 'action',
                        action: {
                            type: 'uri',
                            label: '前往Juno雲端數據中心',
                            uri: 'https://www.jsene.com/juno/Login.aspx'
                        }
                    }
                ]
            }
        });
    }
    else if (receivedMessage === '使用者') {
        try {
            const snapshot = await db.ref('users').once('value');
            const usersData = snapshot.val() || {};
            const userCount = Object.keys(usersData).length;
            let userListText = `總使用者數量：${userCount}\n\n`;
            for (const uid in usersData) {
                const user = usersData[uid];
                const userName = user.name || '未知使用者';
                userListText += `${userName}\n`;
            }
            return client.replyMessage(event.replyToken, { type: 'text', text: userListText });
        } catch (err) {
            return client.replyMessage(event.replyToken, { type: 'text', text: '查詢使用者資料失敗，請稍後再試。' });
        }
    }

    return client.replyMessage(event.replyToken, { type: 'text', text: replyMessage });
}

// ----------------------- Express 路由與定時排程 -----------------------

const recordsDir = path.join(__dirname, 'records');
if (!fs.existsSync(recordsDir)) {
    fs.mkdirSync(recordsDir);
}

app.get('/download/24hr_record.txt', (req, res) => {
    const filePath = path.join(__dirname, 'records', '24hr_record.txt');
    res.download(filePath);
});

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => console.error(err));
});

app.post('/ping', (req, res) => {
    console.log('來自 pinger-app 的訊息:', req.body);
    res.json({ message: 'pong' });
});

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
setInterval(checkFetchStatus, 60 * 60 * 1000);
setInterval(updateAllUserProfiles, 24 * 60 * 60 * 1000);

loginAndFetchPM10Data();
monitorScrapeInterval();
monitorPM10Threshold();
monitorAlertInterval();
restartFetchInterval();

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🌐 LINE Bot webhook 監聽中... 端口: ${PORT}`);
});
