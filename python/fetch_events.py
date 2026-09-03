#!/usr/bin/env python3
"""
Fetch upcoming events from iCloud CalDAV and write a normalized JSON cache.

    python fetch_events.py            fetch and write the cache
    python fetch_events.py --stdout   print the JSON, don't write
    python fetch_events.py --verbose  log discovery steps

Exit codes: 0 = success, 1 = credential problem, 2 = network/server problem.
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import caldav
import keyring
from caldav.lib.error import AuthorizationError, DAVError

SERVICE = "desk-companion-calendar"
CALDAV_URL = "https://caldav.icloud.com"

LOOKAHEAD_DAYS = 7
MAX_EVENTS = 40

# Calendars to skip by display name. Birthday and holiday feeds tend to
# flood a "next few events" view with all-day noise.
SKIP_CALENDARS = {"Birthdays", "Siri Suggestions"}

CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "desk-companion"
CACHE_FILE = CACHE_DIR / "events.json"

LOCAL_TZ = datetime.now().astimezone().tzinfo


def log(message: str, *, verbose: bool) -> None:
    if verbose:
        print(f"  {message}", file=sys.stderr)


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

def load_credentials() -> tuple[str, str]:
    apple_id = keyring.get_password(SERVICE, "apple_id")
    password = keyring.get_password(SERVICE, "app_password")
    if not apple_id or not password:
        raise RuntimeError(
            "No credentials found. Run: python setup_credentials.py"
        )
    return apple_id, password


# --------------------------------------------------------------------------
# Normalizing iCalendar components
# --------------------------------------------------------------------------

def to_local_datetime(value) -> tuple[datetime, bool]:
    """
    Normalize a DTSTART/DTEND value to a timezone-aware local datetime.

    Returns (datetime, is_all_day). All-day events arrive as datetime.date
    rather than datetime.datetime — that distinction is how RFC 5545
    encodes them, and it's the only reliable way to detect them.
    """
    if isinstance(value, datetime):
        if value.tzinfo is None:
            # A floating time: RFC 5545 says interpret in the local zone.
            value = value.replace(tzinfo=LOCAL_TZ)
        return value.astimezone(LOCAL_TZ), False

    if isinstance(value, date):
        midnight = datetime(value.year, value.month, value.day, tzinfo=LOCAL_TZ)
        return midnight, True

    raise TypeError(f"Unexpected date value: {value!r}")


def component_to_event(component, calendar_name: str) -> dict | None:
    """Turn one VEVENT into a flat dict, or None if it can't be used."""
    dtstart_prop = component.get("DTSTART")
    if dtstart_prop is None:
        return None

    start, all_day = to_local_datetime(dtstart_prop.dt)

    dtend_prop = component.get("DTEND")
    if dtend_prop is not None:
        end, _ = to_local_datetime(dtend_prop.dt)
    elif component.get("DURATION") is not None:
        end = start + component.get("DURATION").dt
    elif all_day:
        end = start + timedelta(days=1)
    else:
        end = start + timedelta(hours=1)

    status = str(component.get("STATUS", "")).upper()
    if status == "CANCELLED":
        return None

    return {
        "uid": str(component.get("UID", "")),
        "title": str(component.get("SUMMARY", "")).strip() or "Untitled event",
        "location": str(component.get("LOCATION", "")).strip() or None,
        "start": start.isoformat(),
        "end": end.isoformat(),
        "all_day": all_day,
        "calendar": calendar_name,
    }


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

def search_calendar(calendar, start, end, *, verbose: bool) -> list:
    """
    Try progressively less clever queries. An empty result is a valid
    CalDAV response rather than an error, so every fallback has to trigger
    on zero rows as well as on an exception — otherwise a server that
    quietly ignores `expand` looks identical to an empty calendar.
    """
    import recurring_ical_events

    def expand_locally(objects):
        components = []
        for obj in objects:
            components.extend(recurring_ical_events.of(obj.icalendar_instance).between(start, end))
        return components

    # 1. Server-side expansion. Cheapest by far when the server obliges.
    try:
        results = calendar.search(start=start, end=end, event=True, expand=True)
        if results:
            log(f"server-side expansion returned {len(results)}", verbose=verbose)
            return [r.icalendar_component for r in results]
        log("server-side expansion returned 0; trying unexpanded time-range", verbose=verbose)
    except DAVError as exc:
        log(f"expand=True rejected ({exc}); trying unexpanded time-range", verbose=verbose)

    # 2. Same time-range filter, expansion done here instead.
    try:
        objects = calendar.search(start=start, end=end, event=True, expand=False)
        if objects:
            components = expand_locally(objects)
            log(f"time-range + local expansion returned {len(components)}", verbose=verbose)
            return components
        log("unexpanded time-range returned 0; falling back to full fetch", verbose=verbose)
    except DAVError as exc:
        log(f"time-range search failed ({exc}); falling back to full fetch", verbose=verbose)

    # 3. Fetch every object and filter here. Slow, but it cannot be
    #    defeated by the server misreading a filter.
    components = expand_locally(calendar.events())
    log(f"full fetch + local expansion returned {len(components)}", verbose=verbose)
    return components

