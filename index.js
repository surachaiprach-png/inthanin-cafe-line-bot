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

// ===== à¹à¸§à¸¥à¸²à¹à¸à¸¢ (UTC+7) =====
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

// ===== à¸à¸±à¸à¸à¹à¸à¸±à¸à¹à¸£à¸µà¸¢à¸ API =====
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

// à¹à¸«à¸¥à¸ FAQ à¸à¸¸à¸ 5 à¸à¸²à¸à¸µ
fetchFAQ();
setInterval(fetchFAQ, 5 * 60 * 1000);

// ===== à¸à¸±à¹à¸à¸à¹à¸² =====
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const CODE_EXPIRE_MINUTES = 1440; // 24 à¸à¸±à¹à¸§à¹à¸¡à¸
const REDEEM_COST_WALKIN = 10;  // à¸«à¸à¹à¸²à¸£à¹à¸²à¸ 10 à¹à¸à¹à¸¡
const REDEEM_COST_ONLINE = 15;  // à¸­à¸­à¸à¹à¸¥à¸à¹ 15 à¹à¸à¹à¸¡

// ===== à¸£à¸°à¸à¸à¹à¸à¹à¸à¹à¸à¹à¸¡ V2 (à¹à¸¢à¸ walkin/online) =====
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
    // à¸à¸·à¸à¸à¹à¸²à¸­à¸±à¸à¹à¸à¸à¹à¸¥à¹à¸§
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

    // à¸à¸·à¸à¸à¹à¸²à¸­à¸±à¸à¹à¸à¸à¹à¸¥à¹à¸§
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

