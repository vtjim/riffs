#!/usr/bin/env python3
"""Rebuild data/vermont.json from the digest's Google Calendars.

Runs inside a GitHub Action (see .github/workflows/build-vermont.yml). It reads
each calendar's private iCal feed, keeps only events the digest created (they
carry an [auto:...] marker in the description), strips anything personal, and
writes the site's data file. Standard library only, no pip installs.

Secrets (repo Settings -> Secrets and variables -> Actions):
  MUSIC_ICS_URL       Live Music calendar, "Secret address in iCal format"  (required)
  MOVIES_ICS_URL      Movies calendar                                        (required)
  RIDGELINES_ICS_URL  Ridgelines calendar                                    (optional)
  PRIVATE_WORDS       words that must never be published, comma-separated     (required)
  HOME_TOWN           town drive times are measured from                      (required)

If RIDGELINES_ICS_URL is not set yet, the Ridgelines listings already in
data/vermont.json are carried over unchanged, so nothing disappears.
"""

import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/New_York")
DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "vermont.json")
PAST_DAYS = 1          # keep yesterday so late-night shows don't vanish early
FUTURE_DAYS = 120      # how far ahead to publish

MARKERS = {
    "riffs": "[auto:vtmusic]",
    "reels": "[auto:majestic]",
    "ridgelines": "[auto:ridgelines]",
}

# Public-site rule: no names of people, no household references, no home town.
# The actual names and home town are NOT stored in this public repo; they come from
# two repo secrets so they never appear in code:
#   PRIVATE_WORDS  comma-separated words that must never be published (names, email bits)
#   HOME_TOWN      town drive times are measured from; shown publicly as "the Burlington area"
PRIVATE_WORDS = [w.strip() for w in os.environ.get("PRIVATE_WORDS", "").split(",") if w.strip()]
HOME_TOWN = os.environ.get("HOME_TOWN", "").strip()
_generic = [r"\bshe\b", r"\bher\b", r"\bour\b", r"\bwe\b", r"the family", r"@gmail", r"won't be around"]
_private = [rf"\b{re.escape(w)}\b" for w in PRIVATE_WORDS + ([HOME_TOWN] if HOME_TOWN else [])]
PERSONAL_RE = re.compile("|".join(_generic + _private), re.I)
# Artist/venue names that legitimately contain a flagged word are checked by hand in the
# log rather than blocked (titles and venues are never scrubbed).


# ── tiny iCalendar reader ────────────────────────────────────────────────────

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "riffs-site-builder"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def unfold(text):
    return re.sub(r"\r?\n[ \t]", "", text).splitlines()


def unescape(v):
    v = (v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
          .replace("\\;", ";").replace("\\\\", "\\"))
    return html.unescape(v)


def parse_ics(text):
    events, cur = [], None
    for line in unfold(text):
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            head, value = line.split(":", 1)
            name, *params = head.split(";")
            p = dict(x.split("=", 1) for x in params if "=" in x)
            cur.setdefault(name.upper(), []).append((p, value))
    return events


def first(ev, key, default=""):
    v = ev.get(key)
    return v[0][1] if v else default


def parse_dt(params, value):
    """Return (datetime-aware or date, is_all_day)."""
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return dt.datetime.strptime(value[:8], "%Y%m%d").date(), True
    if value.endswith("Z"):
        d = dt.datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        return d.astimezone(TZ), False
    tz = ZoneInfo(params["TZID"]) if "TZID" in params else TZ
    return dt.datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=tz), False


def rrule_dict(s):
    return dict(x.split("=", 1) for x in s.split(";") if "=" in x)


DAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def expand(start, rule, win_start, win_end):
    """Occurrence starts for simple DAILY/WEEKLY rules (all this digest uses)."""
    r = rrule_dict(rule)
    freq = r.get("FREQ")
    interval = int(r.get("INTERVAL", "1"))
    count = int(r["COUNT"]) if "COUNT" in r else None
    until = None
    if "UNTIL" in r:
        u, _ = parse_dt({}, r["UNTIL"])
        until = u if isinstance(u, dt.datetime) else dt.datetime.combine(u, dt.time(23, 59), TZ)
    if freq not in ("DAILY", "WEEKLY"):
        print(f"  ! unsupported RRULE {rule!r}; using first occurrence only", file=sys.stderr)
        return [start]
    step = dt.timedelta(days=interval if freq == "DAILY" else 7 * interval)
    bydays = [DAYS[d[-2:]] for d in r.get("BYDAY", "").split(",") if d] if freq == "WEEKLY" else []
    out, n, base = [], 0, start
    # guard: never loop more than ~5 years of weeks
    for _ in range(400):
        cands = [base] if not bydays else sorted(
            base + dt.timedelta(days=(wd - base.weekday()) % 7) for wd in bydays)
        for c in cands:
            if c < start:
                continue
            if until and c > until:
                return out
            n += 1
            if count and n > count:
                return out
            if c >= win_start and c <= win_end:
                out.append(c)
        if base > win_end:
            break
        base = base + step
    return out


