const SHEET_NAME = '점수기록';
const MODES = ['normal', 'hard', 'challenge'];
const TOP_N = 10;
const CACHE_SEC = 21600; // 캐시 최대 6시간

// 웹 앱을 열었을 때 게임 화면 제공
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('도형 방어선');
}

// 점수 기록 시트 준비
function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet(); // 이 스크립트가 붙어 있는 스프레드시트
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      '저장 시각', '이름', '모드', '점수',
      '도달 단계', '처치 로봇', '격파 보스',
      '명중 횟수', '생존 시간(초)'
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 최초 1회 실행 + 시트를 직접 수정(행 삭제 등)한 뒤에도 한 번 실행
function setup() {
  getSheet_();
  rebuildRankings_();
}

// ---------- 상위 10명 저장소 (시트 전체를 매번 읽지 않도록) ----------
function key_(d) { return 'top_' + d; }

function readTopFromProps_(d) {
  const p = PropertiesService.getScriptProperties().getProperty(key_(d));
  return p ? JSON.parse(p) : null;
}

function writeTop_(d, list) {
  const s = JSON.stringify(list);
  PropertiesService.getScriptProperties().setProperty(key_(d), s);
  CacheService.getScriptCache().put(key_(d), s, CACHE_SEC);
}

// 시트 전체를 한 번 읽어 세 모드의 랭킹을 다시 계산
function rebuildRankings_() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  const rows = lastRow < 2 ? [] : sheet.getRange(2, 2, lastRow - 1, 3).getValues(); // 이름, 모드, 점수
  const result = {};
  MODES.forEach(d => {
    const list = rows
      .filter(r => r[1] === d)
      .map(r => ({ name: String(r[0]), score: Number(r[2]) || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N);
    writeTop_(d, list);
    result[d] = list;
  });
  return result;
}

// ---------- 클라이언트에서 호출하는 함수 ----------

// 게임 종료 시 점수 저장
function saveScore(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('점수 데이터가 올바르지 않습니다.');

  const name = String(payload.name || '').trim().replace(/[<>]/g, '').slice(0, 20);
  const difficulty = String(payload.difficulty || '');
  const score = Math.floor(Number(payload.score));

  if (!name) throw new Error('이름을 입력해 주세요.');
  if (!MODES.includes(difficulty)) throw new Error('게임 모드가 올바르지 않습니다.');
  if (!Number.isFinite(score) || score < 0) throw new Error('점수가 올바르지 않습니다.');

  const row = [
    new Date(), name, difficulty, score,
    Number(payload.stage) || 1,
    Number(payload.kills) || 0,
    Number(payload.boss) || 0,
    Number(payload.hits) || 0,
    Number(payload.survival) || 0
  ];

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('저장 요청이 몰렸어요. 잠시 후 다시 시도해 주세요.');

  try {
    getSheet_().appendRow(row);

    // 시트를 다시 읽지 않고 저장된 상위 10명에 새 점수만 끼워 넣기
    let list = readTopFromProps_(difficulty);
    if (!list) list = rebuildRankings_()[difficulty]; // 최초 1회만 시트 전체 읽기
    else {
      list.push({ name: name, score: score });
      list.sort((a, b) => b.score - a.score);
      list = list.slice(0, TOP_N);
      writeTop_(difficulty, list);
    }
    return list;
  } finally {
    lock.releaseLock();
  }
}

// 모드별 상위 10명 조회 (시트를 열지 않음)
function getRanking(difficulty) {
  if (!MODES.includes(difficulty)) difficulty = 'normal';

  const cached = CacheService.getScriptCache().get(key_(difficulty));
  if (cached) return JSON.parse(cached);

  const list = readTopFromProps_(difficulty);
  if (list) {
    CacheService.getScriptCache().put(key_(difficulty), JSON.stringify(list), CACHE_SEC);
    return list;
  }
  return rebuildRankings_()[difficulty];
}
