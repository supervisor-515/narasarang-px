// tests/ui.test.js — UI 상호작용 및 SPEC_V3 전면 검증
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const code = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const data = require('../data/cards.json');
const tick = () => new Promise(r => setTimeout(r, 10));

async function boot(stored, fail = false, offline = false, testDate = '2026-10-17T03:00:00Z') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/' });
  const w = dom.window;
  w.scrollTo = () => {};
  w.confirm = () => true;

  // 타이머 이벤트 루프 hang 방지 (테스트 하네스에서 unref 처리)
  const activeTimers = new Set();
  w.setInterval = (fn, ms) => {
    const t = setInterval(fn, ms);
    if (t && typeof t.unref === 'function') t.unref();
    activeTimers.add(t);
    return t;
  };
  w.clearInterval = (t) => {
    clearInterval(t);
    activeTimers.delete(t);
  };

  const DateBase = w.Date;
  w.Date = class extends DateBase {
    constructor(...a) {
      super(...(a.length ? a : [testDate]));
    }
    static now() {
      return new w.Date().getTime();
    }
  };

  if (stored) {
    if (typeof stored === 'string' && stored.includes('"version":2')) {
      w.localStorage.setItem('pxpick:v2', stored);
    } else {
      w.localStorage.setItem('pxpick:v3', typeof stored === 'string' ? stored : JSON.stringify(stored));
    }
  }

  w.fetch = () => fail ? Promise.reject(Error('offline')) : Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  if (offline) Object.defineProperty(w.navigator, 'serviceWorker', { value: { ready: Promise.resolve({ active: {} }) } });

  w.eval(code);
  await tick();

  const origClose = dom.window.close.bind(dom.window);
  dom.window.close = () => {
    for (const t of activeTimers) clearInterval(t);
    activeTimers.clear();
    origClose();
  };

  return dom;
}

let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks++;
}

