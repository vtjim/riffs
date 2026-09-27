#!/usr/bin/env python3
"""Rebuild data/westcoast.json (the trip page) from the West Coast Trip calendar.

The trip digest writes its picks to a shared Google Calendar, each marked
[auto:westcoast] in the description. This reads that calendar's private iCal
feed, keeps only marked events, works out which stop of the trip each one
belongs to, scrubs anything personal, and writes the page's data file. The
stops, their towns and dates come from the `legs` already in
data/westcoast.json, so nothing about the itinerary is hard-coded here.

Shares the calendar reader and the privacy scrubbing with build_vermont.py.
Secrets: WESTCOAST_ICS_URL (the calendar's "Secret address in iCal format"),
plus the same PRIVATE_WORDS and HOME_TOWN the Vermont build requires.
"""

import datetime as dt
import hashlib
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(__file__))
import build_vermont as bv  # noqa: E402  (calendar reader + scrubbing)

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "westcoast.json")
MARKER = "[auto:westcoast]"

# Nearby towns fold into the closest stop's hub (the page's footnote says so);
# Crystal Bay serves two hubs.
HUB = {
    "grass valley": "Nevada City, CA", "nevada city": "Nevada City, CA",
    "truckee": "Tahoe City, CA", "incline village": "Tahoe City, CA", "kings beach": "Tahoe City, CA",
    "crystal bay": "Tahoe City, CA", "tahoe city": "Tahoe City, CA", "tahoe vista": "Tahoe City, CA",
    "olympic valley": "Tahoe City, CA",
    "sparks": "Reno, NV", "carson city": "Reno, NV", "virginia city": "Reno, NV", "reno": "Reno, NV",
    "seattle": "Seattle, WA", "ketchikan": "Ketchikan, AK", "ward cove": "Ketchikan, AK", "saxman": "Ketchikan, AK",
}
ALSO_NEAR = {"crystal bay": ["Reno, NV"]}
# Times are shown in the stop's own local time, as the page always has.
LOCAL_TZ = {"Ketchikan, AK": ZoneInfo("America/Sitka")}
PACIFIC = ZoneInfo("America/Los_Angeles")


def local_iso(d, allday, hub):
    return d.isoformat() if allday else d.astimezone(LOCAL_TZ.get(hub, PACIFIC)).isoformat(timespec="seconds")
CATEGORY_BY_EMOJI = {"🎵": "music", "🎶": "music", "🎸": "music", "🏔": "outdoors", "🥾": "outdoors",
                     "🌲": "outdoors", "🍽": "food", "🍴": "food", "🍺": "food", "🍷": "food", "🎃": "food"}


def town_of(location):
    """'Rainbird Trail, Ketchikan, AK 99901' -> 'ketchikan'."""
    m = re.search(r",\s*([A-Za-z .'-]+),\s*[A-Z]{2}\b", location or "")
    if m:
        return m.group(1).strip().lower()
    for town in HUB:
        if town in (location or "").lower():
            return town
    return ""


def category_of(summary, type_line):
    for emoji, cat in CATEGORY_BY_EMOJI.items():
        if emoji in summary:
            return cat
    t = type_line.lower()
    if re.search(r"music|concert|band|jam|open mic|show", t):
        return "music"
    if re.search(r"food|beer|wine|market|dinner|brew|festival", t):
        return "food"
    return "outdoors"


def legs_for(hubs, first_day, last_day, legs):
    """Stops whose towns include the hub and whose dates overlap the event (travel days count for both)."""
    out = []
    for leg in legs:
        s, e = dt.date.fromisoformat(leg["start"]), dt.date.fromisoformat(leg["end"])
        if any(h in leg.get("cities", []) for h in hubs) and first_day <= e and last_day >= s:
            out.append(leg["id"])
    return out


