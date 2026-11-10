/**
 * 유리수팡 — 서버 코드 (Google Apps Script)
 * 구글 스프레드시트의 [확장 프로그램] → [Apps Script] 에 붙여 넣어 사용합니다.
 *
 * ── 100명 동시 접속을 위한 설계 ──────────────────────────────
 * Apps Script는 한 계정당 "동시에 30개"까지만 실행됩니다.
 * 그래서 요청 하나하나를 아주 짧게(0.1초 안팎) 끝내도록 만들었습니다.
 *  1) 게임 자체는 학생 기기에서만 돌아갑니다 (혼자하기 중 서버 요청 0번).
 *  2) 게임 안 랭킹은 캐시에 보관하고, 점수가 도착하는 즉시 고칩니다 (끝나고 약 2~4초 안에 반영).
 *  3) 시트에는 바로 쓰지 않고 '대기열(스크립트 속성)'에 넣었다가,
 *     1분마다 자동 실행되는 flushQueue()가 모아서 한 번에 씁니다 (시트 기록만 최대 1분 늦음).
 *  4) 대결 중 점수 교환은 캐시 쓰기 1번 + 읽기 1번이면 끝납니다.
 *  5) 전체 잠금(Lock)은 랭킹 캐시를 고치는 아주 짧은 순간에만 씁니다.
 *
 * 시트
 *  - 랭킹     : 모든 게임 기록 (혼자하기 + 대결)
 *  - 대결기록 : 1:1 대결 결과
 */

// 스프레드시트에 붙어 있는 스크립트면 비워 두세요. 따로 만든 스크립트면 시트 ID를 넣으세요.
var SPREADSHEET_ID = '';

var SHEET_RANK = '랭킹';
var SHEET_BATTLE = '대결기록';
var RANK_HEADERS = ['시각', '이름', '모드', '단계', '점수', '최대콤보', '터뜨린식', '종류'];
var BATTLE_HEADERS = ['시각', '방번호', '모드', '단계', '방장', '방장점수', '참가자', '참가자점수', '승자'];
var MODES = { add: '덧셈', sub: '뺄셈', mul: '곱셈', div: '나눗셈' };
var LEVELS = { basic: '기본', adv: '심화' };
var MAX_SCORE = 300000;      // 비정상 점수 차단선
var ROOM_TTL = 3 * 60 * 60;  // 대결방 보관 시간(초)
var START_DELAY = 4000;      // 두 사람이 모인 뒤 시작까지(ms)
var BEST_TTL = 10 * 60;      // 랭킹 캐시 보관 시간(초) — 지나면 시트에서 다시 계산
var BEST_KEEP = 300;         // 캐시에 보관하는 상위 인원
var Q_RANK = 'qr_';          // 점수 대기열 접두어
var Q_BATTLE = 'qb_';        // 대결 결과 대기열 접두어

/* ---------------- 웹앱 ---------------- */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('유리수팡')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 처음 한 번 실행: 시트를 만들고, 1분마다 대기열을 시트로 옮기는 자동 실행을 등록합니다. */
function setup() {
  sheet_(SHEET_RANK, RANK_HEADERS);
  sheet_(SHEET_BATTLE, BATTLE_HEADERS);
  Logger.log('✅ 1단계: 시트 준비 완료 (랭킹, 대결기록)');
  try {
    setupTrigger();
  } catch (e) {
    // 학교 계정 정책 등으로 자동 실행 등록이 막혀도 게임은 정상 동작합니다 (아래 maybeFlush_ 참고).
    Logger.log('⚠️ 2단계: 1분 자동 실행 등록 실패 → ' + e.message);
    Logger.log('   게임은 그대로 쓸 수 있어요. 시트 기록은 학생들이 플레이할 때 1분에 한 번씩 자동으로 옮겨집니다.');
  }
}