def occurrences(events, marker, win_start, win_end):
    """Yield (event_props, start, end, all_day) for marked events in the window."""
    masters, overrides, cancelled = {}, {}, set()
    for ev in events:
        desc = unescape(first(ev, "DESCRIPTION"))
        uid = first(ev, "UID")
        if "RECURRENCE-ID" in ev:
            rp, rv = ev["RECURRENCE-ID"][0]
            rid, _ = parse_dt(rp, rv)
            if first(ev, "STATUS").upper() == "CANCELLED":
                cancelled.add((uid, rid))
            else:
                overrides[(uid, rid)] = ev
            continue
        if first(ev, "STATUS").upper() == "CANCELLED":
            continue
        masters[uid] = ev

    def emit(ev, s):
        if marker not in unescape(first(ev, "DESCRIPTION")):
            return None
        sp, sv = ev["DTSTART"][0]
        s0, allday = parse_dt(sp, sv)
        if "DTEND" in ev:
            e0, _ = parse_dt(*ev["DTEND"][0])
            dur = e0 - s0
        else:
            dur = dt.timedelta(days=1) if allday else dt.timedelta(hours=3)
        return ev, s, s + dur, allday

    out = []
    for uid, ev in masters.items():
        sp, sv = ev["DTSTART"][0]
        s0, allday = parse_dt(sp, sv)
        ws = win_start.date() if allday else win_start
        we = win_end.date() if allday else win_end
        rules = [v for _, v in ev.get("RRULE", [])]
        if rules:
            ex = set()
            for p, v in ev.get("EXDATE", []):
                for part in v.split(","):
                    ex.add(parse_dt(p, part)[0])
            if allday:
                starts = [d for d in expand(dt.datetime.combine(s0, dt.time(), TZ), rules[0],
                                            dt.datetime.combine(ws, dt.time(), TZ),
                                            dt.datetime.combine(we, dt.time(), TZ))]
                starts = [d.date() for d in starts]
            else:
                starts = expand(s0, rules[0], ws, we)
            for s in starts:
                if s in ex or (uid, s) in cancelled:
                    continue
                ov = overrides.pop((uid, s), None)
                if ov is not None:
                    osv = parse_dt(*ov["DTSTART"][0])[0]
                    r = emit(ov, osv)
                else:
                    r = emit(ev, s)
                if r:
                    out.append(r)
        elif ws <= s0 <= we:
            r = emit(ev, s0)
            if r:
                out.append(r)
    # overrides moved into the window from outside it
    for (uid, _), ov in overrides.items():
        s, allday = parse_dt(*ov["DTSTART"][0])
        ws = win_start.date() if allday else win_start
        we = win_end.date() if allday else win_end
        if ws <= s <= we:
            r = emit(ov, s)
            if r:
                out.append(r)
    return out


# ── turning calendar text into site fields ──────────────────────────────────

def scrub(text):
    """Drop personal lines and home-town references from free text."""
    if not text:
        return ""
    keep = []
    for line in text.splitlines():
        if HOME_TOWN:
            line = re.sub(rf"\b{re.escape(HOME_TOWN)}\b", "the Burlington area", line, flags=re.I)
        if PERSONAL_RE.search(line):
            continue
        keep.append(line.strip())
    return "\n".join(l for l in keep if l).strip()


def city_of(address):
    m = re.search(r",\s*([A-Za-z .'-]+),\s*(VT|NY|NH)\b", address or "")
    return m.group(1).strip() if m else ""


def drive_min(text):
    m = re.search(r"~\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*min\b", text or "")
    if m:
        return int(m.group(2) or m.group(1))
    m = re.search(r"~\s*(\d+)\s*h(?:r|our)?s?\s*(\d+)?\s*(?:min)?[^\n]{0,20}\bfrom\b", text or "")
    if m:
        return int(m.group(1)) * 60 + int(m.group(2) or 0)
    return None


