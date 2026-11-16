const express = require('express');
const line = require('@line/bot-sdk');
const https = require('https');
require('dotenv').config();

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

// ===== Google Sheet FAQ =====
const SHEET_ID = '1LmmmwpByLKHmGf4bGzcRXFQolqMSo93nQW-1IwClxqg';
const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/export?format=csv';
var faqData = [];

// ===== Google Sheets Database API =====
// ใส่ URL ของ Apps Script Web App ใน .env หรือ Render Environment
const SHEET_API_URL = process.env.SHEET_API_URL || '';

// ===== ฟังก์ชันเรียก API =====
function callSheetAPI(body) {
  return new Promise(function(resolve, reject) {
    if (!SHEET_API_URL) {
      reject(new Error('SHEET_API_URL not configured'));
      return;
    }
    var postData = JSON.stringify(body);
    var urlObj = new URL(SHEET_API_URL);

    var options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    function doRequest(reqUrl) {
      var u = new URL(reqUrl);
      var opts = {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      var req = https.request(opts, function(res) {
        // Google Apps Script returns 302 redirect after POST
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect with GET
          https.get(res.headers.location, function(res2) {
            var data = '';
            res2.on('data', function(chunk) { data += chunk; });
            res2.on('end', function() {
              try { resolve(JSON.parse(data)); }
              catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
            });
          }).on('error', reject);
          return;
        }
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    }

    doRequest(SHEET_API_URL);
  });
}

// ===== CSV Parser =====
function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    if (inQuotes) {
      if (line[i] === '"' && i+1 < line.length && line[i+1] === '"') {
        current += '"'; i++;
      } else if (line[i] === '"') { inQuotes = false; }
      else { current += line[i]; }
    } else {
      if (line[i] === '"') { inQuotes = true; }
      else if (line[i] === ',') { result.push(current.trim()); current = ''; }
      else { current += line[i]; }
    }
  }
  result.push(current.trim());
  return result;
}

// ===== FAQ Functions =====
function fetchFAQ() {
  return new Promise(function(resolve) {
    function doGet(url) {
      https.get(url, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log('FAQ redirect to: ' + res.headers.location);
          doGet(res.headers.location);
          return;
        }
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          var lines = data.split('\n');
          var newFaq = [];
          for (var i = 1; i < lines.length; i++) {
            var line2 = lines[i].trim();
            if (!line2) continue;
            var fields = parseCSVLine(line2);
            if (fields.length >= 2 && fields[0] && fields[1]) {
              newFaq.push({ q: fields[0].toLowerCase(), a: fields[1] });
            }
          }
          faqData = newFaq;
          console.log('FAQ loaded: ' + faqData.length + ' items');
          resolve();
        });
      }).on('error', function(e) {
        console.error('Error fetching FAQ:', e);
        resolve();
      });
    }
    doGet(SHEET_CSV_URL);
  });
}

function findFAQAnswer(question) {
  var q = question.toLowerCase().trim();
  // 1. ตรงเป๊ะ
  for (var i = 0; i < faqData.length; i++) {
    if (faqData[i].q === q) return faqData[i].a;
  }
  // 2. Substring match
  for (var j = 0; j < faqData.length; j++) {
    if (q.indexOf(faqData[j].q) !== -1 || faqData[j].q.indexOf(q) !== -1) return faqData[j].a;
  }
  // 3. Bigram matching (สำหรับภาษาไทย)
  function getBigrams(text) {
    var chars = Array.from(text);
    var bg = [];
    for (var i = 0; i < chars.length - 1; i++) { bg.push(chars[i] + chars[i+1]); }
    return bg;
  }
  var qBigrams = getBigrams(q);
  var bestScore = 0;
  var bestIdx = -1;
  for (var k = 0; k < faqData.length; k++) {
    var faqBg = getBigrams(faqData[k].q);
    if (faqBg.length < 2) continue;
    var matchCount = 0;
    for (var b = 0; b < faqBg.length; b++) {
      if (qBigrams.indexOf(faqBg[b]) !== -1) matchCount++;
    }
    var score = matchCount / faqBg.length;
    if (score > bestScore && matchCount >= 2) { bestScore = score; bestIdx = k; }
  }
  if (bestScore >= 0.4 && bestIdx >= 0) return faqData[bestIdx].a;
  return null;
}