def fetch_events(*, verbose: bool) -> list[dict]:
    apple_id, password = load_credentials()

    now = datetime.now(LOCAL_TZ)
    window_start = now - timedelta(hours=1)   # keep an in-progress event visible
    window_end = now + timedelta(days=LOOKAHEAD_DAYS)

    log(f"connecting to {CALDAV_URL}", verbose=verbose)
    client = caldav.DAVClient(url=CALDAV_URL, username=apple_id, password=password)

    # This single call performs the current-user-principal PROPFIND.
    principal = client.principal()
    log(f"principal: {principal.url}", verbose=verbose)

    # And this walks calendar-home-set to enumerate collections.
    calendars = principal.calendars()
    log(f"found {len(calendars)} calendars", verbose=verbose)

    events: list[dict] = []
    for calendar in calendars:
        try:
            name = calendar.get_display_name() or "Calendar"
        except DAVError:
            name = "Calendar"

        if name in SKIP_CALENDARS:
            log(f"skipping '{name}'", verbose=verbose)
            continue

        log(f"querying '{name}'", verbose=verbose)
        try:
            components = search_calendar(calendar, window_start, window_end, verbose=verbose)
        except DAVError as exc:
            log(f"'{name}' failed: {exc}", verbose=verbose)
            continue

        for component in components:
            event = component_to_event(component, name)
            if event is not None:
                events.append(event)

    # Deduplicate: subscribed and shared calendars can surface the same
    # UID twice. Key on UID plus start so recurring occurrences survive.
    seen = set()
    unique = []
    for event in sorted(events, key=lambda e: e["start"]):
        key = (event["uid"], event["start"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(event)

    return unique[:MAX_EVENTS]


# --------------------------------------------------------------------------
# Cache writing
# --------------------------------------------------------------------------

def write_cache(payload: dict) -> None:
    """
    Write atomically. The Electron process polls this file, and a partial
    read of a half-written file would crash the renderer. Writing to a
    temp file in the same directory and renaming is atomic on POSIX.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(dir=CACHE_DIR, prefix=".events-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
        os.replace(temp_path, CACHE_FILE)
    except Exception:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
        raise


def record_failure(message: str) -> None:
    """
    Preserve the last good event list and mark it stale, rather than
    replacing a working agenda with an error. A brief network blip
    shouldn't blank the tray.
    """
    payload = {"generated_at": None, "events": [], "error": message}
    if CACHE_FILE.exists():
        try:
            payload = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    payload["error"] = message
    payload["stale"] = True
    write_cache(payload)


# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stdout", action="store_true", help="print JSON instead of writing the cache")
    parser.add_argument("--verbose", action="store_true", help="log discovery steps to stderr")
    args = parser.parse_args()

    try:
        events = fetch_events(verbose=args.verbose)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        record_failure(str(exc))
        return 1
    except AuthorizationError:
        message = "iCloud rejected the credentials. Regenerate the app-specific password."
        print(message, file=sys.stderr)
        record_failure(message)
        return 1
    except (DAVError, OSError) as exc:
        message = f"Could not reach iCloud: {exc}"
        print(message, file=sys.stderr)
        record_failure(message)
        return 2

    payload = {
        "generated_at": datetime.now(LOCAL_TZ).isoformat(),
        "timezone": str(LOCAL_TZ),
        "events": events,
        "error": None,
        "stale": False,
    }

    if args.stdout:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        write_cache(payload)
        print(f"Wrote {len(events)} events to {CACHE_FILE}")

    return 0


if __name__ == "__main__":
    sys.exit(main())