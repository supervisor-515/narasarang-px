// 비교 탭: 이번 결제에 쓸 카드(일시 제외) · 물건별 계산
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script[\s\S]*?<\/script>/g,'');
const code=fs.readFileSync(path.join(root,'js/app.js'),'utf8');
const data=require('../data/cards.json');
const tick=()=>new Promise(r=>setTimeout(r,10));
async function boot(stored) {
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'https://example.test/'}), w=dom.window;
 w.scrollTo=()=>{};w.confirm=()=>true;
 const DateBase=w.Date;w.Date=class extends DateBase {constructor(...a){super(...(a.length?a:['2026-10-17T03:00:00Z']));}};
 if(stored)w.localStorage.setItem('pxpick:v2',stored);
 w.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve(data)});
 w.eval(code);await tick();return dom;
}
// 1위(hero) + 나머지 순위를 [카드 짧은 이름, 혜택] 으로
function ranking(d) {
 const rows=[];
 d.querySelectorAll('#result .hero__name').forEach(n=>rows.push([n.textContent,d.querySelector('#result .hero__amount').textContent]));
 d.querySelectorAll('#result .ranks:not(.ranks--off) .rank').forEach(r=>rows.push([r.querySelector('.rank__name').textContent,r.querySelector('.rank__amount').textContent]));
 return rows;
}
const short=(rows)=>rows.map(([name,amount])=>{const c=data.cards.find(c=>name.startsWith(c.name));if(!c)throw Error('카드 이름 매칭 실패: '+JSON.stringify(name));return c.short+' '+amount;});
let checks=0;
function check(label,actual,expected){assert.deepEqual(actual,expected,label);checks++;}
(async()=>{
 let dom=await boot(), w=dom.window, d=w.document;
 const $=id=>d.getElementById(id);
 const input=(el,value)=>{el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const chip=id=>$('paycards-list').querySelector(`[data-card="${id}"]`);

 // ---- 기능 1: 이번 결제에 쓸 카드 ----
 check('칩은 보유 카드 수만큼',$('paycards-list').querySelectorAll('.pay-chip').length,4);
 check('초기에는 모두 포함',[...$('paycards-list').children].every(c=>c.getAttribute('aria-pressed')==='true'),true);
 input($('amount'),'29,000');
 check('29,000 기본 순위',short(ranking(d)),['하나 5,000원','IBK 4,350원','신한 1,000원','KB 1,000원']);
 chip('hana').click();
 check('하나 제외 후 순위',short(ranking(d)),['IBK 4,350원','신한 1,000원','KB 1,000원']);
 check('IBK 1위',d.querySelector('#result .hero__name').textContent.startsWith('IBK'),true);
 check('제외 칩 상태',chip('hana').getAttribute('aria-pressed'),'false');
 check('기록하기 선택지에서 제외',[...$('quick-card').options].map(o=>o.value),['ibk','shinhan','kb']);
 check('기록하기 기본 카드',$('record-best').textContent,'IBK로 결제 기록');
 check('기록 탭 폼은 보유 카드 그대로',[...$('record-card').options].map(o=>o.value),['hana','ibk','shinhan','kb']);
 check('제외는 저장하지 않음',w.localStorage.getItem('pxpick:v2'),null);
 $('record-best').click();
 let saved=JSON.parse(w.localStorage.getItem('pxpick:v2'));
 check('제외 후 기록은 IBK',saved.records[0].cardId,'ibk');
 check('설정 보유 카드는 그대로',saved.settings.ownedCards,['hana','ibk','shinhan','kb']);
 check('설정에 제외 키 없음',Object.keys(saved.settings).includes('excluded'),false);
 $('quick-feedback').querySelector('button').click();
 check('기록 후 refresh에도 제외 유지',chip('hana').getAttribute('aria-pressed'),'false');
 for (const id of ['ibk','shinhan','kb']) chip(id).click();
 check('전부 제외 안내',/쓸 카드를 모두 뺐어요/.test($('result').textContent),true);
 check('전부 제외 시 기록 버튼 비활성',$('record-best').disabled,true);
 check('전부 제외 시 선택지 없음',$('quick-card').options.length,0);
 chip('kb').click();
 check('다시 포함',short(ranking(d)),['KB 1,000원']);
 saved=w.localStorage.getItem('pxpick:v2');w.close();
 dom=await boot(saved);w=dom.window;d=w.document;
 check('새로고침 시 제외 초기화',[...d.querySelectorAll('.pay-chip')].every(c=>c.getAttribute('aria-pressed')==='true'),true);
 w.close();

 // ---- 기능 4: 물건별 계산 ----
 dom=await boot();w=dom.window;d=w.document;
 check('처음엔 한 줄',$('item-rows').querySelectorAll('.item-row').length,1);
 const rowInputs=i=>$('item-rows').querySelectorAll('.item-row')[i].querySelectorAll('input');
 input(rowInputs(0)[0],'3000');input(rowInputs(0)[1],'2');
 check('가격 콤마 표기',rowInputs(0)[0].value,'3,000');
 check('첫 줄 합계가 바로 비교 금액',$('amount').value,'6,000');
 $('item-add').click();
 check('줄 추가',$('item-rows').querySelectorAll('.item-row').length,2);
 input(rowInputs(1)[0],'12,000');
 check('합계 표시',$('item-total').textContent,'18,000원');
 check('비교 금액 18,000',$('amount').value,'18,000');
 check('라벨로 연결 상태 표시',$('amount-area').querySelector('.amount__label').textContent,'결제 금액 · 물건별 합계');
 check('18,000 결과',short(ranking(d)),['하나 5,000원','IBK 2,700원','신한 1,000원','KB 1,000원']);
 // 직접 고치면 분리
 input($('amount'),'20,000');
 check('직접 입력은 그대로',$('amount').value,'20,000');
 check('분리 라벨',$('amount-area').querySelector('.amount__label').textContent,'결제 금액');
 check('분리 안내',/합계와 분리됐어요/.test($('item-status').textContent),true);
 check('합계는 유지',$('item-total').textContent,'18,000원');
 $('item-status').querySelector('button').click();
 check('합계로 다시 비교',$('amount').value,'18,000');
 // 빠른 칩도 직접 수정으로 분리
 d.querySelector('[data-add="1000"]').click();
 check('칩 더하기 후 금액',$('amount').value,'19,000');
 check('칩 더하기는 분리',/합계와 분리됐어요/.test($('item-status').textContent),true);
 // 물건 줄을 다시 고치면 다시 연결
 input(rowInputs(0)[1],'3');
 check('수량 변경 시 재연결',$('amount').value,'21,000');
 // 줄 삭제
 $('item-rows').querySelectorAll('.item-row__del')[1].click();
 check('삭제 후 한 줄',$('item-rows').querySelectorAll('.item-row').length,1);
 check('삭제 후 금액',$('amount').value,'9,000');
 // 상한 초과는 반영하지 않음
 input(rowInputs(0)[0],'9,999,999');
 check('상한 초과 합계 미반영',$('amount').value,'9,000');
 check('상한 초과 안내',/넘어 결제 금액에 반영하지 않았어요/.test($('item-status').textContent),true);
 // 물건별 금액 + 카드 제외 조합
 input(rowInputs(0)[1],'1');
 check('상한 이하로 돌아오면 반영',$('amount').value,'9,999,999');
 w.close();
 console.log(`비교 탭 ${checks}개 검증 통과: 카드 일시 제외(순위·기록 선택지·전부 제외 안내·비저장) · 물건별 계산(합계 연동·직접 입력 분리·재연결·삭제·상한)`);
})().catch(e=>{console.error(e);process.exit(1);});