// โหลด FAQ ทุก 5 นาที
fetchFAQ();
setInterval(fetchFAQ, 5 * 60 * 1000);

// ===== ตั้งค่า =====
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const CODE_EXPIRE_MINUTES = 1440; // 24 ชั่วโมง
const REDEEM_COST = 15;

// ===== ระบบเก็บแต้ม (Google Sheets) =====
async function getPoints(userId) {
  try {
    var result = await callSheetAPI({ action: 'getCustomer', userId: userId });
    if (!result.found) {
      // สร้างลูกค้าใหม่
      await callSheetAPI({ action: 'setCustomer', userId: userId, data: { points: 0, totalEarned: 0, redeemed: 0, name: '' } });
      return { points: 0, totalEarned: 0, redeemed: 0, name: '' };
    }
    return { points: Number(result.points), totalEarned: Number(result.totalEarned), redeemed: Number(result.redeemed), name: result.name || '' };
  } catch (e) {
    console.error('Error getPoints:', e);
    return { points: 0, totalEarned: 0, redeemed: 0, name: '' };
  }
}

async function addPoints(userId, count) {
  try {
    var user = await getPoints(userId);
    var newPoints = user.points + count;
    var newTotal = user.totalEarned + count;
    await callSheetAPI({ action: 'setCustomer', userId: userId, data: { points: newPoints, totalEarned: newTotal } });
    return { points: newPoints, totalEarned: newTotal, redeemed: user.redeemed, name: user.name };
  } catch (e) {
    console.error('Error addPoints:', e);
    return null;
  }
}

async function updateUserName(userId) {
  try {
    var profile = await client.getProfile(userId);
    await callSheetAPI({ action: 'setCustomer', userId: userId, data: { name: profile.displayName } });
  } catch (e) { console.error('Error getting profile:', e); }
}

async function redeemPoints(userId, cost) {
  try {
    var user = await getPoints(userId);
    if (user.points < cost) return null;

    var newPoints = user.points - cost;
    var newRedeemed = user.redeemed + 1;
    await callSheetAPI({ action: 'setCustomer', userId: userId, data: { points: newPoints, redeemed: newRedeemed } });

    var redeemCode = await generateUniqueRedeemCode();
    await callSheetAPI({ action: 'addRedeem', data: {
      redeemCode: redeemCode,
      userId: userId,
      name: user.name || '',
      cost: cost,
      redeemedAt: new Date().toISOString()
    }});
    return { user: { points: newPoints, totalEarned: user.totalEarned, redeemed: newRedeemed, name: user.name }, redeemCode: redeemCode };
  } catch (e) {
    console.error('Error redeemPoints:', e);
    return null;
  }
}

