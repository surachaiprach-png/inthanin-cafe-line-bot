const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const config = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

const client = new line.Client(config);
const app = express();

// ===== ตั้งค่า =====
const DB_FILE = path.join(__dirname, 'points.json');
const CODES_FILE = path.join(__dirname, 'codes.json');
const BILLS_FILE = path.join(__dirname, 'bills.json');
const REDEEMS_FILE = path.join(__dirname, 'redeems.json');
const ADMIN_PIN = '1234';
const CODE_EXPIRE_MINUTES = 1440;
const REDEEM_COST = 15;

// ===== ระบบเก็บแต้ม =====
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('Error loading DB:', e); }
  return {};
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getPoints(userId) {
  const db = loadDB();
  if (!db[userId]) {
    db[userId] = { points: 0, totalEarned: 0, redeemed: 0, name: '' };
    saveDB(db);
  }
  return db[userId];
}

function addPoints(userId, count) {
  const db = loadDB();
  if (!db[userId]) db[userId] = { points: 0, totalEarned: 0, redeemed: 0, name: '' };
  db[userId].points += count;
  db[userId].totalEarned += count;
  saveDB(db);
  return db[userId];
}

async function updateUserName(userId) {
  try {
    const profile = await client.getProfile(userId);
    const db = loadDB();
    if (db[userId]) {
      db[userId].name = profile.displayName;
      saveDB(db);
    }
  } catch (e) { console.error('Error getting profile:', e); }
}

function redeemPoints(userId, cost) {
  const db = loadDB();
  if (!db[userId] || db[userId].points < cost) return null;
  db[userId].points -= cost;
  db[userId].redeemed += 1;
  saveDB(db);
  var redeemCode = logRedeem(userId, cost, db[userId].name);
  return { user: db[userId], redeemCode: redeemCode };
}

// ===== ระบบบันทึกการแลก =====
function loadRedeems() {
  try {
    if (fs.existsSync(REDEEMS_FILE)) return JSON.parse(fs.readFileSync(REDEEMS_FILE, 'utf8'));
  } catch (e) { console.error('Error loading redeems:', e); }
  return [];
}