def field(text, label):
    m = re.search(rf"(?:^|—\s*){label}:\s*(.+)$", text or "", re.M | re.I)
    return m.group(1).strip() if m else ""


def price_of(text):
    p = field(text, "Price")
    if p:
        return p.rstrip(".")
    m = re.search(r"Price:\s*([^\n]+?)(?:\.\s|\n|$)", text or "")
    if m:
        return m.group(1).strip()
    if re.search(r"\bfree\b", text or "", re.I):
        return "Free"
    return ""


def gcal_template(title, start, end, allday, location):
    if allday:
        fmt = lambda d: d.strftime("%Y%m%d")
    else:
        fmt = lambda d: d.astimezone(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    q = {"action": "TEMPLATE", "text": title, "dates": f"{fmt(start)}/{fmt(end)}",
         "location": location or ""}
    return "https://calendar.google.com/calendar/render?" + urllib.parse.urlencode(q)


def iso(d, allday):
    return d.isoformat() if allday else d.astimezone(TZ).isoformat(timespec="seconds")


def build_event(category, ev, start, end, allday):
    summary = unescape(first(ev, "SUMMARY"))
    raw = unescape(first(ev, "DESCRIPTION"))
    location = unescape(first(ev, "LOCATION"))
    body = raw.replace(MARKERS[category], "").strip()

    title = re.sub(r"^[^\w★(]+", "", summary).strip()           # drop leading emoji
    star = title.startswith("★") or "followed artist" in body.lower()
    title = title.lstrip("★ ").strip()
    venue = ""
    if " — " in title:
        title, venue = title.rsplit(" — ", 1)

    genre = field(body, "Genre")
    notes_lines = []
    if category == "reels":
        showtime = field(body, "Showtime")
        rated = next((l for l in body.splitlines() if l.startswith("Rated")), "")
        genre = rated.split("·")[-1].strip() if "·" in rated else "Movie"
        m = re.search(r"~(\d+)h(\d+)m", rated)
        if showtime and not allday:
            t = dt.datetime.strptime(showtime.upper(), "%I:%M %p").time()
            start = dt.datetime.combine(start.date(), t, TZ)
            if m:
                end = start + dt.timedelta(hours=int(m.group(1)), minutes=int(m.group(2)))
        skip = ("(tentative", "Showtime:", "Arrive by")
        notes_lines = [l for l in body.splitlines() if l.strip() and not l.startswith(skip)]
        price = "Tuesday discount pricing"
    else:
        price = price_of(body)
        if not genre:
            for sent in re.split(r"(?<=\.)\s+|\n", body):
                sent = re.sub(r"^(CHANGED|NEW)\b[^:]*:\s*", "", sent.strip())
                if sent and not re.match(r"(Price|~|Source|★|⚠|Doors|doors|Night \d)", sent):
                    genre = sent.rstrip(".")
                    break
        notes_lines = [re.sub(r"^(CHANGED|NEW)\s*[—-]\s*", "", l) for l in body.splitlines()]

    source = field(body, "Source")
    if not source:
        m = re.search(r"Source:\s*(.+?)(?:\.\s|\n|$)", body)
        source = m.group(1).strip().rstrip(".") if m else ""
    notes = scrub("\n".join(notes_lines))
    confirmed = not re.search(r"not confirmed", raw, re.I)
    uid = first(ev, "UID")
    eid = hashlib.sha1(f"{category}|{uid}|{start}".encode()).hexdigest()[:12]

    return {
        "id": eid,
        "title": title,
        "category": category,
        "city": city_of(location),
        "venue": scrub(venue) or venue,
        "address": scrub(location),
        "start": iso(start, allday),
        "end": iso(end if not allday else (end - dt.timedelta(days=1) if end > start else end), allday),
        "allDay": allday,
        "timeConfirmed": confirmed,
        "genre": scrub(genre),
        "price": scrub(price),
        "url": "",
        "source": scrub(source),
        "star": star,
        "notes": notes,
        "driveMin": drive_min(raw),
        "bookAhead": bool(re.search(r"book ahead", raw, re.I)),
        "calendarLink": gcal_template(title, start, end, allday, location),
    }


# ── main ────────────────────────────────────────────────────────────────────

def main():
    now = dt.datetime.now(TZ)
    if os.environ.get("BUILD_TODAY"):          # for local testing only
        now = dt.datetime.fromisoformat(os.environ["BUILD_TODAY"]).replace(tzinfo=TZ)
    win_start = (now - dt.timedelta(days=PAST_DAYS)).replace(hour=0, minute=0, second=0, microsecond=0)
    win_end = now + dt.timedelta(days=FUTURE_DAYS)

    try:
        previous = json.load(open(DATA_PATH, encoding="utf-8"))
    except (OSError, ValueError):
        previous = {"meta": {}, "events": []}
    prev_counts = (previous.get("meta") or {}).get("counts") or {}

    feeds = {
        "riffs": os.environ.get("MUSIC_ICS_URL", "").strip(),
        "reels": os.environ.get("MOVIES_ICS_URL", "").strip(),
        "ridgelines": os.environ.get("RIDGELINES_ICS_URL", "").strip(),
    }
    if not PRIVATE_WORDS or not HOME_TOWN:
        sys.exit("Missing PRIVATE_WORDS / HOME_TOWN secrets — refusing to publish unscrubbed text.")
    for need in ("riffs", "reels"):
        if not feeds[need]:
            sys.exit(f"Missing secret for {need} calendar (see header of this script).")

    events = []
    for category, url in feeds.items():
        if not url:
            cutoff = win_start.date().isoformat()
            kept = [e for e in previous.get("events", []) if e.get("category") == category
                    and str(e.get("end") or e.get("start") or "9999")[:10] >= cutoff]
            print(f"{category}: no feed configured, carrying over {len(kept)} existing listings")
            events.extend(kept)
            continue
        cal = parse_ics(fetch(url))
        occ = occurrences(cal, MARKERS[category], win_start, win_end)
        built = [build_event(category, *o) for o in occ]
        print(f"{category}: {len(cal)} calendar entries -> {len(built)} published listings")
        events.extend(built)

    events.sort(key=lambda e: (str(e.get("start") or ""), str(e.get("title") or "")))
    counts = {c: sum(1 for e in events if e["category"] == c) for c in MARKERS}

    # Sanity check: a collapse in music listings means a feed problem, not a quiet week.
    prev_riffs = prev_counts.get("riffs", 0)
    if prev_riffs >= 20 and counts["riffs"] < prev_riffs * 0.3:
        sys.exit(f"Riffs dropped from {prev_riffs} to {counts['riffs']} — refusing to publish.")

    ridge_note = ("Ridgelines listings come from the shared Ridgelines calendar."
                  if feeds["ridgelines"] else
                  "Ridgelines listings come from the digest's saved research until a "
                  "Ridgelines calendar is connected.")
    meta = previous.get("meta") or {}
    meta.update({
        "title": "Reels, Riffs & Ridgelines",
        "subtitle": "Movies, live music and the outdoors around northern Vermont",
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "timezone": "America/New_York",
        "origin": "Burlington area, VT",
        "facets": [{"key": "category", "label": "Section", "values": [
            {"value": "reels", "label": "🎬 Reels — movies"},
            {"value": "riffs", "label": "🎵 Riffs — live music"},
            {"value": "ridgelines", "label": "🏔 Ridgelines — outdoors"}]}],
        "showDriveTime": True,
        "counts": counts,
        "notes": [
            "Movie showtimes cover the Majestic 10's Tuesday discount night and are refreshed every Monday.",
            "Riffs and Reels come from the digest's shared Live Music and Movies calendars.",
            ridge_note,
            "Drive times are estimates from the Burlington area. Times marked 'time not confirmed' "
            "were assumed from a venue's usual schedule, not published.",
        ],
    })

    out = {"meta": meta, "events": events}

    # Final public-site check: nothing personal may remain outside titles/venues.
    problems = []
    for e in events:
        for k in ("notes", "address", "genre", "price", "source"):
            if PERSONAL_RE.search(str(e.get(k, ""))):
                problems.append(f"{e['title']} [{k}]")
        for k in ("title", "venue"):
            v = str(e.get(k, ""))
            if PERSONAL_RE.search(v):
                print(f"  note: flagged word in {k} of '{v}' (left as-is; looks like a name)")
    for s in [json.dumps(meta, ensure_ascii=False)]:
        if PERSONAL_RE.search(s):
            problems.append("meta")
    if problems:
        sys.exit("Personal reference survived scrubbing, not publishing: " + "; ".join(problems))

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {DATA_PATH}: {counts}")


if __name__ == "__main__":
    main()
