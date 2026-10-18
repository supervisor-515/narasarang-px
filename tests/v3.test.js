// tests/v3.test.js — SPEC_V3 7장 7대 핵심 검증 케이스
const assert = require('node:assert/strict');
const engine = require('../js/app.js');
const { cards } = require('../data/cards.json');

const date = '2026-10-17';
let checks = 0;
function check(label, actual, expected) {
  assert.deepEqual(actual, expected, label);
  checks++;
}

console.log('--- SPEC_V3 7장 신규 검증 테스트 ---');

// 1. 보정 구간 분리 (IBK 고액 보정 30,000원 입력 시 IBK 소액 잔여 영향 없음)
{
  const ibkCard = cards.find(c => c.id === 'ibk');
  const adj = {
    '2026-10': {
      ibk: { usedLow: 0, usedHigh: 30000, countLow: 0, countHigh: 1, todayUsed: 0, asOf: date }
    }
  };
  const resLow = engine.calcCard(ibkCard, 10000, {
    ibkMode: 'soldier',
    date,
    monthAdjustments: adj
  });
  // 10,000원의 15% = 1,500원. 소액 잔여 10,000원 및 3회 유지
  check('1-1. IBK 소액 혜택 정상', resLow.total, 1500);
  check('1-2. IBK 소액 월 잔여 한도 유지', resLow.monthRemaining, 10000);
  check('1-3. IBK 소액 월 잔여 횟수 유지', resLow.monthCountRemaining, 3);

  // 고액(10만원)의 경우 고액 보정 30,000원이 차감되어 잔여 20,000원, 횟수 1회 남음
  const resHigh = engine.calcCard(ibkCard, 100000, {
    ibkMode: 'soldier',
    date,
    monthAdjustments: adj
  });
  check('1-4. IBK 고액 월 잔여 한도 차감', resHigh.monthRemaining, 20000);
  check('1-5. IBK 고액 월 잔여 횟수 차감', resHigh.monthCountRemaining, 1);
  console.log('✓ 1. 보정 구간 분리 검증 통과');
}

// 2. 역순 기록 재계산 (하나 소액 20,000원 3건을 날짜 역순으로 넣어도 월 혜택 합계는 월 한도 10,000원을 초과하지 않음)
{
  // 3건을 10월 15일, 10월 12일, 10월 05일 역순으로 제공
  const records = [
    { id: 'rec3', date: '2026-10-15', amount: 20000, cardId: 'hana', benefit: 5000, createdAt: '2026-10-15T12:00:00Z' },
    { id: 'rec2', date: '2026-10-12', amount: 20000, cardId: 'hana', benefit: 5000, createdAt: '2026-10-12T12:00:00Z' },
    { id: 'rec1', date: '2026-10-05', amount: 20000, cardId: 'hana', benefit: 5000, createdAt: '2026-10-05T12:00:00Z' }
  ];

  const replayed = engine.replayRecords(records, {}, {}, date, cards);
  // 재생 후 날짜순: rec1 (10-05) -> 5,000, rec2 (10-12) -> 5,000, rec3 (10-15) -> 0
  const r1 = replayed.find(r => r.id === 'rec1');
  const r2 = replayed.find(r => r.id === 'rec2');
  const r3 = replayed.find(r => r.id === 'rec3');

  check('2-1. 첫 번째 기록 5,000원', r1.benefit, 5000);
  check('2-2. 두 번째 기록 5,000원', r2.benefit, 5000);
  check('2-3. 세 번째 기록 한도 초과 0원', r3.benefit, 0);

  const totalBenefit = replayed.reduce((sum, r) => sum + r.benefit, 0);
  check('2-4. 월 혜택 합계 10,000원 한도 일치', totalBenefit, 10000);
  console.log('✓ 2. 역순 기록 재계산 검증 통과');
}

// 3. 10일 자동 적용 (날짜가 10일이면 신한 50% 자동 적용)
{
  const shinhanCard = cards.find(c => c.id === 'shinhan');
  // 10월 10일 (10일 자동 적용)
  const resDay10 = engine.calcCard(shinhanCard, 1500, { date: '2026-10-10' });
  check('3-1. 10일 자동 적용 신한 1,500원 50% = 750원', resDay10.total, 750);
  check('3-2. day10 플래그 참', resDay10.day10, true);

  // 10월 11일 (평일 정상 적용)
  const resDay11 = engine.calcCard(shinhanCard, 1500, { date: '2026-10-11' });
  check('3-3. 평일 자동 적용 신한 1,500원 20% = 300원', resDay11.total, 300);
  check('3-4. day10 플래그 거짓', resDay11.day10, false);
  console.log('✓ 3. 10일 자동 적용 검증 통과');
}

