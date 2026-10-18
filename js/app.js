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
    opts = opts || {};
    if (card.id === CONDITIONAL_ID && opts.ibkMode === 'none') return false;
    if (opts.militaryStatus === 'officer' && (card.id === 'kb' || card.id === 'ibk')) return false;
    if (opts.ibkQualified === false && card.id === 'ibk') return false;
    if (opts.shinhanAccount === false && card.id === 'shinhan') return false;
    return true;
  }

  function isUnconfirmed(card, opts) {
    if (!opts) return false;
    if (card.id === 'kb' && opts.militaryStatus === 'unconfirmed') return true;
    if (card.id === 'ibk' && (opts.militaryStatus === 'unconfirmed' || opts.ibkQualified === 'unconfirmed')) return true;
    if (card.id === 'shinhan' && opts.shinhanAccount === 'unconfirmed') return true;
    return false;
  }

  function hasSalaryPrivilege(opts) {
    if (!opts) return false;
    if (opts.ibkMode === 'salary') return true;
    if (opts.ibkSalary === true) {
      if (!opts.ibkSalaryStartMonth) return true;
      var curMonth = (opts.date || seoulDate().key).slice(0, 7);
      return curMonth > opts.ibkSalaryStartMonth;
    }
    return false;
  }

  function manualFor(value, date) {
    return typeof value === 'number' ? value : (value || {})[date.slice(0, 4)] || 0;
  }

  function getAdj(monthAdj, id) {
    var raw = (monthAdj || {})[id];
    if (raw == null) return { usedLow: 0, usedHigh: 0, countLow: 0, countHigh: 0, todayUsed: 0, asOf: null };
    if (typeof raw === 'number') {
      return { usedLow: raw, usedHigh: 0, countLow: 0, countHigh: 0, todayUsed: 0, asOf: null };
    }
    return {
      usedLow: raw.usedLow || 0,
      usedHigh: raw.usedHigh || 0,
      countLow: raw.countLow || 0,
      countHigh: raw.countHigh || 0,
      todayUsed: raw.todayUsed || 0,
      asOf: raw.asOf || null
    };
  }

  function sortRecords(records) {
    return (records || []).slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      var cA = a.createdAt || '';
      var cB = b.createdAt || '';
      if (cA !== cB) return cA.localeCompare(cB);
      return (a.id || '').localeCompare(b.id || '');
    });
  }

  function aggregate(records, date, manual, adjustments) {
    var month = date.slice(0, 7);
    var year = date.slice(0, 4);
    var out = { cards: {}, specialCount: manualFor(manual, date) };
    var monthAdj = (adjustments || {})[month] || {};

    ['hana', 'ibk', 'shinhan', 'kb'].forEach(function (id) {
      var adj = getAdj(monthAdj, id);
      var todayLow = (adj.asOf === date && adj.todayUsed) ? (typeof adj.todayUsed === 'number' ? adj.todayUsed : 1000) : 0;
      var todayCount = (adj.asOf === date && adj.todayUsed) ? 1 : 0;
      out.cards[id] = {
        month: [adj.usedLow, adj.usedHigh],
        counts: [adj.countLow, adj.countHigh],
        day: [todayLow, 0],
        dayCounts: [todayCount, 0],
        total: adj.usedLow + adj.usedHigh
      };
    });

    (records || []).forEach(function (r) {
      if (r.date > date) return;
      var isSpecial = !!(r.specialApplied || r.specialUsed);
      if (r.cardId === 'ibk' && isSpecial && r.date.slice(0, 4) === year) {
        out.specialCount++;
      }
      if (r.date.slice(0, 7) !== month) return;
      var c = out.cards[r.cardId] || (out.cards[r.cardId] = { month: [0, 0], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: 0 });
      var seg = r.amount < 30000 ? 0 : 1;
      var base = Math.max(0, (r.benefit != null ? r.benefit : 0) - (isSpecial ? 50000 : 0));
      c.month[seg] += base;
      c.counts[seg]++;
      c.total += (r.benefit != null ? r.benefit : 0);
      if (r.date === date) {
        c.day[seg] += base;
        c.dayCounts[seg]++;
      }
    });

    return out;
  }

  function replayRecords(records, adjustments, manualSpecial, upToDate, cardsData, opts) {
    var sorted = sortRecords(records);
    var runningUsage = { cards: {}, specialCount: 0 };
    var resultRecords = [];
    var currentMonth = null;
    var currentYear = null;
    var currentDate = null;

    sorted.forEach(function (r) {
      if (upToDate && r.date > upToDate) return;
      var rMonth = r.date.slice(0, 7);
      var rYear = r.date.slice(0, 4);

      if (rMonth !== currentMonth) {
        currentMonth = rMonth;
        currentYear = rYear;
        var monthAdj = (adjustments || {})[currentMonth] || {};
        runningUsage.cards = {};
        ['hana', 'ibk', 'shinhan', 'kb'].forEach(function (id) {
          var adj = getAdj(monthAdj, id);
          runningUsage.cards[id] = {
            month: [adj.usedLow, adj.usedHigh],
            counts: [adj.countLow, adj.countHigh],
            day: [0, 0],
            dayCounts: [0, 0],
            total: adj.usedLow + adj.usedHigh
          };
        });
        runningUsage.specialCount = manualFor(manualSpecial, r.date);
      }

      if (r.date !== currentDate) {
        currentDate = r.date;
        ['hana', 'ibk', 'shinhan', 'kb'].forEach(function (id) {
          var cUsage = runningUsage.cards[id];
          if (cUsage) {
            cUsage.day = [0, 0];
            cUsage.dayCounts = [0, 0];
          }
        });
      }

      var card = (cardsData || []).find(function (c) { return c.id === r.cardId; });
      if (!card) {
        resultRecords.push(Object.assign({}, r, { benefit: 0, specialApplied: false }));
        return;
      }

      var isDay10 = Number(r.date.slice(8, 10)) === 10;
      var calcOpts = Object.assign({}, opts, {
        date: r.date,
        isDay10: isDay10,
        usage: runningUsage,
        manualSpecialUsed: manualSpecial
      });

      var res = calcCard(card, r.amount, calcOpts);
      var seg = r.amount < 30000 ? 0 : 1;
      var u = runningUsage.cards[r.cardId] || (runningUsage.cards[r.cardId] = { month: [0, 0], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: 0 });
      u.month[seg] += res.base;
      u.counts[seg]++;
      u.total += res.total;
      u.day[seg] += res.base;
      u.dayCounts[seg]++;
      if (res.special > 0) {
        runningUsage.specialCount++;
      }

      resultRecords.push(Object.assign({}, r, {
        benefit: res.total,
        specialApplied: res.special > 0,
        recomputed: true
      }));
    });

    return resultRecords;
  }

  /**
   * @param card  cards.json의 카드 한 장
   * @param amount 결제 금액(원, 정수)
   * @param opts  { ibkMode, militaryStatus, ibkQualified, ibkSalary, ibkSalaryStartMonth, shinhanAccount, isDay10, date, records, manualSpecialUsed, monthAdjustments, usage }
   */
  function calcCard(card, amount, opts) {
    opts = opts || {};
    var px = card.px;
    var targetDate = opts.date || seoulDate().key;
    var day10 = opts.isDay10 != null ? !!(opts.isDay10 && px.tiersOnDay10) : (Number(targetDate.slice(8, 10)) === 10 && !!px.tiersOnDay10);
    var tiers = day10 && px.tiersOnDay10 ? px.tiersOnDay10 : px.tiers;
    var idx = tierIndex(tiers, amount);
    var rate = tiers[idx][1];
    var raw = Math.floor(amount * rate / 100);

    // 자격 조건에 따른 비활성 처리
    if (card.id === 'shinhan' && opts.shinhanAccount === false) {
      raw = 0;
    }
    if ((card.id === 'kb' || card.id === 'ibk') && opts.militaryStatus === 'officer') {
      raw = 0;
    }
    if (card.id === 'ibk' && opts.ibkQualified === false) {
      raw = 0;
    }

    var cap = px.capUnder && amount < px.capUnder.under ? px.capUnder.cap : px.capPerTxn;
    var monthCap = monthCapFor(px, amount);
    var limit = cap == null ? monthCap : monthCap == null ? cap : Math.min(cap, monthCap);
    var base = limit == null ? raw : Math.min(raw, limit);

    var usage = opts.usage || aggregate(opts.records, targetDate, opts.manualSpecialUsed, opts.monthAdjustments);
    var u = usage.cards[card.id] || { month: [0, 0], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: 0 };
    var segIdx = amount < 30000 ? 0 : 1;
    var seg = segmentLimit(px.limits, amount) || {};

    var isSalary = hasSalaryPrivilege(opts);
    var countLimit = isSalary && 'monthCountSalary' in seg ? seg.monthCountSalary : seg.monthCount;
    var reasons = [];
    if (countLimit != null && u.counts[segIdx] >= countLimit) { base = 0; reasons.push('이번 달 횟수 소진'); }
    if (seg.dayCount != null && u.dayCounts[segIdx] >= seg.dayCount) { base = 0; reasons.push('오늘 횟수 소진'); }

    var monthRemaining = monthCap == null ? null : Math.max(0, monthCap - (card.id === 'shinhan' ? u.total : u.month[segIdx]));
    if (monthRemaining != null && base > monthRemaining) { base = monthRemaining; reasons.push('월 잔여 한도까지만 적용'); }

    var dayRemaining = seg.dayCap == null ? null : Math.max(0, seg.dayCap - u.day[segIdx]);
    if (dayRemaining != null && base > dayRemaining) { base = dayRemaining; reasons.push('일 잔여 한도까지만 적용'); }

    var special = 0;
    var specialSpent = false;
    var isIbkActive = opts.ibkMode !== 'none' && opts.ibkQualified !== false && opts.militaryStatus !== 'officer';
    if (px.special && isIbkActive && amount >= px.special.minAmount) {
      var maxSpecialYear = isSalary ? px.special.yearCountSalary : px.special.yearCount;
      if (opts.ibkSpecialLeft === false || usage.specialCount >= maxSpecialYear) specialSpent = true;
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

  function scarcityScore(card, amount, result, opts) {
    if (!result || result.total <= 0) return 0;
    var isSalary = hasSalaryPrivilege(opts);
    if (card.id === 'ibk') {
      if (amount >= 30000) {
        return isSalary ? 1 : 4; // IBK 고액 횟수(월 2회)가 가장 희소 (급여이체는 무제한이라 1)
      } else {
        return 2; // IBK 소액 횟수 (월 3회, 급여 6회)
      }
    }
    if (card.id === 'kb') {
      if (amount < 30000) {
        return 3; // KB 소액 횟수 (월 2회)
      }
      return 1; // KB 고액은 금액 한도
    }
    return 1; // 금액 한도만 있는 카드 (하나, 신한)
  }

  function rankCards(cards, amount, opts) {
    opts = opts || {};
    var rows = cards.filter(function (c) {
      return !opts.ownedCards || opts.ownedCards.indexOf(c.id) !== -1;
    }).map(function (card, i) {
      var res = calcCard(card, amount, opts);
      return {
        card: card,
        order: i,
        result: res,
        active: isActive(card, opts),
        unconfirmed: isUnconfirmed(card, opts),
        scarcity: scarcityScore(card, amount, res, opts)
      };
    });

    var active = rows.filter(function (r) { return r.active; });

    // 1차: 최고 혜택액 계산
    var maxTotal = active.reduce(function (max, r) { return Math.max(max, r.result.total); }, 0);

    active.sort(function (a, b) {
      if (a.unconfirmed !== b.unconfirmed) return a.unconfirmed ? 1 : -1;
      var aNear = (maxTotal - a.result.total) <= 500 && a.result.total > 0;
      var bNear = (maxTotal - b.result.total) <= 500 && b.result.total > 0;
      if (aNear !== bNear) {
        return b.result.total - a.result.total;
      }
      if (aNear && bNear) {
        // 희소 자원 덜 쓰는 쪽 (scarcity 점수 오름차순: 아낄수록 뒤로)
        if (a.scarcity !== b.scarcity) {
          return a.scarcity - b.scarcity;
        }
        // 희소성 같고 동률이면 기본 카드 우선
        if (a.result.total === b.result.total && opts.defaultCard) {
          if (a.card.id === opts.defaultCard && b.card.id !== opts.defaultCard) return -1;
          if (b.card.id === opts.defaultCard && a.card.id !== opts.defaultCard) return 1;
        }
        if (b.result.total !== a.result.total) {
          return b.result.total - a.result.total;
        }
        return a.order - b.order;
      }
      return b.result.total - a.result.total || a.order - b.order;
    });

    // 2.5 동률·근소차 500원 이하 추천 이유 생성
    var reasonLine = null;
    if (active.length >= 1) {
      var top1 = active[0];
      // 원래 자연 혜택 1위(가장 높은 total을 가졌던 카드)를 찾아 비교
      var maxBenefitRow = active.slice().sort(function (a, b) {
        return b.result.total - a.result.total || a.order - b.order;
      })[0];

      if (maxBenefitRow && maxBenefitRow.card.id !== top1.card.id && (maxBenefitRow.result.total - top1.result.total) <= 500) {
        var diff = maxBenefitRow.result.total - top1.result.total;
        var savedCard = maxBenefitRow.card;
        var saveDesc = savedCard.id === 'ibk' ? '10만원 이상 결제를 위해' : savedCard.short + ' 횟수를';
        reasonLine = diff === 0
          ? '혜택이 같아서 ' + savedCard.short + '는 ' + saveDesc + ' 아꼈어요.'
          : '혜택 차이가 ' + diff + '원이라 ' + savedCard.short + '는 ' + saveDesc + ' 아꼈어요.';
      } else if (active.length >= 2 && active[1].result.total === top1.result.total) {
        // 동률 상태에서 이유 생성
        var other = active.find(function (r) { return r.card.id !== top1.card.id && r.scarcity > top1.scarcity && r.result.total === top1.result.total; });
        if (other) {
          var sCard = other.card;
          var sDesc = sCard.id === 'ibk' ? '10만원 이상 결제를 위해' : sCard.short + ' 횟수를';
          reasonLine = '혜택이 같아서 ' + sCard.short + '는 ' + sDesc + ' 아꼈어요.';
        } else if (opts.defaultCard && top1.card.id === opts.defaultCard) {
          reasonLine = '혜택이 같아서 기본 카드로 설정한 ' + top1.card.short + '를 추천해요.';
        }
      }
    }

    active.forEach(function (r, i) {
      r.rank = i > 0 && r.result.total === active[i - 1].result.total ? active[i - 1].rank : i + 1;
    });

    return {
      active: active,
      inactive: rows.filter(function (r) { return !r.active; }),
      reasonLine: reasonLine
    };
  }

  // 2.6 구간 힌트 개편: 순이익(혜택 증가 − 추가 금액) > 0 일 때만 노출. 200,000원 경계 포함
  function tierHint(cards, amount, opts) {
    cards = cards.filter(function (c) { return !opts.ownedCards || opts.ownedCards.indexOf(c.id) !== -1; });
    var targets = new Set();
    cards.forEach(function (card) {
      tiersFor(card.px, opts).forEach(function (t) {
        if (t[0] > amount) targets.add(t[0]);
      });
      if (card.px.special && card.px.special.minAmount > amount) {
        targets.add(card.px.special.minAmount);
      }
    });

    var current = rankCards(cards, amount, opts).active;
    if (!current.length || current[0].result.total === 0) return null;
    var currentTotal = current[0].result.total;

    var candidates = [];
    targets.forEach(function (target) {
      if (target > MAX_AMOUNT) return;
      var add = target - amount;
      var future = rankCards(cards, target, opts).active;
      if (!future.length) return;
      var futureTotal = future[0].result.total;
      var gain = futureTotal - currentTotal;
      var netGain = gain - add;
      if (netGain > 0) {
        candidates.push({
          card: future[0].card,
          target: target,
          add: add,
          total: futureTotal,
          gain: gain,
          netGain: netGain
        });
      }
    });

    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      return b.netGain - a.netGain || a.add - b.add;
    });
    return candidates[0];
  }

  function hintText(hint) {
    return won(hint.add) + ' 더 담으면 혜택 +' + hint.gain.toLocaleString('ko-KR') + '원 · 순이익 +' + hint.netGain.toLocaleString('ko-KR') + '원';
  }

  function sweepCardTable(cards, opts) {
    var ranges = [
      { label: '~29,999원', amount: 15000 },
      { label: '30,000~69,999원', amount: 50000 },
      { label: '70,000~99,999원', amount: 80000 },
      { label: '100,000~199,999원', amount: 120000 },
      { label: '200,000원~', amount: 200000 }
    ];

    return ranges.map(function (range) {
      var ranked = rankCards(cards, range.amount, opts);
      var top = ranked.active[0];
      if (!top || top.result.total === 0) {
        return {
          range: range.label,
          card: null,
          benefit: '혜택 없음',
          status: ''
        };
      }

      var c = top.card;
      var r = top.result;
      var benefitText = '';
      if (r.special > 0) {
        benefitText = won(r.total) + ' (특별할인 포함)';
      } else if (c.id === 'hana') {
        benefitText = range.amount < 30000 ? '30% (최대 5천원)' : '20% (건당 최대 2만원)';
      } else if (c.id === 'ibk') {
        benefitText = range.amount < 30000 ? '15%' : range.amount < 70000 ? '10%' : range.amount < 100000 ? '20%' : '30%';
      } else if (c.id === 'shinhan') {
        benefitText = (r.day10 && range.amount < 30000) ? '50% (최대 1천원)' : '20%';
      } else if (c.id === 'kb') {
        benefitText = range.amount < 30000 ? '10% (최대 1천원)' : '환급할인';
      }

      var statusParts = [];
      if (r.monthRemaining != null) statusParts.push('월 잔여 ' + won(r.monthRemaining));
      if (r.monthCountRemaining != null) statusParts.push('잔여 ' + r.monthCountRemaining + '회');
      if (top.unconfirmed) statusParts.push('조건 미확인');

      return {
        range: range.label,
        card: c,
        benefit: benefitText,
        status: statusParts.join(' · ')
      };
    });
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
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var validCardIds = ['hana', 'ibk', 'shinhan', 'kb'];
    return Object.keys(value).every(function (month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
      var cardsAdj = value[month];
      if (!cardsAdj || typeof cardsAdj !== 'object' || Array.isArray(cardsAdj)) return false;
      return Object.keys(cardsAdj).every(function (id) {
        if (validCardIds.indexOf(id) < 0) return false;
        var adj = cardsAdj[id];
        // v2 단일 숫자 보정
        if (typeof adj === 'number') {
          return Number.isSafeInteger(adj) && adj >= 0;
        }
        // v3 구조화 보정
        if (adj && typeof adj === 'object' && !Array.isArray(adj)) {
          if (adj.usedLow != null && (!Number.isSafeInteger(adj.usedLow) || adj.usedLow < 0)) return false;
          if (adj.usedHigh != null && (!Number.isSafeInteger(adj.usedHigh) || adj.usedHigh < 0)) return false;
          if (adj.countLow != null && (!Number.isSafeInteger(adj.countLow) || adj.countLow < 0)) return false;
          if (adj.countHigh != null && (!Number.isSafeInteger(adj.countHigh) || adj.countHigh < 0)) return false;
          if (adj.asOf != null && (typeof adj.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(adj.asOf))) return false;
          return true;
        }
        return false;
      });
    });
  }

  function validateBackup(value) {
    var ids = ['hana', 'ibk', 'shinhan', 'kb'];
    var settings = value && value.settings;
    if (!value || !settings || !Array.isArray(value.records)) throw new Error('백업 형식이 올바르지 않아요.');

    // v2 형식 지원 (기존 회귀 호환)
    if (value.version === 2) {
      if (!Array.isArray(settings.ownedCards) || new Set(settings.ownedCards).size !== settings.ownedCards.length ||
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

    // v3 형식 지원
    if (value.version === 3) {
      if (!Array.isArray(settings.ownedCards) || new Set(settings.ownedCards).size !== settings.ownedCards.length ||
          settings.ownedCards.some(function (id) { return ids.indexOf(id) < 0; }) ||
          !validManual(settings.manualSpecialUsed) ||
          (settings.adjustments && !validAdjustments(settings.adjustments))) throw new Error('백업 형식이 올바르지 않아요.');
      if (settings.militaryStatus && ['soldier', 'officer', 'unconfirmed'].indexOf(settings.militaryStatus) < 0) throw new Error('신분 설정이 올바르지 않아요.');
      if (settings.defaultCard && ids.indexOf(settings.defaultCard) < 0) throw new Error('기본 카드 설정이 올바르지 않아요.');

      var seen3 = new Set();
      value.records.forEach(function (r) {
        if (!r || typeof r.id !== 'string' || !r.id || seen3.has(r.id) ||
            typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
            !Number.isFinite(Date.parse(r.date)) || new Date(r.date).toISOString().slice(0, 10) !== r.date ||
            ids.indexOf(r.cardId) < 0 || !Number.isInteger(r.amount) || r.amount < 1 || r.amount > MAX_AMOUNT) throw new Error('기록 형식이 올바르지 않아요.');
        if (r.specialApplied != null && typeof r.specialApplied !== 'boolean') throw new Error('특별할인 적용 형식이 올바르지 않아요.');
        seen3.add(r.id);
      });
      return value;
    }

    throw new Error('지원하지 않는 백업 버전이에요.');
  }

  function migrateV2ToV3(v2Data) {
    if (!v2Data || v2Data.version !== 2) return v2Data;
    var settings = v2Data.settings || {};
    var ibkMode = settings.ibkMode || 'soldier';
    return {
      version: 3,
      settings: {
        ownedCards: settings.ownedCards || ['hana', 'ibk', 'shinhan', 'kb'],
        militaryStatus: ibkMode === 'none' ? 'unconfirmed' : 'soldier',
        ibkQualified: ibkMode !== 'none',
        ibkSalary: ibkMode === 'salary',
        ibkSalaryStartMonth: null,
        shinhanAccount: true,
        defaultCard: null,
        manualSpecialUsed: typeof settings.manualSpecialUsed === 'number'
          ? { [seoulDate().key.slice(0, 4)]: settings.manualSpecialUsed }
          : (settings.manualSpecialUsed || {}),
        adjustments: {}, // v2 단일 prior 폐기 (SPEC 5장)
        priorDiscardedBanner: true
      },
      records: (v2Data.records || []).map(function (r, idx) {
        return {
          id: r.id || String(idx + 1),
          date: r.date,
          amount: r.amount,
          cardId: r.cardId,
          specialApplied: !!r.specialUsed,
          createdAt: r.date + 'T00:00:00.000Z'
        };
      })
    };
  }

  var engine = {
    aggregate: aggregate,
    manualFor: manualFor,
    validateBackup: validateBackup,
    migrateV2ToV3: migrateV2ToV3,
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
    limitSentences: limitSentences,
    replayRecords: replayRecords,
    sweepCardTable: sweepCardTable,
    scarcityScore: scarcityScore,
    hasSalaryPrivilege: hasSalaryPrivilege,
    isUnconfirmed: isUnconfirmed,
    getAdj: getAdj,
    sortRecords: sortRecords
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = engine;
    return;
  }

  // ---------- 화면 ----------

  var SPRITE = 'icons/sprite.svg';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STORE_KEY = 'pxpick:v3';
  var OLD_STORE_KEY = 'pxpick:v2';

  // 스펙 6장: 오프라인 데이터 영구 보존 시도
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  function loadSettings() {
    try {
      var rawV3 = localStorage.getItem(STORE_KEY);
      if (rawV3) {
        return validateBackup(JSON.parse(rawV3));
      }
      var rawV2 = localStorage.getItem(OLD_STORE_KEY);
      if (rawV2) {
        var v2Data = validateBackup(JSON.parse(rawV2));
        var v3Data = migrateV2ToV3(v2Data);
        localStorage.setItem(STORE_KEY, JSON.stringify(v3Data));
        return v3Data;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  var rawStored = loadSettings();
  var isFirstVisit = !rawStored && (typeof localStorage !== 'undefined' && localStorage.getItem(STORE_KEY) == null && localStorage.getItem(OLD_STORE_KEY) == null);

  var stored = rawStored || {
    version: 3,
    settings: {
      ownedCards: ['hana', 'ibk', 'shinhan', 'kb'],
      militaryStatus: 'soldier',
      ibkQualified: true,
      ibkSalary: false,
      ibkSalaryStartMonth: null,
      shinhanAccount: true,
      defaultCard: null,
      manualSpecialUsed: {},
      adjustments: {},
      priorDiscardedBanner: false
    },
    records: []
  };

  var saved = stored.settings || {};
  var today = seoulDate();

  var state = {
    records: stored.records || [],
    ownedCards: saved.ownedCards || ['hana', 'ibk', 'shinhan', 'kb'],
    militaryStatus: saved.militaryStatus || (saved.ibkMode === 'none' ? 'unconfirmed' : 'soldier'),
    ibkMode: saved.ibkMode || (saved.ibkSalary ? 'salary' : (saved.ibkQualified === false ? 'none' : 'soldier')),
    ibkQualified: saved.ibkQualified !== false,
    ibkSalary: !!saved.ibkSalary,
    ibkSalaryStartMonth: saved.ibkSalaryStartMonth || null,
    shinhanAccount: saved.shinhanAccount !== false,
    defaultCard: saved.defaultCard || null,
    manualSpecialUsed: typeof saved.manualSpecialUsed === 'number' ? { [today.key.slice(0, 4)]: saved.manualSpecialUsed } : (saved.manualSpecialUsed || {}),
    adjustments: saved.adjustments || saved.monthAdjustments || {},
    priorDiscardedBanner: !!saved.priorDiscardedBanner,
    quickCard: null,
    excluded: [],
    items: [{ price: 0, qty: 1 }],
    itemsLinked: false,
    data: null,
    loadError: false,
    amount: 0,
    today: today,
    lastSaved: null
  };

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(backup()));
      return true;
    } catch (e) {
      notice('저장 공간을 사용할 수 없어요. 백업을 내보내 주세요.');
      return false;
    }
  }

  function backup() {
    return {
      version: 3,
      settings: {
        ownedCards: state.ownedCards,
        militaryStatus: state.militaryStatus,
        ibkQualified: state.ibkQualified,
        ibkSalary: state.ibkSalary,
        ibkSalaryStartMonth: state.ibkSalaryStartMonth,
        shinhanAccount: state.shinhanAccount,
        defaultCard: state.defaultCard,
        manualSpecialUsed: state.manualSpecialUsed,
        adjustments: state.adjustments,
        priorDiscardedBanner: state.priorDiscardedBanner
      },
      records: state.records
    };
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
    footer: $('footer'),
    freshnessText: $('freshness-text'),
    day10Badge: $('day10-badge'),
    cardTable: $('card-table'),
    quickCard: $('quick-card'),
    recordBest: $('record-best'),
    quickFeedback: $('quick-feedback')
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
    return {
      ibkMode: state.ibkMode,
      militaryStatus: state.militaryStatus,
      ibkQualified: state.ibkQualified,
      ibkSalary: state.ibkSalary,
      ibkSalaryStartMonth: state.ibkSalaryStartMonth,
      shinhanAccount: state.shinhanAccount,
      defaultCard: state.defaultCard,
      isDay10: state.today.day === 10,
      records: state.records,
      date: state.today.key,
      ownedCards: state.ownedCards,
      manualSpecialUsed: state.manualSpecialUsed,
      monthAdjustments: state.adjustments
    };
  }

  function payCards() {
    return state.ownedCards.filter(function (id) { return state.excluded.indexOf(id) === -1; });
  }

  function setLive(text) {
    if (ui.live && ui.live.textContent !== text) ui.live.textContent = text;
  }

  function renderFreshness() {
    if (!ui.freshnessText) return;
    if (!state.records.length) {
      ui.freshnessText.textContent = '아직 결제 기록이 없어요';
      return;
    }
    var todayKey = state.today.key;
    var todayCount = state.records.filter(function (r) { return r.date === todayKey; }).length;
    if (todayCount > 0) {
      ui.freshnessText.textContent = '오늘 ' + todayCount + '건 기록됨';
    } else {
      var sorted = sortRecords(state.records);
      var last = sorted[sorted.length - 1];
      var d1 = new Date(todayKey + 'T00:00:00Z');
      var d2 = new Date(last.date + 'T00:00:00Z');
      var diff = Math.max(1, Math.round((d1 - d2) / 86400000));
      ui.freshnessText.textContent = '마지막 기록 ' + diff + '일 전 (' + last.date + ')';
    }
  }

  function updateDay10Badge(rankedActive, o) {
    if (!ui.day10Badge) return;
    if (state.today.day !== 10 || !state.amount || !rankedActive.length) {
      ui.day10Badge.hidden = true;
      return;
    }
    var withoutDay10 = rankCards(state.data.cards, state.amount, Object.assign({}, o, { isDay10: false }));
    var changed = false;
    if (withoutDay10.active.length && rankedActive.length) {
      if (withoutDay10.active[0].card.id !== rankedActive[0].card.id) {
        changed = true;
      } else {
        var sWith = rankedActive.find(function (r) { return r.card.id === 'shinhan'; });
        var sWithout = withoutDay10.active.find(function (r) { return r.card.id === 'shinhan'; });
        if (sWith && sWithout && sWith.rank !== sWithout.rank) {
          changed = true;
        }
      }
    }
    ui.day10Badge.hidden = !changed;
  }

  function renderCardTable() {
    if (!ui.cardTable || !state.data) return;
    ui.cardTable.textContent = '';
    var o = opts();
    var table = sweepCardTable(state.data.cards, o);
    table.forEach(function (row) {
      var rowEl = h('div', { 'class': 'card-table__row' },
        h('span', { 'class': 'card-table__range', text: row.range }),
        row.card
          ? h('span', { 'class': 'card-table__card' }, dot(row.card.color), row.card.short)
          : h('span', { 'class': 'card-table__card', text: '혜택 없음' }),
        h('div', { 'class': 'card-table__right' },
          h('span', { 'class': 'card-table__benefit', text: row.benefit }),
          row.status ? h('span', { 'class': 'card-table__status', text: row.status }) : null
        )
      );
      ui.cardTable.appendChild(rowEl);
    });
  }

  function emptyState() {
    return h('div', { 'class': 'empty' }, icon('calculator', 24), h('p', { text: '금액을 입력하면 바로 비교해드려요' }));
  }

  function statusChips(r, isUnconf) {
    var texts = [];
    if (isUnconf) texts.push('조건 미확인');
    if (r.dayRemaining === 0 || r.dayCountRemaining === 0) texts.push('오늘 한도 소진');
    else if (r.dayRemaining != null) texts.push('오늘 잔여 ' + won(r.dayRemaining));
    if (r.monthCountRemaining != null) texts.push(r.monthCountRemaining ? '이번 달 ' + r.monthCountRemaining + '회 남음' : '이번 달 횟수 소진');
    if (r.monthRemaining != null) texts.push(r.monthRemaining ? '월 잔여 ' + won(r.monthRemaining) : '이번 달 한도 소진');
    if (r.specialSpent) texts.push('특별할인 소진');
    var node = h('div', { 'class': 'status-chips' });
    texts.forEach(function (text) { node.appendChild(h('span', { 'class': 'chip', text: text })); });
    return node;
  }

  function hero(winners, o, reasonLine) {
    var tie = winners.length > 1;
    var total = winners[0].result.total;
    var names = h('div', { 'class': 'hero__names' });
    var conds = h('div', { 'class': 'hero__conds' });
    winners.forEach(function (w) {
      names.appendChild(h('p', { 'class': 'hero__name' }, dot(w.card.color), w.card.name + ' · ' + w.card.benefitType));
      conds.appendChild(statusChips(w.result, w.unconfirmed));
      var line = conditionLine(w.card, w.result, o, false);
      conds.appendChild(h('p', { 'class': 'hero__cond', text: tie ? w.card.short + ' · ' + line : line }));
      var split = specialLine(w.card, w.result, o);
      if (split) conds.appendChild(h('p', { 'class': 'hero__split num', text: split }));
    });
    if (reasonLine) {
      conds.appendChild(h('p', { 'class': 'hero__cond hero__reason', text: reasonLine }));
    }
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
        h('p', { 'class': 'rank__name', text: row.card.name + ' · ' + row.card.benefitType }),
        row.active ? statusChips(row.result, row.unconfirmed) : null,
        h('p', { 'class': 'rank__cond', text: conditionLine(row.card, row.result, o, true) })),
      amount);
  }

  function updateRecordButton(rankedActive) {
    var btn = $('record-best');
    if (!btn) return;
    var select = $('quick-card');
    var cardId = select ? select.value : state.quickCard;

    var isSameAsSaved = state.lastSaved &&
      state.lastSaved.amount === state.amount &&
      state.lastSaved.cardId === cardId &&
      state.lastSaved.date === state.today.key;

    if (isSameAsSaved) {
      var savedCard = state.data && state.data.cards.find(function (c) { return c.id === cardId; });
      btn.disabled = true;
      btn.textContent = '저장됨 · ' + (savedCard ? savedCard.short : '') + ' ' + won(state.amount);
      return;
    }

    if (!state.amount || !state.data || !rankedActive || !rankedActive.length) {
      btn.disabled = true;
      btn.textContent = '결제 기록';
      return;
    }

    var card = state.data.cards.find(function (c) { return c.id === cardId && payCards().indexOf(c.id) !== -1 && isActive(c, opts()); });
    btn.disabled = !card;
    btn.textContent = card ? card.short + (card.id === 'shinhan' ? '으로' : '로') + ' 결제 기록' : '결제 기록';
  }

  function renderResult() {
    if (state.loadError) return;
    var root = ui.result;
    if (!root) return;
    root.textContent = '';
    if (!state.amount) {
      if ($('quick-card')) $('quick-card').textContent = '';
      root.appendChild(emptyState());
      setLive('');
      if (ui.day10Badge) ui.day10Badge.hidden = true;
      updateRecordButton([]);
      return;
    }
    if (!state.data) return;

    var o = opts();
    o.ownedCards = payCards();
    var cards = state.data.cards;
    var ranked = rankCards(cards, state.amount, o);

    renderQuickCards(ranked.active);
    updateRecordButton(ranked.active);
    updateDay10Badge(ranked.active, o);

    if (state.ownedCards.length && !o.ownedCards.length) {
      root.appendChild(h('p', { 'class': 'empty', text: '이번 결제에 쓸 카드를 모두 뺐어요. 위에서 쓸 카드를 하나 이상 눌러 주세요.' }));
      setLive('이번 결제에 쓸 카드를 골라 주세요.');
      return;
    }
    if (!ranked.active.length && !ranked.inactive.length) {
      root.appendChild(h('p', { 'class': 'empty', text: '설정에서 보유 카드를 선택해 주세요.' }));
      setLive('보유 카드를 선택해 주세요.');
      return;
    }
    var top = ranked.active.length ? ranked.active[0].result.total : 0;
    var rest = ranked.active;

    var hint = tierHint(cards, state.amount, o);
    if (hint) root.appendChild(h('p', { 'class': 'hint num' }, icon('info', 16), h('span', { text: hintText(hint) })));

    if (top > 0) {
      var winners = ranked.active.filter(function (r) { return r.rank === 1; });
      root.appendChild(hero(winners, o, ranked.reasonLine));
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

  function checkDate() {
    var now = seoulDate();
    if (now.key === state.today.key) return;
    state.today = now;
    refresh();
  }
  setInterval(checkDate, 60000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkDate();
  });

  function renderStatic() {
    var d = state.data;
    if (!ui.footer || !d) return;
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

  function errorBlock(text, alert) {
    var btn = h('button', { type: 'button', 'class': 'retry', text: '다시 시도' });
    btn.addEventListener('click', loadData);
    return h('div', alert ? { 'class': 'error', role: 'alert' } : { 'class': 'error' },
      icon('info', 24), h('p', { text: text }), btn);
  }

  function renderError() {
    if (ui.result) {
      ui.result.textContent = '';
      ui.result.appendChild(errorBlock('카드 데이터를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.', true));
    }
    if (ui.footer) {
      ui.footer.textContent = '';
      ui.footer.appendChild(h('p', { text: '출처 정보를 불러오지 못했어요.' }));
    }
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
        setupOnboarding();
      })
      .catch(function () {
        state.loadError = true;
        renderError();
      });
  }

  function setAmount(n) {
    state.amount = n;
    var text = n ? n.toLocaleString('ko-KR') : '';
    if (ui.input) ui.input.value = text;
    if (ui.field) {
      ui.field.setAttribute('data-value', text || '0');
      ui.field.classList.toggle('is-empty', !n);
    }
    if (ui.clear) ui.clear.hidden = !n;
    if (ui.kor) ui.kor.textContent = korWon(n);
    renderItemStatus();
    renderResult();
  }

  function setAmountDirect(n) {
    state.itemsLinked = false;
    setAmount(n);
  }

  if (ui.input) {
    ui.input.addEventListener('input', function () {
      var n = Number(ui.input.value.replace(/[^0-9]/g, ''));
      setAmountDirect(n <= MAX_AMOUNT ? n : state.amount);
    });
  }
  if (ui.clear) {
    ui.clear.addEventListener('click', function () { setAmountDirect(0); if (ui.input) ui.input.focus(); });
  }
  document.querySelectorAll('[data-add]').forEach(function (b) {
    b.addEventListener('click', function () { setAmountDirect(Math.min(MAX_AMOUNT, state.amount + Number(b.dataset.add))); });
  });

  function itemsTotal() {
    return state.items.reduce(function (sum, it) { return sum + it.price * it.qty; }, 0);
  }

  function renderItemStatus() {
    var total = itemsTotal();
    if ($('item-total')) $('item-total').textContent = won(total);
    var label = $('amount-area') ? $('amount-area').querySelector('.amount__label') : null;
    if (label) label.textContent = state.itemsLinked ? '결제 금액 · 물건별 합계' : '정확한 금액 입력';
    var root = $('item-status');
    if (!root) return;
    root.textContent = '';
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

  function syncItems() {
    var total = itemsTotal();
    if (state.itemsLinked && total <= MAX_AMOUNT) setAmount(total);
    else renderItemStatus();
  }

  function renderItems() {
    var root = $('item-rows');
    if (!root) return;
    root.textContent = '';
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
        if ($('item-add')) $('item-add').focus();
      });
      root.appendChild(h('div', { 'class': 'item-row' }, price, qty, h('span', { 'class': 'item-row__unit', 'aria-hidden': 'true', text: '개' }), del));
    });
  }

  if ($('item-add')) {
    $('item-add').addEventListener('click', function () {
      state.items.push({ price: 0, qty: 1 });
      renderItems();
      if ($('item-rows') && $('item-rows').lastChild) {
        var inp = $('item-rows').lastChild.querySelector('input');
        if (inp) inp.focus();
      }
    });
  }

  function renderPayCards() {
    var root = $('paycards-list');
    if (!root || !state.data) return;
    root.textContent = '';
    if ($('paycards')) $('paycards').hidden = !state.ownedCards.length;
    state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) {
      var on = state.excluded.indexOf(c.id) === -1;
      var chip = h('button', { type: 'button', 'class': 'pay-chip', 'aria-pressed': String(on), 'data-card': c.id }, dot(c.color, !on), c.short);
      chip.addEventListener('click', function () {
        var nowOn = chip.getAttribute('aria-pressed') !== 'true';
        state.excluded = nowOn ? state.excluded.filter(function (id) { return id !== c.id; }) : state.excluded.concat(c.id);
        chip.setAttribute('aria-pressed', String(nowOn));
        var d = chip.querySelector('.dot');
        if (d) d.classList.toggle('dot--off', !nowOn);
        renderResult();
      });
      root.appendChild(chip);
    });
  }

  var segItems = ui.segment ? Array.prototype.slice.call(ui.segment.querySelectorAll('[role="radio"]')) : [];

  function selectMode(btn, focus) {
    if (!btn) return;
    segItems.forEach(function (b) {
      var on = b === btn;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    if (focus) btn.focus();
    state.ibkMode = btn.getAttribute('data-mode');
    state.ibkQualified = state.ibkMode !== 'none';
    state.ibkSalary = state.ibkMode === 'salary';
    if (ui.desc) ui.desc.textContent = IBK_DESC[state.ibkMode];
  }

  segItems.forEach(function (btn, idx) {
    btn.addEventListener('click', function () {
      selectMode(btn, false);
      saveSettings();
      refresh();
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
    var select = $('quick-card');
    if (!select) return;
    select.textContent = '';
    rows.forEach(function (r) {
      select.appendChild(h('option', { value: r.card.id, text: r.card.name + (r.rank === 1 ? ' · 추천 1위' : '') }));
    });
    if (rows.some(function (r) { return r.card.id === state.quickCard; })) {
      select.value = state.quickCard;
    } else if (rows.length) {
      state.quickCard = rows[0].card.id;
      select.value = state.quickCard;
    }
  }

  if ($('quick-card')) {
    $('quick-card').addEventListener('change', function () {
      state.quickCard = this.value;
      renderResult();
    });
  }

  function showUndo(record, rootId) {
    var root = $(rootId);
    if (!root) return;
    root.textContent = '';
    var card = state.data && state.data.cards.find(function (c) { return c.id === record.cardId; });
    var shortName = card ? card.short : '';
    root.appendChild(h('span', { text: (rootId === 'quick-feedback' ? '저장됨 · ' + shortName + ' ' + won(record.amount) + ' ' : '결제 기록을 저장했어요. ') }));
    var button = h('button', { type: 'button', 'class': 'secondary btn-undo', text: '실행 취소' });
    button.addEventListener('click', function () {
      var before = state.records;
      state.records = state.records.filter(function (r) { return r.id !== record.id; });
      if (!saveSettings()) { state.records = before; return; }
      if (state.lastSaved && state.lastSaved.recordId === record.id) {
        state.lastSaved = null;
      }
      root.textContent = '방금 기록을 취소했어요.';
      refresh();
    });
    root.appendChild(button);
  }

  function addRecord(card, amount, date, feedbackId) {
    var r = calcCard(card, amount, recordOptions(date));
    var active = isActive(card, opts());
    var recordId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.random());
    var record = {
      id: recordId,
      date: date,
      amount: amount,
      cardId: card.id,
      benefit: active ? r.total : 0,
      specialApplied: active && r.special > 0,
      createdAt: new Date().toISOString()
    };
    state.records.push(record);
    // 스펙 2.8: 기록 저장 시 제외 칩 초기화
    state.excluded = [];
    if (!saveSettings()) {
      state.records.pop();
      return;
    }
    if (feedbackId === 'quick-feedback') {
      state.lastSaved = {
        cardId: card.id,
        amount: amount,
        date: date,
        recordId: record.id
      };
    }
    refresh();
    showUndo(record, feedbackId);
    notice(card.short + ' 결제 ' + won(amount) + ' · 혜택 ' + won(record.benefit) + ' 기록했어요.');
  }

  function notice(text) { if ($('notice')) $('notice').textContent = text; }
  function refresh() { renderSettings(); renderRecords(); setAmount(state.amount); }

  function renderRecords() {
    if (!state.data) return;
    var cards = state.data.cards;
    var o = opts();
    var replayed = replayRecords(state.records, state.adjustments, state.manualSpecialUsed, state.today.key, cards, o);

    renderGauges(replayed);
    renderMonthSummary(replayed);
    renderRecordList(replayed);
    renderFreshness();
    renderCardTable();
  }

  function renderGauges(replayed) {
    var root = $('usage-gauges');
    if (!root || !state.data) return;
    root.textContent = '';
    var o = opts();
    var usage = aggregate(replayed, state.today.key, state.manualSpecialUsed, state.adjustments);

    state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) {
      var u = usage.cards[c.id] || { month: [0, 0], counts: [0, 0], day: [0, 0], dayCounts: [0, 0], total: 0 };
      var cardBox = h('article', { 'class': 'gauge-card' },
        h('div', { 'class': 'gauge-head' }, dot(c.color), c.name + ' · ' + c.benefitType)
      );

      var lowCap = monthCapFor(c.px, 15000);
      var lowSeg = segmentLimit(c.px.limits, 15000) || {};
      var lowCountCap = hasSalaryPrivilege(o) && 'monthCountSalary' in lowSeg ? lowSeg.monthCountSalary : lowSeg.monthCount;
      var lowUsed = c.id === 'shinhan' ? u.total : u.month[0];
      var lowCapText = lowCap != null ? won(lowUsed) + ' / ' + won(lowCap) : won(lowUsed);
      var lowPct = lowCap ? Math.min(100, Math.round(lowUsed / lowCap * 100)) : 0;
      var countText = lowCountCap != null ? ' (' + u.counts[0] + '/' + (lowCountCap == null ? '무제한' : lowCountCap + '회') + ')' : '';

      var itemLow = h('div', { 'class': 'gauge-item' },
        h('div', { 'class': 'gauge-item-title' },
          h('span', { text: '3만원 미만 구간' + countText }),
          h('span', { 'class': 'num', text: lowCapText })
        ),
        h('div', { 'class': 'gauge-bar' },
          h('div', { 'class': 'gauge-fill', style: 'width:' + lowPct + '%; background:' + c.color })
        )
      );
      cardBox.appendChild(itemLow);

      var highCap = monthCapFor(c.px, 50000);
      var highSeg = segmentLimit(c.px.limits, 50000) || {};
      var highCountCap = hasSalaryPrivilege(o) && 'monthCountSalary' in highSeg ? highSeg.monthCountSalary : highSeg.monthCount;
      var highUsed = c.id === 'shinhan' ? u.total : u.month[1];
      var highCapText = highCap != null ? won(highUsed) + ' / ' + won(highCap) : won(highUsed);
      var highPct = highCap ? Math.min(100, Math.round(highUsed / highCap * 100)) : 0;
      var highCountText = highCountCap != null ? ' (' + u.counts[1] + '/' + (highCountCap == null ? '무제한' : highCountCap + '회') + ')' : '';

      var itemHigh = h('div', { 'class': 'gauge-item' },
        h('div', { 'class': 'gauge-item-title' },
          h('span', { text: '3만원 이상 구간' + highCountText }),
          h('span', { 'class': 'num', text: highCapText })
        ),
        h('div', { 'class': 'gauge-bar' },
          h('div', { 'class': 'gauge-fill', style: 'width:' + highPct + '%; background:' + c.color })
        )
      );
      cardBox.appendChild(itemHigh);

      if (c.px.special) {
        var spMax = yearCount(c.px.special, o.ibkMode);
        var spUsed = usage.specialCount;
        var spPct = Math.min(100, Math.round(spUsed / spMax * 100));
        var itemSp = h('div', { 'class': 'gauge-item' },
          h('div', { 'class': 'gauge-item-title' },
            h('span', { text: '올해 20만원 특별할인' }),
            h('span', { 'class': 'num', text: spUsed + ' / ' + spMax + '회' })
          ),
          h('div', { 'class': 'gauge-bar' },
            h('div', { 'class': 'gauge-fill', style: 'width:' + spPct + '%; background:' + c.color })
          )
        );
        cardBox.appendChild(itemSp);
      }

      root.appendChild(cardBox);
    });
  }

  function renderMonthSummary(replayed) {
    var root = $('month-summary');
    if (!root || !state.data) return;
    root.textContent = '';
    var curMonth = state.today.key.slice(0, 7);
    var monthRecords = replayed.filter(function (r) { return r.date.slice(0, 7) === curMonth; });
    var totalBenefit = monthRecords.reduce(function (sum, r) { return sum + (r.benefit || 0); }, 0);
    var usage = aggregate(replayed, state.today.key, state.manualSpecialUsed, state.adjustments);

    root.appendChild(h('h3', { text: curMonth + ' 예상 혜택 합계: ' + won(totalBenefit) }));
    state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) {
      var u = usage.cards[c.id] || { total: 0, month: [0, 0], counts: [0, 0] };
      var r = calcCard(c, 20000, opts());
      var box = h('article', { 'class': 'summary-card' },
        h('p', { 'class': 'hero__name' }, dot(c.color), c.short + ' · ' + won(u.total)),
        h('p', { 'class': 'settings__desc', text: '기록 ' + (u.counts[0] + u.counts[1]) + '회' }),
        statusChips(r, isUnconfirmed(c, opts()))
      );
      root.appendChild(box);
    });
  }

  function renderRecordList(replayed) {
    var root = $('record-list');
    if (!root || !state.data) return;
    root.textContent = '';
    var month = '';
    var sorted = replayed.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    sorted.forEach(function (r) {
      if (month !== r.date.slice(0, 7)) {
        month = r.date.slice(0, 7);
        root.appendChild(h('h3', { text: month }));
      }
      var c = state.data.cards.find(function (c) { return c.id === r.cardId; });
      var cardName = c ? c.name : r.cardId;
      var cardShort = c ? c.short : r.cardId;
      var button = h('button', { type: 'button', text: '삭제', 'aria-label': r.date + ' ' + cardShort + ' ' + won(r.amount) + ' 기록 삭제' });
      button.addEventListener('click', function () {
        var before = state.records;
        state.records = state.records.filter(function (x) { return x.id !== r.id; });
        if (!saveSettings()) { state.records = before; return; }
        refresh();
      });
      root.appendChild(h('article', { 'class': 'record-item num' },
        h('p', { text: r.date + ' · ' + cardName }),
        h('p', { text: won(r.amount) + ' · 예상 혜택 ' + won(r.benefit != null ? r.benefit : 0) + (r.specialApplied ? ' · 특별할인 적용' : '') }),
        button
      ));
    });
    if (!replayed.length) {
      root.appendChild(h('p', { 'class': 'empty', text: '아직 결제 기록이 없어요.' }));
    }
  }

  function renderSettings() {
    if (!state.data) return;

    var milBtns = $('military-status') ? Array.from($('military-status').querySelectorAll('button')) : [];
    milBtns.forEach(function (btn) {
      var on = btn.getAttribute('data-status') === state.militaryStatus;
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
    });

    var ownedRoot = $('owned-cards');
    if (ownedRoot) {
      ownedRoot.textContent = '';
      state.data.cards.forEach(function (c) {
        var input = h('input', { type: 'checkbox', value: c.id });
        input.checked = state.ownedCards.indexOf(c.id) !== -1;
        input.addEventListener('change', function () {
          state.ownedCards = state.data.cards.filter(function (card) {
            return card.id === c.id ? input.checked : state.ownedCards.indexOf(card.id) !== -1;
          }).map(function (card) { return card.id; });
          saveSettings();
          refresh();
        });
        ownedRoot.appendChild(h('label', null, input, dot(c.color), c.name));
      });
    }

    if ($('default-card')) {
      $('default-card').value = state.defaultCard || '';
    }

    if ($('ibk-desc')) {
      $('ibk-desc').textContent = IBK_DESC[state.ibkMode];
    }
    if ($('ibk-salary-start')) {
      $('ibk-salary-start').value = state.ibkSalaryStartMonth || '';
    }
    if ($('manual-special')) {
      $('manual-special').value = manualFor(state.manualSpecialUsed, state.today.key);
    }

    if ($('shinhan-account')) {
      $('shinhan-account').checked = state.shinhanAccount;
    }

    if ($('prior-notice-banner')) {
      $('prior-notice-banner').hidden = !state.priorDiscardedBanner;
    }

    renderAdjustments();
    renderCardDetails();
    renderPayCards();

    var select = $('record-card');
    if (select) {
      var previous = select.value;
      select.textContent = '';
      state.data.cards.filter(function (c) { return state.ownedCards.indexOf(c.id) !== -1; }).forEach(function (c) {
        select.appendChild(h('option', { value: c.id, text: c.name }));
      });
      if (state.ownedCards.indexOf(previous) !== -1) select.value = previous;
      if ($('record-submit')) $('record-submit').disabled = !state.ownedCards.length;
    }
    previewRecord();
  }

  function renderAdjustments() {
    var root = $('month-adjustments');
    if (!root || !state.data) return;
    root.textContent = '';
    var month = state.today.key.slice(0, 7);
    if (!state.adjustments[month]) state.adjustments[month] = {};
    var mAdj = state.adjustments[month];

    state.data.cards.forEach(function (c) {
      var adj = getAdj(mAdj, c.id);
      var cardBox = h('div', { 'class': 'adj-card' },
        h('div', { 'class': 'adj-card-title' }, dot(c.color), c.short + ' 기록 전 사용분 보정')
      );
      var grid = h('div', { 'class': 'adj-grid' });

      function makeInput(label, field, val) {
        var input = h('input', {
          type: 'number',
          min: '0',
          step: '1',
          'data-card': c.id,
          'data-field': field,
          value: String(val || 0)
        });
        input.addEventListener('change', function () {
          var n = Number(input.value);
          if (!Number.isSafeInteger(n) || n < 0) { input.value = String(val || 0); return; }
          if (!mAdj[c.id]) mAdj[c.id] = {};
          mAdj[c.id][field] = n;
          mAdj[c.id].asOf = state.today.key;
          saveSettings();
          refresh();
        });
        return h('label', { 'class': 'form-field' }, label, input);
      }

      grid.appendChild(makeInput('소액 혜택액 (원)', 'usedLow', adj.usedLow));
      grid.appendChild(makeInput('소액 횟수 (회)', 'countLow', adj.countLow));
      grid.appendChild(makeInput('고액 혜택액 (원)', 'usedHigh', adj.usedHigh));
      grid.appendChild(makeInput('고액 횟수 (회)', 'countHigh', adj.countHigh));

      cardBox.appendChild(grid);
      root.appendChild(cardBox);
    });
  }

  function renderCardDetails() {
    var root = $('card-details-list');
    if (!root || !state.data) return;
    root.textContent = '';
    state.data.cards.forEach(function (c) {
      var px = c.px;
      var conds = h('ul', { 'class': 'bcard__conds' });
      px.conditions.concat(limitSentences(px)).forEach(function (text) {
        conds.appendChild(h('li', null, h('span', { 'class': 'bcard__bullet' }, icon('check', 16)), h('span', { text: text })));
      });
      var hls = h('ul', { 'class': 'bcard__highlights' });
      c.highlights.forEach(function (hl) {
        hls.appendChild(h('li', null,
          h('p', { 'class': 'bcard__hl-title', text: hl.title }),
          h('p', { 'class': 'bcard__hl-cond', text: hl.cond })
        ));
      });
      var details = h('details', { 'class': 'card-detail' },
        h('summary', { 'class': 'card-detail__summary' },
          h('span', null, dot(c.color), ' ' + c.name + ' (' + c.benefitType + ')'),
          icon('chevron-down', 16)
        ),
        h('div', { 'class': 'card-detail__content' },
          h('p', { 'class': 'bcard__account', text: c.account }),
          h('p', { 'class': 'bcard__sub', text: 'PX 혜택 요약: ' + px.summary }),
          conds,
          h('div', { 'class': 'bcard__divider' }),
          h('p', { 'class': 'bcard__sub', text: '대표 혜택' }),
          hls
        )
      );
      root.appendChild(details);
    });
  }

  function recordOptions(date) {
    var o = opts();
    o.date = date;
    o.isDay10 = Number(date.slice(8, 10)) === 10;
    return o;
  }

  function previewRecord() {
    if (!state.data) return;
    var c = state.data.cards.find(function (c) { return c.id === ($('record-card') ? $('record-card').value : ''); });
    var amount = Number($('record-amount') ? $('record-amount').value : 0);
    var dateVal = $('record-date') ? $('record-date').value : '';
    if (c && amount > 0 && amount <= MAX_AMOUNT && dateVal) {
      var r = calcCard(c, amount, recordOptions(dateVal));
      if ($('record-preview')) {
        $('record-preview').textContent = '예상 혜택 ' + won(r.total) +
          (c.id === 'ibk' && state.ibkMode === 'none' ? ' · 현역병 인정 시 참고값, 저장 혜택 0원' : '');
      }
    } else {
      if ($('record-preview')) $('record-preview').textContent = '';
    }
  }

  if ($('record-date')) $('record-date').value = state.today.key;
  ['record-date', 'record-amount', 'record-card'].forEach(function (id) {
    if ($(id)) $(id).addEventListener('input', previewRecord);
  });

  if ($('record-form')) {
    $('record-form').addEventListener('submit', function (e) {
      e.preventDefault();
      checkDate();
      var amount = Number($('record-amount').value);
      var date = $('record-date').value;
      var card = state.data && state.data.cards.find(function (c) {
        return c.id === $('record-card').value && state.ownedCards.indexOf(c.id) !== -1;
      });
      if (!card || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT || !date || date > state.today.key) {
        notice('오늘까지의 날짜와 올바른 금액·카드를 선택해 주세요.');
        return;
      }
      addRecord(card, amount, date, 'record-feedback');
    });
  }

  if ($('record-best')) {
    $('record-best').addEventListener('click', function () {
      checkDate();
      if (!state.data || !state.amount) return;
      var card = state.data.cards.find(function (c) {
        return c.id === ($('quick-card') ? $('quick-card').value : state.quickCard) && payCards().indexOf(c.id) !== -1 && isActive(c, opts());
      });
      if (card) addRecord(card, state.amount, state.today.key, 'quick-feedback');
    });
  }

  if ($('manual-special')) {
    $('manual-special').addEventListener('change', function () {
      var n = Number(this.value);
      if (!Number.isSafeInteger(n) || n < 0) {
        this.value = manualFor(state.manualSpecialUsed, state.today.key);
        return;
      }
      state.manualSpecialUsed[state.today.key.slice(0, 4)] = n;
      saveSettings();
      refresh();
    });
  }

  if ($('military-status')) {
    Array.from($('military-status').querySelectorAll('button')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.militaryStatus = btn.getAttribute('data-status');
        saveSettings();
        refresh();
      });
    });
  }

  if ($('default-card')) {
    $('default-card').addEventListener('change', function () {
      state.defaultCard = this.value || null;
      saveSettings();
      refresh();
    });
  }

  if ($('ibk-salary-start')) {
    $('ibk-salary-start').addEventListener('change', function () {
      state.ibkSalaryStartMonth = this.value || null;
      saveSettings();
      refresh();
    });
  }

  if ($('shinhan-account')) {
    $('shinhan-account').addEventListener('change', function () {
      state.shinhanAccount = this.checked;
      saveSettings();
      refresh();
    });
  }

  if ($('export-data')) {
    $('export-data').addEventListener('click', function () {
      var url = URL.createObjectURL(new Blob([JSON.stringify(backup(), null, 2)], { type: 'application/json' }));
      var a = h('a', { href: url, download: 'pxpick-' + state.today.key + '.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  if ($('import-data')) {
    $('import-data').addEventListener('change', async function () {
      var file = this.files[0];
      if (!file) return;
      try {
        var json = JSON.parse(await file.text());
        var data = validateBackup(json);
        if (data.version === 2) {
          data = migrateV2ToV3(data);
        }
        if (!confirm('현재 기록과 설정을 백업 내용으로 교체할까요?')) return;
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
        location.reload();
      } catch (e) {
        notice('가져오지 못했어요. 백업 형식과 저장 공간을 확인해 주세요.');
      } finally {
        this.value = '';
      }
    });
  }

  if ($('delete-data')) {
    $('delete-data').addEventListener('click', function () {
      if (!confirm('모든 결제 기록과 설정을 삭제할까요?')) return;
      try {
        localStorage.removeItem(STORE_KEY);
        localStorage.removeItem(OLD_STORE_KEY);
        location.reload();
      } catch (e) {
        notice('삭제하지 못했어요. 기기의 저장 권한을 확인해 주세요.');
      }
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(function () {
      if ($('offline-status')) $('offline-status').hidden = false;
    }).catch(function () {});
  }

  var tabs = Array.from(document.querySelectorAll('[data-tab]'));
  function selectTab(tab) {
    tabs.forEach(function (b) {
      var on = b === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      var panel = $('panel-' + b.dataset.tab);
      if (panel) panel.hidden = !on;
    });
    checkDate();
    refresh();
    window.scrollTo(0, 0);
  }
  tabs.forEach(function (b, i) {
    b.addEventListener('click', function () { selectTab(b); });
    b.addEventListener('keydown', function (e) {
      var index = e.key === 'ArrowRight' ? (i + 1) % 3 : e.key === 'ArrowLeft' ? (i + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1;
      if (index < 0) return;
      e.preventDefault();
      selectTab(tabs[index]);
      tabs[index].focus();
    });
  });

  function setupOnboarding() {
    var modal = $('onboarding-modal');
    if (!modal) return;
    if (isFirstVisit) {
      modal.hidden = false;
    }
    var onboardCards = $('onboard-cards');
    if (onboardCards && state.data) {
      onboardCards.textContent = '';
      state.data.cards.forEach(function (c) {
        var input = h('input', { type: 'checkbox', value: c.id });
        input.checked = true;
        onboardCards.appendChild(h('label', null, input, dot(c.color), c.short));
      });
    }

    var finishBtn = $('onboard-finish');
    if (finishBtn) {
      finishBtn.addEventListener('click', function () {
        var activeMil = $('onboard-military') ? $('onboard-military').querySelector('[aria-checked="true"]') : null;
        if (activeMil) {
          state.militaryStatus = activeMil.getAttribute('data-status');
        }
        if (onboardCards) {
          var checked = Array.from(onboardCards.querySelectorAll('input:checked')).map(function (i) { return i.value; });
          state.ownedCards = checked.length ? checked : ['hana', 'ibk', 'shinhan', 'kb'];
        }
        modal.hidden = true;
        saveSettings();
        refresh();
      });
    }
  }

  ['onboard-military', 'onboard-usage'].forEach(function (id) {
    var seg = $(id);
    if (!seg) return;
    var btns = Array.from(seg.querySelectorAll('button'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (btn) { btn.setAttribute('aria-checked', String(btn === b)); });
      });
    });
  });

  if (segItems.length) {
    selectMode(segItems.filter(function (b) { return b.getAttribute('data-mode') === state.ibkMode; })[0] || segItems[0], false);
  }
  if (typeof saved.manualSpecialUsed === 'number') saveSettings();
  renderItems();
  setAmount(0);
  loadData();
})();
