import { useEffect, useMemo, useState } from "react";

const SOON_MINUTES = 15;

// --------------------------------------------------------------------------
// Time formatting
// --------------------------------------------------------------------------

function formatClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayOffset(iso) {
  const days = (startOfDay(new Date(iso)) - startOfDay(new Date())) / 86400000;
  return Math.round(days);
}

function dayHeading(iso) {
  const offset = dayOffset(iso);
  if (offset === 0) {
    return "Today";
  }
  if (offset === 1) {
    return "Tomorrow";
  }
  return new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

function describeCountdown(event, now) {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();

  if (now >= start && now < end) {
    const remaining = Math.round((end - now) / 60000);
    return { text: remaining >= 60 ? `${Math.floor(remaining / 60)}h ${remaining % 60}m left` : `${remaining}m left`, state: "active" };
  }

  const minutes = Math.round((start - now) / 60000);
  if (minutes < 60) {
    return { text: `in ${minutes}m`, state: minutes <= SOON_MINUTES ? "soon" : "idle" };
  }
  if (minutes < 60 * 12) {
    const hours = Math.floor(minutes / 60);
    return { text: `in ${hours}h ${minutes % 60}m`, state: "idle" };
  }
  return { text: dayHeading(event.start).toLowerCase(), state: "idle" };
}

// --------------------------------------------------------------------------
// Components
// --------------------------------------------------------------------------

function NextUp({ event, now }) {
  if (!event) {
    return (
      <header className="next next--empty">
        <p className="next__title">Nothing scheduled</p>
        <p className="next__meta">Your next seven days are clear.</p>
      </header>
    );
  }

  const countdown = describeCountdown(event, now);

  return (
    <header className={`next next--${countdown.state}`}>
      <p className="next__countdown">{event.all_day ? "All day" : countdown.text}</p>
      <h1 className="next__title">{event.title}</h1>
      <p className="next__meta">
        {event.all_day ? dayHeading(event.start) : `${formatClock(event.start)} – ${formatClock(event.end)}`}
        {event.location ? ` · ${event.location}` : ""}
      </p>
    </header>
  );
}

function EventRow({ event, now }) {
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  const inProgress = now >= start && now < end;

  return (
    <li className={`row${inProgress ? " row--active" : ""}`}>
      <span className="row__time">{event.all_day ? "—" : formatClock(event.start)}</span>
      <span className="row__body">
        <span className="row__title">{event.title}</span>
        {event.location ? <span className="row__location">{event.location}</span> : null}
      </span>
    </li>
  );
}

function Agenda({ events, now }) {
  // Group by calendar day so the list reads as a schedule, not a queue.
  const groups = useMemo(() => {
    const map = new Map();
    for (const event of events) {
      const key = dayOffset(event.start);
      if (!map.has(key)) {
        map.set(key, { heading: dayHeading(event.start), events: [] });
      }
      map.get(key).events.push(event);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  }, [events]);

  if (groups.length === 0) {
    return <p className="agenda__empty">Nothing else coming up.</p>;
  }

  return (
    <div className="agenda">
      {groups.map((group) => (
        <section className="agenda__day" key={group.heading}>
          <h2 className="agenda__heading">{group.heading}</h2>
          <ul className="agenda__list">
            {group.events.map((event) => (
              <EventRow key={`${event.uid}-${event.start}`} event={event} now={now} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------

export default function App() {
  const [cache, setCache] = useState({ events: [], generated_at: null, error: null, stale: false });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    window.calendar.get().then(setCache);
    return window.calendar.subscribe(setCache);
  }, []);

  useEffect(() => {
    // 15s is enough for minute-granularity countdowns without burning
    // a render every second on a window that's usually hidden.
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        window.calendar.hide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const upcoming = useMemo(
    () => cache.events.filter((event) => new Date(event.end).getTime() > now),
    [cache.events, now]
  );

  const [next, ...rest] = upcoming;

  return (
    <div className="app">
      <NextUp event={next} now={now} />

      {cache.error ? <p className="notice">{cache.error}</p> : null}
      {cache.stale && !cache.error ? <p className="notice">Showing the last successful fetch.</p> : null}

      <Agenda events={rest} now={now} />

      <footer className="footer">
        <span className="footer__stamp">
          {cache.generated_at ? `Updated ${formatClock(cache.generated_at)}` : "Never updated"}
        </span>
        <button type="button" className="footer__action" onClick={() => window.calendar.refresh()}>
          Refresh
        </button>
      </footer>
    </div>
  );
}