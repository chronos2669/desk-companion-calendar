#!/usr/bin/env python3
"""
Isolate why the CalDAV search returns no events.

Runs three progressively less clever queries against every calendar and
reports what each returns, so you can tell which layer is empty:

  1. time-range + server-side expansion   (what fetch_events.py does now)
  2. time-range, no expansion             (is the filter itself the problem?)
  3. no filter at all                     (is there anything there at all?)

    python diagnose.py
"""

import sys
from datetime import datetime, timedelta

import caldav
import keyring

SERVICE = "desk-companion-calendar"
CALDAV_URL = "https://caldav.icloud.com"
LOOKAHEAD_DAYS = 7


def main() -> int:
    apple_id = keyring.get_password(SERVICE, "apple_id")
    password = keyring.get_password(SERVICE, "app_password")
    if not apple_id or not password:
        print("No credentials. Run setup_credentials.py first.", file=sys.stderr)
        return 1

    print(f"caldav library version: {caldav.__version__}")

    local_tz = datetime.now().astimezone().tzinfo
    now = datetime.now(local_tz)
    start = now - timedelta(hours=1)
    end = now + timedelta(days=LOOKAHEAD_DAYS)

    print(f"local timezone: {local_tz}")
    print(f"window: {start.isoformat()}  ->  {end.isoformat()}")

    client = caldav.DAVClient(url=CALDAV_URL, username=apple_id, password=password)
    principal = client.principal()
    print(f"principal: {principal.url}")

    calendars = principal.calendars()
    print(f"calendars found: {len(calendars)}")

    for calendar in calendars:
        try:
            name = calendar.get_display_name() or "(unnamed)"
        except Exception as exc:
            name = f"(name unavailable: {exc})"

        print(f"\n=== {name}")
        print(f"    url: {calendar.url}")

        # A Reminders list or a contacts collection will legitimately return
        # zero VEVENTs. This tells you whether it should have any at all.
        try:
            components = calendar.get_supported_components()
            print(f"    supported components: {components}")
        except Exception as exc:
            print(f"    supported components: unavailable ({type(exc).__name__}: {exc})")

        # Layer 1 — what the current script does.
        try:
            results = calendar.search(start=start, end=end, event=True, expand=True)
            print(f"    [1] time-range + expand : {len(results)}")
        except Exception as exc:
            print(f"    [1] time-range + expand : ERROR {type(exc).__name__}: {exc}")

        # Layer 2 — same filter, no expansion. If this is non-zero while
        # layer 1 is zero, iCloud silently ignored the expand request.
        try:
            results = calendar.search(start=start, end=end, event=True, expand=False)
            print(f"    [2] time-range only     : {len(results)}")
            for obj in results[:3]:
                component = obj.icalendar_component
                rrule = "recurring" if component.get("RRULE") else "single"
                print(f"          - {component.get('SUMMARY')} @ {component.get('DTSTART').dt} ({rrule})")
        except Exception as exc:
            print(f"    [2] time-range only     : ERROR {type(exc).__name__}: {exc}")

        # Layer 3 — no filter. If this is non-zero while layer 2 is zero,
        # the time-range filter is the problem, not the calendar.
        try:
            objects = calendar.events()
            print(f"    [3] no filter           : {len(objects)}")
            for obj in objects[:3]:
                component = obj.icalendar_component
                rrule = "recurring" if component.get("RRULE") else "single"
                print(f"          - {component.get('SUMMARY')} @ {component.get('DTSTART').dt} ({rrule})")
        except Exception as exc:
            print(f"    [3] no filter           : ERROR {type(exc).__name__}: {exc}")

    return 0


if __name__ == "__main__":
    sys.exit(main())