/** 문제가 생겼을 때 실행: 어느 단계가 막혔는지 실행 로그에 하나씩 보여 줍니다. */
function checkSetup() {
  var steps = [
    ['스프레드시트 연결', function () { return ss_().getName(); }],
    ['시트 확인', function () { return [SHEET_RANK, SHEET_BATTLE].map(function (n) { return n + (ss_().getSheetByName(n) ? ' 있음' : ' 없음'); }).join(', '); }],
    ['캐시', function () { CacheService.getScriptCache().put('ping', '1', 10); return '정상'; }],
    ['스크립트 속성(대기열)', function () { var n = Object.keys(PropertiesService.getScriptProperties().getProperties()).length; return '정상, 대기 중 ' + n + '개'; }],
    ['잠금', function () { var l = LockService.getScriptLock(); l.tryLock(1000); l.releaseLock(); return '정상'; }],
    ['자동 실행', function () { var t = ScriptApp.getProjectTriggers().filter(function (x) { return x.getHandlerFunction() === 'flushQueue'; }); return t.length ? '등록됨' : '없음 (없어도 게임은 동작)'; }]
  ];
  steps.forEach(function (s) {
    try { Logger.log('✅ ' + s[0] + ': ' + s[1]()); } catch (e) { Logger.log('❌ ' + s[0] + ': ' + e.message); }
  });
}

/** 1분마다 대기열을 시트로 옮기는 자동 실행 등록 (setup에서 실패했다면 따로 실행해 보세요) */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'flushQueue') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('flushQueue').timeBased().everyMinutes(1).create();
  Logger.log('✅ 2단계: 1분 자동 실행(flushQueue) 등록 완료');
}

/** 자동 실행이 없어도 기록이 쌓이도록: 학생 요청 중 1분에 한 번만 대기열을 시트로 옮김 */
function maybeFlush_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('flush_recent')) return;
  cache.put('flush_recent', '1', 60);
  try { flush_(10); } catch (e) {}
}

function ss_() {
  return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}
function sheet_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#FFE9A8');
    sh.setFrozenRows(1);
  }
  return sh;
}
function cleanName_(s) {
  return String(s || '').replace(/[<>]/g, '').replace(/^[=+\-@]+/, '').trim().slice(0, 16);
}
function checkMode_(mode, level) {
  if (!MODES[mode] || !LEVELS[level]) throw new Error('모드 정보가 올바르지 않아요.');
}
function qid_(prefix) {
  return prefix + Date.now() + '_' + Math.floor(Math.random() * 1e9);
}

/* ---------------- 점수 저장 (대기열) ---------------- */
function submitScore(p) {
  return saveScore_(p);
}

/** 혼자하기(submitScore)와 대결 종료(updateScore)가 함께 쓰는 저장 함수 */
function saveScore_(p) {
  var name = cleanName_(p.name);
  checkMode_(p.mode, p.level);
  var score = Math.floor(Number(p.score) || 0);
  if (!name) throw new Error('이름이 비어 있어요.');
  if (score <= 0 || score > MAX_SCORE) throw new Error('점수가 올바르지 않아요.');
  var now = Date.now();
  var row = [now, name, p.mode, p.level, score,
    Math.floor(Number(p.maxCombo) || 0), Math.floor(Number(p.clears) || 0),
    p.kind === 'battle' ? '대결' : '혼자'];

  // 1) 대기열에 넣기 (잠금 없이, 아주 빠름)
  PropertiesService.getScriptProperties().setProperty(qid_(Q_RANK), JSON.stringify(row));

  // 2) 랭킹 캐시 고치기
  var entry = { name: name, score: score, maxCombo: row[5], t: now };
  var list = mergeBest_(p.mode, p.level, entry);
  maybeFlush_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].name === name) return { rank: i + 1, best: list[i].score };
  }
  return { rank: 0, best: score };
}

/** 1분마다 자동 실행: 대기열을 모아서 시트에 한 번에 씁니다. 수동 실행해도 됩니다. */
function flushQueue() {
  flush_(20000);
}
function flush_(waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var rk = [], bt = [], done = [];
    Object.keys(all).sort().forEach(function (k) {
      if (done.length >= 3000) return;
      var r;
      try { r = JSON.parse(all[k]); } catch (e) { if (k.indexOf(Q_RANK) === 0 || k.indexOf(Q_BATTLE) === 0) done.push(k); return; }
      if (k.indexOf(Q_RANK) === 0) {
        rk.push([new Date(r[0]), r[1], MODES[r[2]], LEVELS[r[3]], r[4], r[5], r[6], r[7]]);
        done.push(k);
      } else if (k.indexOf(Q_BATTLE) === 0) {
        r[0] = new Date(r[0]); r[2] = MODES[r[2]]; r[3] = LEVELS[r[3]];
        bt.push(r); done.push(k);
      }
    });
    if (rk.length) { var s1 = sheet_(SHEET_RANK, RANK_HEADERS); s1.getRange(s1.getLastRow() + 1, 1, rk.length, 8).setValues(rk); }
    if (bt.length) { var s2 = sheet_(SHEET_BATTLE, BATTLE_HEADERS); s2.getRange(s2.getLastRow() + 1, 1, bt.length, 9).setValues(bt); }
    SpreadsheetApp.flush();
    done.forEach(function (k) { props.deleteProperty(k); });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- 랭킹 ---------------- */
/** 모드·단계별 TOP 20 (한 사람은 최고 기록 1개만) — 캐시에서 바로 읽음 */
function getRanking(mode, level) {
  checkMode_(mode, level);
  return loadBest_(mode, level).slice(0, 20);
}
function bestKey_(mode, level) { return 'best_' + mode + '_' + level; }

function loadBest_(mode, level) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(bestKey_(mode, level));
  if (hit) return JSON.parse(hit);
  var list = buildBest_(mode, level);
  cache.put(bestKey_(mode, level), JSON.stringify(list), BEST_TTL);
  return list;
}

