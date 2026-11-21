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
const SHEET_API_URL = process.env.SHEET_API_URL || '';

// ===== เวลาไทย (UTC+7) =====
function getBangkokISO() {
  var now = new Date();
  var utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  var bkk = new Date(utc + (7 * 3600000));
  var yyyy = bkk.getFullYear();
  var mm = String(bkk.getMonth() + 1).padStart(2, '0');
  var dd = String(bkk.getDate()).padStart(2, '0');
  var hh = String(bkk.getHours()).padStart(2, '0');
  var mi = String(bkk.getMinutes()).padStart(2, '0');
  var ss = String(bkk.getSeconds()).padStart(2, '0');
  return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mi + ':' + ss;
}

// ===== ฟังก์ชันเรียก API =====
function callSheetAPI(body) {
  return new Promise(function(resolve, reject) {
    if (!SHEET_API_URL) {
      reject(new Error('SHEET_API_URL not configured'));
      return;
    }
    var postData = JSON.stringify(body);

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
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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
  for (var i = 0; i < faqData.length; i++) {
    if (faqData[i].q === q) return faqData[i].a;
  }
  for (var j = 0; j < faqData.length; j++) {
    if (q.indexOf(faqData[j].q) !== -1 || faqData[j].q.indexOf(q) !== -1) return faqData[j].a;
  }
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
const REDEEM_COST_WALKIN = 10;  // หน้าร้าน 10 แต้ม
const REDEEM_COST_ONLINE = 15;  // ออนไลน์ 15 แต้ม

// ===== ระบบเก็บแต้ม V2 (แยก walkin/online) =====
async function getPoints(userId) {
  try {
    var result = await callSheetAPI({ action: 'getCustomer', userId: userId });
    if (!result.found) {
      await callSheetAPI({ action: 'setCustomer', userId: userId, data: {
        pointsWalkin: 0, pointsOnline: 0,
        totalWalkin: 0, totalOnline: 0,
        redeemedWalkin: 0, redeemedOnline: 0,
        name: ''
      }});
      return { pointsWalkin: 0, pointsOnline: 0, totalWalkin: 0, totalOnline: 0, redeemedWalkin: 0, redeemedOnline: 0, name: '' };
    }
    return {
      pointsWalkin: Number(result.pointsWalkin) || 0,
      pointsOnline: Number(result.pointsOnline) || 0,
      totalWalkin: Number(result.totalWalkin) || 0,
      totalOnline: Number(result.totalOnline) || 0,
      redeemedWalkin: Number(result.redeemedWalkin) || 0,
      redeemedOnline: Number(result.redeemedOnline) || 0,
      name: result.name || ''
    };
  } catch (e) {
    console.error('Error getPoints:', e);
    return { pointsWalkin: 0, pointsOnline: 0, totalWalkin: 0, totalOnline: 0, redeemedWalkin: 0, redeemedOnline: 0, name: '' };
  }
}

async function addPoints(userId, count, channel) {
  try {
    var user = await getPoints(userId);
    var updateData = {};
    if (channel === 'online') {
      updateData.pointsOnline = user.pointsOnline + count;
      updateData.totalOnline = user.totalOnline + count;
    } else {
      updateData.pointsWalkin = user.pointsWalkin + count;
      updateData.totalWalkin = user.totalWalkin + count;
    }
    await callSheetAPI({ action: 'setCustomer', userId: userId, data: updateData });
    // คืนค่าอัปเดตแล้ว
    if (channel === 'online') {
      user.pointsOnline += count;
      user.totalOnline += count;
    } else {
      user.pointsWalkin += count;
      user.totalWalkin += count;
    }
    return user;
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

async function redeemPoints(userId, channel) {
  try {
    var user = await getPoints(userId);
    var cost = channel === 'online' ? REDEEM_COST_ONLINE : REDEEM_COST_WALKIN;
    var currentPoints = channel === 'online' ? user.pointsOnline : user.pointsWalkin;

    if (currentPoints < cost) return null;

    var updateData = {};
    if (channel === 'online') {
      updateData.pointsOnline = user.pointsOnline - cost;
      updateData.redeemedOnline = user.redeemedOnline + 1;
    } else {
      updateData.pointsWalkin = user.pointsWalkin - cost;
      updateData.redeemedWalkin = user.redeemedWalkin + 1;
    }
    await callSheetAPI({ action: 'setCustomer', userId: userId, data: updateData });

    var redeemCode = await generateUniqueRedeemCode();
    await callSheetAPI({ action: 'addRedeem', data: {
      redeemCode: redeemCode,
      userId: userId,
      name: user.name || '',
      cost: cost,
      redeemedAt: getBangkokISO(),
      channel: channel
    }});

    // คืนค่าอัปเดตแล้ว
    if (channel === 'online') {
      user.pointsOnline -= cost;
      user.redeemedOnline += 1;
    } else {
      user.pointsWalkin -= cost;
      user.redeemedWalkin += 1;
    }
    return { user: user, redeemCode: redeemCode, channel: channel };
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
  return code;
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

async function createCode(staffId, pointsAmount, billNo, channel) {
  var code = await generateUniqueCode();
  var now = getBangkokISO();
  await callSheetAPI({ action: 'setCode', code: code, data: {
    points: pointsAmount,
    billNo: billNo,
    createdBy: staffId,
    createdAt: now,
    used: false,
    channel: channel
  }});
  await callSheetAPI({ action: 'setBill', billNo: billNo, data: {
    code: code,
    points: pointsAmount,
    createdBy: staffId,
    createdAt: now,
    channel: channel
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
      usedAt: getBangkokISO()
    }});
    var channel = String(result.channel || 'walkin');
    return { success: true, points: Number(result.points), channel: channel };
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
  // ===== Follow Event: ลูกค้าเพิ่มเพื่อน =====
  if (event.type === 'follow') {
    const userId = event.source.userId;
    try {
      var profile = await client.getProfile(userId);
      var customerName = profile.displayName || '';
      // บันทึกลูกค้าใหม่ลง Google Sheet (ถ้ายังไม่มี)
      var existing = await getPoints(userId);
      if (!existing || (!existing.pointsWalkin && !existing.pointsOnline && !existing.totalWalkin && !existing.totalOnline)) {
        await callSheetAPI({
          action: 'setCustomer',
          userId: userId,
          data: {
            name: customerName,
            pointsWalkin: 0,
            pointsOnline: 0,
            totalWalkin: 0,
            totalOnline: 0,
            redeemedWalkin: 0,
            redeemedOnline: 0
          }
        });
        console.log('New follower registered: ' + customerName + ' (' + userId + ')');
      }
    } catch (e) {
      console.error('Error handling follow event:', e);
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'สวัสดีค่ะ! ยินดีต้อนรับสู่ Inthanin Cafe ☕\n\n🏪 หน้าร้าน: สะสมครบ 10 แต้ม แลกฟรี!\n🛒 ออนไลน์: สะสมครบ 15 แต้ม แลกฟรี!\n\nพิมพ์ "เมนู" ดูเมนู\nพิมพ์ "แต้ม" เช็คแต้มสะสม\nพิมพ์ "ช่วยเหลือ" ดูคำสั่งทั้งหมด'
    });
  }

  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  let replyText;

  // ===== คำสั่งพนักงาน: สร้าง:1234:00003:3 หรือ สร้าง:1234:00003:3:ร หรือ สร้าง:1234:00003:3:อ =====
  const createMatch = msg.match(/^สร้าง[:\s](\d{4})[:\s]([A-Za-z0-9\/]+)[:\s](\d+)(?:[:\s]([รอ]))?$/);
  if (createMatch) {
    const pin = createMatch[1];
    const billNo = createMatch[2];
    const count = parseInt(createMatch[3]);
    const chFlag = createMatch[4] || 'ร'; // ค่าเริ่มต้น = หน้าร้าน
    const channel = chFlag === 'อ' ? 'online' : 'walkin';
    const channelLabel = channel === 'online' ? '🛒 ออนไลน์' : '🏪 หน้าร้าน';

    if (pin !== ADMIN_PIN) {
      replyText = '❌ รหัสไม่ถูกต้อง';
    } else if (count < 1 || count > 20) {
      replyText = '❌ ใส่จำนวน 1-20 แก้ว';
    } else if (await isBillUsed(billNo)) {
      replyText = '❌ บิลเลขที่ ' + billNo + ' ถูกใช้ไปแล้ว!';
    } else {
      const code = await createCode(userId, count, billNo, channel);
      replyText = '✅ สร้างรหัสสำเร็จ!\n\n🎫 รหัส: ' + code + '\n🧾 บิล: ' + billNo + '\n☕ จำนวน: ' + count + ' แต้ม\n' + channelLabel + '\n⏰ หมดอายุใน 24 ชั่วโมง\n\nบอกรหัสนี้ให้ลูกค้า';
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
          let totalW = 0, totalO = 0;
          for (var i = 0; i < users.length && i < 20; i++) {
            var u = users[i];
            var pw = Number(u.pointsWalkin) || 0;
            var po = Number(u.pointsOnline) || 0;
            totalW += pw;
            totalO += po;
            var name = u.name || 'ไม่ทราบชื่อ';
            summary += (i + 1) + '. ' + name + '\n   🏪 ' + pw + ' | 🛒 ' + po + ' | แลก: ' + ((Number(u.redeemedWalkin) || 0) + (Number(u.redeemedOnline) || 0)) + ' ครั้ง\n';
          }
          if (users.length > 20) summary += '...(แสดง 20 คนแรก)\n';
          summary += '\n🏪 แต้มหน้าร้านรวม: ' + totalW;
          summary += '\n🛒 แต้มออนไลน์รวม: ' + totalO;
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
        if (s.billCountWalkin > 0 || s.billCountOnline > 0) {
          text += '   🏪 หน้าร้าน: ' + (s.billCountWalkin || 0) + ' บิล (' + (s.totalPointsWalkin || 0) + ' แต้ม)\n';
          text += '   🛒 ออนไลน์: ' + (s.billCountOnline || 0) + ' บิล (' + (s.totalPointsOnline || 0) + ' แต้ม)\n';
        }
        if (s.bills && s.bills.length > 0) {
          text += '📝 รายละเอียดบิล:\n';
          for (var b = 0; b < s.bills.length; b++) {
            var chIcon = s.bills[b].channel === 'online' ? '🛒' : '🏪';
            text += '   ' + (b + 1) + '. ' + s.bills[b].billNo + ' (' + s.bills[b].points + ' แต้ม) ' + chIcon + '\n';
          }
        }
        text += '━━━━━━━━━━━━━━━\n';
        text += '☕ แต้มที่ให้ทั้งหมด: ' + s.totalPoints + ' แต้ม\n';
        text += '✅ รหัสที่ใช้แล้ว: ' + s.usedCodes + ' รหัส\n';
        text += '⏳ รหัสยังไม่ได้ใช้: ' + s.unusedCodes + ' รหัส\n';
        text += '━━━━━━━━━━━━━━━\n';
        text += '🎁 จำนวนแลกฟรี: ' + s.redeemCount + ' ครั้ง\n';
        if ((s.redeemCountWalkin || 0) > 0 || (s.redeemCountOnline || 0) > 0) {
          text += '   🏪 หน้าร้าน: ' + (s.redeemCountWalkin || 0) + ' ครั้ง\n';
          text += '   🛒 ออนไลน์: ' + (s.redeemCountOnline || 0) + ' ครั้ง\n';
        }
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
        var chLabel2 = String(vResult.redeem.channel || 'walkin') === 'online' ? '🛒 ออนไลน์' : '🏪 หน้าร้าน';
        replyText = '⚠️ รหัส ' + rCode + ' ถูกยืนยันไปแล้ว!\n\n👤 ชื่อ: ' + (vResult.redeem.name || 'ไม่ทราบ') + '\n' + chLabel2 + '\n\n❌ ไม่สามารถใช้ซ้ำได้';
      } else if (vResult.success) {
        var chLabel3 = String(vResult.redeem.channel || 'walkin') === 'online' ? '🛒 ออนไลน์' : '🏪 หน้าร้าน';
        replyText = '✅ ยืนยันสำเร็จ! รหัส ' + rCode + '\n\n👤 ชื่อลูกค้า: ' + (vResult.redeem.name || 'ไม่ทราบ') + '\n' + chLabel3 + '\n\n☕ ให้เครื่องดื่มฟรี 1 แก้วได้เลย!';
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
      var ch = result.channel || 'walkin';
      const user = await addPoints(userId, result.points, ch);
      updateUserName(userId); // ไม่ต้อง await

      var chLabel = ch === 'online' ? '🛒 ออนไลน์' : '🏪 หน้าร้าน';
      var currentPts = ch === 'online' ? user.pointsOnline : user.pointsWalkin;
      var redeemCost = ch === 'online' ? REDEEM_COST_ONLINE : REDEEM_COST_WALKIN;
      var remaining = redeemCost - currentPts;

      if (currentPts >= redeemCost) {
        replyText = '✅ สะสม ' + result.points + ' แต้ม สำเร็จ! ' + chLabel + '\n\n🎯 แต้ม' + (ch === 'online' ? 'ออนไลน์' : 'หน้าร้าน') + ': ' + currentPts + ' แต้ม\n🎉 แลกเครื่องดื่มฟรีได้!\n\nพิมพ์ "' + (ch === 'online' ? 'แลกอ' : 'แลก') + '" เพื่อใช้สิทธิ์';
      } else {
        replyText = '✅ สะสม ' + result.points + ' แต้ม สำเร็จ! ' + chLabel + '\n\n🎯 แต้ม' + (ch === 'online' ? 'ออนไลน์' : 'หน้าร้าน') + ': ' + currentPts + ' แต้ม\n📍 อีก ' + remaining + ' แต้มแลกเครื่องดื่มฟรี!';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งลูกค้า: แต้ม =====
  if (msg === 'แต้ม' || msg === 'คะแนน' || msg === 'points') {
    const user = await getPoints(userId);
    updateUserName(userId);
    var remainW = REDEEM_COST_WALKIN - user.pointsWalkin;
    var remainO = REDEEM_COST_ONLINE - user.pointsOnline;
    var totalRedeemed = user.redeemedWalkin + user.redeemedOnline;

    replyText = '🎯 แต้มสะสมของคุณ\n\n';
    // หน้าร้าน
    replyText += '🏪 หน้าร้าน: ' + user.pointsWalkin + ' แต้ม';
    if (user.pointsWalkin >= REDEEM_COST_WALKIN) {
      replyText += ' 🎉 แลกได้!';
    } else {
      replyText += ' (อีก ' + remainW + ' แลกฟรี)';
    }
    replyText += '\n';
    // ออนไลน์
    replyText += '🛒 ออนไลน์: ' + user.pointsOnline + ' แต้ม';
    if (user.pointsOnline >= REDEEM_COST_ONLINE) {
      replyText += ' 🎉 แลกได้!';
    } else {
      replyText += ' (อีก ' + remainO + ' แลกฟรี)';
    }
    replyText += '\n\n';
    replyText += '🏆 รวมสะสม: ' + (user.totalWalkin + user.totalOnline) + ' แต้ม\n';
    replyText += '🎁 แลกไปแล้ว: ' + totalRedeemed + ' ครั้ง';

    if (user.pointsWalkin >= REDEEM_COST_WALKIN || user.pointsOnline >= REDEEM_COST_ONLINE) {
      replyText += '\n\n';
      if (user.pointsWalkin >= REDEEM_COST_WALKIN) replyText += '👉 พิมพ์ "แลก" ใช้สิทธิ์หน้าร้าน\n';
      if (user.pointsOnline >= REDEEM_COST_ONLINE) replyText += '👉 พิมพ์ "แลกอ" ใช้สิทธิ์ออนไลน์';
    }
  }
  // ===== คำสั่งลูกค้า: แลก / แลกร / แลกอ =====
  else if (msg === 'แลก' || msg === 'แลกร' || msg === 'redeem') {
    // แลกแต้มหน้าร้าน
    var redeemResult = await redeemPoints(userId, 'walkin');
    if (redeemResult) {
      replyText = '🎉🎉🎉 แลกสำเร็จ! 🎉🎉🎉\n\n🏪 ช่องทาง: หน้าร้าน\n☕ เครื่องดื่มฟรี 1 แก้ว!\n🔑 รหัสยืนยัน: ' + redeemResult.redeemCode + '\n🎯 แต้มหน้าร้านคงเหลือ: ' + redeemResult.user.pointsWalkin + ' แต้ม\n\n📌 แสดงรหัสยืนยันให้พนักงาน';
    } else {
      var user4 = await getPoints(userId);
      replyText = '❌ แต้มหน้าร้านยังไม่ครบ\n\n🏪 แต้มหน้าร้าน: ' + user4.pointsWalkin + ' แต้ม\n📍 ต้องสะสมอีก ' + (REDEEM_COST_WALKIN - user4.pointsWalkin) + ' แต้ม (ครบ ' + REDEEM_COST_WALKIN + ' แลกฟรี)';
    }
  } else if (msg === 'แลกอ') {
    // แลกแต้มออนไลน์
    var redeemResult2 = await redeemPoints(userId, 'online');
    if (redeemResult2) {
      replyText = '🎉🎉🎉 แลกสำเร็จ! 🎉🎉🎉\n\n🛒 ช่องทาง: ออนไลน์\n☕ เครื่องดื่มฟรี 1 แก้ว!\n🔑 รหัสยืนยัน: ' + redeemResult2.redeemCode + '\n🎯 แต้มออนไลน์คงเหลือ: ' + redeemResult2.user.pointsOnline + ' แต้ม\n\n📌 แสดงรหัสยืนยันให้พนักงาน';
    } else {
      var user5 = await getPoints(userId);
      replyText = '❌ แต้มออนไลน์ยังไม่ครบ\n\n🛒 แต้มออนไลน์: ' + user5.pointsOnline + ' แต้ม\n📍 ต้องสะสมอีก ' + (REDEEM_COST_ONLINE - user5.pointsOnline) + ' แต้ม (ครบ ' + REDEEM_COST_ONLINE + ' แลกฟรี)';
    }
  }
  // ===== เมนู =====
  else if (msg === 'เมนู' || msg === 'menu') {
    replyText = 'เนื่องจากเป็นโปรโมชั่นพิเศษ\n☕ เมนูที่แลกได้เฉพาะ Inthanin Coffee มัยลาภเท่านั้น\n\nอเมริกาโน่\nเอสเพรสโซ่\nโกโก้\nชาเขียว\nชาไทย\nชามะนาว\nออลเดย์\nชาดำ\n\n🏪 หน้าร้าน: สะสมครบ ' + REDEEM_COST_WALKIN + ' แต้ม แลกฟรี!\n🛒 ออนไลน์: สะสมครบ ' + REDEEM_COST_ONLINE + ' แต้ม แลกฟรี!';
  }
  // ===== ช่วยเหลือ =====
  else if (msg === 'help' || msg === 'ช่วยเหลือ') {
    replyText = '🤖 คำสั่งลูกค้า:\n\n🎫 "สะสม:รหัส" - ใช้รหัสสะสมแต้ม\n🎯 "แต้ม" - เช็คแต้มสะสม\n🎁 "แลก" - แลกแต้มหน้าร้าน (' + REDEEM_COST_WALKIN + ' แต้ม)\n🎁 "แลกอ" - แลกแต้มออนไลน์ (' + REDEEM_COST_ONLINE + ' แต้ม)\n📋 "เมนู" - ดูเมนูเครื่องดื่ม\n❓ "ช่วยเหลือ" - ดูคำสั่งทั้งหมด';
  }
  // ===== FAQ / ข้อความทั่วไป =====
  else {
    var faqAnswer = findFAQAnswer(msg);
    if (faqAnswer) {
      replyText = faqAnswer;
    } else {
      replyText = 'สวัสดีค่ะ! ยินดีต้อนรับสู่ Inthanin Cafe ☕\n\n🏪 หน้าร้าน: สะสมครบ ' + REDEEM_COST_WALKIN + ' แต้ม แลกฟรี!\n🛒 ออนไลน์: สะสมครบ ' + REDEEM_COST_ONLINE + ' แต้ม แลกฟรี!\n\nพิมพ์ "เมนู" ดูเมนู\nพิมพ์ "แต้ม" เช็คแต้มสะสม\nพิมพ์ "ช่วยเหลือ" ดูคำสั่งทั้งหมด';
    }
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

app.get('/', (req, res) => { res.send('Inthanin Cafe LINE Bot V2 is running!'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Bot V2 running on port ' + PORT); });
