// data/cards.json의 examples로 계산 엔진 검증: node tests/examples.test.js
const path = require('path');
const engine = require('../js/app.js');
const data = require('../data/cards.json');

const IDS = ['hana', 'ibk', 'shinhan', 'kb'];
let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  return ok ? String(actual) : `${actual} (기대 ${expected}) FAIL`;
}

console.log('examples (평일 · IBK 현역병)');
for (const ex of data.examples) {
  const opts = { ibkMode: 'soldier', isDay10: false };
  const cells = IDS.map((id) => {
    const card = data.cards.find((c) => c.id === id);
    const r = engine.calcCard(card, ex.amount, opts);
    return `${card.short} ${check(id, r.total, ex.expected[id])}`;
  });
  console.log(`  ${ex.amount.toLocaleString('ko-KR')}원: ${cells.join(' / ')}`);
  if (ex.ibkBreakdown) {
    const ibk = data.cards.find((c) => c.id === 'ibk');
    const r = engine.calcCard(ibk, ex.amount, opts);
    check('ibk base', r.base, 50000);
    check('ibk special', r.special, 50000);
    console.log(`    IBK 분해: ${engine.specialLine(ibk, r, opts)}`);
  }
}

// 규칙 보조 검증
const card = (id) => data.cards.find((c) => c.id === id);
const extra = [
  ['급여이체도 금액 동일 (20만원 IBK)', engine.calcCard(card('ibk'), 200000, { ibkMode: 'salary' }).total, 100000],
  ['해당 없음은 특별 제외 (20만원 IBK 참고값)', engine.calcCard(card('ibk'), 200000, { ibkMode: 'none' }).total, 50000],
  ['신한 10일 2만원 → 50% 후 건당 1천원', engine.calcCard(card('shinhan'), 20000, { isDay10: true }).total, 1000],
  ['신한 10일 1,500원 → 750원', engine.calcCard(card('shinhan'), 1500, { isDay10: true }).total, 750],
  ['신한 평일 1,500원 → 300원', engine.calcCard(card('shinhan'), 1500, { isDay10: false }).total, 300],
  ['구간 경계 3만원은 이상 구간 (하나 20%)', engine.calcCard(card('hana'), 30000, {}).total, 6000],
];
console.log('보조 규칙');
for (const [label, actual, expected] of extra) console.log(`  ${label}: ${check(label, actual, expected)}`);

// 랭킹: 5만원 하나·신한 공동 1위, IBK 해당 없음이면 비활성
const r50 = engine.rankCards(data.cards, 50000, { ibkMode: 'soldier' });
const top = r50.active.filter((r) => r.rank === 1).map((r) => r.card.id).join(',');
console.log(`  5만원 공동 1위: ${check('tie', top, 'hana,shinhan')}`);
console.log(`  5만원 순위: ${r50.active.map((r) => r.card.short + r.rank).join(' ')}`);
const rNone = engine.rankCards(data.cards, 200000, { ibkMode: 'none' });
console.log(`  해당 없음 비활성: ${check('inactive', rNone.inactive.map((r) => r.card.id).join(','), 'ibk')}`);

// 월한도 상한: 큰 금액
console.log('큰 금액 (월한도 상한 · 평일 · IBK 현역병)');
const big = { hana: 20000, ibk: 100000, shinhan: 100000, kb: 50000 };
const bigOpts = { ibkMode: 'soldier', isDay10: false };
console.log(`  1,000,000원: ${IDS.map((id) => `${card(id).short} ${check(id, engine.calcCard(card(id), 1000000, bigOpts).total, big[id])}`).join(' / ')}`);
const ibkBig = engine.calcCard(card('ibk'), 1000000, bigOpts);
check('ibk 100만 base', ibkBig.base, 50000);
check('ibk 100만 special', ibkBig.special, 50000);
console.log(`    IBK 분해: ${engine.specialLine(card('ibk'), ibkBig, bigOpts)}`);
console.log(`    신한 조건: ${engine.conditionLine(card('shinhan'), engine.calcCard(card('shinhan'), 1000000, bigOpts), bigOpts, true)}`);

// 토글
console.log('토글');
const spent = { ibkMode: 'soldier', ibkSpecialLeft: false };
const ibkSpent = engine.calcCard(card('ibk'), 200000, spent);
console.log(`  특별할인 소진 20만원 IBK → ${check('spent', ibkSpent.total, 50000)} (${engine.conditionLine(card('ibk'), ibkSpent, spent, true)})`);
console.log(`  10일 보기 신한 2만원 → ${check('day10 view', engine.calcCard(card('shinhan'), 20000, { isDay10: true }).total, 1000)}, 1,500원 → ${check('day10 view small', engine.calcCard(card('shinhan'), 1500, { isDay10: true }).total, 750)}`);

// 서울 날짜
console.log('날짜 (Asia/Seoul)');
console.log(`  2026-10-09T15:30Z → ${check('seoul day', engine.seoulDate(new Date('2026-10-09T15:30:00Z')).day, 10)}일`);
console.log(`  2026-10-10T15:00Z → ${check('seoul day next', engine.seoulDate(new Date('2026-10-10T15:00:00Z')).key, '2026-10-11')}`);

// 구간 힌트
console.log('구간 힌트');
const hintOpts = { ibkMode: 'soldier', isDay10: false };
for (const [amount, expected] of [
  [29000, '1,000원 더 담아 30,000원에 맞추면 최대 혜택 6,000원 (지금보다 +1,000)'],
  [65000, '5,000원 더 담아 70,000원에 맞추면 최대 혜택 14,000원 (지금보다 +1,000)'],
  [150000, null],
]) {
  const hint = engine.tierHint(data.cards, amount, hintOpts);
  console.log(`  ${amount.toLocaleString('ko-KR')}원: ${check('hint ' + amount, hint && engine.hintText(hint), expected)}`);
}

console.log(failures ? `\n실패 ${failures}건` : '\n전부 통과');
process.exit(failures ? 1 : 0);