function mergeBest_(mode, level, e) {
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(5000);   // 캐시만 고치므로 순식간에 끝남
  try {
    var list = loadBest_(mode, level);
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].name === e.name) { idx = i; break; }
    if (idx >= 0) {
      if (e.score > list[idx].score || (e.score === list[idx].score && e.maxCombo > list[idx].maxCombo)) list[idx] = e;
    } else {
      list.push(e);
    }
    sortBest_(list);
    list = list.slice(0, BEST_KEEP);
    if (got) CacheService.getScriptCache().put(bestKey_(mode, level), JSON.stringify(list), BEST_TTL);
    return list;
  } finally {
    if (got) lock.releaseLock();
  }
}

function sortBest_(list) {
  list.sort(function (a, b) { return b.score - a.score || b.maxCombo - a.maxCombo || a.t - b.t; });
}

/** 시트 + 아직 시트로 옮기지 않은 대기열을 합쳐 최고 기록 목록을 다시 계산 */
function buildBest_(mode, level) {
  var best = {};
  function take(name, score, combo, t) {
    name = String(name); score = Number(score) || 0; combo = Number(combo) || 0;
    var b = best[name];
    if (!b || score > b.score || (score === b.score && combo > b.maxCombo)) best[name] = { name: name, score: score, maxCombo: combo, t: t };
  }
  var sh = sheet_(SHEET_RANK, RANK_HEADERS);
  var last = sh.getLastRow();
  if (last >= 2) {
    var m = MODES[mode], l = LEVELS[level];
    sh.getRange(2, 1, last - 1, 6).getValues().forEach(function (r) {
      if (r[2] === m && r[3] === l) take(r[1], r[4], r[5], r[0] instanceof Date ? r[0].getTime() : 0);
    });
  }
  var props = PropertiesService.getScriptProperties().getProperties();
  Object.keys(props).forEach(function (k) {
    if (k.indexOf(Q_RANK) !== 0) return;
    try { var r = JSON.parse(props[k]); if (r[2] === mode && r[3] === level) take(r[1], r[4], r[5], r[0]); } catch (e) {}
  });
  var list = Object.keys(best).map(function (k) { return best[k]; });
  sortBest_(list);
  return list.slice(0, BEST_KEEP);
}

/** 시트에서 기록을 지웠을 때 실행하면 랭킹이 바로 새로 계산됩니다. */
function resetRankingCache() {
  var keys = [];
  Object.keys(MODES).forEach(function (m) { Object.keys(LEVELS).forEach(function (l) { keys.push(bestKey_(m, l)); }); });
  CacheService.getScriptCache().removeAll(keys);
}

/* ---------------- 1:1 대결 (캐시만 사용, 잠금 없음) ---------------- */
function roomGet_(code) {
  var v = CacheService.getScriptCache().get('room_' + code);
  return v ? JSON.parse(v) : null;
}
function roomPut_(room) {
  CacheService.getScriptCache().put('room_' + room.code, JSON.stringify(room), ROOM_TTL);
}

function createRoom(p) {
  checkMode_(p.mode, p.level);
  var name = cleanName_(p.name);
  if (!name) throw new Error('이름이 비어 있어요.');
  var code;
  for (var i = 0; i < 30; i++) {
    code = String(Math.floor(1000 + Math.random() * 9000));
    if (!roomGet_(code)) break;
  }
  var room = {
    code: code, mode: p.mode, level: p.level,
    seed: Math.floor(Math.random() * 2147483647),
    host: { id: String(p.id), name: name }, guest: null,
    startAt: 0, created: Date.now(), recorded: false
  };
  roomPut_(room);
  return { room: room, serverNow: Date.now() };
}

