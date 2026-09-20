/* Reels, Riffs & Ridgelines — shared front-end for the digest pages.
 *
 * Each page sets window.DIGEST_CONFIG = { dataUrl } before loading this file.
 * Everything else (which filters exist, category labels, footnotes) is driven
 * by the "meta" block inside the data file, so one script serves both pages.
 *
 * Dates are treated as venue-local wall clock: we read the literal Y-M-D / H:M
 * out of the ISO string rather than constructing a Date, so a Seattle 8pm show
 * still reads as 8pm on the right day when viewed from Vermont.
 */
(function () {
  "use strict";

  var cfg = window.DIGEST_CONFIG || {};
  var DATA = { meta: {}, events: [] };
  var state = {
    view: "list",
    facets: {},       // facet key -> Set of selected values, built from meta.facets
    dows: new Set(),
    times: new Set(),
    range: "upcoming",
    star: false,
    free: false,
    reachable: false, // "only dates in town" — turned on by default when the data has legs
    maxDrive: null,
    q: "",
    month: null,      // "YYYY-MM"
    selectedDay: null // "YYYY-MM-DD"
  };

  function facetSet(key) {
    if (!state.facets[key]) state.facets[key] = new Set();
    return state.facets[key];
  }

  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["January","February","March","April","May","June","July",
                "August","September","October","November","December"];

  /* ── tiny DOM helper ─────────────────────────────────── */
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  function $(sel) { return document.querySelector(sel); }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }

  /* ── date helpers (string-based, venue-local) ────────── */
  function parts(iso) {
    if (!iso) return null;
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return null;
    return {
      date: m[1] + "-" + m[2] + "-" + m[3],
      y: +m[1], mo: +m[2], d: +m[3],
      hh: m[4] === undefined ? null : +m[4],
      mm: m[5] === undefined ? null : +m[5]
    };
  }
  function dowOf(dateStr) {
    var p = dateStr.split("-");
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function addDays(dateStr, n) {
    var p = dateStr.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }
  function fmtDay(dateStr) {
    var p = dateStr.split("-");
    return DOW[dowOf(dateStr)] + ", " + MONTHS[+p[1] - 1] + " " + (+p[2]);
  }
  function fmtTime(hh, mm) {
    if (hh === null || hh === undefined) return "";
    var ap = hh >= 12 ? "PM" : "AM", h = hh % 12; if (h === 0) h = 12;
    return h + (mm ? ":" + pad(mm) : "") + " " + ap;
  }
  function relative(dateStr) {
    var t = todayStr();
    if (dateStr === t) return "";
    if (dateStr === addDays(t, 1)) return "tomorrow";
    var diff = Math.round((Date.parse(dateStr + "T00:00:00Z") - Date.parse(t + "T00:00:00Z")) / 86400000);
    if (diff < 0) return Math.abs(diff) + " days ago";
    if (diff < 7) return "in " + diff + " days";
    if (diff < 14) return "next week";
    return "";
  }

  /* ── derived per-event fields ────────────────────────── */
  function prep(ev) {
    var s = parts(ev.start), e = parts(ev.end);
    ev._p = s;
    ev._date = s ? s.date : null;
    // An all-day run keeps its closing *time* in `end` and its real last day in
    // `endDate`, so the span is whichever of those reaches furthest.
    var ends = [e && e.date, ev.endDate && parts(ev.endDate).date, ev.spanEnd, ev._date].filter(Boolean);
    ev._endDate = ends.sort()[ends.length - 1] || ev._date;
    ev._dow = ev._date ? dowOf(ev._date) : null;
    ev._hh = s ? s.hh : null;
    ev._timeBucket = ev._hh === null ? null : (ev._hh < 12 ? "morning" : ev._hh < 17 ? "afternoon" : "evening");
    ev._free = /free|no cover/i.test(ev.price || "");
    // A trail that's walkable for a month isn't a calendar entry, it's an option.
    ev._spanDays = (ev._date && ev._endDate)
      ? Math.round((Date.parse(ev._endDate + "T00:00:00Z") - Date.parse(ev._date + "T00:00:00Z")) / 86400000)
      : 0;
    ev._anytime = !ev._date || ev._spanDays >= 8;
    ev._hay = [ev.title, ev.venue, ev.city, ev.genre, ev.notes, ev.address, ev.source]
      .filter(Boolean).join(" ").toLowerCase();
    return ev;
  }

  /* ── filtering ───────────────────────────────────────── */
  function rangeBounds() {
    var t = todayStr(), hw = DATA.meta.highlightWindow;
    switch (state.range) {
      case "all":      return [null, null];
      case "7":        return [t, addDays(t, 7)];
      case "weekend":  {
        var d = dowOf(t), toSat = (6 - d + 7) % 7;
        if (d === 0) return [t, t];                       // today is Sunday
        return [addDays(t, toSat), addDays(t, toSat + 1)];
      }
      case "window":   return hw ? [hw.start, hw.end] : [t, null];
      default:         return [t, null];                  // upcoming
    }
  }

  function passes(ev) {
    var b = rangeBounds();
    if (ev._date) {
      // a multi-day item counts as in-range if any of its span overlaps
      if (b[0] && (ev._endDate || ev._date) < b[0]) return false;
      if (b[1] && ev._date > b[1]) return false;
    }
    // undated items are ongoing by definition, so they clear any date range —
    // but a day-of-week or time-of-day filter is asking a question they can't answer
    if ((!ev._date || ev._anytime) && (state.dows.size || state.times.size)) return false;
    if (state.reachable && ev.reachable === false) return false;

    var ok = true;
    Object.keys(state.facets).forEach(function (key) {
      var set = state.facets[key];
      if (!set.size || !ok) return;
      var v = ev[key];
      if (Array.isArray(v)) {                                   // e.g. legs
        ok = v.some(function (x) { return set.has(x); });
      } else if (key === "city") {                              // a venue between two hubs counts for both
        ok = set.has(v) || (ev.alsoNear || []).some(function (c) { return set.has(c); });
      } else {
        ok = set.has(v);
      }
    });
    if (!ok) return false;
    if (state.dows.size && (ev._dow === null || !state.dows.has(String(ev._dow)))) return false;
    if (state.times.size && (!ev._timeBucket || !state.times.has(ev._timeBucket))) return false;
    if (state.star && !ev.star) return false;
    if (state.free && !ev._free) return false;
    if (state.maxDrive !== null && ev.driveMin !== null && ev.driveMin !== undefined
        && ev.driveMin > state.maxDrive) return false;
    if (state.q && ev._hay.indexOf(state.q) === -1) return false;
    return true;
  }

  function visible() {
    var lo = rangeBounds()[0];
    return DATA.events.filter(passes).map(function (ev) {
      // A multi-day run that started before the window still matters today, but
      // filing it under its original start date buries it under a stale header.
      var d = (lo && ev._date < lo && (ev._endDate || ev._date) >= lo) ? lo : ev._date;
      // Likewise, a four-night run that opens before the stop begins should file
      // under the first night inside the stop's dates, not opening night.
      var legStart = firstDayShesThere(ev);
      if (legStart && legStart > d) d = legStart;
      ev._listDate = d;
      return ev;
    });
  }

  function firstDayShesThere(ev) {
    if (!ev._date || !(ev.legs || []).length) return null;
    var starts = (DATA.meta.legs || [])
      .filter(function (L) { return ev.legs.indexOf(L.id) !== -1; })
      .map(function (L) { return L.start; })
      .filter(function (s) { return s <= (ev._endDate || ev._date); })
      .sort();
    return starts.length ? starts[0] : null;
  }

  function spanLabel(ev) {
    if (!ev._endDate || ev._endDate === ev._date) return null;
    var a = ev._date.split("-"), b = ev._endDate.split("-");
    return "runs " + MONTHS[+a[1] - 1].slice(0, 3) + " " + (+a[2]) +
           " – " + MONTHS[+b[1] - 1].slice(0, 3) + " " + (+b[2]);
  }

  /* ── filter UI ───────────────────────────────────────── */
  function chip(label, pressed, onToggle, extra) {
    var props = { class: "chip" + (extra && extra.cls ? " " + extra.cls : ""),
                  type: "button", "aria-pressed": pressed ? "true" : "false", text: label,
                  onclick: onToggle };
    if (extra && extra.cat) props["data-cat"] = extra.cat;
    return el("button", props);
  }

  function toggleIn(set, val) {
    if (set.has(val)) set.delete(val); else set.add(val);
    render();
  }

  function buildFilters() {
    var host = clear($("#filters"));
    var facets = DATA.meta.facets || [];

    if (DATA.meta.reachableFilter) {
      var rf = DATA.meta.reachableFilter;
      var n = DATA.events.filter(function (e) { return e.reachable; }).length;
      var line0 = el("div", { class: "filterline" }, [el("span", { class: "label", text: "Reach" })]);
      line0.appendChild(chip(rf.label + " (" + n + ")", state.reachable, function () {
        state.reachable = !state.reachable; render();
      }));
      if (!state.reachable) {
        line0.appendChild(el("span", { class: "resultcount",
          text: "showing everything found in all five towns, including dates outside each stop" }));
      }
      host.appendChild(line0);
    }

    facets.forEach(function (f) {
      var vals = f.values && f.values.length ? f.values
        : uniq(DATA.events.map(function (e) { return e[f.key]; })).filter(Boolean)
            .sort().map(function (v) { return { value: v, label: v }; });
      if (vals.length < 2) return;
      var set = facetSet(f.key);
      var line = el("div", { class: "filterline" }, [el("span", { class: "label", text: f.label })]);
      vals.forEach(function (v) {
        line.appendChild(chip(v.label, set.has(v.value), function () { toggleIn(set, v.value); },
          { cls: f.key === "category" ? "cat" : "", cat: f.key === "category" ? v.value : null }));
      });
      host.appendChild(line);
    });

    // day of week — explicitly asked for
    var dayLine = el("div", { class: "filterline" }, [el("span", { class: "label", text: "Day" })]);
    [1, 2, 3, 4, 5, 6, 0].forEach(function (d) {
      dayLine.appendChild(chip(DOW[d], state.dows.has(String(d)), function () { toggleIn(state.dows, String(d)); }));
    });
    host.appendChild(dayLine);

    // secondary filters, tucked away
    var more = el("details", { class: "morefilters" }, [el("summary", { text: "More filters" })]);
    var timeLine = el("div", { class: "filterline" }, [el("span", { class: "label", text: "Time" })]);
    [["morning", "Morning"], ["afternoon", "Afternoon"], ["evening", "Evening"]].forEach(function (t) {
      timeLine.appendChild(chip(t[1], state.times.has(t[0]), function () { toggleIn(state.times, t[0]); }));
    });
    more.appendChild(timeLine);

    var whenLine = el("div", { class: "filterline" }, [el("span", { class: "label", text: "When" })]);
    var presets = [["upcoming", "Upcoming"], ["7", "Next 7 days"], ["weekend", "This weekend"]];
    if (DATA.meta.highlightWindow) presets.push(["window", DATA.meta.highlightWindow.label || "Date window"]);
    presets.push(["all", "Everything"]);
    presets.forEach(function (p) {
      whenLine.appendChild(chip(p[1], state.range === p[0], function () {
        state.range = state.range === p[0] ? "upcoming" : p[0]; render();
      }));
    });
    more.appendChild(whenLine);

    var flagLine = el("div", { class: "filterline" }, [el("span", { class: "label", text: "Only" })]);
    flagLine.appendChild(chip("★ Top picks", state.star, function () { state.star = !state.star; render(); }));
    flagLine.appendChild(chip("Free", state.free, function () { state.free = !state.free; render(); }));
    if (DATA.meta.showDriveTime) {
      [30, 45, 60, 90].forEach(function (mins) {
        flagLine.appendChild(chip("≤ " + mins + " min", state.maxDrive === mins, function () {
          state.maxDrive = state.maxDrive === mins ? null : mins; render();
        }));
      });
    }
    more.appendChild(flagLine);
    host.appendChild(more);
  }

  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  function activeFilterCount() {
    var n = state.dows.size + state.times.size +
      (state.star ? 1 : 0) + (state.free ? 1 : 0) + (state.maxDrive !== null ? 1 : 0) +
      (state.q ? 1 : 0) + (state.range !== "upcoming" ? 1 : 0);
    Object.keys(state.facets).forEach(function (k) { n += state.facets[k].size; });
    // the reachable filter counts as "active" only when flipped off its default
    var def = !!(DATA.meta.reachableFilter && DATA.meta.reachableFilter.defaultOn);
    if (state.reachable !== def) n += 1;
    return n;
  }

  function resetFilters() {
    Object.keys(state.facets).forEach(function (k) { state.facets[k].clear(); });
    state.dows.clear(); state.times.clear();
    state.star = false; state.free = false; state.maxDrive = null; state.q = "";
    state.range = "upcoming"; state.selectedDay = null;
    state.reachable = !!(DATA.meta.reachableFilter && DATA.meta.reachableFilter.defaultOn);
    var s = $("#search"); if (s) s.value = "";
    render();
  }

  /* ── cards ───────────────────────────────────────────── */
  function catLabel(key) {
    var f = (DATA.meta.facets || []).filter(function (x) { return x.key === "category"; })[0];
    var hit = f && (f.values || []).filter(function (v) { return v.value === key; })[0];
    return hit ? hit.label : key;
  }

  function card(ev) {
    var timeTxt = ev.allDay || ev._hh === null ? "all day" : fmtTime(ev._hh, ev._p.mm);
    var endP = parts(ev.end);
    if (endP && endP.hh !== null && !ev.allDay && endP.date === ev._date) {
      timeTxt += "–" + fmtTime(endP.hh, endP.mm);
    }
    var timeCell = el("div", { class: "time" }, [
      el("span", { text: timeTxt }),
      !ev.timeConfirmed && !ev.allDay ? el("span", { class: "unconf", text: "not confirmed" }) : null
    ]);

    // don't say "Smugglers' Notch Resort, Jeffersonville · Jeffersonville"
    var showCity = ev.city && ev.venue &&
      ev.venue.toLowerCase().indexOf(ev.city.split(",")[0].toLowerCase()) === -1;
    var where = [ev.venue, showCity ? ev.city : null].filter(Boolean).join(" · ");
    var span = spanLabel(ev);
    var legTags = (ev.legs || []).map(function (id) {
      var L = (DATA.meta.legs || []).filter(function (x) { return x.id === id; })[0];
      return el("span", { class: "tag leg", text: "in " + (L ? L.short || L.label : id) });
    });
    if (DATA.meta.legs && ev.reachable === false) {
      legTags.push(el("span", { class: "tag away", text: "outside stop dates" }));
    }

    var meta = el("div", { class: "meta" }, [
      el("span", { class: "tag cat", "data-cat": ev.category, text: catLabel(ev.category) }),
      span ? el("span", { class: "tag", text: span }) : null,
      ev.genre ? el("span", { class: "tag", text: ev.genre }) : null,
      ev.price ? el("span", { class: "tag" + (ev._free ? " free" : ""), text: ev.price }) : null,
      (ev.driveMin !== null && ev.driveMin !== undefined)
        ? el("span", { class: "tag", text: "~" + ev.driveMin + " min" }) : null,
      (ev.alsoNear || []).length ? el("span", { class: "tag", text: "also near " + ev.alsoNear.join(", ") }) : null,
      ev.url ? el("a", { class: "ticket", href: ev.url, target: "_blank", rel: "noopener",
                         text: "details ↗" }) : null
    ].concat(legTags));

    return el("article", { class: "card", "data-cat": ev.category }, [
      timeCell,
      el("div", {}, [
        el("h3", {}, [ev.star ? el("span", { class: "star", text: "★" }) : null, ev.title]),
        where ? el("div", { class: "where", text: where }) : null,
        meta,
        ev.notes ? el("div", { class: "note", text: ev.notes }) : null
      ])
    ]);
  }

  /* ── list view ───────────────────────────────────────── */
  function renderList(all) {
    var host = clear($("#view"));
    var evs = all.filter(function (e) { return !e._anytime; });
    var anytime = all.filter(function (e) { return e._anytime; });
    if (!evs.length && !anytime.length) {
      host.appendChild(el("div", { class: "empty" }, [
        el("strong", { text: "Nothing matches those filters." }),
        el("span", { text: "Try clearing a filter, or switch “When” to Everything to include past dates." })
      ]));
      return;
    }
    var byDay = {};
    evs.forEach(function (e) { var k = e._listDate || e._date; (byDay[k] = byDay[k] || []).push(e); });

    Object.keys(byDay).sort().forEach(function (day) {
      var items = byDay[day].sort(function (a, b) {
        return (a._hh === null) - (b._hh === null) || (a._hh - b._hh) || a.title.localeCompare(b.title);
      });
      var stars = items.filter(function (i) { return i.star; }).length;
      var head = el("div", { class: "dayhead" }, [
        el("h2", { text: fmtDay(day) }),
        day === todayStr() ? el("span", { class: "today-pill", text: "today" }) : null,
        el("span", { class: "rel", text: relative(day) }),
        stars > 1 ? el("span", { class: "rel", text: "· " + stars + " top picks same day" }) : null
      ]);
      var group = el("section", { class: "daygroup" }, [head]);
      items.forEach(function (e) { group.appendChild(card(e)); });
      host.appendChild(group);
    });

    if (anytime.length) {
      var sec = el("section", { class: "ongoing" }, [
        el("h2", { text: "Anytime — ongoing, or no fixed date (" + anytime.length + ")" })
      ]);
      anytime.sort(function (a, b) { return (a._date || "").localeCompare(b._date || ""); })
             .forEach(function (e) { sec.appendChild(card(e)); });
      host.appendChild(sec);
    }
  }

  /* ── calendar view ───────────────────────────────────── */
  function monthsWithData() {
    return uniq(DATA.events.filter(function (e) { return e._date; })
      .map(function (e) { return e._date.slice(0, 7); })).sort();
  }

  function renderCalendar(all) {
    var host = clear($("#view"));
    var evs = all.filter(function (e) { return !e._anytime; });
    var anytime = all.filter(function (e) { return e._anytime; });
    var months = monthsWithData();
    if (!months.length) { host.appendChild(el("div", { class: "empty" }, [el("strong", { text: "No dated events." })])); return; }
    if (!state.month || months.indexOf(state.month) === -1) {
      var cur = todayStr().slice(0, 7);
      state.month = months.indexOf(cur) !== -1 ? cur : months[0];
    }

    var idx = months.indexOf(state.month);
    var y = +state.month.slice(0, 4), mo = +state.month.slice(5, 7);

    var nav = el("div", { class: "calnav" }, [
      el("button", { class: "iconbtn", type: "button", "aria-label": "Previous month",
        disabled: idx <= 0, text: "‹", onclick: function () { state.month = months[idx - 1]; state.selectedDay = null; render(); } }),
      el("h2", { text: MONTHS[mo - 1] + " " + y }),
      el("button", { class: "iconbtn", type: "button", "aria-label": "Next month",
        disabled: idx >= months.length - 1, text: "›", onclick: function () { state.month = months[idx + 1]; state.selectedDay = null; render(); } }),
      el("span", { class: "spacer" }),
      el("button", { class: "linkbtn", type: "button", text: "Jump to today",
        onclick: function () { var c = todayStr().slice(0, 7); if (months.indexOf(c) !== -1) { state.month = c; state.selectedDay = todayStr(); render(); } } })
    ]);
    host.appendChild(nav);

    if (anytime.length) {
      var strip = el("div", { class: "anytime" }, [
        el("h3", { text: "Anytime this month — " + anytime.length + " ongoing options" })
      ]);
      var row = el("div", { class: "row" });
      anytime.forEach(function (e) {
        row.appendChild(el("span", { class: "pill", "data-cat": e.category,
          title: [e.venue, e.city].filter(Boolean).join(" · ") },
          [(e.star ? "★ " : "") + e.title]));
      });
      strip.appendChild(row);
      host.appendChild(strip);
    }

    var byDay = {};
    evs.forEach(function (e) {
      var d = e._date, guard = 0;
      while (d && d <= (e._endDate || e._date) && guard++ < 60) {   // spread multi-day items
        if (d.slice(0, 7) === state.month) (byDay[d] = byDay[d] || []).push(e);
        d = addDays(d, 1);
      }
    });

    var grid = el("div", { class: "calgrid", role: "grid" });
    DOW.forEach(function (d) { grid.appendChild(el("div", { class: "dow", text: d })); });

    var first = y + "-" + pad(mo) + "-01";
    var lead = dowOf(first);
    var daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    for (var i = 0; i < lead; i++) grid.appendChild(el("div", { class: "daycell pad" }));

    var hw = DATA.meta.highlightWindow;
    for (var dd = 1; dd <= daysIn; dd++) {
      (function (dayStr) {
        var items = (byDay[dayStr] || []).sort(function (a, b) { return (a._hh === null) - (b._hh === null) || a._hh - b._hh; });
        var cls = "daycell";
        if (dayStr === todayStr()) cls += " today";
        if (hw && dayStr >= hw.start && dayStr <= hw.end) cls += " inwindow";
        if (state.selectedDay === dayStr) cls += " selected";
        var cell = el("button", { class: cls, type: "button",
          "aria-label": fmtDay(dayStr) + ", " + items.length + " events",
          onclick: function () { state.selectedDay = state.selectedDay === dayStr ? null : dayStr; render(); } },
          [el("span", { class: "dnum", text: String(dd) })]);

        items.slice(0, 3).forEach(function (e) {
          cell.appendChild(el("span", { class: "pill", "data-cat": e.category, title: e.title + " — " + (e.venue || "") }, [
            e._hh !== null && !e.allDay ? el("span", { class: "t", text: fmtTime(e._hh, null) + " " }) : null,
            (e.star ? "★ " : "") + e.title
          ]));
        });
        if (items.length > 3) cell.appendChild(el("span", { class: "more", text: "+" + (items.length - 3) + " more" }));

        var dots = el("span", { class: "dots" });
        uniq(items.map(function (e) { return e.category; })).forEach(function (c) {
          dots.appendChild(el("span", { class: "dot", "data-cat": c }));
        });
        if (items.length) cell.appendChild(dots);
        grid.appendChild(cell);
      })(y + "-" + pad(mo) + "-" + pad(dd));
    }
    host.appendChild(grid);

    if (state.selectedDay) {
      var sel = (byDay[state.selectedDay] || []).sort(function (a, b) { return (a._hh === null) - (b._hh === null) || a._hh - b._hh; });
      var panel = el("div", { class: "daypanel" }, [
        el("h3", { text: fmtDay(state.selectedDay) + " — " + sel.length + (sel.length === 1 ? " event" : " events") })
      ]);
      if (!sel.length) panel.appendChild(el("div", { class: "empty" }, [el("strong", { text: "Nothing on this day." })]));
      sel.forEach(function (e) { panel.appendChild(card(e)); });
      host.appendChild(panel);
    }
  }

  /* ── chrome ──────────────────────────────────────────── */
  function renderHeader() {
    var m = DATA.meta;
    if (m.title) { $("#title").textContent = m.title; document.title = m.title; }
    if (m.subtitle) $("#subtitle").textContent = m.subtitle;
    var stamp = $("#stamp");
    if (stamp && m.generated) {
      var d = new Date(m.generated);
      clear(stamp).appendChild(el("span", {}, [
        "Updated ", el("strong", { text: d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) }),
        " · " + DATA.events.length + " listings"
      ]));
    }
    if ((m.highlightWindow || m.legs) && $("#banner")) {
      var b = clear($("#banner"));
      if (m.highlightWindow) {
        var hw = m.highlightWindow;
        b.appendChild(el("div", {}, [
          el("strong", { text: hw.label || "Window" }),
          " · " + fmtDay(hw.start) + " – " + fmtDay(hw.end)
        ]));
      }
      if (m.legs) {
        var tl = el("div", { class: "legtimeline" });
        m.legs.forEach(function (L) {
          tl.appendChild(el("button", { class: "legstep", type: "button",
            "aria-pressed": facetSet("legs").has(L.id) ? "true" : "false",
            onclick: function () { toggleIn(facetSet("legs"), L.id); } }, [
            el("span", { class: "legname", text: L.label }),
            el("span", { class: "legdates",
              text: fmtDay(L.start).replace(/^\w+, /, "") + " – " + fmtDay(L.end).replace(/^\w+, /, "") })
          ]));
        });
        b.appendChild(tl);
      }
      $("#banner").hidden = false;
    }
    var notes = $("#notes-list");
    if (notes && m.notes) {
      clear(notes);
      m.notes.forEach(function (n) { notes.appendChild(el("li", { text: n })); });
    }
    var legend = $("#legend");
    if (legend) {
      clear(legend);
      ((m.facets || []).filter(function (f) { return f.key === "category"; })[0] || { values: [] })
        .values.forEach(function (v) {
          legend.appendChild(el("span", {}, [el("span", { class: "dot", "data-cat": v.value }), v.label]));
        });
    }
  }

  function render() {
    var evs = visible();
    buildFilters();
    var rc = $("#resultcount");
    if (rc) rc.textContent = evs.length + (evs.length === 1 ? " listing" : " listings") +
      (activeFilterCount() ? " · filtered" : "");
    $("#clearbtn").hidden = activeFilterCount() === 0;
    document.querySelectorAll(".viewtoggle button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.view === state.view ? "true" : "false");
    });
    if (state.view === "calendar") renderCalendar(evs); else renderList(evs);
    writeHash();
  }

  /* ── shareable state in the URL ──────────────────────── */
  function writeHash() {
    var p = [];
    if (state.view !== "list") p.push("view=" + state.view);
    Object.keys(state.facets).forEach(function (k) {
      if (state.facets[k].size) {
        p.push(k + "=" + Array.from(state.facets[k]).map(encodeURIComponent).join(","));
      }
    });
    if (state.dows.size) p.push("dow=" + Array.from(state.dows).join(","));
    if (state.range !== "upcoming") p.push("when=" + state.range);
    if (state.star) p.push("star=1");
    if (state.free) p.push("free=1");
    if (DATA.meta.reachableFilter && !state.reachable) p.push("all=1");
    if (state.q) p.push("q=" + encodeURIComponent(state.q));
    var h = p.join("&");
    if (("#" + h) !== location.hash) history.replaceState(null, "", h ? "#" + h : location.pathname);
  }
  function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return;
    h.split("&").forEach(function (kv) {
      var i = kv.indexOf("="), k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1) || "");
      if (k === "view") state.view = v;
      else if (k === "dow") v.split(",").forEach(function (x) { state.dows.add(x); });
      else if (k === "when") state.range = v;
      else if (k === "star") state.star = true;
      else if (k === "free") state.free = true;
      else if (k === "all") state.reachable = false;
      else if (k === "cat") v.split(",").forEach(function (x) { facetSet("category").add(x); });
      else if (k) v.split(",").forEach(function (x) { facetSet(k).add(decodeURIComponent(x)); });
      else if (k === "q") { state.q = v.toLowerCase(); var s = $("#search"); if (s) s.value = v; }
    });
  }

  /* ── theme ───────────────────────────────────────────── */
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("digest-theme"); } catch (e) {}
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    var btn = $("#themebtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var isDark = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("digest-theme", next); } catch (e) {}
    });
  }

  /* ── boot ────────────────────────────────────────────── */
  function boot() {
    initTheme();
    document.querySelectorAll(".viewtoggle button").forEach(function (b) {
      b.addEventListener("click", function () { state.view = b.dataset.view; state.selectedDay = null; render(); });
    });
    var s = $("#search");
    if (s) s.addEventListener("input", function () { state.q = s.value.trim().toLowerCase(); render(); });
    $("#clearbtn").addEventListener("click", resetFilters);

    fetch(cfg.dataUrl, { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (json) {
        DATA = json;
        DATA.events = (json.events || []).map(prep);
        // apply the data file's default before the hash, so a shared link can override it
        state.reachable = !!(DATA.meta.reachableFilter && DATA.meta.reachableFilter.defaultOn);
        readHash();
        renderHeader();
        render();
      })
      .catch(function (err) {
        clear($("#view")).appendChild(el("div", { class: "empty" }, [
          el("strong", { text: "Couldn’t load the listings." }),
          el("span", { text: String(err) + " — expected " + cfg.dataUrl }),
          el("span", { text: "If you're opening this file directly from disk, run a local server instead: python3 -m http.server" })
        ]));
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