// ===== à¸£à¸°à¸à¸à¸£à¸«à¸±à¸ª =====
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

    // à¹à¸à¹à¸à¸«à¸¡à¸à¸­à¸²à¸¢à¸¸
    var created = new Date(result.createdAt);
    var now = new Date();
    var diffMinutes = (now - created) / (1000 * 60);
    if (diffMinutes > CODE_EXPIRE_MINUTES) return { error: 'expired' };

    // à¹à¸à¹à¸£à¸«à¸±à¸ªà¸ªà¸³à¹à¸£à¹à¸
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
  // ===== Follow Event: à¸¥à¸¹à¸à¸à¹à¸²à¹à¸à¸´à¹à¸¡à¹à¸à¸·à¹à¸­à¸ =====
  if (event.type === 'follow') {
    const userId = event.source.userId;
    try {
      var profile = await client.getProfile(userId);
      var customerName = profile.displayName || '';
      // à¸à¸±à¸à¸à¸¶à¸à¸¥à¸¹à¸à¸à¹à¸²à¹à¸«à¸¡à¹à¸¥à¸ Google Sheet (à¸à¹à¸²à¸¢à¸±à¸à¹à¸¡à¹à¸¡à¸µ)
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
      text: 'à¸ªà¸§à¸±à¸ªà¸à¸µà¸à¹à¸ ! à¸¢à¸´à¸à¸à¸µà¸à¹à¸­à¸à¸£à¸±à¸à¸ªà¸¹à¹ Inthanin Cafe â\n\nðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸: à¸ªà¸°à¸ªà¸¡à¸à¸£à¸ 10 à¹à¸à¹à¸¡ à¹à¸¥à¸à¸à¸£à¸µ!\nð à¸­à¸­à¸à¹à¸¥à¸à¹: à¸ªà¸°à¸ªà¸¡à¸à¸£à¸ 15 à¹à¸à¹à¸¡ à¹à¸¥à¸à¸à¸£à¸µ!\n\nà¸à¸´à¸¡à¸à¹ "à¹à¸¡à¸à¸¹" à¸à¸¹à¹à¸¡à¸à¸¹\nà¸à¸´à¸¡à¸à¹ "à¹à¸à¹à¸¡" à¹à¸à¹à¸à¹à¸à¹à¸¡à¸ªà¸°à¸ªà¸¡\nà¸à¸´à¸¡à¸à¹ "à¸à¹à¸§à¸¢à¹à¸«à¸¥à¸·à¸­" à¸à¸¹à¸à¸³à¸ªà¸±à¹à¸à¸à¸±à¹à¸à¸«à¸¡à¸'
    });
  }

  // ===== Postback Event: à¸¥à¸¹à¸à¸à¹à¸²à¸à¸à¸à¸¸à¹à¸¡à¸ªà¸°à¸ªà¸¡à¹à¸à¹à¸¡ =====
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    if (action === 'useCode') {
      const code = data.get('code');
      const userId = event.source.userId;
      const result = await useCode(code, userId);
      let replyText;

      if (result.error === 'not_found') {
        replyText = 'â à¹à¸¡à¹à¸à¸à¸£à¸«à¸±à¸ªà¸à¸µà¹ à¸à¸£à¸¸à¸à¸²à¸à¸£à¸§à¸à¸ªà¸­à¸à¸­à¸µà¸à¸à¸£à¸±à¹à¸';
      } else if (result.error === 'already_used') {
        replyText = 'â à¸£à¸«à¸±à¸ªà¸à¸µà¹à¸à¸¹à¸à¹à¸à¹à¹à¸à¹à¸¥à¹à¸§';
      } else if (result.error === 'expired') {
        replyText = 'â à¸£à¸«à¸±à¸ªà¸à¸µà¹à¸«à¸¡à¸à¸­à¸²à¸¢à¸¸à¹à¸¥à¹à¸§ à¸à¸£à¸¸à¸à¸²à¸à¸­à¸£à¸«à¸±à¸ªà¹à¸«à¸¡à¹à¸à¸²à¸à¸à¸à¸±à¸à¸à¸²à¸';
      } else if (result.error) {
        replyText = 'â à¹à¸à¸´à¸à¸à¹à¸­à¸à¸´à¸à¸à¸¥à¸²à¸ à¸à¸£à¸¸à¸à¸²à¸¥à¸­à¸à¹à¸«à¸¡à¹';
      } else {
        var ch = result.channel || 'walkin';
        const user = await addPoints(userId, result.points, ch);
        updateUserName(userId);

        var chLabel = ch === 'online' ? 'ð à¸­à¸­à¸à¹à¸¥à¸à¹' : 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸';
        var currentPts = ch === 'online' ? user.pointsOnline : user.pointsWalkin;
        var redeemCost = ch === 'online' ? REDEEM_COST_ONLINE : REDEEM_COST_WALKIN;
        var remaining = redeemCost - currentPts;

        if (currentPts >= redeemCost) {
          replyText = 'â à¸ªà¸°à¸ªà¸¡ ' + result.points + ' à¹à¸à¹à¸¡ à¸ªà¸³à¹à¸£à¹à¸! ' + chLabel + '\n\nð¯ à¹à¸à¹à¸¡' + (ch === 'online' ? 'à¸­à¸­à¸à¹à¸¥à¸à¹' : 'à¸«à¸à¹à¸²à¸£à¹à¸²à¸') + ': ' + currentPts + ' à¹à¸à¹à¸¡\nð à¹à¸¥à¸à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µà¹à¸à¹!\n\nà¸à¸´à¸¡à¸à¹ "' + (ch === 'online' ? 'à¹à¸¥à¸à¸­' : 'à¹à¸¥à¸') + '" à¹à¸à¸·à¹à¸­à¹à¸à¹à¸ªà¸´à¸à¸à¸´à¹';
        } else {
          replyText = 'â à¸ªà¸°à¸ªà¸¡ ' + result.points + ' à¹à¸à¹à¸¡ à¸ªà¸³à¹à¸£à¹à¸! ' + chLabel + '\n\nð¯ à¹à¸à¹à¸¡' + (ch === 'online' ? 'à¸­à¸­à¸à¹à¸¥à¸à¹' : 'à¸«à¸à¹à¸²à¸£à¹à¸²à¸') + ': ' + currentPts + ' à¹à¸à¹à¸¡\nð à¸­à¸µà¸ ' + remaining + ' à¹à¸à¹à¸¡à¹à¸¥à¸à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µ!';
        }
      }
      return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }
    return null;
  }

  if (event.type !== 'message' || event.message.type !== 'text') return null;
  const userId = event.source.userId;
  const msg = event.message.text.trim();

  let replyText;

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸à¸à¸±à¸à¸à¸²à¸: à¸ªà¸£à¹à¸²à¸:1234:00003:3 à¸«à¸£à¸·à¸­ à¸ªà¸£à¹à¸²à¸:1234:00003:3:à¸£ à¸«à¸£à¸·à¸­ à¸ªà¸£à¹à¸²à¸:1234:00003:3:à¸­ =====
  const createMatch = msg.match(/^à¸ªà¸£à¹à¸²à¸[:\s](\d{4})[:\s]([A-Za-z0-9\/]+)[:\s](\d+)(?:[:\s]([à¸£à¸­]))?$/);
  if (createMatch) {
    const pin = createMatch[1];
    const billNo = createMatch[2];
    const count = parseInt(createMatch[3]);
    const chFlag = createMatch[4] || 'à¸£'; // à¸à¹à¸²à¹à¸£à¸´à¹à¸¡à¸à¹à¸ = à¸«à¸à¹à¸²à¸£à¹à¸²à¸
    const channel = chFlag === 'à¸­' ? 'online' : 'walkin';
    const channelLabel = channel === 'online' ? 'ð à¸­à¸­à¸à¹à¸¥à¸à¹' : 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸';

    if (pin !== ADMIN_PIN) {
      replyText = 'â à¸£à¸«à¸±à¸ªà¹à¸¡à¹à¸à¸¹à¸à¸à¹à¸­à¸';
    } else if (count < 1 || count > 20) {
      replyText = 'â à¹à¸ªà¹à¸à¸³à¸à¸§à¸ 1-20 à¹à¸à¹à¸§';
    } else if (await isBillUsed(billNo)) {
      replyText = 'â à¸à¸´à¸¥à¹à¸¥à¸à¸à¸µà¹ ' + billNo + ' à¸à¸¹à¸à¹à¸à¹à¹à¸à¹à¸¥à¹à¸§!';
    } else {
      const code = await createCode(userId, count, billNo, channel);
      replyText = 'â à¸ªà¸£à¹à¸²à¸à¸£à¸«à¸±à¸ªà¸ªà¸³à¹à¸£à¹à¸!\n\nð« à¸£à¸«à¸±à¸ª: ' + code + '\nð§¾ à¸à¸´à¸¥: ' + billNo + '\nâ à¸à¸³à¸à¸§à¸: ' + count + ' à¹à¸à¹à¸¡\n' + channelLabel + '\nâ° à¸«à¸¡à¸à¸­à¸²à¸¢à¸¸à¹à¸ 24 à¸à¸±à¹à¸§à¹à¸¡à¸\n\nà¸à¸­à¸à¸£à¸«à¸±à¸ªà¸à¸µà¹à¹à¸«à¹à¸¥à¸¹à¸à¸à¹à¸²';
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸à¸à¸±à¸à¸à¸²à¸: à¸ªà¸£à¹à¸²à¸à¸ªà¹à¸:1234:00003:3:à¸£:à¸à¸·à¹à¸­à¸¥à¸¹à¸à¸à¹à¸² â à¸ªà¸£à¹à¸²à¸à¹à¸à¹à¸ + à¸ªà¹à¸ Flex Message à¹à¸«à¹à¸¥à¸¹à¸à¸à¹à¸² =====
  const createSendMatch = msg.match(/^à¸ªà¸£à¹à¸²à¸à¸ªà¹à¸[:\s](\d{4})[:\s]([A-Za-z0-9\/]+)[:\s](\d+)(?:[:\s]([à¸£à¸­]))?[:\s](.+)$/);
  if (createSendMatch) {
    const pin = createSendMatch[1];
    const billNo = createSendMatch[2];
    const count = parseInt(createSendMatch[3]);
    const chFlag = createSendMatch[4] || 'à¸£';
    const channel = chFlag === 'à¸­' ? 'online' : 'walkin';
    const channelLabel = channel === 'online' ? 'ð à¸­à¸­à¸à¹à¸¥à¸à¹' : 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸';
    const customerName = createSendMatch[5].trim();

    if (pin !== ADMIN_PIN) {
      replyText = 'â à¸£à¸«à¸±à¸ªà¹à¸¡à¹à¸à¸¹à¸à¸à¹à¸­à¸';
    } else if (count < 1 || count > 20) {
      replyText = 'â à¹à¸ªà¹à¸à¸³à¸à¸§à¸ 1-20 à¹à¸à¹à¸§';
    } else if (await isBillUsed(billNo)) {
      replyText = 'â à¸à¸´à¸¥à¹à¸¥à¸à¸à¸µà¹ ' + billNo + ' à¸à¸¹à¸à¹à¸à¹à¹à¸à¹à¸¥à¹à¸§!';
    } else {
      // à¸à¹à¸à¸«à¸²à¸¥à¸¹à¸à¸à¹à¸²à¸à¸²à¸ Google Sheet à¸à¸²à¸¡à¸à¸·à¹à¸­
      try {
        var allResult = await callSheetAPI({ action: 'getAllCustomers' });
        var customers = allResult.customers || [];
        var found = null;
        for (var c = 0; c < customers.length; c++) {
          if (customers[c].name && customers[c].name.toLowerCase().indexOf(customerName.toLowerCase()) !== -1) {
            found = customers[c];
            break;
          }
        }

        if (!found || !found.userId) {
          replyText = 'â à¹à¸¡à¹à¸à¸à¸¥à¸¹à¸à¸à¹à¸²à¸à¸·à¹à¸­ "' + customerName + '" à¹à¸à¸£à¸°à¸à¸\n\nà¸¥à¸¹à¸à¸à¹à¸²à¸à¹à¸­à¸à¹à¸à¸´à¹à¸¡à¹à¸à¸·à¹à¸­à¸à¸à¸­à¸à¸à¹à¸­à¸à¸à¸¶à¸à¸à¸°à¸ªà¹à¸à¹à¸à¹';
        } else {
          // à¸ªà¸£à¹à¸²à¸à¹à¸à¹à¸
          const code = await createCode(userId, count, billNo, channel);

          // à¸ªà¸£à¹à¸²à¸ Flex Message à¸à¸£à¹à¸­à¸¡à¸à¸¸à¹à¸¡à¸à¸à¸ªà¸°à¸ªà¸¡à¹à¸à¹à¸¡
          var flexMsg = {
            type: 'flex',
            altText: 'â à¸à¸à¸ªà¸°à¸ªà¸¡ ' + count + ' à¹à¸à¹à¸¡ â Inthanin Cafe',
            contents: {
              type: 'bubble',
              size: 'kilo',
              header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#2E7D32',
                paddingAll: '15px',
                contents: [
                  {
                    type: 'text',
                    text: 'â Inthanin Cafe',
                    color: '#FFFFFF',
                    size: 'lg',
                    weight: 'bold'
                  },
                  {
                    type: 'text',
                    text: 'à¸ªà¸°à¸ªà¸¡à¹à¸à¹à¸¡à¸£à¸±à¸à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µ!',
                    color: '#C8E6C9',
                    size: 'xs',
                    margin: 'sm'
                  }
                ]
              },
              body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                paddingAll: '15px',
                contents: [
                  {
                    type: 'text',
                    text: 'à¸à¸¸à¸à¹à¸à¹à¸£à¸±à¸ ' + count + ' à¹à¸à¹à¸¡!',
                    size: 'xl',
                    weight: 'bold',
                    align: 'center',
                    color: '#2E7D32'
                  },
                  {
                    type: 'separator',
                    margin: 'md'
                  },
                  {
                    type: 'box',
                    layout: 'vertical',
                    spacing: 'sm',
                    margin: 'md',
                    contents: [
                      {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                          { type: 'text', text: 'ð§¾ à¸à¸´à¸¥:', size: 'sm', color: '#888888', flex: 3 },
                          { type: 'text', text: billNo, size: 'sm', weight: 'bold', flex: 5 }
                        ]
                      },
                      {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                          { type: 'text', text: 'ð à¸à¹à¸­à¸à¸à¸²à¸:', size: 'sm', color: '#888888', flex: 3 },
                          { type: 'text', text: channelLabel, size: 'sm', weight: 'bold', flex: 5 }
                        ]
                      },
                      {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                          { type: 'text', text: 'â° à¸«à¸¡à¸à¸­à¸²à¸¢à¸¸:', size: 'sm', color: '#888888', flex: 3 },
                          { type: 'text', text: '24 à¸à¸±à¹à¸§à¹à¸¡à¸', size: 'sm', flex: 5 }
                        ]
                      }
                    ]
                  }
                ]
              },
              footer: {
                type: 'box',
                layout: 'vertical',
                paddingAll: '15px',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#2E7D32',
                    height: 'md',
                    action: {
                      type: 'postback',
                      label: 'à¸à¸à¸ªà¸°à¸ªà¸¡à¹à¸à¹à¸¡ â¨',
                      data: 'action=useCode&code=' + code,
                      displayText: 'à¸ªà¸°à¸ªà¸¡:' + code
                    }
                  },
                  {
                    type: 'text',
                    text: 'à¸«à¸£à¸·à¸­à¸à¸´à¸¡à¸à¹ à¸ªà¸°à¸ªà¸¡:' + code,
                    size: 'xxs',
                    color: '#AAAAAA',
                    align: 'center',
                    margin: 'md'
                  }
                ]
              }
            }
          };

          // à¸ªà¹à¸ push message à¹à¸à¸«à¸²à¸¥à¸¹à¸à¸à¹à¸²à¹à¸à¸¢à¸à¸£à¸
          await client.pushMessage(found.userId, flexMsg);

          replyText = 'â à¸ªà¸£à¹à¸²à¸à¸£à¸«à¸±à¸ªà¹à¸¥à¸°à¸ªà¹à¸à¹à¸«à¹à¸¥à¸¹à¸à¸à¹à¸²à¹à¸¥à¹à¸§!\n\nð« à¸£à¸«à¸±à¸ª: ' + code + '\nð§¾ à¸à¸´à¸¥: ' + billNo + '\nâ à¸à¸³à¸à¸§à¸: ' + count + ' à¹à¸à¹à¸¡\n' + channelLabel + '\nð¤ à¸ªà¹à¸à¹à¸«à¹: ' + found.name + '\n\nð± à¸¥à¸¹à¸à¸à¹à¸²à¹à¸à¹à¸£à¸±à¸ Flex Message à¸à¸£à¹à¸­à¸¡à¸à¸¸à¹à¸¡à¸à¸à¸ªà¸°à¸ªà¸¡à¹à¸à¹à¸¡à¹à¸¥à¹à¸§!';
        }
      } catch (e) {
        console.error('Error createSend:', e);
        replyText = 'â à¹à¸à¸´à¸à¸à¹à¸­à¸à¸´à¸à¸à¸¥à¸²à¸à¹à¸à¸à¸²à¸£à¸ªà¹à¸ à¸à¸£à¸¸à¸à¸²à¸¥à¸­à¸à¹à¸«à¸¡à¹';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸à¸à¸±à¸à¸à¸²à¸: à¹à¸à¹à¸:1234 =====
  const checkMatch = msg.match(/^à¹à¸à¹à¸[:\s](\d{4})$/);
  if (checkMatch) {
    const pin = checkMatch[1];
    if (pin !== ADMIN_PIN) {
      replyText = 'â à¸£à¸«à¸±à¸ªà¹à¸¡à¹à¸à¸¹à¸à¸à¹à¸­à¸';
    } else {
      try {
        var allResult = await callSheetAPI({ action: 'getAllCustomers' });
        var users = allResult.customers || [];
        if (users.length === 0) {
          replyText = 'ð à¸¢à¸±à¸à¹à¸¡à¹à¸¡à¸µà¸¥à¸¹à¸à¸à¹à¸²à¹à¸à¸£à¸°à¸à¸';
        } else {
          let summary = 'ð à¸ªà¸£à¸¸à¸à¹à¸à¹à¸¡à¸¥à¸¹à¸à¸à¹à¸² (' + users.length + ' à¸à¸)\n\n';
          let totalW = 0, totalO = 0;
          for (var i = 0; i < users.length && i < 20; i++) {
            var u = users[i];
            var pw = Number(u.pointsWalkin) || 0;
            var po = Number(u.pointsOnline) || 0;
            totalW += pw;
            totalO += po;
            var name = u.name || 'à¹à¸¡à¹à¸à¸£à¸²à¸à¸à¸·à¹à¸­';
            summary += (i + 1) + '. ' + name + '\n   ðª ' + pw + ' | ð ' + po + ' | à¹à¸¥à¸: ' + ((Number(u.redeemedWalkin) || 0) + (Number(u.redeemedOnline) || 0)) + ' à¸à¸£à¸±à¹à¸\n';
          }
          if (users.length > 20) summary += '...(à¹à¸ªà¸à¸ 20 à¸à¸à¹à¸£à¸)\n';
          summary += '\nðª à¹à¸à¹à¸¡à¸«à¸à¹à¸²à¸£à¹à¸²à¸à¸£à¸§à¸¡: ' + totalW;
          summary += '\nð à¹à¸à¹à¸¡à¸­à¸­à¸à¹à¸¥à¸à¹à¸£à¸§à¸¡: ' + totalO;
          replyText = summary;
        }
      } catch (e) {
        console.error('Error checking:', e);
        replyText = 'â à¹à¸à¸´à¸à¸à¹à¸­à¸à¸´à¸à¸à¸¥à¸²à¸à¹à¸à¸à¸²à¸£à¸à¸¶à¸à¸à¹à¸­à¸¡à¸¹à¸¥';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸à¸à¸±à¸à¸à¸²à¸: à¸ªà¸£à¸¸à¸:1234 à¸«à¸£à¸·à¸­ à¸ªà¸£à¸¸à¸:1234:14/11/2026 =====
  const summaryMatch = msg.match(/^à¸ªà¸£à¸¸à¸[:\s](\d{4})(?:[:\s](\d{1,2})\/(\d{1,2})\/(\d{4}))?$/);
  if (summaryMatch) {
    const pin = summaryMatch[1];
    if (pin !== ADMIN_PIN) {
      replyText = 'â à¸£à¸«à¸±à¸ªà¹à¸¡à¹à¸à¸¹à¸à¸à¹à¸­à¸';
    } else {
      try {
        var dateStr = null;
        if (summaryMatch[2] && summaryMatch[3] && summaryMatch[4]) {
          dateStr = summaryMatch[2].padStart(2, '0') + '/' + summaryMatch[3].padStart(2, '0') + '/' + summaryMatch[4];
        }
        var s = await callSheetAPI({ action: 'getDailySummary', date: dateStr });

        var text = 'ð à¸ªà¸£à¸¸à¸à¸¢à¸­à¸à¸à¸£à¸°à¸à¸³à¸§à¸±à¸\n';
        text += 'ð à¸§à¸±à¸à¸à¸µà¹: ' + s.date + '\n';
        text += 'âââââââââââââââ\n';
        text += 'ð§¾ à¸à¸³à¸à¸§à¸à¸à¸´à¸¥: ' + s.billCount + ' à¸à¸´à¸¥\n';
        if (s.billCountWalkin > 0 || s.billCountOnline > 0) {
          text += '   ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸: ' + (s.billCountWalkin || 0) + ' à¸à¸´à¸¥ (' + (s.totalPointsWalkin || 0) + ' à¹à¸à¹à¸¡)\n';
          text += '   ð à¸­à¸­à¸à¹à¸¥à¸à¹: ' + (s.billCountOnline || 0) + ' à¸à¸´à¸¥ (' + (s.totalPointsOnline || 0) + ' à¹à¸à¹à¸¡)\n';
        }
        if (s.bills && s.bills.length > 0) {
          text += 'ð à¸£à¸²à¸¢à¸¥à¸°à¹à¸­à¸µà¸¢à¸à¸à¸´à¸¥:\n';
          for (var b = 0; b < s.bills.length; b++) {
            var chIcon = s.bills[b].channel === 'online' ? 'ð' : 'ðª';
            text += '   ' + (b + 1) + '. ' + s.bills[b].billNo + ' (' + s.bills[b].points + ' à¹à¸à¹à¸¡) ' + chIcon + '\n';
          }
        }
        text += 'âââââââââââââââ\n';
        text += 'â à¹à¸à¹à¸¡à¸à¸µà¹à¹à¸«à¹à¸à¸±à¹à¸à¸«à¸¡à¸: ' + s.totalPoints + ' à¹à¸à¹à¸¡\n';
        text += 'â à¸£à¸«à¸±à¸ªà¸à¸µà¹à¹à¸à¹à¹à¸¥à¹à¸§: ' + s.usedCodes + ' à¸£à¸«à¸±à¸ª\n';
        text += 'â³ à¸£à¸«à¸±à¸ªà¸¢à¸±à¸à¹à¸¡à¹à¹à¸à¹à¹à¸à¹: ' + s.unusedCodes + ' à¸£à¸«à¸±à¸ª\n';
        text += 'âââââââââââââââ\n';
        text += 'ð à¸à¸³à¸à¸§à¸à¹à¸¥à¸à¸à¸£à¸µ: ' + s.redeemCount + ' à¸à¸£à¸±à¹à¸\n';
        if ((s.redeemCountWalkin || 0) > 0 || (s.redeemCountOnline || 0) > 0) {
          text += '   ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸: ' + (s.redeemCountWalkin || 0) + ' à¸à¸£à¸±à¹à¸\n';
          text += '   ð à¸­à¸­à¸à¹à¸¥à¸à¹: ' + (s.redeemCountOnline || 0) + ' à¸à¸£à¸±à¹à¸\n';
        }
        if (s.redeemNames && s.redeemNames.length > 0) {
          text += 'ð¤ à¸à¸¹à¹à¹à¸¥à¸: ' + s.redeemNames.join(', ') + '\n';
        }
        if (s.billCount === 0 && s.redeemCount === 0) {
          text += '\nð¤ à¹à¸¡à¹à¸¡à¸µà¸£à¸²à¸¢à¸à¸²à¸£à¹à¸à¸§à¸±à¸à¸à¸µà¹';
        }
        replyText = text;
      } catch (e) {
        console.error('Error summary:', e);
        replyText = 'â à¹à¸à¸´à¸à¸à¹à¸­à¸à¸´à¸à¸à¸¥à¸²à¸à¹à¸à¸à¸²à¸£à¸à¸¶à¸à¸à¹à¸­à¸¡à¸¹à¸¥';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸à¸à¸±à¸à¸à¸²à¸: à¸¢à¸·à¸à¸¢à¸±à¸:1234:R-A7X92K =====
  var verifyMatch = msg.match(/^à¸¢à¸·à¸à¸¢à¸±à¸[:\s](\d{4})[:\s](R-[A-Za-z0-9]{6})$/i);
  if (verifyMatch) {
    var pin4 = verifyMatch[1];
    var rCode = verifyMatch[2].toUpperCase();
    if (pin4 !== ADMIN_PIN) {
      replyText = 'â à¸£à¸«à¸±à¸ªà¹à¸¡à¹à¸à¸¹à¸à¸à¹à¸­à¸';
    } else {
      var vResult = await verifyRedeem(rCode);
      if (vResult.error === 'not_found') {
        replyText = 'â à¹à¸¡à¹à¸à¸à¸£à¸«à¸±à¸ªà¹à¸¥à¸ ' + rCode + '\n\nâ ï¸ à¸­à¸²à¸à¹à¸à¹à¸à¸£à¸«à¸±à¸ªà¸à¸¥à¸­à¸¡!';
      } else if (vResult.error === 'already_confirmed') {
        var chLabel2 = String(vResult.redeem.channel || 'walkin') === 'online' ? 'ð à¸­à¸­à¸à¹à¸¥à¸à¹' : 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸';
        replyText = 'â ï¸ à¸£à¸«à¸±à¸ª ' + rCode + ' à¸à¸¹à¸à¸¢à¸·à¸à¸¢à¸±à¸à¹à¸à¹à¸¥à¹à¸§!\n\nð¤ à¸à¸·à¹à¸­: ' + (vResult.redeem.name || 'à¹à¸¡à¹à¸à¸£à¸²à¸') + '\n' + chLabel2 + '\n\nâ à¹à¸¡à¹à¸ªà¸²à¸¡à¸²à¸£à¸à¹à¸à¹à¸à¹à¸³à¹à¸à¹';
      } else if (vResult.success) {
        var chLabel3 = String(vResult.redeem.channel || 'walkin') === 'online' ? 'ð à¸­à¸­à¸à¹à¸¥à¸à¹' : 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸';
        replyText = 'â à¸¢à¸·à¸à¸¢à¸±à¸à¸ªà¸³à¹à¸£à¹à¸! à¸£à¸«à¸±à¸ª ' + rCode + '\n\nð¤ à¸à¸·à¹à¸­à¸¥à¸¹à¸à¸à¹à¸²: ' + (vResult.redeem.name || 'à¹à¸¡à¹à¸à¸£à¸²à¸') + '\n' + chLabel3 + '\n\nâ à¹à¸«à¹à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µ 1 à¹à¸à¹à¸§à¹à¸à¹à¹à¸¥à¸¢!';
      } else {
        replyText = 'â à¹à¸à¸´à¸à¸à¹à¸­à¸à¸´à¸à¸à¸¥à¸²à¸ à¸à¸£à¸¸à¸à¸²à¸¥à¸­à¸à¹à¸«à¸¡à¹';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸¥à¸¹à¸à¸à¹à¸²: à¸ªà¸°à¸ªà¸¡:A7X92K =====
  const redeemCodeMatch = msg.match(/^à¸ªà¸°à¸ªà¸¡[:\s]([A-Za-z0-9]{6})$/);
  if (redeemCodeMatch) {
    const code = redeemCodeMatch[1];
    const result = await useCode(code, userId);

    if (result.error === 'not_found') {
      replyText = 'â à¹à¸¡à¹à¸à¸à¸£à¸«à¸±à¸ªà¸à¸µà¹ à¸à¸£à¸¸à¸à¸²à¸à¸£à¸§à¸à¸ªà¸­à¸à¸­à¸µà¸à¸à¸£à¸±à¹à¸';
    } else if (result.error === 'already_used') {
      replyText = 'â à¸£à¸«à¸±à¸ªà¸à¸µà¹à¸à¸¹à¸à¹à¸à¹à¹à¸à¹à¸¥à¹à¸§';
    } else if (result.error === 'expired') {
      replyText = 'â à¸£à¸«à¸±à¸ªà¸à¸µà¹à¸«à¸¡à¸à¸­à¸²à¸¢à¸¸à¹à¸¥à¹à¸§ à¸à¸£à¸¸à¸à¸²à¸à¸­à¸£à¸«à¸±à¸ªà¹à¸«à¸¡à¹à¸à¸²à¸à¸à¸à¸±à¸à¸à¸²à¸';
    } else if (result.error) {
      replyText = 'â à¹à¸à¸´à¸à¸à¹à¸­à¸à¸´à¸à¸à¸¥à¸²à¸ à¸à¸£à¸¸à¸à¸²à¸¥à¸­à¸à¹à¸«à¸¡à¹';
    } else {
      var ch = result.channel || 'walkin';
      const user = await addPoints(userId, result.points, ch);
      updateUserName(userId); // à¹à¸¡à¹à¸à¹à¸­à¸ await

      var chLabel = ch === 'online' ? 'ð à¸­à¸­à¸à¹à¸¥à¸à¹' : 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸';
      var currentPts = ch === 'online' ? user.pointsOnline : user.pointsWalkin;
      var redeemCost = ch === 'online' ? REDEEM_COST_ONLINE : REDEEM_COST_WALKIN;
      var remaining = redeemCost - currentPts;

      if (currentPts >= redeemCost) {
        replyText = 'â à¸ªà¸°à¸ªà¸¡ ' + result.points + ' à¹à¸à¹à¸¡ à¸ªà¸³à¹à¸£à¹à¸! ' + chLabel + '\n\nð¯ à¹à¸à¹à¸¡' + (ch === 'online' ? 'à¸­à¸­à¸à¹à¸¥à¸à¹' : 'à¸«à¸à¹à¸²à¸£à¹à¸²à¸') + ': ' + currentPts + ' à¹à¸à¹à¸¡\nð à¹à¸¥à¸à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µà¹à¸à¹!\n\nà¸à¸´à¸¡à¸à¹ "' + (ch === 'online' ? 'à¹à¸¥à¸à¸­' : 'à¹à¸¥à¸') + '" à¹à¸à¸·à¹à¸­à¹à¸à¹à¸ªà¸´à¸à¸à¸´à¹';
      } else {
        replyText = 'â à¸ªà¸°à¸ªà¸¡ ' + result.points + ' à¹à¸à¹à¸¡ à¸ªà¸³à¹à¸£à¹à¸! ' + chLabel + '\n\nð¯ à¹à¸à¹à¸¡' + (ch === 'online' ? 'à¸­à¸­à¸à¹à¸¥à¸à¹' : 'à¸«à¸à¹à¸²à¸£à¹à¸²à¸') + ': ' + currentPts + ' à¹à¸à¹à¸¡\nð à¸­à¸µà¸ ' + remaining + ' à¹à¸à¹à¸¡à¹à¸¥à¸à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µ!';
      }
    }
    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸¥à¸¹à¸à¸à¹à¸²: à¹à¸à¹à¸¡ =====
  if (msg === 'à¹à¸à¹à¸¡' || msg === 'à¸à¸°à¹à¸à¸' || msg === 'points') {
    const user = await getPoints(userId);
    updateUserName(userId);
    var remainW = REDEEM_COST_WALKIN - user.pointsWalkin;
    var remainO = REDEEM_COST_ONLINE - user.pointsOnline;
    var totalRedeemed = user.redeemedWalkin + user.redeemedOnline;

    replyText = 'ð¯ à¹à¸à¹à¸¡à¸ªà¸°à¸ªà¸¡à¸à¸­à¸à¸à¸¸à¸\n\n';
    // à¸«à¸à¹à¸²à¸£à¹à¸²à¸
    replyText += 'ðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸: ' + user.pointsWalkin + ' à¹à¸à¹à¸¡';
    if (user.pointsWalkin >= REDEEM_COST_WALKIN) {
      replyText += ' ð à¹à¸¥à¸à¹à¸à¹!';
    } else {
      replyText += ' (à¸­à¸µà¸ ' + remainW + ' à¹à¸¥à¸à¸à¸£à¸µ)';
    }
    replyText += '\n';
    // à¸­à¸­à¸à¹à¸¥à¸à¹
    replyText += 'ð à¸­à¸­à¸à¹à¸¥à¸à¹: ' + user.pointsOnline + ' à¹à¸à¹à¸¡';
    if (user.pointsOnline >= REDEEM_COST_ONLINE) {
      replyText += ' ð à¹à¸¥à¸à¹à¸à¹!';
    } else {
      replyText += ' (à¸­à¸µà¸ ' + remainO + ' à¹à¸¥à¸à¸à¸£à¸µ)';
    }
    replyText += '\n\n';
    replyText += 'ð à¸£à¸§à¸¡à¸ªà¸°à¸ªà¸¡: ' + (user.totalWalkin + user.totalOnline) + ' à¹à¸à¹à¸¡\n';
    replyText += 'ð à¹à¸¥à¸à¹à¸à¹à¸¥à¹à¸§: ' + totalRedeemed + ' à¸à¸£à¸±à¹à¸';

    if (user.pointsWalkin >= REDEEM_COST_WALKIN || user.pointsOnline >= REDEEM_COST_ONLINE) {
      replyText += '\n\n';
      if (user.pointsWalkin >= REDEEM_COST_WALKIN) replyText += 'ð à¸à¸´à¸¡à¸à¹ "à¹à¸¥à¸" à¹à¸à¹à¸ªà¸´à¸à¸à¸´à¹à¸«à¸à¹à¸²à¸£à¹à¸²à¸\n';
      if (user.pointsOnline >= REDEEM_COST_ONLINE) replyText += 'ð à¸à¸´à¸¡à¸à¹ "à¹à¸¥à¸à¸­" à¹à¸à¹à¸ªà¸´à¸à¸à¸´à¹à¸­à¸­à¸à¹à¸¥à¸à¹';
    }
  }
  // ===== à¸à¸³à¸ªà¸±à¹à¸à¸¥à¸¹à¸à¸à¹à¸²: à¹à¸¥à¸ / à¹à¸¥à¸à¸£ / à¹à¸¥à¸à¸­ =====
  else if (msg === 'à¹à¸¥à¸' || msg === 'à¹à¸¥à¸à¸£' || msg === 'redeem') {
    // à¹à¸¥à¸à¹à¸à¹à¸¡à¸«à¸à¹à¸²à¸£à¹à¸²à¸
    var redeemResult = await redeemPoints(userId, 'walkin');
    if (redeemResult) {
      replyText = 'ððð à¹à¸¥à¸à¸ªà¸³à¹à¸£à¹à¸! ððð\n\nðª à¸à¹à¸­à¸à¸à¸²à¸: à¸«à¸à¹à¸²à¸£à¹à¸²à¸\nâ à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µ 1 à¹à¸à¹à¸§!\nð à¸£à¸«à¸±à¸ªà¸¢à¸·à¸à¸¢à¸±à¸: ' + redeemResult.redeemCode + '\nð¯ à¹à¸à¹à¸¡à¸«à¸à¹à¸²à¸£à¹à¸²à¸à¸à¸à¹à¸«à¸¥à¸·à¸­: ' + redeemResult.user.pointsWalkin + ' à¹à¸à¹à¸¡\n\nð à¹à¸ªà¸à¸à¸£à¸«à¸±à¸ªà¸¢à¸·à¸à¸¢à¸±à¸à¹à¸«à¹à¸à¸à¸±à¸à¸à¸²à¸';
    } else {
      var user4 = await getPoints(userId);
      replyText = 'â à¹à¸à¹à¸¡à¸«à¸à¹à¸²à¸£à¹à¸²à¸à¸¢à¸±à¸à¹à¸¡à¹à¸à¸£à¸\n\nðª à¹à¸à¹à¸¡à¸«à¸à¹à¸²à¸£à¹à¸²à¸: ' + user4.pointsWalkin + ' à¹à¸à¹à¸¡\nð à¸à¹à¸­à¸à¸ªà¸°à¸ªà¸¡à¸­à¸µà¸ ' + (REDEEM_COST_WALKIN - user4.pointsWalkin) + ' à¹à¸à¹à¸¡ (à¸à¸£à¸ ' + REDEEM_COST_WALKIN + ' à¹à¸¥à¸à¸à¸£à¸µ)';
    }
  } else if (msg === 'à¹à¸¥à¸à¸­') {
    // à¹à¸¥à¸à¹à¸à¹à¸¡à¸­à¸­à¸à¹à¸¥à¸à¹
    var redeemResult2 = await redeemPoints(userId, 'online');
    if (redeemResult2) {
      replyText = 'ððð à¹à¸¥à¸à¸ªà¸³à¹à¸£à¹à¸! ððð\n\nð à¸à¹à¸­à¸à¸à¸²à¸: à¸­à¸­à¸à¹à¸¥à¸à¹\nâ à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡à¸à¸£à¸µ 1 à¹à¸à¹à¸§!\nð à¸£à¸«à¸±à¸ªà¸¢à¸·à¸à¸¢à¸±à¸: ' + redeemResult2.redeemCode + '\nð¯ à¹à¸à¹à¸¡à¸­à¸­à¸à¹à¸¥à¸à¹à¸à¸à¹à¸«à¸¥à¸·à¸­: ' + redeemResult2.user.pointsOnline + ' à¹à¸à¹à¸¡\n\nð à¹à¸ªà¸à¸à¸£à¸«à¸±à¸ªà¸¢à¸·à¸à¸¢à¸±à¸à¹à¸«à¹à¸à¸à¸±à¸à¸à¸²à¸';
    } else {
      var user5 = await getPoints(userId);
      replyText = 'â à¹à¸à¹à¸¡à¸­à¸­à¸à¹à¸¥à¸à¹à¸¢à¸±à¸à¹à¸¡à¹à¸à¸£à¸\n\nð à¹à¸à¹à¸¡à¸­à¸­à¸à¹à¸¥à¸à¹: ' + user5.pointsOnline + ' à¹à¸à¹à¸¡\nð à¸à¹à¸­à¸à¸ªà¸°à¸ªà¸¡à¸­à¸µà¸ ' + (REDEEM_COST_ONLINE - user5.pointsOnline) + ' à¹à¸à¹à¸¡ (à¸à¸£à¸ ' + REDEEM_COST_ONLINE + ' à¹à¸¥à¸à¸à¸£à¸µ)';
    }
  }
  // ===== à¹à¸¡à¸à¸¹ =====
  else if (msg === 'à¹à¸¡à¸à¸¹' || msg === 'menu') {
    replyText = 'à¹à¸à¸·à¹à¸­à¸à¸à¸²à¸à¹à¸à¹à¸à¹à¸à¸£à¹à¸¡à¸à¸±à¹à¸à¸à¸´à¹à¸¨à¸©\nâ à¹à¸¡à¸à¸¹à¸à¸µà¹à¹à¸¥à¸à¹à¸à¹à¹à¸à¸à¸²à¸° Inthanin Coffee à¸¡à¸±à¸¢à¸¥à¸²à¸ à¹à¸à¹à¸²à¸à¸±à¹à¸\n\nà¸­à¹à¸¡à¸£à¸´à¸à¸²à¹à¸à¹\nà¹à¸­à¸ªà¹à¸à¸£à¸ªà¹à¸à¹\nà¹à¸à¹à¸à¹\nà¸à¸²à¹à¸à¸µà¸¢à¸§\nà¸à¸²à¹à¸à¸¢\nà¸à¸²à¸¡à¸°à¸à¸²à¸§\nà¸­à¸­à¸¥à¹à¸à¸¢à¹\nà¸à¸²à¸à¸³\n\nðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸: à¸ªà¸°à¸ªà¸¡à¸à¸£à¸ ' + REDEEM_COST_WALKIN + ' à¹à¸à¹à¸¡ à¹à¸¥à¸à¸à¸£à¸µ!\nð à¸­à¸­à¸à¹à¸¥à¸à¹: à¸ªà¸°à¸ªà¸¡à¸à¸£à¸ ' + REDEEM_COST_ONLINE + ' à¹à¸à¹à¸¡ à¹à¸¥à¸à¸à¸£à¸µ!';
  }
  // ===== à¸à¹à¸§à¸¢à¹à¸«à¸¥à¸·à¸­ =====
  else if (msg === 'help' || msg === 'à¸à¹à¸§à¸¢à¹à¸«à¸¥à¸·à¸­') {
    replyText = 'ð¤ à¸à¸³à¸ªà¸±à¹à¸à¸¥à¸¹à¸à¸à¹à¸²:\n\nð« "à¸ªà¸°à¸ªà¸¡:à¸£à¸«à¸±à¸ª" - à¹à¸à¹à¸£à¸«à¸±à¸ªà¸ªà¸°à¸ªà¸¡à¹à¸à¹à¸¡\nð¯ "à¹à¸à¹à¸¡" - à¹à¸à¹à¸à¹à¸à¹à¸¡à¸ªà¸°à¸ªà¸¡\nð "à¹à¸¥à¸" - à¹à¸¥à¸à¹à¸à¹à¸¡à¸«à¸à¹à¸²à¸£à¹à¸²à¸ (' + REDEEM_COST_WALKIN + ' à¹à¸à¹à¸¡)\nð "à¹à¸¥à¸à¸­" - à¹à¸¥à¸à¹à¸à¹à¸¡à¸­à¸­à¸à¹à¸¥à¸à¹ (' + REDEEM_COST_ONLINE + ' à¹à¸à¹à¸¡)\nð "à¹à¸¡à¸à¸¹" - à¸à¸¹à¹à¸¡à¸à¸¹à¹à¸à¸£à¸·à¹à¸­à¸à¸à¸·à¹à¸¡\nâ "à¸à¹à¸§à¸¢à¹à¸«à¸¥à¸·à¸­" - à¸à¸¹à¸à¸³à¸ªà¸±à¹à¸à¸à¸±à¹à¸à¸«à¸¡à¸';
  }
  // ===== FAQ / à¸à¹à¸­à¸à¸§à¸²à¸¡à¸à¸±à¹à¸§à¹à¸ =====
  else {
    var faqAnswer = findFAQAnswer(msg);
    if (faqAnswer) {
      replyText = faqAnswer;
    } else {
      replyText = 'à¸ªà¸§à¸±à¸ªà¸à¸µà¸à¹à¸°! à¸¢à¸´à¸à¸à¸µà¸à¹à¸­à¸à¸£à¸±à¸à¸ªà¸¹à¹ Inthanin Cafe â\n\nðª à¸«à¸à¹à¸²à¸£à¹à¸²à¸: à¸ªà¸°à¸ªà¸¡à¸à¸£à¸ ' + REDEEM_COST_WALKIN + ' à¹à¸à¹à¸¡ à¹à¸¥à¸à¸à¸£à¸µ!\nð à¸­à¸­à¸à¹à¸¥à¸à¹: à¸ªà¸°à¸ªà¸¡à¸à¸£à¸ ' + REDEEM_COST_ONLINE + ' à¹à¸à¹à¸¡ à¹à¸¥à¸à¸à¸£à¸µ!\n\nà¸à¸´à¸¡à¸à¹ "à¹à¸¡à¸à¸¹" à¸à¸¹à¹à¸¡à¸à¸¹\nà¸à¸´à¸¡à¸à¹ "à¹à¸à¹à¸¡" à¹à¸à¹à¸à¹à¸à¹à¸¡à¸ªà¸°à¸ªà¸¡\nà¸à¸´à¸¡à¸à¹ "à¸à¹à¸§à¸¢à¹à¸«à¸¥à¸·à¸­" à¸à¸¹à¸à¸³à¸ªà¸±à¹à¸à¸à¸±à¹à¸à¸«à¸¡à¸';
    }
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

app.get('/', (req, res) => { res.send('Inthanin Cafe LINE Bot V2 is running!'); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('Bot V2 running on port ' + PORT); });