// ===== ระบบรหัส =====
function generateCodeStr() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateRedeemCodeStr() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = 'R-';
  for (var i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

async function generateUniqueCode() {
  var code;
  var maxTries = 10;
  for (var i = 0; i < maxTries; i++) {
    code = generateCodeStr();
    var result = await callSheetAPI({ action: 'codeExists', code: code });
    if (!result.exists) return code;
  }
  return code; // fallback
}

async function generateUniqueRedeemCode() {
  var code;
  var maxTries = 10;
  for (var i = 0; i < maxTries; i++) {
    code = generateRedeemCodeStr();
    var result = await callSheetAPI({ action: 'redeemCodeExists', redeemCode: code });
    if (!result.exists) return code;
  }
  return code;
}

async function isBillUsed(billNo) {
  try {
    var result = await callSheetAPI({ action: 'getBill', billNo: billNo });
    return result.found === true;
  } catch (e) { return false; }
}

async function createCode(staffId, pointsAmount, billNo) {
  var code = await generateUniqueCode();
  var now = new Date().toISOString();
  await callSheetAPI({ action: 'setCode', code: code, data: {
    points: pointsAmount,
    billNo: billNo,
    createdBy: staffId,
    createdAt: now,
    used: false
  }});
  await callSheetAPI({ action: 'setBill', billNo: billNo, data: {
    code: code,
    points: pointsAmount,
    createdBy: staffId,
    createdAt: now
  }});
  return code;
}

async function useCode(code, userId) {
  try {
    var upperCode = code.toUpperCase();
    var result = await callSheetAPI({ action: 'getCode', code: upperCode });

    if (!result.found) return { error: 'not_found' };
    if (result.used === true || result.used === 'TRUE' || result.used === 'true') return { error: 'already_used' };

    // เช็คหมดอายุ
    var created = new Date(result.createdAt);
    var now = new Date();
    var diffMinutes = (now - created) / (1000 * 60);
    if (diffMinutes > CODE_EXPIRE_MINUTES) return { error: 'expired' };

    // ใช้รหัสสำเร็จ
    await callSheetAPI({ action: 'setCode', code: upperCode, data: {
      used: true,
      usedBy: userId,
      usedAt: new Date().toISOString()
    }});
    return { success: true, points: Number(result.points) };
  } catch (e) {
    console.error('Error useCode:', e);
    return { error: 'system_error' };
  }
}

async function verifyRedeem(redeemCode) {
  try {
    var result = await callSheetAPI({ action: 'confirmRedeem', redeemCode: redeemCode.toUpperCase() });
    return result;
  } catch (e) {
    console.error('Error verifyRedeem:', e);
    return { error: 'system_error' };
  }
}

// ===== Webhook =====
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => { console.error('Error:', err); res.status(500).end(); });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  let replyText;

  // ===== คำสั่งพนักงาน: สร้าง:1234:00003:3 =====
  const createMatch = msg.match(/^สร้าง[:\s](\d{4})[:\s]([A-Za-z0-9\/]+)[:\s](\d+)$/);
  if (createMatch) {
    const pin = createMatch[1];
    const billNo = createMatch[2];
    const count = parseInt(createMatch[3]);

    if (pin !== ADMIN_PIN) {
      replyText = '❌ รหัสไม่ถูกต้อง';
    } else if (count < 1 || count > 20) {
      replyText = '❌ ใส่จำนวน 1-20 แก้ว';
    } else if (await isBillUsed(billNo)) {
      replyText = '❌ บิลเลขที่ ' + billNo + ' ถูกใช้ไปแล้ว!';
    } else {
      const code = await createCode(userId, count, billNo);
      replyText = '✅ สร้างรหัสสำเร็จ!\n\n🎫 รหัส: ' + code + '\n🧾 บิล: ' + billNo + '\n☕ จำนวน: ' + count + ' แต้ม\n⏰ หมดอายุใน 24 ชั่วโมง\n\nบอกรหัสนี้ให้ลูกค้า';
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งพนักงาน: เช็ค:1234 =====
  const checkMatch = msg.match(/^เช็ค[:\s](\d{4})$/);
  if (checkMatch) {
    const pin = checkMatch[1];
    if (pin !== ADMIN_PIN) {
      replyText = '❌ รหัสไม่ถูกต้อง';
    } else {
      try {
        var allResult = await callSheetAPI({ action: 'getAllCustomers' });
        var users = allResult.customers || [];
        if (users.length === 0) {
          replyText = '📊 ยังไม่มีลูกค้าในระบบ';
        } else {
          let summary = '📊 สรุปแต้มลูกค้า (' + users.length + ' คน)\n\n';
          let totalPoints = 0;
          for (var i = 0; i < users.length && i < 20; i++) {
            var u = users[i];
            totalPoints += Number(u.points);
            var name = u.name || 'ไม่ทราบชื่อ';
            summary += (i + 1) + '. ' + name + '\n   แต้ม: ' + u.points + ' | รวมสะสม: ' + u.totalEarned + ' | แลกแล้ว: ' + u.redeemed + ' ครั้ง\n';
          }
          if (users.length > 20) summary += '...(แสดง 20 คนแรก)\n';
          summary += '\n🏆 แต้มรวมทั้งระบบ: ' + totalPoints;
          replyText = summary;
        }
      } catch (e) {
        console.error('Error checking:', e);
        replyText = '❌ เกิดข้อผิดพลาดในการดึงข้อมูล';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งพนักงาน: สรุป:1234 หรือ สรุป:1234:14/11/2026 =====
  const summaryMatch = msg.match(/^สรุป[:\s](\d{4})(?:[:\s](\d{1,2})\/(\d{1,2})\/(\d{4}))?$/);
  if (summaryMatch) {
    const pin = summaryMatch[1];
    if (pin !== ADMIN_PIN) {
      replyText = '❌ รหัสไม่ถูกต้อง';
    } else {
      try {
        var dateStr = null;
        if (summaryMatch[2] && summaryMatch[3] && summaryMatch[4]) {
          dateStr = summaryMatch[2].padStart(2, '0') + '/' + summaryMatch[3].padStart(2, '0') + '/' + summaryMatch[4];
        }
        var s = await callSheetAPI({ action: 'getDailySummary', date: dateStr });

        var text = '📋 สรุปยอดประจำวัน\n';
        text += '📅 วันที่: ' + s.date + '\n';
        text += '━━━━━━━━━━━━━━━\n';
        text += '🧾 จำนวนบิล: ' + s.billCount + ' บิล\n';
        if (s.bills && s.bills.length > 0) {
          text += '📝 เลขที่บิล:\n';
          for (var b = 0; b < s.bills.length; b++) {
            text += '   ' + (b + 1) + '. ' + s.bills[b].billNo + ' (' + s.bills[b].points + ' แต้ม)\n';
          }
        }
        text += '━━━━━━━━━━━━━━━\n';
        text += '☕ แต้มที่ให้ทั้งหมด: ' + s.totalPoints + ' แต้ม\n';
        text += '✅ รหัสที่ใช้แล้ว: ' + s.usedCodes + ' รหัส\n';
        text += '⏳ รหัสยังไม่ได้ใช้: ' + s.unusedCodes + ' รหัส\n';
        text += '━━━━━━━━━━━━━━━\n';
        text += '🎁 จำนวนแลกฟรี: ' + s.redeemCount + ' ครั้ง\n';
        if (s.redeemNames && s.redeemNames.length > 0) {
          text += '👤 ผู้แลก: ' + s.redeemNames.join(', ') + '\n';
        }
        if (s.billCount === 0 && s.redeemCount === 0) {
          text += '\n💤 ไม่มีรายการในวันนี้';
        }
        replyText = text;
      } catch (e) {
        console.error('Error summary:', e);
        replyText = '❌ เกิดข้อผิดพลาดในการดึงข้อมูล';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งพนักงาน: ยืนยัน:1234:R-A7X92K =====
  var verifyMatch = msg.match(/^ยืนยัน[:\s](\d{4})[:\s](R-[A-Za-z0-9]{6})$/i);
  if (verifyMatch) {
    var pin4 = verifyMatch[1];
    var rCode = verifyMatch[2].toUpperCase();
    if (pin4 !== ADMIN_PIN) {
      replyText = '❌ รหัสไม่ถูกต้อง';
    } else {
      var vResult = await verifyRedeem(rCode);
      if (vResult.error === 'not_found') {
        replyText = '❌ ไม่พบรหัสแลก ' + rCode + '\n\n⚠️ อาจเป็นรหัสปลอม!';
      } else if (vResult.error === 'already_confirmed') {
        replyText = '⚠️ รหัส ' + rCode + ' ถูกยืนยันไปแล้ว!\n\n👤 ชื่อ: ' + (vResult.redeem.name || 'ไม่ทราบ') + '\n\n❌ ไม่สามารถใช้ซ้ำได้';
      } else if (vResult.success) {
        replyText = '✅ ยืนยันสำเร็จ! รหัส ' + rCode + '\n\n👤 ชื่อลูกค้า: ' + (vResult.redeem.name || 'ไม่ทราบ') + '\n\n☕ ให้เครื่องดื่มฟรี 1 แก้วได้เลย!';
      } else {
        replyText = '❌ เกิดข้อผิดพลาด กรุณาลองใหม่';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งลูกค้า: สะสม:A7X92K =====
  const redeemCodeMatch = msg.match(/^สะสม[:\s]([A-Za-z0-9]{6})$/);
  if (redeemCodeMatch) {
    const code = redeemCodeMatch[1];
    const result = await useCode(code, userId);

    if (result.error === 'not_found') {
      replyText = '❌ ไม่พบรหัสนี้ กรุณาตรวจสอบอีกครั้ง';
    } else if (result.error === 'already_used') {
      replyText = '❌ รหัสนี้ถูกใช้ไปแล้ว';
    } else if (result.error === 'expired') {
      replyText = '❌ รหัสนี้หมดอายุแล้ว กรุณาขอรหัสใหม่จากพนักงาน';
    } else if (result.error) {
      replyText = '❌ เกิดข้อผิดพลาด กรุณาลองใหม่';
    } else {
      const user = await addPoints(userId, result.points);
      updateUserName(userId); // ไม่ต้อง await
      const remaining = REDEEM_COST - user.points;

      if (user.points >= REDEEM_COST) {
        replyText = '✅ สะสม ' + result.points + ' แต้ม สำเร็จ!\n\n🎯 แต้มสะสม: ' + user.points + ' แต้ม\n🎉 แลกเครื่องดื่มฟรีได้!\n\nพิมพ์ "แลก" เพื่อใช้สิทธิ์';
      } else {
        replyText = '✅ สะสม ' + result.points + ' แต้ม สำเร็จ!\n\n🎯 แต้มสะสม: ' + user.points + ' แต้ม\n📍 อีก ' + remaining + ' แต้มแลกเครื่องดื่มฟรี!';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งลูกค้าทั่วไป =====
  if (msg === 'แต้ม' || msg === 'คะแนน' || msg === 'points') {
    const user = await getPoints(userId);
    updateUserName(userId);
    const remaining = REDEEM_COST - user.points;
    if (user.points >= REDEEM_COST) {
      replyText = '🎯 แต้มสะสม: ' + user.points + ' แต้ม\n🏆 รวมทั้งหมด: ' + user.totalEarned + ' แต้ม\n🎁 แลกไปแล้ว: ' + user.redeemed + ' ครั้ง\n\n🎉 พิมพ์ "แลก" เพื่อใช้สิทธิ์!';
    } else {
      replyText = '🎯 แต้มสะสม: ' + user.points + ' แต้ม\n🏆 รวมทั้งหมด: ' + user.totalEarned + ' แต้ม\n🎁 แลกไปแล้ว: ' + user.redeemed + ' ครั้ง\n\n📍 อีก ' + remaining + ' แต้มแลกฟรี!';
    }
  } else if (msg === 'แลก' || msg === 'redeem') {
    var redeemResult = await redeemPoints(userId, REDEEM_COST);
    if (redeemResult) {
      replyText = '🎉🎉🎉 แลกสำเร็จ! 🎉🎉🎉\n\n☕ เครื่องดื่มฟรี 1 แก้ว!\n🔑 รหัสยืนยัน: ' + redeemResult.redeemCode + '\n🎯 แต้มคงเหลือ: ' + redeemResult.user.points + ' แต้ม\n\n📌 แสดงรหัสยืนยันให้พนักงาน';
    } else {
      var user4 = await getPoints(userId);
      replyText = '❌ แต้มยังไม่ครบ\n\n🎯 แต้มสะสม: ' + user4.points + ' แต้ม\n📍 ต้องสะสมอีก ' + (REDEEM_COST - user4.points) + ' แต้ม';
    }
  } else if (msg === 'เมนู' || msg === 'menu') {
    replyText = 'เนื่องจากเป็นโปรโมชั่นพิเศษ\n☕ เมนูที่แลกได้เฉพาะ Inthanin Coffee มัยลาภเท่านั้น\n\nอเมริกาโน่\nเอสเพรสโซ่\nโกโก้\nชาเขียว\nชาไทย\nชามะนาว\nออลเดย์\nชาดำ\n\n📍 สะสม 1 แต้มต่อ 1 แก้ว!';
  } else if (msg === 'help' || msg === 'ช่วยเหลือ') {
    replyText = '🤖 คำสั่งที่ใช้ได้:\n\n🎫 "สะสม:รหัส" - ใช้รหัสสะสมแต้ม\n🎯 "แต้ม" - เช็คแต้มสะสม\n🎁 "แลก" - แลกเครื่องดื่มฟรี (ครบ ' + REDEEM_COST + ' แต้ม)\n📋 "เมนู" - ดูเมนูเครื่องดื่ม\n❓ "ช่วยเหลือ" - ดูคำสั่งทั้งหมด';
  } else {
    var faqAnswer = findFAQAnswer(msg);
    if (faqAnswer) {
      replyText = faqAnswer;
    } else {
      replyText = 'สวัสดีค่ะ! ยินดีต้อนรับสู่ Inthanin Cafe ☕\n\n🎯 สะสมครบ ' + REDEEM_COST + ' แต้ม แลกเครื่องดื่มฟรี!\n\nพิมพ์ "เมนู" ดูเมนู\nพิมพ์ "แต้ม" เช็คแต้มสะสม\nพิมพ์ "ช่วยเหลือ" ดูคำสั่งทั้งหมด';
    }
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

app.get('/', (req, res) => { res.send('Inthanin Cafe LINE Bot is running!'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Bot running on port ' + PORT); });
