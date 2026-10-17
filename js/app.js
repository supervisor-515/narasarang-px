/* PX픽 — 계산 엔진 + 화면. 엔진 부분은 node에서 require 해 테스트할 수 있다. */
(function () {
  'use strict';

  var MAX_AMOUNT = 9999999;
  // IBK 조건 선택의 영향을 받는 카드
  var CONDITIONAL_ID = 'ibk';

  var IBK_DESC = {
    soldier: '특별할인 연 1회 기준',
    salary: '횟수 우대 · 특별할인 연 2회',
    none: 'IBK는 현역병 인정 시 받을 수 있는 참고값으로 보여드려요'
  };

  // ---------- 금액 표기 ----------

  function won(n) {
    return n.toLocaleString('ko-KR') + '원';
  }

  // 52000 → "5만 2천원", 5000 → "5천원", 1500 → "1천 500원"
  function korWon(n) {
    if (!n) return '0원';
    var man = Math.floor(n / 10000);
    var rest = n % 10000;
    var chun = Math.floor(rest / 1000);
    var under = rest % 1000;
    var parts = [];
    if (man) parts.push(man.toLocaleString('ko-KR') + '만');
    if (chun) parts.push(chun + '천');
    if (under) parts.push(String(under));
    return parts.join(' ') + '원';
  }

  // ---------- 계산 엔진 ----------

  // 금액 이상 기준으로 해당 구간 인덱스
  function tierIndex(tiers, amount) {
    var idx = 0;
    for (var i = 0; i < tiers.length; i++) {
      if (amount >= tiers[i][0]) idx = i;
    }
    return idx;
  }

  function tiersFor(px, opts) {
    return opts.isDay10 && px.tiersOnDay10 ? px.tiersOnDay10 : px.tiers;
  }

  // 금액에 해당하는 월한도 중 최솟값. 구간(under/over) 없는 항목은 전 구간 공통
  function monthCapFor(px, amount) {
    var cap = null;
    px.limits.forEach(function (l) {
      if (l.monthCap == null) return;
      var inSeg = l.under != null ? amount < l.under : l.over != null ? amount >= l.over : true;
      if (inSeg && (cap == null || l.monthCap < cap)) cap = l.monthCap;
    });
    return cap;
  }

  function isActive(card, opts) {
    return !(card.id === CONDITIONAL_ID && opts.ibkMode === 'none');
  }

  function manualFor(value, date) {
    return typeof value === 'number' ? value : (value || {})[date.slice(0, 4)] || 0;
  }

  function aggregate(records, date, manual, adjustments) {
    var out = { cards: {}, specialCount: manualFor(manual, date) };
    var prior = (adjustments || {})[date.slice(0, 7)] || {};
    Object.keys(prior).forEach(function (id) {
      out.cards[id] = { month: [prior[id], prior[id]], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: prior[id] };
    });
    (records || []).forEach(function (r) {
      if (r.date > date) return;
      if (r.cardId === 'ibk' && r.specialUsed && r.date.slice(0, 4) === date.slice(0, 4)) out.specialCount++;
      if (r.date.slice(0, 7) !== date.slice(0, 7)) return;
      var c = out.cards[r.cardId] || (out.cards[r.cardId] = { month: [0, 0], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: 0 });
      var seg = r.amount < 30000 ? 0 : 1;
      var base = Math.max(0, r.benefit - (r.specialUsed ? 50000 : 0));
      c.month[seg] += base;
      c.counts[seg]++;
      c.total += r.benefit;
      if (r.date === date) { c.day[seg] += base; c.dayCounts[seg]++; }
    });
    return out;
  }

  /**
   * @param card  cards.json의 카드 한 장
   * @param amount 결제 금액(원, 정수)
   * @param opts  { ibkMode: 'soldier' | 'salary' | 'none', isDay10: boolean, ibkSpecialLeft: boolean(기본 true) }
   */
  function calcCard(card, amount, opts) {
    opts = opts || {};
    var px = card.px;
    var day10 = !!(opts.isDay10 && px.tiersOnDay10);
    var tiers = tiersFor(px, opts);
    var idx = tierIndex(tiers, amount);
    var rate = tiers[idx][1];
    var raw = Math.floor(amount * rate / 100);
    // 건당한도와 월한도 중 작은 쪽이 최종 상한
    var cap = px.capUnder && amount < px.capUnder.under ? px.capUnder.cap : px.capPerTxn;
    var monthCap = monthCapFor(px, amount);
    var limit = cap == null ? monthCap : monthCap == null ? cap : Math.min(cap, monthCap);
    var base = limit == null ? raw : Math.min(raw, limit);

    var usage = opts.usage || aggregate(opts.records, opts.date || seoulDate().key, opts.manualSpecialUsed, opts.monthAdjustments);
    var u = usage.cards[card.id] || { month: [0, 0], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: 0 };
    var segIdx = amount < 30000 ? 0 : 1;
    var seg = segmentLimit(px.limits, amount) || {};
    var countLimit = opts.ibkMode === 'salary' && 'monthCountSalary' in seg ? seg.monthCountSalary : seg.monthCount;
    var reasons = [];
    if (countLimit != null && u.counts[segIdx] >= countLimit) { base = 0; reasons.push('이번 달 횟수 소진'); }
    if (seg.dayCount != null && u.dayCounts[segIdx] >= seg.dayCount) { base = 0; reasons.push('오늘 횟수 소진'); }
    var monthRemaining = monthCap == null ? null : Math.max(0, monthCap - (card.id === 'shinhan' ? u.total : u.month[segIdx]));
    if (monthRemaining != null && base > monthRemaining) { base = monthRemaining; reasons.push('월 잔여 한도까지만 적용'); }
    var dayRemaining = seg.dayCap == null ? null : Math.max(0, seg.dayCap - u.day[segIdx]);
    if (dayRemaining != null && base > dayRemaining) { base = dayRemaining; reasons.push('일 잔여 한도까지만 적용'); }
    var special = 0;
    var specialSpent = false;
    if (px.special && opts.ibkMode !== 'none' && amount >= px.special.minAmount) {
      if (opts.ibkSpecialLeft === false || usage.specialCount >= yearCount(px.special, opts.ibkMode)) specialSpent = true;
      else special = px.special.fixed;
    }

    return {
      monthCountRemaining: countLimit == null ? null : Math.max(0, countLimit - u.counts[segIdx]),
      dayCountRemaining: seg.dayCount == null ? null : Math.max(0, seg.dayCount - u.dayCounts[segIdx]),
      reasons: reasons,
      monthRemaining: monthRemaining,
      dayRemaining: dayRemaining,
      amount: amount,
      tiers: tiers,
      tierIdx: idx,
      rate: rate,
      day10: day10,
      raw: raw,
      cap: cap,
      monthCap: monthCap,
      limit: limit,
      capped: limit != null && raw > limit,
      base: base,
      special: special,
      specialSpent: specialSpent,
      total: base + special
    };
  }

  // 활성 카드는 혜택 큰 순(동률은 cards.json 순서), 동률은 같은 순위(1, 1, 3)
  function rankCards(cards, amount, opts) {
    var rows = cards.filter(function (c) { return !opts.ownedCards || opts.ownedCards.indexOf(c.id) !== -1; }).map(function (card, i) {
      return { card: card, order: i, result: calcCard(card, amount, opts), active: isActive(card, opts) };
    });
    var active = rows.filter(function (r) { return r.active; });
    active.sort(function (a, b) {
      return b.result.total - a.result.total || a.order - b.order;
    });
    active.forEach(function (r, i) {
      r.rank = i > 0 && r.result.total === active[i - 1].result.total ? active[i - 1].rank : i + 1;
    });
    return { active: active, inactive: rows.filter(function (r) { return !r.active; }) };
  }

  // 현재 금액보다 큰 가장 가까운 구간 경계(전 카드 tiers 기준)로 올렸을 때
  // 혜택이 가장 많이 늘어나는 활성 카드. 경계가 없거나 늘어나는 카드가 없으면 null
  function tierHint(cards, amount, opts) {
    cards = cards.filter(function (c) { return !opts.ownedCards || opts.ownedCards.indexOf(c.id) !== -1; });
    var target = null;
    cards.forEach(function (card) {
      tiersFor(card.px, opts).forEach(function (t) {
        if (t[0] > amount && (target == null || t[0] < target)) target = t[0];
      });
    });
    if (target == null || target > MAX_AMOUNT) return null;
    var current = rankCards(cards, amount, opts).active;
    var future = rankCards(cards, target, opts).active;
    if (!current.length || !future.length) return null;
    var gain = future[0].result.total - current[0].result.total;
    var best = gain > 0 ? { card: future[0].card, target: target, add: target - amount, total: future[0].result.total, gain: gain } : null;
    return best;
  }

  function hintText(hint) {
    return won(hint.add) + ' 더 담아 ' + won(hint.target) + '에 맞추면 ' + '최대 혜택 ' +
      won(hint.total) + ' (지금보다 +' + hint.gain.toLocaleString('ko-KR') + ')';
  }

  // ---------- 날짜 (Asia/Seoul) ----------

  var seoulFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

  function seoulDate(date) {
    var p = {};
    seoulFmt.formatToParts(date || new Date()).forEach(function (x) { p[x.type] = x.value; });
    return { key: p.year + '-' + p.month + '-' + p.day, day: Number(p.day) };
  }

  // ---------- 조건 문구 ----------

  function tierText(r) {
    var t = r.tiers[r.tierIdx];
    var next = r.tiers[r.tierIdx + 1];
    var text;
    if (r.tiers.length === 1) text = t[1] + '%';
    else if (t[0] === 0) text = korWon(next[0]) + ' 미만 ' + t[1] + '%';
    else text = korWon(t[0]) + ' 이상 ' + t[1] + '%';
    if (r.day10 && t[0] === 0) text = '10일 ' + text;
    return text;
  }

  function segmentLimit(limits, amount) {
    for (var i = 0; i < limits.length; i++) {
      var l = limits[i];
      if ((l.under != null && amount < l.under) || (l.over != null && amount >= l.over)) return l;
    }
    return null;
  }

  function countText(l, ibkMode) {
    if (l.monthCount != null) {
      if (ibkMode === 'salary' && 'monthCountSalary' in l) {
        return l.monthCountSalary == null ? '횟수 무제한' : '월 ' + l.monthCountSalary + '회';
      }
      return '월 ' + l.monthCount + '회';
    }
    if (l.dayCount != null) return '하루 ' + l.dayCount + '회';
    return '';
  }

  function yearCount(special, ibkMode) {
    return ibkMode === 'salary' ? special.yearCountSalary : special.yearCount;
  }

  // 결과 행에 붙는 조건 한 줄
  function conditionLine(card, r, opts, withSpecial) {
    if (!isActive(card, opts)) return '현역병 인정 시';
    var px = card.px;
    var parts = [tierText(r)];
    if (r.cap != null) {
      parts.push('건당 최대 ' + korWon(r.cap));
    } else {
      var month = px.limits.filter(function (l) { return l.monthCap && l.under == null && l.over == null; })[0];
      if (month) parts.push('월 최대 ' + korWon(month.monthCap));
    }
    var seg = segmentLimit(px.limits, r.amount);
    var count = seg ? countText(seg, opts.ibkMode) : '';
    if (count) parts.push(count);
    if (r.specialSpent) parts.push('특별할인 소진');
    if (withSpecial && r.special) {
      parts.push('특별 ' + korWon(r.special) + ' 포함 (연 ' + yearCount(px.special, opts.ibkMode) + '회)');
    }
    return parts.concat(r.reasons || []).join(' · ');
  }

  // IBK 특별할인 분해 표기
  function specialLine(card, r, opts) {
    if (!r.special) return '';
    return '기본 ' + won(r.base) + ' + 특별 ' + won(r.special) + ' · 연 ' + yearCount(card.px.special, opts.ibkMode) + '회';
  }

  // 카드별 혜택 섹션: limits/special을 문장으로
  function limitSentences(px) {
    var out = px.limits.map(function (l) {
      var scope = l.under != null ? korWon(l.under) + ' 미만: ' : l.over != null ? korWon(l.over) + ' 이상: ' : '';
      var bits = [];
      if (l.dayCap != null) bits.push('하루 최대 ' + korWon(l.dayCap));
      if (l.dayCount != null) bits.push('하루 ' + l.dayCount + '회');
      if (l.monthCount != null) bits.push('월 ' + l.monthCount + '회');
      if (l.monthCap != null) bits.push('월 최대 ' + korWon(l.monthCap));
      var s = scope + bits.join(' · ');
      if ('monthCountSalary' in l) {
        s += l.monthCountSalary == null ? ' (급여이체 시 횟수 무제한)' : ' (급여이체 시 월 ' + l.monthCountSalary + '회)';
      }
      return s;
    });
    if (px.special) {
      var sp = px.special;
      out.push(korWon(sp.minAmount) + ' 이상 결제 시 ' + korWon(sp.fixed) + ' 특별할인 추가 (연 ' + sp.yearCount +
        '회, 급여이체 시 연 ' + sp.yearCountSalary + '회) · ' + sp.note);
    }
    return out;
  }

  function validManual(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(function (year) {
      return /^\d{4}$/.test(year) && Number.isSafeInteger(value[year]) && value[year] >= 0;
    });
  }
  function validAdjustments(value) {
    return value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(function (month) {
      var amounts = value[month];
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && amounts && typeof amounts === 'object' && !Array.isArray(amounts) && Object.keys(amounts).every(function (id) {
        return ['hana','ibk','shinhan','kb'].indexOf(id) !== -1 && Number.isSafeInteger(amounts[id]) && amounts[id] >= 0;
      });
    }));
  }

  function validateBackup(value) {
    var ids = ['hana', 'ibk', 'shinhan', 'kb'];
    var settings = value && value.settings;
    if (!value || value.version !== 2 || !settings || !Array.isArray(value.records) ||
        !Array.isArray(settings.ownedCards) || new Set(settings.ownedCards).size !== settings.ownedCards.length ||
        settings.ownedCards.some(function (id) { return ids.indexOf(id) < 0; }) ||
        !Object.prototype.hasOwnProperty.call(IBK_DESC, settings.ibkMode) ||
        !validManual(settings.manualSpecialUsed) || !validAdjustments(settings.monthAdjustments) ||
        typeof settings.day10View !== 'boolean') throw new Error('백업 형식이 올바르지 않아요.');
    var seen = new Set();
    value.records.forEach(function (r) {
      if (!r || typeof r.id !== 'string' || !r.id || seen.has(r.id) ||
          typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
          !Number.isFinite(Date.parse(r.date)) || new Date(r.date).toISOString().slice(0, 10) !== r.date ||
          ids.indexOf(r.cardId) < 0 || !Number.isInteger(r.amount) || r.amount < 1 || r.amount > MAX_AMOUNT ||
          !Number.isSafeInteger(r.benefit) || r.benefit < 0 || r.benefit > 150000 ||
          typeof r.specialUsed !== 'boolean' || (r.specialUsed && (r.cardId !== 'ibk' || r.amount < 200000 || r.benefit < 50000))) throw new Error('기록 형식이 올바르지 않아요.');
      seen.add(r.id);
    });
    return value;
  }

  var engine = {
    aggregate: aggregate,
    manualFor: manualFor,
    validateBackup: validateBackup,
    MAX_AMOUNT: MAX_AMOUNT,
    won: won,
    korWon: korWon,
    calcCard: calcCard,
    rankCards: rankCards,
    tierHint: tierHint,
    hintText: hintText,
    seoulDate: seoulDate,
    conditionLine: conditionLine,
    specialLine: specialLine,
    limitSentences: limitSentences
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = engine;
    return;
  }

  // ---------- 화면 ----------

  var SPRITE = 'icons/sprite.svg';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STORE_KEY = 'pxpick:v2';

  function loadSettings() {
    try { return validateBackup(JSON.parse(localStorage.getItem(STORE_KEY))); } catch (e) { return {}; }
  }

  var stored = loadSettings();
  var saved = stored.settings || {};
  var today = seoulDate();

  var state = {
    records: stored.records || [],
    ownedCards: saved.ownedCards || ['hana', 'ibk', 'shinhan', 'kb'],
    manualSpecialUsed: typeof saved.manualSpecialUsed === 'number' ? { [today.key.slice(0, 4)]: saved.manualSpecialUsed } : saved.manualSpecialUsed || {},
    monthAdjustments: saved.monthAdjustments || {},
    quickCard: null,
    // 이번 비교에서만 뺀 카드 (저장하지 않음, 새로고침 시 초기화)
    excluded: [],
    // 물건별 계산 줄. itemsLinked면 합계가 곧 비교 금액
    items: [{ price: 0, qty: 1 }],
    itemsLinked: false,
    data: null,
    loadError: false,
    amount: 0,
    ibkMode: IBK_DESC.hasOwnProperty(saved.ibkMode) ? saved.ibkMode : 'soldier',
    // 사용자가 직접 고른 '매월 10일로 보기' 값. 실제 10일에는 이 값과 무관하게 켠 상태로 시작
    day10Pref: saved.day10View === true,
    today: today,
    day10View: false
  };
  state.day10View = today.day === 10 || state.day10Pref;

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(backup()));
      return true;
    } catch (e) { notice('저장 공간을 사용할 수 없어요. 백업을 내보내 주세요.'); return false; }
  }
  function backup() {
    return { version: 2, settings: { ownedCards: state.ownedCards, ibkMode: state.ibkMode, manualSpecialUsed: state.manualSpecialUsed, monthAdjustments: state.monthAdjustments, day10View: state.day10Pref }, records: state.records };
  }

  var $ = function (id) { return document.getElementById(id); };
  var ui = {
    input: $('amount'),
    field: $('amount-field'),
    clear: $('amount-clear'),
    kor: $('amount-kor'),
    area: $('amount-area'),
    result: $('result'),
    live: $('result-live'),
    segment: $('ibk-mode'),
    desc: $('ibk-desc'),

    day10Toggle: $('toggle-day10'),
    day10: $('day10-slot'),
    benefits: $('benefits'),
    list: $('benefit-list'),
    footer: $('footer'),

    toTop: $('to-top')
  };

  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (k === 'text') node.textContent = props[k];
        else if (k === 'style') node.setAttribute('style', props[k]);
        else node.setAttribute(k, props[k]);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function icon(name, size) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon icon--' + size);
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', SPRITE + '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function dot(color, off) {
    return h('span', { 'class': 'dot' + (off ? ' dot--off' : ''), style: 'background:' + color, 'aria-hidden': 'true' });
  }

  function opts() {
    return { ibkMode: state.ibkMode, isDay10: state.day10View, records: state.records, date: state.today.key, ownedCards: state.ownedCards, manualSpecialUsed: state.manualSpecialUsed, monthAdjustments: state.monthAdjustments };
  }

  // 보유 카드 중 이번 비교에서 빼지 않은 카드
  function payCards() {
    return state.ownedCards.filter(function (id) { return state.excluded.indexOf(id) === -1; });
  }

  // 스크린리더에는 1위 요약만 읽어준다 (결과 전체를 live로 두면 키 입력마다 전부 다시 읽음)
  function setLive(text) {
    if (ui.live.textContent !== text) ui.live.textContent = text;
  }

  // ----- 결과 -----

  function emptyState() {
    return h('div', { 'class': 'empty' }, icon('calculator', 24), h('p', { text: '금액을 입력하면 바로 비교해드려요' }));
  }

  function hero(winners, o) {
    var tie = winners.length > 1;
    var total = winners[0].result.total;
    var names = h('div', { 'class': 'hero__names' });
    var conds = h('div', { 'class': 'hero__conds' });
    winners.forEach(function (w) {
      names.appendChild(h('p', { 'class': 'hero__name' }, dot(w.card.color), w.card.name + ' · ' + w.card.benefitType));
      conds.appendChild(statusChips(w.result));
      var line = conditionLine(w.card, w.result, o, false);
      conds.appendChild(h('p', { 'class': 'hero__cond', text: tie ? w.card.short + ' · ' + line : line }));
      var split = specialLine(w.card, w.result, o);
      if (split) conds.appendChild(h('p', { 'class': 'hero__split num', text: split }));
    });
    return h('div', { 'class': 'hero' },
      h('p', { 'class': 'hero__label' }, icon('check-circle', 16), tie ? '공동 1위' : '가장 이득'),
      names,
      h('p', { 'class': 'hero__amount num', text: won(total) }),
      h('p', { 'class': 'hero__gain num', text: (tie ? '어느 카드로 결제해도 ' : '이 카드로 결제하면 ') + won(total) + ' 이득' }),
      conds
    );
  }

  function statusChips(r) {
    var texts = [];
    if (r.dayRemaining === 0 || r.dayCountRemaining === 0) texts.push('오늘 한도 소진');
    else if (r.dayRemaining != null) texts.push('오늘 잔여 ' + won(r.dayRemaining));
    if (r.monthCountRemaining != null) texts.push(r.monthCountRemaining ? '이번 달 ' + r.monthCountRemaining + '회 남음' : '이번 달 횟수 소진');
    if (r.monthRemaining != null) texts.push(r.monthRemaining ? '월 잔여 ' + won(r.monthRemaining) : '이번 달 한도 소진');
    if (r.specialSpent) texts.push('특별할인 소진');
    var node = h('div', { 'class': 'status-chips' });
    texts.forEach(function (text) { node.appendChild(h('span', { 'class': 'chip', text: text })); });
    return node;
  }

  function rankRow(row, o) {
    var off = !row.active;
    var total = row.result.total;
    var amount = h('p', { 'class': 'rank__amount num' + (!off && total === 0 ? ' is-zero' : '') },
      off ? h('span', { 'class': 'ref-chip', text: '참고' }) : null,
      won(total));
    return h('li', { 'class': 'rank' + (off ? ' rank--off' : '') },
      h('span', { 'class': 'rank__no num', text: off ? '–' : String(row.rank) }),
      dot(row.card.color, off),
      h('div', { 'class': 'rank__text' },
        h('p', { 'class': 'rank__name', text: row.card.name + ' · ' + row.card.benefitType }),
        row.active ? statusChips(row.result) : null,
        h('p', { 'class': 'rank__cond', text: conditionLine(row.card, row.result, o, true) })),
      amount);
  }

  function renderResult() {
    // 오류 상태는 renderError가 한 번 그려 두고, 입력이 바뀌어도 유지한다
    if (state.loadError) return;
    var root = ui.result;
    root.textContent = '';
    if (!state.amount) { $('quick-card').textContent = ''; root.appendChild(emptyState()); setLive(''); return; }
    if (!state.data) return;

    var o = opts();
    o.ownedCards = payCards();
    var cards = state.data.cards;
    var ranked = rankCards(cards, state.amount, o);
    $('record-best').disabled = !ranked.active.length;
    renderQuickCards(ranked.active);
    if (state.ownedCards.length && !o.ownedCards.length) { root.appendChild(h('p', { 'class': 'empty', text: '이번 결제에 쓸 카드를 모두 뺐어요. 위에서 쓸 카드를 하나 이상 눌러 주세요.' })); setLive('이번 결제에 쓸 카드를 골라 주세요.'); return; }
    if (!ranked.active.length && !ranked.inactive.length) { root.appendChild(h('p', { 'class': 'empty', text: '설정에서 보유 카드를 선택해 주세요.' })); setLive('보유 카드를 선택해 주세요.'); return; }
    var top = ranked.active.length ? ranked.active[0].result.total : 0;
    var rest = ranked.active;

    var hint = tierHint(cards, state.amount, o);
    if (hint) root.appendChild(h('p', { 'class': 'hint num' }, icon('info', 16), h('span', { text: hintText(hint) })));

    if (top > 0) {
      var winners = ranked.active.filter(function (r) { return r.rank === 1; });
      root.appendChild(hero(winners, o));
      rest = ranked.active.filter(function (r) { return r.rank !== 1; });
      setLive((winners.length > 1 ? '공동 1위 ' : '가장 이득 ') +
        winners.map(function (w) { return w.card.name; }).join(', ') + ', ' + won(top));
    } else {
      root.appendChild(h('p', { 'class': 'empty empty--inline', text: '이 금액은 받을 수 있는 혜택이 없어요' }));
      setLive('이 금액은 받을 수 있는 혜택이 없어요');
    }

    if (rest.length) {
      var list = h('ul', { 'class': 'ranks' });
      rest.forEach(function (r) { list.appendChild(rankRow(r, o)); });
      root.appendChild(list);
    }
    if (ranked.inactive.length) {
      var offList = h('ul', { 'class': 'ranks ranks--off' });
      ranked.inactive.forEach(function (r) { offList.appendChild(rankRow(r, o)); });
      root.appendChild(offList);
    }
  }

  // ----- 설정: 10일 배지 · 토글 -----

  function renderDay10() {
    ui.day10Toggle.setAttribute('aria-checked', state.day10View ? 'true' : 'false');
    ui.day10.textContent = '';
    if (!state.day10View) return;
    if (state.today.day === 10) {
      ui.day10.appendChild(h('p', { 'class': 'badge-day10' }, icon('calendar', 16), '오늘은 매월 10일 — 신한 3만원 미만 50% 적용 중'));
    } else {
      ui.day10.appendChild(h('p', { 'class': 'badge-day10 badge-day10--preview' }, icon('calendar', 16), '미리보기 — 매월 10일 기준, 신한 3만원 미만 50%'));
    }
  }

  ui.day10Toggle.addEventListener('click', function () {
    state.day10View = !state.day10View;
    state.day10Pref = state.day10View;
    saveSettings();
    renderDay10();
    renderResult();
    previewRecord();
  });

  // 서울 기준 날짜가 바뀌면 10일 상태를 다시 정한다 (화면을 켜 둔 채 자정이 지나는 경우)
  function checkDate() {
    var now = seoulDate();
    if (now.key === state.today.key) return;
    state.today = now;
    state.day10View = now.day === 10 || state.day10Pref;
    renderSettings();
    renderDay10();
    renderResult();
    renderRecords();
  }
  setInterval(checkDate, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkDate();
  });

  // ----- 정적 섹션 -----

  function benefitCard(card) {
    var px = card.px;
    var conds = h('ul', { 'class': 'bcard__conds' });
    px.conditions.concat(limitSentences(px)).forEach(function (text) {
      conds.appendChild(h('li', null, h('span', { 'class': 'bcard__bullet' }, icon('check', 16)), h('span', { text: text })));
    });
    var hls = h('ul', { 'class': 'bcard__highlights' });
    card.highlights.forEach(function (hl) {
      hls.appendChild(h('li', null,
        h('p', { 'class': 'bcard__hl-title', text: hl.title }),
        h('p', { 'class': 'bcard__hl-cond', text: hl.cond })));
    });
    return h('article', { 'class': 'bcard', 'aria-label': card.name },
      h('div', { 'class': 'bcard__head' },
        h('span', { 'class': 'bcard__bar', style: 'background:' + card.color, 'aria-hidden': 'true' }),
        h('h3', { 'class': 'bcard__name', text: card.name }),
        h('span', { 'class': 'chip', text: card.benefitType })),
      h('p', { 'class': 'bcard__account', text: card.account }),
      h('div', { 'class': 'bcard__px' },
        h('p', { 'class': 'bcard__sub', text: 'PX 혜택' }),
        h('p', { 'class': 'bcard__summary', text: px.summary })),
      conds,
      h('div', { 'class': 'bcard__divider', 'aria-hidden': 'true' }),
      h('p', { 'class': 'bcard__sub', text: '대표 혜택' }),
      hls);
  }

  function renderStatic() {
    var d = state.data;
    ui.list.textContent = '';
    d.cards.forEach(function (card) { ui.list.appendChild(benefitCard(card)); });
    ui.footer.textContent = '';
    ui.footer.appendChild(h('p', { text: '출처: ' + d.sources }));
    if (d.sourceUrls && d.sourceUrls.length) {
      var links = h('ul', { 'class': 'footer__links' });
      d.sourceUrls.forEach(function (s) {
        links.appendChild(h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener', text: s.name })));
      });
      ui.footer.appendChild(links);
    }
    ui.footer.appendChild(h('p', { text: '기록과 설정은 이 기기에만 저장되며 외부로 전송되지 않아요.' }));
    ui.footer.appendChild(h('p', { text: '기준: ' + d.updated + ' · 실제 혜택은 카드사 사정에 따라 달라질 수 있어요.' }));
  }

  // ----- 데이터 로드 · 오류 -----

  function errorBlock(text, alert) {
    var btn = h('button', { type: 'button', 'class': 'retry', text: '다시 시도' });
    btn.addEventListener('click', loadData);
    return h('div', alert ? { 'class': 'error', role: 'alert' } : { 'class': 'error' },
      icon('info', 24), h('p', { text: text }), btn);
  }

  function renderError() {
    ui.result.textContent = '';
    ui.result.appendChild(errorBlock('카드 데이터를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.', true));
    ui.list.textContent = '';
    ui.list.appendChild(h('div', { 'class': 'bcard' }, errorBlock('카드별 혜택을 불러오지 못했어요.', false)));
    ui.footer.textContent = '';
    ui.footer.appendChild(h('p', { text: '출처 정보를 불러오지 못했어요.' }));
    setLive('');
  }

  function loadData() {
    Array.prototype.forEach.call(document.querySelectorAll('.retry'), function (b) {
      b.disabled = true;
      b.textContent = '불러오는 중…';
    });
    fetch('data/cards.json')
      .then(function (res) {
        if (!res.ok) throw new Error(res.status);
        return res.json();
      })
      .then(function (data) {
        state.data = data;
        state.loadError = false;
        renderStatic();
        renderSettings();
        renderRecords();
        renderResult();
      })
      .catch(function () {
        state.loadError = true;
        renderError();
      });
  }

  function setAmount(n) {
    state.amount = n;
    var text = n ? n.toLocaleString('ko-KR') : '';
    ui.input.value = text;
    ui.field.setAttribute('data-value', text || '0');
    ui.field.classList.toggle('is-empty', !n);
    ui.clear.hidden = !n;
    ui.kor.textContent = korWon(n);
    $('record-best').disabled = !n || !state.data;
    renderItemStatus();
    renderResult();
  }
  // 금액을 직접 고치면 물건별 합계와 분리한다
  function setAmountDirect(n) {
    state.itemsLinked = false;
    setAmount(n);
  }
  ui.input.addEventListener('input', function () {
    var n = Number(ui.input.value.replace(/[^0-9]/g, ''));
    setAmountDirect(n <= MAX_AMOUNT ? n : state.amount);
  });
  ui.clear.addEventListener('click', function () { setAmountDirect(0); ui.input.focus(); });
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { setAmountDirect(Math.min(MAX_AMOUNT, state.amount + Number(b.dataset.add))); });
  });

  // ----- 물건별 계산 -----

  function itemsTotal() {
    return state.items.reduce(function (sum, it) { return sum + it.price * it.qty; }, 0);
  }

  function renderItemStatus() {
    var total = itemsTotal();
    $('item-total').textContent = won(total);
    $('amount-area').querySelector('.amount__label').textContent = state.itemsLinked ? '결제 금액 · 물건별 합계' : '결제 금액';
    var root = $('item-status'); root.textContent = '';
    if (total > MAX_AMOUNT) {
      root.textContent = '합계가 ' + won(MAX_AMOUNT) + '을 넘어 결제 금액에 반영하지 않았어요.';
    } else if (state.itemsLinked) {
      root.textContent = '합계를 결제 금액으로 비교하고 있어요.';
    } else if (total > 0 && total !== state.amount) {
      root.appendChild(h('span', { text: '결제 금액을 직접 고쳐서 합계와 분리됐어요.' }));
      var relink = h('button', { type: 'button', 'class': 'secondary', text: '합계로 비교' });
      relink.addEventListener('click', function () { state.itemsLinked = true; syncItems(); });
      root.appendChild(relink);
    }
  }

  // 물건 줄을 고치면 합계가 비교 금액이 된다
  function syncItems() {
    var total = itemsTotal();
    if (state.itemsLinked && total <= MAX_AMOUNT) setAmount(total);
    else renderItemStatus();
  }

  function renderItems() {
    var root = $('item-rows'); root.textContent = '';
    state.items.forEach(function (it, i) {
      var no = (i + 1) + '번째 물건';
      var price = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', 'class': 'num', placeholder: '가격(원)', 'aria-label': no + ' 가격', value: it.price ? it.price.toLocaleString('ko-KR') : '' });
      price.addEventListener('input', function () {
        var n = Number(price.value.replace(/[^0-9]/g, ''));
        if (n <= MAX_AMOUNT) it.price = n;
        price.value = it.price ? it.price.toLocaleString('ko-KR') : '';
        state.itemsLinked = true; syncItems();
      });
      var qty = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '99', step: '1', 'class': 'num', 'aria-label': no + ' 수량', value: String(it.qty) });
      qty.addEventListener('input', function () {
        var n = Number(qty.value);
        // 입력 중 빈 칸은 0개로 계산하고, 범위를 벗어난 값은 이전 수량 유지
        if (qty.value === '') it.qty = 0;
        else if (Number.isInteger(n) && n >= 0 && n <= 99) it.qty = n;
        else qty.value = String(it.qty);
        state.itemsLinked = true; syncItems();
      });
      var del = h('button', { type: 'button', 'class': 'item-row__del', 'aria-label': no + ' 삭제' }, icon('close', 20));
      del.addEventListener('click', function () {
        state.items.splice(i, 1);
        state.itemsLinked = true;
        renderItems(); syncItems();
        $('item-add').focus();
      });
      root.appendChild(h('div', { 'class': 'item-row' }, price, qty, h('span', { 'class': 'item-row__unit', 'aria-hidden': 'true', text: '개' }), del));
    });
  }

  $('item-add').addEventListener('click', function () {
    state.items.push({ price: 0, qty: 1 });
    renderItems();
    $('item-rows').lastChild.querySelector('input').focus();
  });

  // ----- 이번 결제에 쓸 카드 -----

  function renderPayCards() {
    var root = $('paycards-list'); root.textContent = '';
    $('paycards').hidden = !state.ownedCards.length;
    state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) {
      var on = state.excluded.indexOf(c.id) === -1;
      var chip = h('button', { type: 'button', 'class': 'pay-chip', 'aria-pressed': String(on), 'data-card': c.id }, dot(c.color, !on), c.short);
      chip.addEventListener('click', function () {
        var nowOn = chip.getAttribute('aria-pressed') !== 'true';
        state.excluded = nowOn ? state.excluded.filter(function (id) { return id !== c.id; }) : state.excluded.concat(c.id);
        chip.setAttribute('aria-pressed', String(nowOn));
        chip.querySelector('.dot').classList.toggle('dot--off', !nowOn);
        renderResult();
      });
      root.appendChild(chip);
    });
  }
  ui.toTop.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'auto' }); ui.input.focus(); });

  // ----- IBK 조건 세그먼트 -----

  var segItems = Array.prototype.slice.call(ui.segment.querySelectorAll('[role="radio"]'));

  function selectMode(btn, focus) {
    segItems.forEach(function (b) {
      var on = b === btn;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    if (focus) btn.focus();
    state.ibkMode = btn.getAttribute('data-mode');
    ui.desc.textContent = IBK_DESC[state.ibkMode];
  }

  segItems.forEach(function (btn, idx) {
    btn.addEventListener('click', function () {
      selectMode(btn, false);
      saveSettings();
      renderResult();
      renderRecords();
      renderSettings();
    });
    btn.addEventListener('keydown', function (e) {
      var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      selectMode(segItems[(idx + step + segItems.length) % segItems.length], true);
      saveSettings();
      refresh();
    });
  });

  function renderQuickCards(rows) {
    var select = $('quick-card'); select.textContent = '';
    rows.forEach(function (r) { select.appendChild(h('option', { value: r.card.id, text: r.card.name + (r.rank === 1 ? ' · 추천 1위' : '') })); });
    if (rows.some(function (r) { return r.card.id === state.quickCard; })) select.value = state.quickCard;
    var card = rows.find(function (r) { return r.card.id === select.value; });
    $('record-best').textContent = card ? card.card.short + (card.card.id === 'shinhan' ? '으로' : '로') + ' 결제 기록' : '결제 기록';
  }
  $('quick-card').addEventListener('change', function () { state.quickCard = this.value; renderResult(); });
  // 저장한 경로(빠른 기록/기록 폼) 바로 아래에 완료 메시지와 실행 취소를 띄운다
  function showUndo(record, rootId) {
    var root = $(rootId); root.textContent = '';
    root.appendChild(h('span', { text: '결제 기록을 저장했어요.' }));
    var button = h('button', { type: 'button', 'class': 'secondary', text: '실행 취소' });
    button.addEventListener('click', function () {
      var before = state.records;
      state.records = state.records.filter(function (r) { return r.id !== record.id; });
      if (!saveSettings()) { state.records = before; return; }
      root.textContent = '방금 기록을 취소했어요.'; refresh();
    });
    root.appendChild(button);
  }
  function renderAdjustments() {
    var root = $('month-adjustments'); root.textContent = '';
    var month = state.today.key.slice(0,7);
    state.data.cards.forEach(function (c) {
      var input = h('input', { type: 'number', min: '0', step: '1', 'data-card': c.id, value: (state.monthAdjustments[month] || {})[c.id] || 0 });
      input.addEventListener('change', function () {
        var value = Number(input.value);
        if (!Number.isSafeInteger(value) || value < 0) { renderAdjustments(); return; }
        if (!state.monthAdjustments[month]) state.monthAdjustments[month] = {};
        state.monthAdjustments[month][c.id] = value; saveSettings(); refresh();
      });
      root.appendChild(h('label', { 'class': 'form-field' }, c.short + ' 기록 전 사용 혜택액 (원)', input));
    });
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(function () { $('offline-status').hidden = false; }).catch(function () {});
  }

  function notice(text) { $('notice').textContent = text; }
  function refresh() { renderSettings(); renderDay10(); renderRecords(); setAmount(state.amount); }
  function renderSettings() {
    if (!state.data) return;
    $('settings-summary').textContent = '보유 카드 ' + state.ownedCards.length + '개 · IBK ' + ({soldier:'현역병',salary:'급여이체',none:'해당 없음'})[state.ibkMode];
    $('manual-special').value = manualFor(state.manualSpecialUsed, state.today.key);
    renderAdjustments();
    renderPayCards();
    var root = $('owned-cards'); root.textContent = '';
    state.data.cards.forEach(function (c) {
      var input = h('input', { type: 'checkbox', value: c.id });
      input.checked = state.ownedCards.indexOf(c.id) !== -1;
      input.addEventListener('change', function () {
        state.ownedCards = state.data.cards.filter(function (card) { return card.id === c.id ? input.checked : state.ownedCards.indexOf(card.id) !== -1; }).map(function (card) { return card.id; });
        saveSettings(); refresh();
      });
      root.appendChild(h('label', null, input, dot(c.color), c.name));
    });
    var select = $('record-card'), previous = select.value; select.textContent = '';
    state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) { select.appendChild(h('option', { value: c.id, text: c.name })); });
    if (state.ownedCards.indexOf(previous) !== -1) select.value = previous;
    $('record-submit').disabled = !state.ownedCards.length;
    previewRecord();
  }
  function recordOptions(date) {
    var o = opts(); o.date = date; o.isDay10 = date.slice(-2) === '10'; return o;
  }
  function previewRecord() {
    if (!state.data) return;
    var c = state.data.cards.find(function (c) { return c.id === $('record-card').value; });
    var amount = Number($('record-amount').value);
    $('record-preview').textContent = c && amount > 0 && amount <= MAX_AMOUNT && $('record-date').value ? '예상 혜택 ' + won(calcCard(c, amount, recordOptions($('record-date').value)).total) + (c.id === 'ibk' && state.ibkMode === 'none' ? ' · 현역병 인정 시 참고값, 저장 혜택 0원' : '') : '';
  }
  function addRecord(card, amount, date, feedbackId) {
    var r = calcCard(card, amount, recordOptions(date));
    var active = isActive(card, opts());
    var record = { id: crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random(), date: date, amount: amount, cardId: card.id, benefit: active ? r.total : 0, specialUsed: active && r.special > 0 };
    state.records.push(record);
    if (!saveSettings()) { state.records.pop(); return; }
    refresh(); showUndo(record, feedbackId); notice(card.short + ' 결제 ' + won(amount) + ' · 혜택 ' + won(record.benefit) + ' 기록했어요.');
  }
  function renderRecords() {
    if (!state.data) return;
    var usage = aggregate(state.records, state.today.key, state.manualSpecialUsed, state.monthAdjustments);
    var root = $('month-summary'); root.textContent = '';
    root.appendChild(h('h3', { text: state.today.key.slice(0, 7) + ' 예상 혜택' }));
    state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) {
      var u = usage.cards[c.id] || { total: 0, month: [0,0], counts: [0,0], day: [0,0], dayCounts: [0,0] };
      var box = h('article', { 'class': 'summary-card' }, h('p', { 'class': 'hero__name' }, dot(c.color), c.short + ' · ' + won(u.total)));
      var r = calcCard(c, 20000, opts());
      box.appendChild(h('p', { 'class': 'settings__desc', text: '기록 ' + (u.counts[0] + u.counts[1]) + '회 · 기록 전 사용분 ' + won(((state.monthAdjustments[state.today.key.slice(0,7)] || {})[c.id]) || 0) }));
      box.appendChild(statusChips(r));
      if (c.px.special) box.appendChild(h('p', { 'class': 'settings__desc', text: '올해 특별할인 잔여 ' + Math.max(0, yearCount(c.px.special, state.ibkMode)-usage.specialCount) + '회' }));
      root.appendChild(box);
    });
    root = $('record-list'); root.textContent = '';
    var month = '';
    state.records.slice().sort(function (a,b) { return b.date.localeCompare(a.date); }).forEach(function (r) {
      if (month !== r.date.slice(0,7)) { month = r.date.slice(0,7); root.appendChild(h('h3', { text: month })); }
      var c = state.data.cards.find(function(c) { return c.id === r.cardId; });
      var button = h('button', { type: 'button', text: '삭제', 'aria-label': r.date + ' ' + c.short + ' ' + won(r.amount) + ' 기록 삭제' });
      button.addEventListener('click', function () { var before = state.records; state.records = state.records.filter(function (x) { return x.id !== r.id; }); if (!saveSettings()) state.records = before; refresh(); });
      root.appendChild(h('article', { 'class': 'record-item num' }, h('p', { text: r.date + ' · ' + c.name }), h('p', { text: won(r.amount) + ' · 예상 혜택 ' + won(r.benefit) + (r.specialUsed ? ' · 특별할인 사용' : '') }), button));
    });
    if (!state.records.length) root.appendChild(h('p', { 'class': 'empty', text: '아직 결제 기록이 없어요.' }));
    previewRecord();
  }
  $('record-date').value = state.today.key;
  ['record-date','record-amount','record-card'].forEach(function (id) { $(id).addEventListener('input', previewRecord); });
  $('record-form').addEventListener('submit', function (e) {
    e.preventDefault(); checkDate();
    var amount = Number($('record-amount').value), date = $('record-date').value;
    var card = state.data && state.data.cards.find(function (c) { return c.id === $('record-card').value && state.ownedCards.indexOf(c.id) !== -1; });
    if (!card || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT || !date || date > state.today.key) { notice('오늘까지의 날짜와 올바른 금액·카드를 선택해 주세요.'); return; }
    addRecord(card, amount, date, 'record-feedback');
  });
  $('record-best').addEventListener('click', function () {
    checkDate();
    if (!state.data || !state.amount) return;
    var card = state.data.cards.find(function (c) { return c.id === $('quick-card').value && payCards().indexOf(c.id) !== -1 && isActive(c, opts()); });
    if (card) addRecord(card, state.amount, state.today.key, 'quick-feedback');
  });
  $('manual-special').addEventListener('change', function () {
    var n = Number(this.value);
    if (!Number.isSafeInteger(n) || n < 0) { this.value = manualFor(state.manualSpecialUsed, state.today.key); return; }
    state.manualSpecialUsed[state.today.key.slice(0,4)] = n; saveSettings(); refresh();
  });
  $('export-data').addEventListener('click', function () {
    var url = URL.createObjectURL(new Blob([JSON.stringify(backup(), null, 2)], {type:'application/json'}));
    var a = h('a', { href:url, download:'pxpick-' + state.today.key + '.json' }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
  $('import-data').addEventListener('change', async function () {
    var file = this.files[0]; if (!file) return;
    try {
      var data = validateBackup(JSON.parse(await file.text()));
      if (!confirm('현재 기록과 설정을 백업 내용으로 교체할까요?')) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(data)); location.reload();
    } catch (e) { notice('가져오지 못했어요. 백업 형식과 저장 공간을 확인해 주세요.'); }
    finally { this.value = ''; }
  });
  $('delete-data').addEventListener('click', function () {
    if (!confirm('모든 결제 기록과 v2 설정을 삭제할까요?')) return;
    try { localStorage.removeItem(STORE_KEY); location.reload(); } catch (e) { notice('삭제하지 못했어요. 기기의 저장 권한을 확인해 주세요.'); }
  });
  var tabs = Array.from(document.querySelectorAll('[data-tab]'));
  function selectTab(tab) {
    tabs.forEach(function (b) { var on = b === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; $('panel-' + b.dataset.tab).hidden = !on; });
    checkDate(); refresh(); window.scrollTo(0,0);
  }
  tabs.forEach(function (b, i) {
    b.addEventListener('click', function () { selectTab(b); });
    b.addEventListener('keydown', function (e) {
      var index = e.key === 'ArrowRight' ? (i+1)%3 : e.key === 'ArrowLeft' ? (i+2)%3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1;
      if (index < 0) return; e.preventDefault(); selectTab(tabs[index]); tabs[index].focus();
    });
  });

  // ----- 시작 -----

  selectMode(segItems.filter(function (b) { return b.getAttribute('data-mode') === state.ibkMode; })[0], false);
  // 예전 숫자 하나로 저장된 특별할인 수동 횟수는 올해 값으로 옮겨 바로 저장
  if (typeof saved.manualSpecialUsed === 'number') saveSettings();

  renderDay10();
  renderItems();
  setAmount(0);
  loadData();
})();
