const express = require("express");
const puppeteer = require("puppeteer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

app.get("/", async (req, res) => {
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

    // 導航到目標網站
    await page.goto("https://developer.chrome.com/");

    // 抓取網站的 <title> 標籤內容
    const fullTitle = await page.title();

    // 印出完整標題
    const logStatement = `The title of this page is: ${fullTitle}`;
    console.log(logStatement);

    // 將標題回傳到用戶端
    res.send(logStatement);
  } catch (e) {
    console.error(e);
    res.send(`Something went wrong while running Puppeteer: ${e}`);
  } finally {
    await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