// 4. 동률·근소차 희소성 우선 (500원 이하 차이 시 희소 자원 아끼는 카드 1위 + 이유 문구)
{
  // 70,000원 결제 시:
  // 하나 14,000 (금액 한도, 점수 1)
  // IBK 14,000 (고액 횟수 월 2회 소모, 점수 4)
  // 신한 14,000 (금액 한도, 점수 1)
  const ranked = engine.rankCards(cards, 70000, {
    ibkMode: 'soldier',
    date: '2026-10-17'
  });
  check('4-1. 1위는 희소 자원을 아끼는 하나', ranked.active[0].card.id, 'hana');
  check('4-2. 2위도 금액 한도만 쓰는 신한', ranked.active[1].card.id, 'shinhan');
  check('4-3. IBK는 고액 횟수를 아끼기 위해 3위로 양보', ranked.active[2].card.id, 'ibk');
  check('4-4. 추천 이유 문구 생성', ranked.reasonLine, '혜택이 같아서 IBK는 10만원 이상 결제를 위해 아꼈어요.');

  // 기본 카드 설정 시 동률 최종 우선
  const rankedDefault = engine.rankCards(cards, 70000, {
    ibkMode: 'soldier',
    date: '2026-10-17',
    defaultCard: 'shinhan'
  });
  check('4-5. 기본 카드로 설정한 신한이 1위', rankedDefault.active[0].card.id, 'shinhan');
  console.log('✓ 4. 동률·근소차 희소성 우선 검증 통과');
}

// 5. 구간 힌트 순이익 조건 (순이익 > 0 일 때만 노출, 20만원 특별할인 경계 포함)
{
  // 29,000원: 30,000원으로 올리면 add=1,000, gain=1,000, netGain = 0 -> null
  const hint29 = engine.tierHint(cards, 29000, { ibkMode: 'soldier' });
  check('5-1. 순이익 0원은 힌트 미표시', hint29, null);

  // 150,000원: 200,000원(IBK 특별할인) 도달 시 add=50,000, gain=55,000, netGain=5,000 > 0
  const hint150 = engine.tierHint(cards, 150000, { ibkMode: 'soldier' });
  check('5-2. 20만원 특별할인 경계로 힌트 생성', hint150.target, 200000);
  check('5-3. 추가 금액 50,000원', hint150.add, 50000);
  check('5-4. 순이익 5,000원', hint150.netGain, 5000);
  check('5-5. 힌트 문구 형식 일치', engine.hintText(hint150), '50,000원 더 담으면 혜택 +55,000원 · 순이익 +5,000원');
  console.log('✓ 5. 구간 힌트 순이익 조건 검증 통과');
}

// 6. 자격 게이트 및 미확인 상태
{
  const kbCard = cards.find(c => c.id === 'kb');
  const ibkCard = cards.find(c => c.id === 'ibk');
  const shinhanCard = cards.find(c => c.id === 'shinhan');

  // 간부인 경우 KB 비활성
  check('6-1. 간부 KB 비활성', engine.calcCard(kbCard, 10000, { militaryStatus: 'officer' }).base, 0);

  // 신한 계좌 미연결인 경우 캐시백 0원
  check('6-2. 신한 계좌 미연결 0원', engine.calcCard(shinhanCard, 50000, { shinhanAccount: false }).total, 0);

  // 미확인 상태
  check('6-3. 신한 계좌 미확인 플래그', engine.isUnconfirmed(shinhanCard, { shinhanAccount: 'unconfirmed' }), true);
  check('6-4. KB 신분 미확인 플래그', engine.isUnconfirmed(kbCard, { militaryStatus: 'unconfirmed' }), true);

  // 급여이체 시작월 다음 달 적용 규칙
  check('6-5. 급여이체 당월은 우대 미적용', engine.hasSalaryPrivilege({
    date: '2026-10-17',
    ibkSalary: true,
    ibkSalaryStartMonth: '2026-10'
  }), false);
  check('6-6. 급여이체 다음달부터 우대 적용', engine.hasSalaryPrivilege({
    date: '2026-11-01',
    ibkSalary: true,
    ibkSalaryStartMonth: '2026-10'
  }), true);
  console.log('✓ 6. 자격 게이트 검증 통과');
}

// 7. v2 → v3 마이그레이션 및 백업 검증
{
  const v2Backup = {
    version: 2,
    settings: {
      ownedCards: ['hana', 'ibk', 'shinhan'],
      ibkMode: 'soldier',
      manualSpecialUsed: 1,
      monthAdjustments: { '2026-10': { hana: 8000 } },
      day10View: false
    },
    records: [
      { id: '1', date: '2026-10-15', amount: 20000, benefit: 5000, cardId: 'hana', specialUsed: false }
    ]
  };

  const v3Data = engine.migrateV2ToV3(v2Backup);
  check('7-1. 버전 3 승격', v3Data.version, 3);
  check('7-2. 보유 카드 유지', v3Data.settings.ownedCards, ['hana', 'ibk', 'shinhan']);
  check('7-3. 기존 prior 폐기', Object.keys(v3Data.settings.adjustments).length, 0);
  check('7-4. prior 폐기 배너 플래그 설정', v3Data.settings.priorDiscardedBanner, true);
  check('7-5. 기록 specialApplied 포맷 변환', v3Data.records[0].specialApplied, false);
  check('7-6. v3 백업 검증 통과', engine.validateBackup(v3Data), v3Data);

  // 금액대 카드표 산출 (sweepCardTable)
  const table = engine.sweepCardTable(cards, { ibkMode: 'soldier', date: '2026-10-17' });
  check('7-7. 카드표 5개 구간 생성', table.length, 5);
  check('7-8. 3만원 미만 1위는 하나', table[0].card.short, '하나');
  console.log('✓ 7. 마이그레이션 및 카드표 검증 통과');
}

console.log(`\n신규 v3 테스트 ${checks}개 항목 전부 통과!`);