function joinRoom(p) {
  var code = String(p.code || '').trim();
  var id = String(p.id);
  var name = cleanName_(p.name);
  if (!name) throw new Error('이름이 비어 있어요.');
  var room = roomGet_(code);
  if (!room) throw new Error('방을 찾을 수 없어요. 번호를 확인해 주세요.');
  if (room.host.id === id) throw new Error('내가 만든 방에는 들어갈 수 없어요.');
  if (room.guest && room.guest.id !== id) throw new Error('이미 두 명이 모두 들어간 방이에요.');
  if (!room.guest) {
    room.guest = { id: id, name: name };
    room.startAt = Date.now() + START_DELAY;
    roomPut_(room);
    // 아주 드물게 두 명이 동시에 들어온 경우: 나중에 기록된 한 명만 남김
    Utilities.sleep(150);
    room = roomGet_(code);
    if (!room || !room.guest || room.guest.id !== id) throw new Error('이미 두 명이 모두 들어간 방이에요.');
  }
  return { room: room, serverNow: Date.now() };
}

function getRoom(code) {
  return { room: roomGet_(String(code)), serverNow: Date.now() };
}

function leaveRoom(p) {
  var room = roomGet_(String(p.code));
  if (room && !room.guest && room.host.id === String(p.id)) {
    CacheService.getScriptCache().remove('room_' + room.code);
  }
  return true;
}

/**
 * 내 점수를 올리고 상대 점수를 받아 옵니다 (게임 중 약 2초마다 호출).
 * 캐시 읽기 1번(내 것+상대 것 한꺼번에) + 쓰기 1번이라 아주 빠릅니다.
 * 게임이 끝난 첫 요청에서는 랭킹 저장까지 같이 해서, 따로 저장 요청을 보내지 않습니다.
 */
function updateScore(p) {
  var cache = CacheService.getScriptCache();
  var code = String(p.code), id = String(p.id), oppId = String(p.oppId || '');
  var myKey = 'sc_' + code + '_' + id, oppKey = 'sc_' + code + '_' + oppId;
  var got = cache.getAll(oppId ? [myKey, oppKey] : [myKey]);
  var prev = got[myKey] ? JSON.parse(got[myKey]) : {};
  var opp = got[oppKey] ? JSON.parse(got[oppKey]) : { score: 0, combo: 0, finished: false };
  var mine = {
    score: Math.min(MAX_SCORE, Math.max(0, Math.floor(Number(p.score) || 0))),
    combo: Math.floor(Number(p.combo) || 0),
    finished: !!p.finished, quit: !!p.quit, t: Date.now(),
    saved: !!prev.saved, rank: prev.rank || null
  };
  if (mine.finished && !mine.quit && !mine.saved && p.rec && mine.score > 0) {
    try {
      mine.rank = saveScore_({ name: p.rec.name, mode: p.rec.mode, level: p.rec.level, score: mine.score,
        maxCombo: p.rec.maxCombo, clears: p.rec.clears, kind: 'battle' });
    } catch (e) { mine.rank = null; }
    mine.saved = true;
  }
  cache.put(myKey, JSON.stringify(mine), ROOM_TTL);

  // 결과 기록은 방장 쪽 요청에서만 (중복 방지, 잠금 불필요)
  if (p.role === 'host' && mine.finished && (opp.finished || p.final)) recordBattle_(code, mine, opp);
  return { opp: { score: opp.score, combo: opp.combo, finished: opp.finished, quit: opp.quit }, rank: mine.rank, serverNow: Date.now() };
}

function recordBattle_(code, h, g) {
  var room = roomGet_(code);
  if (!room || room.recorded || !room.guest) return;
  room.recorded = true;
  roomPut_(room);
  var hs = h.score || 0, gs = g.score || 0;
  var winner = hs > gs ? room.host.name : gs > hs ? room.guest.name : '무승부';
  var row = [Date.now(), code, room.mode, room.level, room.host.name, hs, room.guest.name, gs, winner];
  PropertiesService.getScriptProperties().setProperty(qid_(Q_BATTLE), JSON.stringify(row));
}