(async () => {
  // ==========================================
  // 1. 첫 방문 온보딩 모달 & 기본 UI 화면 검증
  // ==========================================
  let dom = await boot();
  let w = dom.window;
  let d = w.document;
  const $ = id => d.getElementById(id);
  const input = (id, value) => {
    const el = $(id);
    el.value = value;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  };

  check('첫 방문 시 온보딩 모달 노출', $('onboarding-modal').hidden, false);
  $('onboard-finish').click();
  check('온보딩 완료 후 모달 숨김', $('onboarding-modal').hidden, true);

  // 기본 입력 속성 및 가상 키패드·옛 토글 제거 확인
  check('금액 입력창 readOnly false', $('amount').readOnly, false);
  check('금액 입력창 numeric inputmode', $('amount').inputMode, 'numeric');
  check('가상 키패드 제거됨', d.querySelector('.keypad'), null);
  check('옛 10일 토글 영구 삭제됨', $('toggle-day10'), null);
  check('결제 탭에서 상품 설명서 제거됨', $('panel-compare').querySelector('.card-detail'), null);

  // 신선도 줄 초기 상태
  check('기록 없을 때 신선도 줄 텍스트', $('freshness-text').textContent, '아직 결제 기록이 없어요');

  // 금액대 카드표 렌더링 확인
  check('금액대 카드표 행 존재', $('card-table').querySelectorAll('.card-table__row').length > 0, true);

  // ==========================================
  // 2. 정확한 금액 입력 + 추천 히어로 + 거래 단위 저장 상태
  // ==========================================
  input('amount', '29,000');
  check('29,000원 1위 하나 5,000원 히어로 표시', /5,000원/.test($('result').textContent), true);
  check('기록 버튼 기본 텍스트', $('record-best').textContent, '하나로 결제 기록');
  check('기록 버튼 활성화 상태', $('record-best').disabled, false);

  // 기록 저장 실행
  $('record-best').click();
  let saved = JSON.parse(w.localStorage.getItem('pxpick:v3'));
  check('v3 스토리지에 저장된 기록 1건', saved.records.length, 1);
  check('저장된 카드 ID는 hana', saved.records[0].cardId, 'hana');
  check('저장된 금액은 29000', saved.records[0].amount, 29000);

  // 중복 저장 방지: 저장 완료 상태로 전환
  check('저장 직후 버튼 비활성화', $('record-best').disabled, true);
  check('저장 직후 버튼 텍스트', $('record-best').textContent, '저장됨 · 하나 29,000원');
  check('신선도 줄 오늘 기록 건수 반영', $('freshness-text').textContent, '오늘 1건 기록됨');
  check('실행 취소 버튼 노출', /실행 취소/.test($('quick-feedback').textContent), true);

  // 금액 변경 시 버튼 상태 재활성화
  input('amount', '30,000');
  check('금액 변경 시 버튼 다시 활성화', $('record-best').disabled, false);
  check('30,000원 버튼 텍스트', $('record-best').textContent, '하나로 결제 기록');

  // 다시 29,000원으로 돌리면 동일 거래 차단 (비활성화 유지)
  input('amount', '29,000');
  check('원래 결제 금액으로 복귀 시 중복 저장 차단', $('record-best').disabled, true);
  check('중복 저장 차단 텍스트', $('record-best').textContent, '저장됨 · 하나 29,000원');

  // 빠른 카드 선택 변경 시 활성화
  input('quick-card', 'ibk');
  $('quick-card').dispatchEvent(new w.Event('change'));
  check('카드 변경 시 활성화', $('record-best').disabled, false);
  check('카드 변경 시 버튼 텍스트', $('record-best').textContent, 'IBK로 결제 기록');

  // 하나로 복귀 후 실행 취소 클릭
  input('quick-card', 'hana');
  $('quick-card').dispatchEvent(new w.Event('change'));
  check('하나 복귀 시 비활성', $('record-best').disabled, true);
  $('quick-feedback').querySelector('button').click();
  saved = JSON.parse(w.localStorage.getItem('pxpick:v3'));
  check('실행 취소 후 기록 삭제됨', saved.records.length, 0);
  check('실행 취소 후 버튼 다시 활성화', $('record-best').disabled, false);
  check('실행 취소 후 신선도 줄 복구', $('freshness-text').textContent, '아직 결제 기록이 없어요');

  // ==========================================
  // 3. 탭 네비게이션 전환 (결제 / 내역 / 내 카드)
  // ==========================================
  // 내역 탭 전환
  $('tab-records').click();
  check('내역 패널 노출', $('panel-records').hidden, false);
  check('결제 패널 숨김', $('panel-compare').hidden, true);
  check('내 카드 패널 숨김', $('panel-settings').hidden, true);
  check('내역 탭 aria-selected', $('tab-records').getAttribute('aria-selected'), 'true');

  // 내 카드 탭 전환
  $('tab-settings').click();
  check('내 카드 패널 노출', $('panel-settings').hidden, false);
  check('내역 패널 숨김', $('panel-records').hidden, true);
  check('내 카드 탭 aria-selected', $('tab-settings').getAttribute('aria-selected'), 'true');

  // 결제 탭 복귀
  $('tab-compare').click();
  check('결제 패널 다시 노출', $('panel-compare').hidden, false);
  check('내 카드 패널 숨김', $('panel-settings').hidden, true);

  // ==========================================
  // 4. 내역 탭 기능 (구간별 게이지, 직접 추가, 기록 재생, 삭제)
  // ==========================================
  $('tab-records').click();

  // 구간별 잔여 게이지 확인
  check('구간별 게이지 렌더링', $('usage-gauges').querySelectorAll('.gauge-card').length, 4);
  check('3만원 미만 구간 표시', /3만원 미만 구간/.test($('usage-gauges').textContent), true);
  check('3만원 이상 구간 표시', /3만원 이상 구간/.test($('usage-gauges').textContent), true);
  check('옛 2만원 하드코딩 없음', /2만원 미만/.test($('panel-records').textContent), false);

  // 기록 직접 추가 폼
  input('record-date', '2026-10-10');
  input('record-amount', '1500');
  input('record-card', 'shinhan');
  check('10일 신한 1,500원 예상 혜택 750원 미리보기', /750원/.test($('record-preview').textContent), true);

  $('record-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  saved = JSON.parse(w.localStorage.getItem('pxpick:v3'));
  check('직접 추가로 기록 1건 저장', saved.records.length, 1);
  check('저장 피드백 안내', /결제 기록을 저장했어요/.test($('record-feedback').textContent), true);

  // 하나 20,000원 추가 (2026-10-12)
  input('record-date', '2026-10-12');
  input('record-amount', '20000');
  input('record-card', 'hana');
  $('record-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  saved = JSON.parse(w.localStorage.getItem('pxpick:v3'));
  check('기록 2건 저장됨', saved.records.length, 2);

  // 기록 목록 렌더링 확인 (날짜 최신순: 10-12, 10-10)
  const recordItems = $('record-list').querySelectorAll('.record-item');
  check('기록 목록 2건 렌더링', recordItems.length, 2);

  // 기록 삭제 클릭 시 자동 재생 및 재계산
  recordItems[0].querySelector('button').click();
  saved = JSON.parse(w.localStorage.getItem('pxpick:v3'));
  check('삭제 후 기록 1건 유지', saved.records.length, 1);
  check('남은 기록은 신한', saved.records[0].cardId, 'shinhan');

  // ==========================================
  // 5. 내 카드 탭 설정 (자격 조건, 구간별 보정, 카드 상세 아코디언)
  // ==========================================
  $('tab-settings').click();

  // 5-1. 신분 선택
  const milBtns = $('military-status').querySelectorAll('button');
  const officerBtn = Array.from(milBtns).find(b => b.dataset.status === 'officer');
  const soldierBtn = Array.from(milBtns).find(b => b.dataset.status === 'soldier');
  const unconfBtn = Array.from(milBtns).find(b => b.dataset.status === 'unconfirmed');

  // 간부 선택 시 KB/IBK 비활성 처리
  officerBtn.click();
  check('간부 선택 반영', JSON.parse(w.localStorage.getItem('pxpick:v3')).settings.militaryStatus, 'officer');
  $('tab-compare').click();
  input('amount', '50,000');
  // 간부이면 KB와 IBK는 active가 아님
  check('간부 시 KB/IBK 참고 처리', d.querySelectorAll('.ranks--off .rank').length >= 1, true);

  // 미확인 신분 선택 시
  $('tab-settings').click();
  unconfBtn.click();
  check('미확인 신분 반영', JSON.parse(w.localStorage.getItem('pxpick:v3')).settings.militaryStatus, 'unconfirmed');
  $('tab-compare').click();
  input('amount', '20,000');
  check('미확인 상태에서 조건 미확인 배지 노출', /조건 미확인/.test($('result').textContent), true);

  // 병사로 복구
  $('tab-settings').click();
  soldierBtn.click();

  // 5-2. 보유 카드 선택 해제/전체 해제
  const ownedInputs = $('owned-cards').querySelectorAll('input');
  for (const c of ownedInputs) {
    c.checked = false;
    c.dispatchEvent(new w.Event('change'));
  }
  check('보유 카드 모두 해제', JSON.parse(w.localStorage.getItem('pxpick:v3')).settings.ownedCards.length, 0);
  $('tab-compare').click();
  check('카드 전부 해제 시 안내', /보유 카드를 선택/.test($('result').textContent), true);
  check('카드 전부 해제 시 기록 버튼 비활성', $('record-best').disabled, true);

  // 카드 전부 다시 체크
  $('tab-settings').click();
  for (const c of $('owned-cards').querySelectorAll('input')) {
    c.checked = true;
    c.dispatchEvent(new w.Event('change'));
  }

  // 5-3. 기본 카드 설정 (동률 시 우선순위)
  $('default-card').value = 'hana';
  $('default-card').dispatchEvent(new w.Event('change'));
  check('기본 카드 설정 저장', JSON.parse(w.localStorage.getItem('pxpick:v3')).settings.defaultCard, 'hana');

  // 5-4. IBK 조건 설정 및 연도별 특별할인 저장
  $('manual-special').value = '1';
  $('manual-special').dispatchEvent(new w.Event('change'));
  check('IBK 특별할인 올해 연도 키로 저장', JSON.parse(w.localStorage.getItem('pxpick:v3')).settings.manualSpecialUsed, { '2026': 1 });

  // 5-5. 구간별 보정 (기록 전 사용분)
  const hanaLowAdj = $('month-adjustments').querySelector('[data-card="hana"][data-field="usedLow"]');
  hanaLowAdj.value = '8000';
  hanaLowAdj.dispatchEvent(new w.Event('change'));
  check('하나 소액 보정 저장', JSON.parse(w.localStorage.getItem('pxpick:v3')).settings.adjustments['2026-10'].hana.usedLow, 8000);

  $('tab-compare').click();
  input('amount', '20,000');
  check('소액 8,000원 보정으로 월 잔여 2,000원 표시', /월 잔여 2,000원/.test($('result').textContent), true);

  // 5-6. 카드별 접이식 상세 아코디언 확인 (비PX 혜택 포함)
  $('tab-settings').click();
  const cardDetails = $('card-details-list').querySelectorAll('.card-detail');
  check('카드 상세 아코디언 4장 렌더링', cardDetails.length, 4);
  check('비PX 대표 혜택 포함 확인', /놀이공원|영화|커피/.test($('card-details-list').textContent), true);

  // 5-7. 데이터 관리 버튼 존재 확인
  check('JSON 내보내기 버튼 존재', $('export-data') != null, true);
  check('JSON 가져오기 필드 존재', $('import-data') != null, true);
  check('데이터 초기화 버튼 존재', $('delete-data') != null, true);

  w.close();

  // ==========================================
  // 6. 10일 자동 적용 검증 (토글 없음, 날짜 기반 자동 판정)
  // ==========================================
  // 10일인 경우 (2026-10-10)
  dom = await boot(null, false, false, '2026-10-10T03:00:00Z');
  w = dom.window;
  d = w.document;
  input('amount', '1500');
  check('10일 자동 50% 적용: 750원', /750원/.test(d.getElementById('result').textContent), true);
  check('10일 규칙으로 순위 변경 시 배지 노출', d.getElementById('day10-badge').hidden, false);
  check('10일 배지 문구', d.getElementById('day10-badge').textContent, '오늘은 매월 10일 혜택이 적용돼요');
  w.close();

  // 비 10일인 경우 (2026-10-17)
  dom = await boot(null, false, false, '2026-10-17T03:00:00Z');
  w = dom.window;
  d = w.document;
  input('amount', '1500');
  check('비 10일 일반 20% 적용: 300원', /300원/.test(d.getElementById('result').textContent), true);
  check('비 10일 배지 숨김', d.getElementById('day10-badge').hidden, true);
  w.close();

  // ==========================================
  // 7. v2 -> v3 마이그레이션 검증
  // ==========================================
  const v2Backup = JSON.stringify({
    version: 2,
    settings: {
      ownedCards: ['hana', 'ibk', 'shinhan'],
      ibkMode: 'soldier',
      manualSpecialUsed: 1,
      monthAdjustments: { '2026-10': { hana: 5000 } },
      day10View: false
    },
    records: [
      { id: '1', date: '2026-10-10', amount: 20000, benefit: 1234, cardId: 'hana', specialUsed: false }
    ]
  });
  dom = await boot(v2Backup);
  w = dom.window;
  d = w.document;

  const migrated = JSON.parse(w.localStorage.getItem('pxpick:v3'));
  check('v3 스토리지 키 생성됨', migrated != null, true);
  check('v3 버전 번호', migrated.version, 3);
  check('구 prior 안내 배너 노출', d.getElementById('prior-notice-banner').hidden, false);

  // 내역 탭에서 기록 재생 검증 (구 1,234원 무시하고 20,000원에 대해 재계산: 하나 30% 건당 5,000원 상한 = 5,000원)
  d.getElementById('tab-records').click();
  check('과거 기록 v3 엔진으로 재계산 (5,000원)', /5,000원/.test(d.getElementById('record-list').textContent), true);
  check('구 기록 benefit(1,234원) 무시됨', !d.getElementById('record-list').textContent.includes('1,234'), true);
  w.close();

  // ==========================================
  // 8. 신선도 줄 과거 날짜 계산 검증
  // ==========================================
  const pastData = JSON.stringify({
    version: 3,
    settings: {
      ownedCards: ['hana', 'ibk', 'shinhan', 'kb'],
      manualSpecialUsed: { '2026': 0 }
    },
    records: [
      { id: 'rec-past', date: '2026-10-14', amount: 10000, cardId: 'hana' }
    ]
  });
  dom = await boot(pastData, false, false, '2026-10-17T03:00:00Z');
  w = dom.window;
  d = w.document;
  check('3일 전 기록 신선도 표시', d.getElementById('freshness-text').textContent, '마지막 기록 3일 전 (2026-10-14)');
  w.close();

  // ==========================================
  // 9. 오류 및 오프라인 상태 처리 검증
  // ==========================================
  dom = await boot('{broken', true);
  w = dom.window;
  d = w.document;
  check('데이터 로드 실패 시 다시 시도 버튼 노출', /다시 시도/.test(d.getElementById('result').textContent), true);
  w.close();

  dom = await boot(null, false, true);
  w = dom.window;
  d = w.document;
  check('오프라인 준비 상태 표시', d.getElementById('offline-status').hidden, false);
  w.close();

  console.log(`UI ${checks}개 검증 전수 통과: 온보딩 모달 · 기본 입력/키패드 · 추천 히어로 · 거래 단위 저장/중복 방지/실행 취소 · 탭 전환 · 구간별 게이지 · 직접 추가/목록/삭제 재생 · 자격 설정(신분/기본카드/보유/IBK/신한) · 구간별 보정 · 카드 상세 아코디언 · 10일 자동 적용/배지 · v2 마이그레이션 · 신선도 날짜 · 오프라인/오류`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