function saveRedeems(data) {
  fs.writeFileSync(REDEEMS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function generateRedeemCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = 'R-';
  for (var i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function logRedeem(userId, cost, name) {
  const redeems = loadRedeems();
  var redeemCode;
  do {
    redeemCode = generateRedeemCode();
  } while (redeems.some(function(r) { return r.redeemCode === redeemCode; }));

  redeems.push({
    redeemCode: redeemCode,
    userId: userId,
    name: name || '',
    cost: cost,
    redeemedAt: new Date().toISOString(),
    confirmed: false,
  });
  saveRedeems(redeems);
  return redeemCode;
}

function verifyRedeem(redeemCode) {
  var redeems = loadRedeems();
  var found = null;
  for (var i = 0; i < redeems.length; i++) {
    if (redeems[i].redeemCode === redeemCode.toUpperCase()) {
      found = redeems[i];
      if (found.confirmed) {
        return { error: 'already_confirmed', redeem: found };
      }
      redeems[i].confirmed = true;
      redeems[i].confirmedAt = new Date().toISOString();
      saveRedeems(redeems);
      return { success: true, redeem: found };
    }
  }
  return { error: 'not_found' };
}

// ===== ระบบสรุปยอดประจำวัน =====
function getDateString(date) {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return dd + '/' + mm + '/' + yyyy;
}

function isSameDate(isoString, targetDate) {
  const d = new Date(isoString);
  return d.getFullYear() === targetDate.getFullYear() &&
    d.getMonth() === targetDate.getMonth() &&
    d.getDate() === targetDate.getDate();
}

function getDailySummary(targetDate) {
  const bills = loadBills();
  const codes = loadCodes();
  const redeems = loadRedeems();
  const db = loadDB();

  const dayBills = [];
  let totalPoints = 0;
  for (const billNo of Object.keys(bills)) {
    if (isSameDate(bills[billNo].createdAt, targetDate)) {
      dayBills.push({ billNo: billNo, points: bills[billNo].points, code: bills[billNo].code });
      totalPoints += bills[billNo].points;
    }
  }

  let usedCodes = 0;
  let unusedCodes = 0;
  for (const code of Object.keys(codes)) {
    if (isSameDate(codes[code].createdAt, targetDate)) {
      if (codes[code].used) { usedCodes++; } else { unusedCodes++; }
    }
  }

  const dayRedeems = redeems.filter(function(r) { return isSameDate(r.redeemedAt, targetDate); });

  const dayNewCustomers = [];
  for (const code of Object.keys(codes)) {
    if (codes[code].used && codes[code].usedAt && isSameDate(codes[code].usedAt, targetDate)) {
      const uid = codes[code].usedBy;
      if (db[uid] && db[uid].totalEarned <= codes[code].points) {
        dayNewCustomers.push(db[uid].name || 'ไม่ทราบชื่อ');
      }
    }
  }

  return {
    date: getDateString(targetDate),
    billCount: dayBills.length,
    bills: dayBills,
    totalPoints: totalPoints,
    usedCodes: usedCodes,
    unusedCodes: unusedCodes,
    redeemCount: dayRedeems.length,
    redeemNames: dayRedeems.map(function(r) { return r.name || 'ไม่ทราบชื่อ'; }),
    newCustomers: dayNewCustomers,
  };
}

// ===== ระบบรหัสสะสมแต้ม (One-time Code) =====
function loadCodes() {
  try {
    if (fs.existsSync(CODES_FILE)) return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  } catch (e) { console.error('Error loading codes:', e); }
  return {};
}

function saveCodes(data) {
  fs.writeFileSync(CODES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ===== ระบบเลขบิล =====
function loadBills() {
  try {
    if (fs.existsSync(BILLS_FILE)) return JSON.parse(fs.readFileSync(BILLS_FILE, 'utf8'));
  } catch (e) { console.error('Error loading bills:', e); }
  return {};
}

function saveBills(data) {
  fs.writeFileSync(BILLS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isBillUsed(billNo) {
  const bills = loadBills();
  return !!bills[billNo];
}

function saveBill(billNo, code, points, staffId) {
  const bills = loadBills();
  bills[billNo] = {
    code: code,
    points: points,
    createdBy: staffId,
    createdAt: new Date().toISOString(),
  };
  saveBills(bills);
}

function createCode(staffId, pointsAmount, billNo) {
  const codes = loadCodes();
  let code;
  do {
    code = generateCode();
  } while (codes[code]);

  codes[code] = {
    points: pointsAmount,
    billNo: billNo,
    createdBy: staffId,
    createdAt: new Date().toISOString(),
    used: false,
  };
  saveCodes(codes);
  saveBill(billNo, code, pointsAmount, staffId);
  return code;
}

function useCode(code, userId) {
  const codes = loadCodes();
  const upperCode = code.toUpperCase();

  if (!codes[upperCode]) return { error: 'not_found' };
  if (codes[upperCode].used) return { error: 'already_used' };

  const created = new Date(codes[upperCode].createdAt);
  const now = new Date();
  const diffMinutes = (now - created) / (1000 * 60);
  if (diffMinutes > CODE_EXPIRE_MINUTES) return { error: 'expired' };

  codes[upperCode].used = true;
  codes[upperCode].usedBy = userId;
  codes[upperCode].usedAt = new Date().toISOString();
  saveCodes(codes);

  return { success: true, points: codes[upperCode].points };
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
    } else if (isBillUsed(billNo)) {
      replyText = '❌ บิลเลขที่ ' + billNo + ' ถูกใช้ไปแล้ว!';
    } else {
      const code = createCode(userId, count, billNo);
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
      const db = loadDB();
      const users = Object.keys(db);
      if (users.length === 0) {
        replyText = '📊 ยังไม่มีลูกค้าในระบบ';
      } else {
        let summary = '📊 สรุปแต้มลูกค้า (' + users.length + ' คน)\n\n';
        let totalPoints = 0;
        let i = 1;
        for (const uid of users) {
          const u = db[uid];
          totalPoints += u.points;
          const name = u.name || 'ไม่ทราบชื่อ';
          summary += i + '. ' + name + '\n   แต้ม: ' + u.points + ' | รวมสะสม: ' + u.totalEarned + ' | แลกแล้ว: ' + u.redeemed + ' ครั้ง\n';
          i++;
          if (i > 20) { summary += '...(แสดง 20 คนแรก)\n'; break; }
        }
        summary += '\n🏆 แต้มรวมทั้งระบบ: ' + totalPoints;
        replyText = summary;
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
      var targetDate;
      if (summaryMatch[2] && summaryMatch[3] && summaryMatch[4]) {
        var dd = parseInt(summaryMatch[2]);
        var mm = parseInt(summaryMatch[3]) - 1;
        var yyyy = parseInt(summaryMatch[4]);
        targetDate = new Date(yyyy, mm, dd);
      } else {
        targetDate = new Date();
      }

      var s = getDailySummary(targetDate);

      var text = '📋 สรุปยอดประจำวัน\n';
      text += '📅 วันที่: ' + s.date + '\n';
      text += '━━━━━━━━━━━━━━━\n';
      text += '🧾 จำนวนบิล: ' + s.billCount + ' บิล\n';
      if (s.bills.length > 0) {
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
      if (s.redeemNames.length > 0) {
        text += '👤 ผู้แลก: ' + s.redeemNames.join(', ') + '\n';
      }
      if (s.newCustomers.length > 0) {
        text += '🆕 ลูกค้าใหม่: ' + s.newCustomers.length + ' คน (' + s.newCustomers.join(', ') + ')\n';
      }

      if (s.billCount === 0 && s.redeemCount === 0) {
        text += '\n💤 ไม่มีรายการในวันนี้';
      }

      replyText = text;
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
      var vResult = verifyRedeem(rCode);
      if (vResult.error === 'not_found') {
        replyText = '❌ ไม่พบรหัสแลก ' + rCode + '\n\n⚠️ อาจเป็นรหัสปลอม!';
      } else if (vResult.error === 'already_confirmed') {
        replyText = '⚠️ รหัส ' + rCode + ' ถูกยืนยันไปแล้ว!\n\n👤 ชื่อ: ' + (vResult.redeem.name || 'ไม่ทราบ') + '\n🕐 แลกเมื่อ: ' + vResult.redeem.redeemedAt.replace('T', ' ').substring(0, 19) + '\n\n❌ ไม่สามารถใช้ซ้ำได้';
      } else {
        replyText = '✅ ยืนยันสำเร็จ! รหัส ' + rCode + '\n\n👤 ชื่อลูกค้า: ' + (vResult.redeem.name || 'ไม่ทราบ') + '\n🕐 แลกเมื่อ: ' + vResult.redeem.redeemedAt.replace('T', ' ').substring(0, 19) + '\n\n☕ ให้เครื่องดื่มฟรี 1 แก้วได้เลย!';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== คำสั่งลูกค้า: สะสม:A7X92K =====
  const redeemCodeMatch = msg.match(/^สะสม[:\s]([A-Za-z0-9]{6})$/);
  if (redeemCodeMatch) {
    const code = redeemCodeMatch[1];
    const result = useCode(code, userId);

    if (result.error === 'not_found') {
      replyText = '❌ ไม่พบรหัสนี้ กรุณาตรวจสอบอีกครั้ง';
    } else if (result.error === 'already_used') {
      replyText = '❌ รหัสนี้ถูกใช้ไปแล้ว';
    } else if (result.error === 'expired') {
      replyText = '❌ รหัสนี้หมดอายุแล้ว กรุณาขอรหัสใหม่จากพนักงาน';
    } else {
      const user = addPoints(userId, result.points);
      updateUserName(userId);
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
    const user = getPoints(userId);
    updateUserName(userId);
    const remaining = REDEEM_COST - user.points;
    if (user.points >= REDEEM_COST) {
      replyText = '🎯 แต้มสะสม: ' + user.points + ' แต้ม\n🏆 รวมทั้งหมด: ' + user.totalEarned + ' แต้ม\n🎁 แลกไปแล้ว: ' + user.redeemed + ' ครั้ง\n\n🎉 พิมพ์ "แลก" เพื่อใช้สิทธิ์!';
    } else {
      replyText = '🎯 แต้มสะสม: ' + user.points + ' แต้ม\n🏆 รวมทั้งหมด: ' + user.totalEarned + ' แต้ม\n🎁 แลกไปแล้ว: ' + user.redeemed + ' ครั้ง\n\n📍 อีก ' + remaining + ' แต้มแลกฟรี!';
    }
  } else if (msg === 'แลก' || msg === 'redeem') {
    var redeemResult = redeemPoints(userId, REDEEM_COST);
    if (redeemResult) {
      replyText = '🎉🎉🎉 แลกสำเร็จ! 🎉🎉🎉\n\n☕ เครื่องดื่มฟรี 1 แก้ว!\n🔑 รหัสยืนยัน: ' + redeemResult.redeemCode + '\n🎯 แต้มคงเหลือ: ' + redeemResult.user.points + ' แต้ม\n\n📌 แสดงรหัสยืนยันให้พนักงาน';
    } else {
      var user4 = getPoints(userId);
      replyText = '❌ แต้มยังไม่ครบ\n\n🎯 แต้มสะสม: ' + user4.points + ' แต้ม\n📍 ต้องสะสมอีก ' + (REDEEM_COST - user4.points) + ' แต้ม';
    }
  } else if (msg === 'เมนู' || msg === 'menu') {
    replyText = 'เนื่องจากเป็นโปรโมชั่นพิเศษ\n\u2615 เมนูที่แลกได้เฉพาะ Inthanin Coffee มัยลาภเท่านั้น\n\nอเมริกาโน่\nเอสเพรสโซ่\nโกโก้\nชาเขียว\nชาไทย\nชามะนาว\nออลเดย์\nชาดำ\n\n\ud83d\udccd สะสม 1 แต้มต่อ 1 แก้ว!';
  } else if (msg === 'help' || msg === 'ช่วยเหลือ') {
    replyText = '🤖 คำสั่งที่ใช้ได้:\n\n🎫 "สะสม:รหัส" - ใช้รหัสสะสมแต้ม\n🎯 "แต้ม" - เช็คแต้มสะสม\n🎁 "แลก" - แลกเครื่องดื่มฟรี (ครบ ' + REDEEM_COST + ' แต้ม)\n📋 "เมนู" - ดูเมนูเครื่องดื่ม\n❓ "ช่วยเหลือ" - ดูคำสั่งทั้งหมด';
  } else {
    replyText = 'สวัสดีค่ะ! ยินดีต้อนรับสู่ Inthanin Cafe ☕\n\n🎯 สะสมครบ ' + REDEEM_COST + ' แต้ม แลกเครื่องดื่มฟรี!\n\nพิมพ์ "เมนู" ดูเมนู\nพิมพ์ "แต้ม" เช็คแต้มสะสม\nพิมพ์ "ช่วยเหลือ" ดูคำสั่งทั้งหมด';
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

app.get('/', (req, res) => { res.send('Inthanin Cafe LINE Bot is running!'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Bot running on port ' + PORT); });
