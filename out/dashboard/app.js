// Launch Radar's page. Reads window.RADAR (written beside dashboard/ by main.ts) and renders three
// views — the ranked board, the already-trading comparison set, and the screened-out register —
// plus a detail page per protocol and a side-by-side compare view. Board rows can be pinned (a
// pinned-only filter keeps them in view) and up to three can be set aside in a compare tray.
// All state lives in the location hash, so every view has an address:
//   #/                 the board          #/live          already trading
//   #/board?cat=...    a filtered board   #/off           off the board, with reasons
//   #/p/<slug>         one protocol's detail page
//   #/compare?slugs=   two or three protocols side by side, factor by factor
// No network: every byte the page shows came out of the sealed snapshot by way of data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var bySlug = {};
  DATA.rows.forEach(function (r) { bySlug[r.slug] = r; });

  // ------------------------------------------------------------ formatting

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + ' yrs';
    return Math.round(days) + ' days';
  }
  function fmtMult(n) { return n.toFixed(3) + 'x'; }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + (n % 1 === 0 ? String(n) : n.toFixed(2));
  }

  // The model, recomputed in the page from the row's own factors — the same multiplication
  // lib/model.ts runs, in the same order, so the detail page can check the board's figure.
  function impliedOf(row) {
    return Math.max(1, Math.round(row.tvl_usd * row.model.multiple * row.model.momentum_multiplier * row.model.maturity_multiplier));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ------------------------------------------------------------ masthead

  document.getElementById('stamp').textContent = 'Snapshot ' + DATA.as_of + ' · DefiLlama protocols · sealed input, no live feed';
  document.getElementById('model-line').innerHTML =
    '<strong>The model.</strong> A pre-token protocol is priced at the multiple of TVL the market already pays ' +
    'live protocols in its category (median market cap / TVL; the global median, <span class="fx">' + fmtMult(DATA.global_multiple) +
    '</span> across ' + DATA.global_peers + ' trading protocols, where a category has too few peers of its own), ' +
    'shaded by its 7-day TVL momentum and by how long it has run with no token. ' +
    '<span class="fx">implied = TVL x category multiple x momentum x maturity</span> — every factor is printed on each protocol\u2019s page.';
  var chips = document.getElementById('chips');
  [
    [DATA.protocols_size, 'protocols in the snapshot'],
    [DATA.watchlist_size, 'on the house watchlist — all ranked'],
    [DATA.board_size, 'rows on the board'],
    [DATA.early_size, 'early finds below the $50M floor'],
    [DATA.live_size, 'already trading, kept apart'],
    [DATA.excluded_size, 'screened out — every one listed with its reason'],
  ].forEach(function (pair) {
    var c = el('span', { 'class': 'chip' });
    var b = el('b', { text: String(pair[0]) });
    c.appendChild(b);
    c.appendChild(document.createTextNode(' ' + pair[1]));
    chips.appendChild(c);
  });

  // ------------------------------------------------------------ routing

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var q = {};
    var path = h;
    var at = h.indexOf('?');
    if (at >= 0) {
      path = h.slice(0, at);
      h.slice(at + 1).split('&').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv[0]) q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    }
    return { path: path, q: q };
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  var tabs = document.getElementById('tabs');
  tabs.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-view]');
    if (!btn) return;
    var view = btn.getAttribute('data-view');
    go(view === 'board' ? '#/' : '#/' + view);
  });
  function markTabs(view) {
    tabs.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-view') === view ? 'true' : 'false');
    });
  }

  // ------------------------------------------------------------ the board

  var SORTS = {
    rank: function (r) { return r.rank; },
    name: function (r) { return r.name.toLowerCase(); },
    tvl: function (r) { return r.tvl_usd; },
    change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
    age: function (r) { return r.age_days === null ? -1 : r.age_days; },
    implied: function (r) { return r.implied_value_usd; },
  };

  function boardView(q) {
    markTabs('board');
    var state = {
      q: q.q || '',
      cat: q.cat || 'all',
      chain: q.chain || 'all',
      watch: q.watch === '1',
      pinsOnly: q.pins === '1',
      pins: q.pin ? q.pin.split(',').filter(function (s) { return bySlug[s]; }) : [],
      cmp: q.cmp ? q.cmp.split(',').filter(function (s) { return bySlug[s]; }).slice(0, 3) : [],
      sort: SORTS[q.sort] ? q.sort : 'rank',
      dir: q.dir === '-1' ? -1 : 1,
    };
    if (!q.sort) { state.sort = 'rank'; state.dir = 1; }

    var cats = [];
    var chains = [];
    DATA.rows.forEach(function (r) {
      if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
      r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
    });
    cats.sort(); chains.sort();

    var search = el('input', { type: 'search', placeholder: 'Search name or slug', value: state.q, 'aria-label': 'Search protocols' });
    var catSel = el('select', { 'aria-label': 'Category' },
      el('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return el('option', { value: c, text: c, selected: c === state.cat ? 'selected' : null }); }));
    var chainSel = el('select', { 'aria-label': 'Chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    var watchBox = el('input', { type: 'checkbox', checked: state.watch ? 'checked' : null });
    var pinsBox = el('input', { type: 'checkbox', checked: state.pinsOnly ? 'checked' : null });
    var count = el('span', { 'class': 'count' });
    var controls = el('div', { 'class': 'controls' },
      el('label', null, search),
      el('label', null, 'Category', catSel),
      el('label', null, 'Chain', chainSel),
      el('label', null, watchBox, 'Watchlist only'),
      el('label', null, pinsBox, 'Pinned only'),
      count);
    var strip = el('div', { 'class': 'strip' },
      el('span', { 'class': 'strip-label', text: 'The multiples — median mcap / TVL of the snapshot\u2019s own trading peers, by category: ' }),
      DATA.categories.map(function (c) {
        return el('span', { 'class': 'strip-item', text: c.category + ' ' + fmtMult(c.multiple) + ' (' + c.peers + ' peers)' });
      }),
      el('span', { 'class': 'strip-item global', text: 'Global median ' + fmtMult(DATA.global_multiple) + ' (' + DATA.global_peers + ' peers)' }));
    var tray = el('div');
    var tableWrap = el('div');

    function apply(writeHash) {
      state.q = search.value;
      state.cat = catSel.value;
      state.chain = chainSel.value;
      state.watch = watchBox.checked;
      state.pinsOnly = pinsBox.checked;
      if (writeHash) {
        var params = [];
        if (state.q) params.push('q=' + encodeURIComponent(state.q));
        if (state.cat !== 'all') params.push('cat=' + encodeURIComponent(state.cat));
        if (state.chain !== 'all') params.push('chain=' + encodeURIComponent(state.chain));
        if (state.watch) params.push('watch=1');
        if (state.pinsOnly) params.push('pins=1');
        if (state.pins.length) params.push('pin=' + state.pins.join(','));
        if (state.cmp.length) params.push('cmp=' + state.cmp.join(','));
        if (state.sort !== 'rank') params.push('sort=' + state.sort);
        if (state.dir !== 1) params.push('dir=-1');
        history.replaceState(null, '', '#/board' + (params.length ? '?' + params.join('&') : ''));
      }
      renderTable();
    }
    function togglePin(slug) {
      var i = state.pins.indexOf(slug);
      if (i >= 0) state.pins.splice(i, 1); else state.pins.push(slug);
      apply(true);
    }
    function toggleCmp(slug) {
      var i = state.cmp.indexOf(slug);
      if (i >= 0) state.cmp.splice(i, 1);
      else { if (state.cmp.length >= 3) state.cmp.shift(); state.cmp.push(slug); }
      apply(true);
    }
    function renderTray() {
      clear(tray);
      if (state.cmp.length === 0) { tray.className = ''; return; }
      tray.className = 'tray';
      tray.appendChild(el('span', { 'class': 'tray-label', text: 'Compare tray — up to three, set side by side factor by factor: ' }));
      state.cmp.forEach(function (slug) {
        tray.appendChild(el('span', { 'class': 'tray-item', text: bySlug[slug].name }));
      });
      var goBtn = el('button', { type: 'button', 'class': 'mini on', text: 'Compare side by side' });
      goBtn.disabled = state.cmp.length < 2;
      goBtn.addEventListener('click', function () { go('#/compare?slugs=' + state.cmp.join(',')); });
      tray.appendChild(goBtn);
      var clr = el('button', { type: 'button', 'class': 'mini', text: 'Clear tray' });
      clr.addEventListener('click', function () { state.cmp = []; apply(true); });
      tray.appendChild(clr);
    }
    function renderTable() {
      renderTray();
      var rows = DATA.rows.filter(function (r) {
        if (state.watch && !r.watchlist) return false;
        if (state.pinsOnly && state.pins.indexOf(r.slug) < 0) return false;
        if (state.cat !== 'all' && r.category !== state.cat) return false;
        if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
        if (state.q) {
          var needle = state.q.toLowerCase();
          if (r.name.toLowerCase().indexOf(needle) < 0 && r.slug.indexOf(needle) < 0) return false;
        }
        return true;
      });
      var key = SORTS[state.sort];
      rows.sort(function (a, b) {
        var va = key(a), vb = key(b);
        var cmp = va < vb ? -1 : va > vb ? 1 : 0;
        if (cmp === 0) cmp = a.rank - b.rank;
        return cmp * state.dir;
      });
      count.textContent = rows.length + ' of ' + DATA.rows.length + ' protocols';
      clear(tableWrap);
      if (rows.length === 0) {
        tableWrap.appendChild(el('p', { 'class': 'empty', text: 'No protocol matches that filter. Loosen it — the radar is only as good as what it is allowed to see.' }));
        return;
      }
      var head = [['rank', '#', 'num'], ['name', 'Protocol', ''], ['tvl', 'TVL', 'num'], ['change', '7d', 'num'], ['age', 'Age', 'num hide-s'], ['implied', 'Implied value', 'num']];
      var thead = el('thead', null, el('tr', null, head.map(function (h) {
        var th = el('th', { 'class': 'sortable ' + h[2], text: h[1] });
        if (state.sort === h[0]) th.appendChild(el('span', { 'class': 'arrow', text: state.dir === 1 ? ' \u25B2' : ' \u25BC' }));
        th.addEventListener('click', function () {
          if (state.sort === h[0]) state.dir = -state.dir;
          else { state.sort = h[0]; state.dir = h[0] === 'name' ? 1 : -1; if (h[0] === 'rank') state.dir = 1; }
          apply(true);
        });
        return th;
      }), el('th', { text: 'Category', 'class': 'hide-s' }), el('th', { text: 'Chains', 'class': 'hide-s' }), el('th', { text: 'Keep' })));
      var tbody = el('tbody', null, rows.map(function (r) {
        var pinned = state.pins.indexOf(r.slug) >= 0;
        var inTray = state.cmp.indexOf(r.slug) >= 0;
        var tr = el('tr', { tabindex: '0', 'aria-label': r.name + ' detail', 'class': pinned ? 'pinned' : '' },
          el('td', { 'class': 'rank num', text: String(r.rank) }),
          el('td', null,
            el('span', { 'class': 'name', text: r.name }),
            r.watchlist ? el('span', { 'class': 'badge', text: 'WATCHLIST' }) : el('span', { 'class': 'badge early', text: 'EARLY' }),
            pinned ? el('span', { 'class': 'badge pin', text: 'PINNED' }) : null,
            el('span', { 'class': 'sub', text: r.slug })),
          el('td', { 'class': 'num', text: fmtUsd(r.tvl_usd) }),
          el('td', { 'class': 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
          el('td', { 'class': 'num hide-s', text: fmtAge(r.age_days) }),
          el('td', { 'class': 'num', text: fmtUsd(r.implied_value_usd) }),
          el('td', { 'class': 'hide-s', text: r.category || 'Uncategorised' }),
          el('td', { 'class': 'hide-s', text: r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') }),
          el('td', { 'class': 'actions' },
            el('button', { type: 'button', 'class': 'mini' + (pinned ? ' on' : ''), text: pinned ? 'Pinned' : 'Pin', onclick: function (ev) { ev.stopPropagation(); togglePin(r.slug); } }),
            el('button', { type: 'button', 'class': 'mini' + (inTray ? ' on' : ''), text: inTray ? 'In tray' : 'Compare', onclick: function (ev) { ev.stopPropagation(); toggleCmp(r.slug); } })));
        function open() { go('#/p/' + r.slug); }
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') open(); });
        return tr;
      }));
      tableWrap.appendChild(el('table', null, thead, tbody));
    }
    search.addEventListener('input', function () { apply(true); });
    catSel.addEventListener('change', function () { apply(true); });
    chainSel.addEventListener('change', function () { apply(true); });
    watchBox.addEventListener('change', function () { apply(true); });
    pinsBox.addEventListener('change', function () { apply(true); });
    clear(app);
    app.appendChild(controls);
    app.appendChild(strip);
    app.appendChild(tray);
    app.appendChild(tableWrap);
    renderTable();
  }

  // ------------------------------------------------------------ detail

  function kv(k, v) { return el('div', { 'class': 'kv' }, el('span', { 'class': 'k', text: k }), el('span', { 'class': 'v', text: v })); }

  function detailView(slug) {
    var r = bySlug[slug];
    if (!r) { boardView({}); return; }
    markTabs('board');
    var check = impliedOf(r);
    var head = el('div', null,
      el('a', { 'class': 'back', href: '#/', text: '\u2190 Back to the board' }),
      el('div', { 'class': 'detail-head' },
        el('h2', { text: r.name }),
        r.watchlist ? el('span', { 'class': 'badge', text: 'ON THE HOUSE WATCHLIST' }) : el('span', { 'class': 'badge early', text: 'EARLY FIND — BELOW THE FLOOR' })),
      el('p', { 'class': 'implied-big', text: fmtUsd(r.implied_value_usd) }),
      el('p', { 'class': 'implied-cap', text: 'implied value if ' + r.name + ' issued a token at today\u2019s record — rank #' + r.rank + ' of ' + DATA.rows.length + ' pre-token protocols' }));

    var calc = el('div', { 'class': 'calc' },
      el('div', null, 'TVL ', el('span', { 'class': 'op', text: ' ' }), fmtUsd(r.tvl_usd)),
      el('div', null, el('span', { 'class': 'op', text: '\u00D7 ' }), 'category multiple ', fmtMult(r.model.multiple),
        ' (', r.model.multiple_source === 'category' ? 'median of ' + r.model.category_peers + ' trading ' + (r.category || '') + ' protocols' : 'global median — too few trading peers in its category', ')'),
      el('div', null, el('span', { 'class': 'op', text: '\u00D7 ' }), 'momentum ', r.model.momentum_multiplier.toFixed(3), ' (7d TVL ', fmtPct(r.change_7d), ', clamped)'),
      el('div', null, el('span', { 'class': 'op', text: '\u00D7 ' }), 'maturity ', r.model.maturity_multiplier.toFixed(3), ' (', fmtAge(r.model.age_days_used), ' with no token', r.model.age_imputed ? ', age imputed from the snapshot median' : '', ')'),
      el('div', null, el('span', { 'class': 'op', text: '= ' }), el('span', { 'class': 'res', text: fmtUsd(r.implied_value_usd) })),
      el('p', { 'class': 'agree', text: check === r.implied_value_usd ? '\u2713 this page recomputes the same figure from the factors above' : 'page recompute: ' + fmtUsd(check) }));

    var facts = el('div', null,
      kv('Category', r.category || 'Uncategorised'),
      kv('Chains', r.chains.join(', ') || 'none recorded'),
      kv('TVL', fmtUsd(r.tvl_usd)),
      kv('TVL change, 7d', fmtPct(r.change_7d)),
      kv('First tracked', r.listed_at || 'not recorded'),
      kv('Age with no token', fmtAge(r.age_days)),
      kv('Token', 'none recorded in the snapshot'),
      kv('DefiLlama slug', r.slug));

    var farm = el('ol', { 'class': 'farm' }, r.farm_steps.map(function (s) { return el('li', { text: s }); }));
    var totals = DATA.plan_totals ? DATA.plan_totals[r.slug] : null;
    var totalsEl = totals ? el('p', { 'class': 'plan-totals', text: 'Plan totals: about ' + fmtMoney(totals.gas_low_usd) + '\u2013' + fmtMoney(totals.gas_high_usd) + ' of gas and fees across ' + (totals.weeks + 3) + ' paid actions over ' + totals.weeks + ' weeks, plus ' + fmtUsd(totals.capital_usd) + ' of farm capital held in the position — the capital is held, not spent.' }) : null;

    clear(app);
    app.appendChild(head);
    var grid = el('div', { 'class': 'grid' },
      el('section', { 'class': 'card' }, el('h3', { text: 'How the value is derived' }), calc),
      el('section', { 'class': 'card' }, el('h3', { text: 'The record' }), facts),
      el('section', { 'class': 'card' }, el('h3', { text: 'Farm plan — before any token exists' }), farm, totalsEl));
    app.appendChild(grid);
    app.appendChild(el('p', { 'class': 'note', text: 'Farming a protocol that may never issue a token is a cost, not an investment: the plan above is sized so the whole position can be written off. The implied value is a pricing exercise on today\u2019s figures, not a forecast.' }));
  }

  // ------------------------------------------------------------ compare

  function compareView(q) {
    markTabs('board');
    var slugs = q.slugs ? q.slugs.split(',') : [];
    var rows = slugs.map(function (s) { return bySlug[s]; }).filter(function (r) { return r; }).slice(0, 3);
    clear(app);
    app.appendChild(el('a', { 'class': 'back', href: '#/', text: '\u2190 Back to the board' }));
    if (rows.length < 2) {
      app.appendChild(el('p', { 'class': 'empty', text: 'Pick at least two protocols on the board — the Compare button on each row adds it to the tray — and this page sets them side by side.' }));
      return;
    }
    app.appendChild(el('h2', { 'class': 'cmp-title', text: 'Side by side' }));
    app.appendChild(el('p', { 'class': 'note', text: 'Every figure is the row\u2019s own record and the model\u2019s factors, as recomputed on each protocol\u2019s page: implied = TVL \u00D7 multiple \u00D7 momentum \u00D7 maturity. The multiples are the medians of the snapshot\u2019s own trading peers.' }));
    function factor(label, fn) {
      return el('tr', { 'class': 'static' },
        el('td', { 'class': 'factor', text: label }),
        rows.map(function (r) { return el('td', { 'class': 'num', text: fn(r) }); }));
    }
    var thead = el('thead', null, el('tr', null, el('th', { text: 'Factor' }), rows.map(function (r) {
      var th = el('th', { 'class': 'num' });
      th.appendChild(el('a', { href: '#/p/' + r.slug, text: r.name }));
      return th;
    })));
    var tbody = el('tbody', null, [
      factor('Rank', function (r) { return '#' + r.rank + ' of ' + DATA.rows.length; }),
      factor('Implied value', function (r) { return fmtUsd(r.implied_value_usd); }),
      factor('TVL', function (r) { return fmtUsd(r.tvl_usd); }),
      factor('TVL change, 7d', function (r) { return fmtPct(r.change_7d); }),
      factor('Age with no token', function (r) { return fmtAge(r.age_days); }),
      factor('Category', function (r) { return r.category || 'Uncategorised'; }),
      factor('Chains', function (r) { return r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) + ' more' : ''); }),
      factor('Multiple', function (r) { return fmtMult(r.model.multiple) + (r.model.multiple_source === 'category' ? ' (category median, ' + r.model.category_peers + ' peers)' : ' (global median)'); }),
      factor('Momentum', function (r) { return r.model.momentum_multiplier.toFixed(3); }),
      factor('Maturity', function (r) { return r.model.maturity_multiplier.toFixed(3); }),
      factor('On the house watchlist', function (r) { return r.watchlist ? 'yes' : 'no — early find'; }),
      factor('Farm plan', function (r) { var t = DATA.plan_totals ? DATA.plan_totals[r.slug] : null; return t ? t.weeks + ' weeks; ' + fmtMoney(t.gas_low_usd) + '\u2013' + fmtMoney(t.gas_high_usd) + ' of gas and fees' : 'see its page'; }),
    ]);
    app.appendChild(el('table', { 'class': 'cmp' }, thead, tbody));
  }

  // ------------------------------------------------------------ the side views

  function liveView() {
    markTabs('live');
    clear(app);
    app.appendChild(el('p', { 'class': 'note', text: 'These protocols already have a token: the market prices them, so the radar does not rank them. They are the comparison set — the category multiples on the board are the medians of this group\u2019s market cap over TVL.' }));
    var thead = el('thead', null, el('tr', null,
      el('th', { text: 'Protocol' }), el('th', { text: 'Market cap', 'class': 'num' }),
      el('th', { text: 'TVL', 'class': 'num' }), el('th', { text: 'Mcap / TVL', 'class': 'num' }),
      el('th', { text: '7d', 'class': 'num' }), el('th', { text: 'Category', 'class': 'hide-s' })));
    var tbody = el('tbody', null, DATA.live.map(function (r) {
      return el('tr', { 'class': 'static' },
        el('td', null, el('span', { 'class': 'name', text: r.name }), el('span', { 'class': 'sub', text: r.slug })),
        el('td', { 'class': 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { 'class': 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { 'class': 'num', text: r.multiple === null ? 'n/a' : fmtMult(r.multiple) }),
        el('td', { 'class': 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { 'class': 'hide-s', text: r.category || 'Uncategorised' }));
    }));
    app.appendChild(el('table', null, thead, tbody));
  }

  function offView() {
    markTabs('off');
    clear(app);
    app.appendChild(el('p', { 'class': 'note', text: 'The complete register: every pre-token protocol that is not on the board, with the rule that kept it off. The snapshot records ' + DATA.pretoken_size + ' pre-token protocols — ' + DATA.board_size + ' are ranked on the board and all ' + DATA.excluded_size + ' of the rest are listed here, biggest first — so the whole pre-token universe is accounted for. Most are a product of an asset or a venue that already exists; the rest sit at or above the floor without a watchlist place.' }));
    var thead = el('thead', null, el('tr', null,
      el('th', { text: 'Protocol' }), el('th', { text: 'TVL', 'class': 'num' }), el('th', { text: 'Why it is not ranked' })));
    var tbody = el('tbody', null, DATA.excluded.map(function (r) {
      return el('tr', { 'class': 'static' },
        el('td', null, el('span', { 'class': 'name', text: r.name }), el('span', { 'class': 'sub', text: r.slug })),
        el('td', { 'class': 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { 'class': 'reason', text: r.reason }));
    }));
    app.appendChild(el('table', null, thead, tbody));
  }

  // ------------------------------------------------------------ render

  function render() {
    var route = parseHash();
    if (route.path === 'live') liveView();
    else if (route.path === 'off') offView();
    else if (route.path === 'compare') compareView(route.q);
    else if (route.path.indexOf('p/') === 0) detailView(route.path.slice(2));
    else boardView(route.q);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', render);
  render();
})();
