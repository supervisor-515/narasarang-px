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

  /**
   * @param card  cards.json의 카드 한 장
   * @param amount 결제 금액(원, 정수)
   * @param opts  { ibkMode: 'soldier' | 'salary' | 'none', isDay10: boolean, ibkSpecialLeft: boolean(기본 true) }
   */
  function calcCard(card, amount, opts) {
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

    var special = 0;
    var specialSpent = false;
    if (px.special && opts.ibkMode !== 'none' && amount >= px.special.minAmount) {
      if (opts.ibkSpecialLeft === false) specialSpent = true;
      else special = px.special.fixed;
    }

    return {
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
    var rows = cards.map(function (card, i) {
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
    var target = null;
    cards.forEach(function (card) {
      tiersFor(card.px, opts).forEach(function (t) {
        if (t[0] > amount && (target == null || t[0] < target)) target = t[0];
      });
    });
    if (target == null || target > MAX_AMOUNT) return null;
    var best = null;
    cards.forEach(function (card) {
      if (!isActive(card, opts)) return;
      var then = calcCard(card, target, opts).total;
      var gain = then - calcCard(card, amount, opts).total;
      if (gain > 0 && (!best || gain > best.gain)) {
        best = { card: card, target: target, add: target - amount, total: then, gain: gain };
      }
    });
    return best;
  }

  function hintText(hint) {
    return won(hint.add) + ' 더 담아 ' + won(hint.target) + '에 맞추면 ' + hint.card.short + ' 혜택 ' +
      won(hint.total) + ' (+' + hint.gain.toLocaleString('ko-KR') + ')';
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
    return parts.join(' · ');
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

  var engine = {
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
  var STORE_KEY = 'pxpick:settings';

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }

  var saved = loadSettings();
  var today = seoulDate();

  var state = {
    data: null,
    loadError: false,
    amount: 0,
    ibkMode: IBK_DESC.hasOwnProperty(saved.ibkMode) ? saved.ibkMode : 'soldier',
    ibkSpecialLeft: saved.ibkSpecialLeft !== false,
    // 사용자가 직접 고른 '매월 10일로 보기' 값. 실제 10일에는 이 값과 무관하게 켠 상태로 시작
    day10Pref: saved.day10View === true,
    today: today,
    day10View: false
  };
  state.day10View = today.day === 10 || state.day10Pref;

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        ibkMode: state.ibkMode,
        ibkSpecialLeft: state.ibkSpecialLeft,
        day10View: state.day10Pref
      }));
    } catch (e) { /* 저장 불가(사파리 개인 정보 보호 등)면 무시 */ }
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
    specialToggle: $('toggle-ibk-special'),
    day10Toggle: $('toggle-day10'),
    day10: $('day10-slot'),
    benefits: $('benefits'),
    list: $('benefit-list'),
    footer: $('footer'),
    keypad: $('keypad'),
    keypadClose: $('keypad-close'),
    back: $('key-back'),
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
    return { ibkMode: state.ibkMode, isDay10: state.day10View, ibkSpecialLeft: state.ibkSpecialLeft };
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
      names.appendChild(h('p', { 'class': 'hero__name' }, dot(w.card.color), w.card.name));
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
        h('p', { 'class': 'rank__name', text: row.card.name }),
        h('p', { 'class': 'rank__cond', text: conditionLine(row.card, row.result, o, true) })),
      amount);
  }

  function renderResult() {
    // 오류 상태는 renderError가 한 번 그려 두고, 입력이 바뀌어도 유지한다
    if (state.loadError) return;
    var root = ui.result;
    root.textContent = '';
    if (!state.amount) { root.appendChild(emptyState()); setLive(''); return; }
    if (!state.data) return;

    var o = opts();
    var cards = state.data.cards;
    var ranked = rankCards(cards, state.amount, o);
    var top = ranked.active[0].result.total;
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

  function renderSpecialToggle() {
    ui.specialToggle.setAttribute('aria-checked', state.ibkSpecialLeft ? 'true' : 'false');
  }

  ui.specialToggle.addEventListener('click', function () {
    state.ibkSpecialLeft = !state.ibkSpecialLeft;
    saveSettings();
    renderSpecialToggle();
    renderResult();
  });

  ui.day10Toggle.addEventListener('click', function () {
    state.day10View = !state.day10View;
    state.day10Pref = state.day10View;
    saveSettings();
    renderDay10();
    renderResult();
  });

  // 서울 기준 날짜가 바뀌면 10일 상태를 다시 정한다 (화면을 켜 둔 채 자정이 지나는 경우)
  function checkDate() {
    var now = seoulDate();
    if (now.key === state.today.key) return;
    state.today = now;
    state.day10View = now.day === 10 || state.day10Pref;
    renderDay10();
    renderResult();
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
        renderResult();
      })
      .catch(function () {
        state.loadError = true;
        renderError();
      });
  }

  // ----- 금액 입력 (내장 키패드 + 하드웨어 키보드) -----

  function setAmount(n) {
    state.amount = n;
    var text = n ? n.toLocaleString('ko-KR') : '';
    ui.input.value = text;
    ui.field.setAttribute('data-value', text || '0');
    ui.field.classList.toggle('is-empty', !n);
    ui.clear.hidden = !n;
    ui.kor.textContent = korWon(n);
    ui.back.classList.toggle('is-idle', !n);
    renderResult();
  }

  // 숫자 키 ('0'~'9', '00')를 뒤에 붙인다. 상한을 넘으면 무시
  function typeKey(k) {
    if (!state.amount && k.charAt(0) === '0') return;
    var next = Number(String(state.amount || '') + k);
    if (next > MAX_AMOUNT) return;
    setAmount(next);
  }

  function addAmount(n) {
    var next = state.amount + n;
    if (next > MAX_AMOUNT) return;
    setAmount(next);
  }

  function backspace() {
    setAmount(Math.floor(state.amount / 10));
  }

  // input은 readonly라 시스템 키보드가 뜨지 않는다. 하드웨어 키보드는 여기서 받는다
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      typeKey(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      backspace();
    } else if (e.key === 'Delete' && e.target === ui.input) {
      e.preventDefault();
      setAmount(0);
    }
  });

  ui.clear.addEventListener('click', function () {
    setAmount(0);
    if (window.matchMedia('(pointer: fine)').matches) ui.input.focus();
  });

  ui.field.addEventListener('click', function () { ui.input.focus(); });

  // ----- 키패드 -----

  var keypadState = { closed: false, autoHidden: false };

  function updateKeypad() {
    ui.keypad.hidden = keypadState.closed || keypadState.autoHidden;
  }

  // 사용자가 직접 연 경우: 수동 닫힘과 자동 접힘 모두 해제
  function openKeypad() {
    keypadState.closed = false;
    keypadState.autoHidden = false;
    updateKeypad();
  }

  ui.keypad.addEventListener('click', function (e) {
    var add = e.target.closest('[data-add]');
    if (add) { addAmount(Number(add.getAttribute('data-add'))); return; }
    var key = e.target.closest('[data-key]');
    if (key) typeKey(key.getAttribute('data-key'));
  });

  // 백스페이스: 탭 = 한 글자, 500ms 길게 = 전체
  var holdTimer = null;
  var holdFired = false;
  function cancelHold() { clearTimeout(holdTimer); holdTimer = null; }
  ui.back.addEventListener('pointerdown', function () {
    holdFired = false;
    cancelHold();
    holdTimer = setTimeout(function () {
      holdFired = true;
      holdTimer = null;
      setAmount(0);
    }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) {
    ui.back.addEventListener(t, cancelHold);
  });
  ui.back.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  ui.back.addEventListener('click', function () {
    if (holdFired) { holdFired = false; return; }
    backspace();
  });

  ui.keypadClose.addEventListener('click', function () {
    keypadState.closed = true;
    updateKeypad();
  });

  ui.area.addEventListener('click', openKeypad);

  // 카드별 혜택 섹션 상단이 화면 절반 위로 올라가면 키패드를 내린다.
  // rootMargin으로 뷰포트 위쪽 절반만 관찰해, 상단이 중앙선을 지날 때마다 콜백이 온다.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      var entry = entries[entries.length - 1];
      keypadState.autoHidden = entry.boundingClientRect.top < window.innerHeight / 2;
      updateKeypad();
    }, { rootMargin: '0px 0px -50% 0px' }).observe(ui.benefits);
  }

  ui.toTop.addEventListener('click', function () {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    openKeypad();
  });

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
    });
    btn.addEventListener('keydown', function (e) {
      var step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      selectMode(segItems[(idx + step + segItems.length) % segItems.length], true);
      saveSettings();
      renderResult();
    });
  });

  // ----- 시작 -----

  selectMode(segItems.filter(function (b) { return b.getAttribute('data-mode') === state.ibkMode; })[0], false);
  renderSpecialToggle();
  renderDay10();
  setAmount(0);
  loadData();
})();
