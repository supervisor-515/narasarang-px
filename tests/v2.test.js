const assert = require('node:assert/strict');
const e = require('../js/app');
const {cards} = require('../data/cards.json');
const date = '2026-10-17';
let seq = 0, checks = 0;
const record = (cardId, amount, benefit, day='2026-10-16', specialUsed=false) => ({id:String(++seq),date:day,amount,benefit,cardId,specialUsed});
const options = (records=[], extra={}) => ({ibkMode:'soldier',isDay10:false,date,records,...extra});
const calc = (id, amount, opts) => e.calcCard(cards.find(c=>c.id===id),amount,opts);
function check(label, actual, expected) { assert.deepEqual(actual,expected,label); checks++; }
const cases = [
 ['A',29000,[record('hana',20000,5000),record('hana',10000,3000)], [2000,4350,1000,1000]],
 ['B',20000,[record('kb',10000,1000),record('kb',10000,1000)], [5000,3000,1000,0]],
 ['C',200000,[record('ibk',200000,100000,'2026-09-01',true)], [20000,50000,40000,40000]],
 ['D',100000,[record('shinhan',475000,95000)], [20000,30000,5000,20000]],
 ['E',20000,[record('hana',20000,5000,date)], [0,3000,1000,1000]],
];
for (const [name,amount,records,expected] of cases) {
 const opts=options(records), actual=cards.map(c=>e.calcCard(c,amount,opts).total);
 check(name,actual,expected);
 console.log(`${name}: 하나 ${actual[0]} / IBK ${actual[1]} / 신한 ${actual[2]} / KB ${actual[3]}`);
}
check('A 1위',e.rankCards(cards,29000,options(cases[0][2])).active[0].card.id,'ibk');
check('월 캡 사유',calc('hana',29000,options(cases[0][2])).reasons,['월 잔여 한도까지만 적용']);
check('일 캡 사유',calc('hana',20000,options(cases[4][2])).reasons,['일 잔여 한도까지만 적용']);
const low=Array.from({length:3},()=>record('ibk',1000,150));
check('IBK 소액 3회',calc('ibk',20000,options(low)).total,0);
check('급여 6회 우대',calc('ibk',20000,options(low,{ibkMode:'salary'})).total,3000);
check('급여 6회 소진',calc('ibk',20000,options(low.concat(low))).total,0);
check('급여 실제 6회 소진',calc('ibk',20000,options(low.concat(low),{ibkMode:'salary'})).total,0);
const high=[record('ibk',30000,3000),record('ibk',30000,3000)];
check('IBK 고액 2회',calc('ibk',100000,options(high)).base,0);
check('급여 고액 무제한',calc('ibk',100000,options(high,{ibkMode:'salary'})).base,30000);
check('신한 소액 오늘 소진',calc('shinhan',20000,options([record('shinhan',1000,200,date)])).total,0);
check('신한 고액은 별도',calc('shinhan',30000,options([record('shinhan',1000,200,date)])).total,6000);
check('하나 구간 별도',calc('hana',100000,options(cases[4][2])).total,20000);
check('다른 월 제외',calc('hana',20000,options([record('hana',20000,10000,'2026-09-17')])).total,5000);
check('미래 기록 제외',calc('hana',20000,options([record('hana',20000,10000,'2026-10-18')])).total,5000);
check('다른 연 특별 제외',calc('ibk',200000,options([record('ibk',200000,100000,'2025-10-17',true)])).special,50000);
check('수동 소진',calc('ibk',200000,options([],{manualSpecialUsed:1})).total,50000);
check('급여 수동과 기록 합산',calc('ibk',200000,options(cases[2][2],{ibkMode:'salary',manualSpecialUsed:1})).special,0);
const special=record('ibk',200000,100000,date,true);
check('특별은 기본 월한도와 분리',e.aggregate([special],date,0).cards.ibk.month,[0,50000]);
check('기본 소진도 특별 별도',calc('ibk',200000,options([record('ibk',200000,50000)],{ibkMode:'salary'})).total,50000);
check('보유 제외',e.rankCards(cards,20000,options([],{ownedCards:['kb']})).active.map(r=>r.card.id),['kb']);
check('보유 없음',e.rankCards(cards,20000,options([],{ownedCards:[]})).active,[]);
check('힌트 보유 반영',e.tierHint(cards,29000,options([],{ownedCards:[]})),null);
const backup={version:2,settings:{ownedCards:cards.map(c=>c.id),ibkMode:'salary',manualSpecialUsed:1,day10View:false},records:[special]};
check('백업 왕복',e.validateBackup(JSON.parse(JSON.stringify(backup))),backup);
for (const mutate of [b=>b.records.push(b.records[0]), b=>b.records[0].date='2026-02-30', b=>b.records[0].benefit=-1,b=>b.settings.ownedCards=['unknown'],b=>b.settings.manualSpecialUsed=-1,b=>b.records[0].specialUsed='true']) {
 const b=JSON.parse(JSON.stringify(backup));mutate(b);assert.throws(()=>e.validateBackup(b));checks++;
}
check('연도별 수동 현재 연도',calc('ibk',200000,options([],{manualSpecialUsed:{2026:1,2025:2}})).special,0);
check('다른 연도 수동 제외',calc('ibk',200000,options([],{manualSpecialUsed:{2025:2}})).special,50000);
check('월별 보정 적용',calc('hana',20000,options([],{monthAdjustments:{'2026-10':{hana:8000}}})).total,2000);
check('다른 월 보정 제외',calc('hana',20000,options([],{monthAdjustments:{'2026-09':{hana:8000}}})).total,5000);
check('보정 요약 합산',e.aggregate([record('hana',1000,300)],date,{}, {'2026-10':{hana:8000}}).cards.hana.total,8300);
check('잔여 횟수',calc('ibk',20000,options(low.slice(0,2))).monthCountRemaining,1);
check('IBK만 비활성 유지',e.rankCards(cards,20000,options([],{ownedCards:['ibk'],ibkMode:'none'})).inactive.map(r=>r.card.id),['ibk']);
check('최선 증가 없으면 힌트 숨김',e.tierHint(cards,29000,options([],{ownedCards:['hana'],monthAdjustments:{'2026-10':{hana:100000}}})),null);
const extended=JSON.parse(JSON.stringify(backup));extended.settings.manualSpecialUsed={2026:1};extended.settings.monthAdjustments={'2026-10':{hana:2000}};
check('새 설정 백업 왕복',e.validateBackup(extended),extended);
for (const mutate of [b=>b.settings.manualSpecialUsed={bad:1},b=>b.settings.manualSpecialUsed={2026:-1},b=>b.settings.monthAdjustments={'2026-13':{hana:1}},b=>b.settings.monthAdjustments={'2026-10':{hana:-1}},b=>b.settings.monthAdjustments={'2026-10':{unknown:1}}]) {
 const b=JSON.parse(JSON.stringify(extended));mutate(b);assert.throws(()=>e.validateBackup(b));checks++;
}
console.log(`v2 ${checks}개 검증 통과`);
