const express = require("express");
const puppeteer = require("puppeteer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

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
    return pm10Data184;  // 返回抓取的數據
  } catch (error) {
    console.error('抓取數據時出錯:', error);
    return null;  // 如果出錯，返回 null
  } finally {
    await browser.close(); // 確保瀏覽器正常關閉
  }
}

// 定義根路由處理器
app.get("/", async (req, res) => {
  const data = await scrapeData();  // 調用 scrapeData 函數抓取數據
  if (data) {
    res.send(`理虹(184) PM10 數據: ${data}`);  // 將數據顯示給用戶
  } else {
    res.send("無法抓取數據");
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