def build_event(ev, start, end, allday, legs):
    summary = bv.unescape(bv.first(ev, "SUMMARY"))
    raw = bv.unescape(bv.first(ev, "DESCRIPTION"))
    location = bv.unescape(bv.first(ev, "LOCATION"))
    lines = [l.strip() for l in raw.replace(MARKER, "").splitlines() if l.strip()]

    star = "★" in summary or any(re.match(r"★\s*top pick", l, re.I) for l in lines)
    lines = [l for l in lines if not re.match(r"★\s*top pick", l, re.I) and not l.lower().startswith("leg:")]
    type_line = lines[0] if lines and "·" in lines[0] else ""
    if type_line:
        lines = lines[1:]
    genre, _, price = (p.strip() for p in type_line.partition("·"))

    title = re.sub(r"^[^\w★(]+", "", summary).strip().lstrip("★ ").strip()
    venue = ""
    if " — " in title:
        title, venue = title.rsplit(" — ", 1)

    town = town_of(location)
    hub = HUB.get(town, "")
    also = ALSO_NEAR.get(town, [])
    tz = LOCAL_TZ.get(hub, PACIFIC)
    first_day = start if allday else start.astimezone(tz).date()
    last_excl = end if allday else end.astimezone(tz).date()
    last_day = (last_excl - dt.timedelta(days=1)) if allday and last_excl > first_day else (last_excl if not allday else first_day)
    my_legs = legs_for([hub] + also, first_day, last_day, legs) if hub else []

    url_m = re.search(r"https?://\S+", raw)
    source_m = re.search(r"Source:\s*(.+)", raw)
    notes = bv.scrub("\n".join(l for l in lines if not l.lower().startswith("source:")))
    uid = bv.first(ev, "UID")
    e = {
        "id": hashlib.sha1(f"westcoast|{uid}|{start}".encode()).hexdigest()[:12],
        "title": title,
        "city": hub or (location.split(",")[-2].strip() if location.count(",") >= 2 else ""),
        "venue": venue or (location.split(",")[0].strip() if location else ""),
        "address": bv.scrub(location),
        "start": local_iso(start, allday, hub),
        "end": local_iso(last_day if allday else end, allday, hub),
        "allDay": allday,
        "timeConfirmed": not re.search(r"not confirmed", raw, re.I),
        "category": category_of(summary, type_line),
        "genre": bv.scrub(genre),
        "price": bv.scrub(price),
        "url": url_m.group(0).rstrip(").,") if url_m else "",
        "source": bv.scrub(source_m.group(1).strip()) if source_m else "",
        "star": star,
        "notes": notes,
        "alsoNear": also,
        "legs": my_legs,
        "reachable": bool(my_legs),
    }
    if allday and last_day > first_day:
        e["endDate"] = last_day.isoformat()
    e["spanEnd"] = (e.get("endDate") or e["start"])[:10]
    return e


def main():
    url = bv.clean_url(os.environ.get("WESTCOAST_ICS_URL", ""), "WESTCOAST_ICS_URL")
    if not url:
        print("WESTCOAST_ICS_URL not set — leaving the trip page as it is.")
        return
    if not bv.PRIVATE_WORDS or not bv.HOME_TOWN:
        sys.exit("Missing PRIVATE_WORDS / HOME_TOWN secrets — refusing to publish unscrubbed text.")

    previous = json.load(open(DATA_PATH, encoding="utf-8"))
    meta = previous["meta"]
    legs = meta.get("legs") or []
    trip_end = dt.date.fromisoformat(meta.get("tripEnd") or legs[-1]["end"])
    now = dt.datetime.now(bv.TZ)
    win_start = (now - dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    win_end = dt.datetime.combine(trip_end + dt.timedelta(days=2), dt.time(23, 59), bv.TZ)

    cal = bv.parse_ics(bv.fetch(url))
    occ = bv.occurrences(cal, MARKER, win_start, win_end)
    events = [build_event(*o, legs) for o in occ]
    events.sort(key=lambda e: (e["start"], e["title"]))
    print(f"westcoast: {len(cal)} calendar entries -> {len(events)} published listings, "
          f"{sum(e['reachable'] for e in events)} in town on the right dates")

    prev_n = len(previous.get("events", []))
    if prev_n >= 30 and len(events) < prev_n * 0.3:
        sys.exit(f"Trip listings dropped from {prev_n} to {len(events)} — refusing to publish.")

    meta["generated"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    meta["counts"] = {c: sum(1 for e in events if e["category"] == c) for c in ("music", "outdoors", "food")}

    problems = [f"{e['title']} [{k}]" for e in events for k in ("notes", "address", "genre", "price", "source")
                if bv.PERSONAL_RE.search(str(e.get(k, "")))]
    if bv.PERSONAL_RE.search(json.dumps(meta, ensure_ascii=False)):
        problems.append("meta")
    if problems:
        sys.exit("Personal reference survived scrubbing, not publishing: " + "; ".join(problems))

    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "events": events}, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {DATA_PATH}: {meta['counts']}")


if __name__ == "__main__":
    main()
