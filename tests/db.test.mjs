import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDb, asRole } from './helpers/db.mjs';

const TABLES = ['services', 'staff', 'staff_services', 'weekly_hours', 'time_off', 'appointments'];

async function staffIdsByName(db) {
  const { rows } = await db.query('select id, name from staff');
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

async function insertAppointment(db, { staffId, services, start, end, status = 'pending', source }) {
  const cols = ['staff_id', 'services', 'starts_at', 'ends_at', 'status'];
  const vals = [staffId, services, start, end, status];
  if (source) {
    cols.push('source');
    vals.push(source);
  }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  return db.query(`insert into appointments (${cols.join(', ')}) values (${placeholders})`, vals);
}

test('seeds services', async () => {
  const db = await newDb();
  const { rows } = await db.query('select name, requires from services');
  assert.equal(rows.length, 19); // UV Gel + Hard Gel became UV Gel/Hard Gel (migration 6)

  const byName = Object.fromEntries(rows.map((r) => [r.name, r.requires]));
  for (const name of ['Nails', 'Massage', 'Head Spa', 'Eyelash Extensions', 'Facials', 'Waxing']) {
    assert.equal(byName[name], name, name);
  }
  assert.equal(byName['$38 Bundle: Regular Mani + Pedi'], 'Nails');
  assert.equal(byName['Other'], null);
});

test('seeds staff', async () => {
  const db = await newDb();
  const { rows } = await db.query('select name, active, sort from staff order by sort');
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Mia', 'Yoyo', 'Carmela', 'Lili', 'Linda']
  );
  for (const r of rows) assert.equal(r.active, true, r.name);
  assert.deepEqual(
    rows.map((r) => r.sort),
    [1, 2, 3, 4, 5]
  );

  const { rows: links } = await db.query(`
    select st.name, ss.service
    from staff st
    join staff_services ss on ss.staff_id = st.id
    where ss.service = 'Nails'
  `);
  assert.equal(links.length, 5);
  for (const r of links) assert.equal(r.service, 'Nails', r.name);

  const { rows: hours } = await db.query('select * from weekly_hours');
  assert.equal(hours.length, 0);
});

test('overlapping pending/confirmed rejected', async () => {
  const db = await newDb();
  const staffIds = await staffIdsByName(db);

  await insertAppointment(db, {
    staffId: staffIds.Mia,
    services: ['Nails'],
    start: '2026-10-01T10:00:00',
    end: '2026-10-01T11:00:00',
    status: 'pending',
  });

  await assert.rejects(
    insertAppointment(db, {
      staffId: staffIds.Mia,
      services: ['Nails'],
      start: '2026-10-01T10:30:00',
      end: '2026-10-01T11:30:00',
      status: 'confirmed',
    }),
    (err) => {
      assert.equal(err.code, '23P01');
      return true;
    }
  );

  // A declined appointment doesn't block time.
  await insertAppointment(db, {
    staffId: staffIds.Mia,
    services: ['Nails'],
    start: '2026-10-01T10:30:00',
    end: '2026-10-01T11:30:00',
    status: 'declined',
  });

  // Different staff, same range: ok.
  await insertAppointment(db, {
    staffId: staffIds.Yoyo,
    services: ['Nails'],
    start: '2026-10-01T10:00:00',
    end: '2026-10-01T11:00:00',
    status: 'pending',
  });

  // Back-to-back (no overlap): ok.
  await insertAppointment(db, {
    staffId: staffIds.Mia,
    services: ['Nails'],
    start: '2026-10-01T11:00:00',
    end: '2026-10-01T12:00:00',
    status: 'pending',
  });
});

test('status and source are checked', async () => {
  const db = await newDb();
  const staffIds = await staffIdsByName(db);

  await assert.rejects(
    insertAppointment(db, {
      staffId: staffIds.Mia,
      services: ['Nails'],
      start: '2026-10-01T10:00:00',
      end: '2026-10-01T11:00:00',
      status: 'maybe',
    }),
    (err) => {
      assert.equal(err.code, '23514');
      return true;
    }
  );

  await assert.rejects(
    insertAppointment(db, {
      staffId: staffIds.Mia,
      services: ['Nails'],
      start: '2026-10-01T10:00:00',
      end: '2026-10-01T11:00:00',
      status: 'pending',
      source: 'web2',
    }),
    (err) => {
      assert.equal(err.code, '23514');
      return true;
    }
  );
});

test('anon sees no table rows and cannot insert', async () => {
  const db = await newDb();
  const staffIds = await staffIdsByName(db);

  await asRole(db, 'anon', async () => {
    for (const table of TABLES) {
      const { rows } = await db.query(`select count(*) from ${table}`);
      assert.equal(Number(rows[0].count), 0, table);
    }

    await assert.rejects(
      insertAppointment(db, {
        staffId: staffIds.Mia,
        services: ['Nails'],
        start: '2026-10-01T10:00:00',
        end: '2026-10-01T11:00:00',
      })
    );
  });
});

test('authenticated has full access', async () => {
  const db = await newDb();
  const staffIds = await staffIdsByName(db);

  await asRole(db, 'authenticated', async () => {
    const { rows: staff } = await db.query('select id from staff');
    assert.equal(staff.length, 5);

    const { rows: inserted } = await db.query(
      `insert into appointments (staff_id, services, starts_at, ends_at, status)
       values ($1, $2, $3, $4, 'pending') returning id`,
      [staffIds.Mia, ['Nails'], '2026-10-01T09:00:00', '2026-10-01T10:00:00']
    );
    const id = inserted[0].id;

    await db.query(`update appointments set status = 'confirmed' where id = $1`, [id]);
    await db.query('delete from appointments where id = $1', [id]);
  });
});

// --- Task 2: public RPCs + realtime broadcast -----------------------------

const NOW = '2026-10-20 12:00-04'; // Tuesday, pinned "now" for every test below
const DEFAULT_DAY = '2026-10-27'; // Tuesday

const NAIL_SERVICES = [
  'Manicure', 'Pedicure', 'Gel Manicure', 'Gel Pedicure', 'SNS Powder', 'Gel X',
  'UV Gel/Hard Gel', 'Spa Pedicure', 'Buff & Shine Manicure', 'Buff & Shine Pedicure',
  'Polish Change',
];

test('nail services are their own skills', async () => {
  const db = await newDb();
  const { rows } = await db.query('select name, requires from services where name = any($1)', [NAIL_SERVICES]);
  assert.equal(rows.length, NAIL_SERVICES.length);
  for (const r of rows) assert.equal(r.requires, r.name, r.name);
});

test("nail skills copy Nails staff, except Yoyo's Gel X / UV Gel/Hard Gel", async () => {
  const db = await newDb();
  const { rows } = await db.query(`
    select st.name, array_agg(ss.service) filter (where ss.service = any($1)) as nail
    from staff st
    join staff_services ss on ss.staff_id = st.id
    group by st.name
  `, [NAIL_SERVICES]);
  assert.equal(rows.length, 5);
  for (const r of rows) {
    const expected = r.name === 'Yoyo'
      ? NAIL_SERVICES.filter((s) => s !== 'Gel X' && s !== 'UV Gel/Hard Gel')
      : NAIL_SERVICES;
    assert.deepEqual([...r.nail].sort(), [...expected].sort(), r.name);
  }
});

// Pins public._now() so lead-time/horizon checks are deterministic.
async function pinClock(db) {
  await db.query(
    `create or replace function public._now() returns timestamptz
       language sql stable as $$ select '${NOW}'::timestamptz $$`
  );
}

// Seeds Tue (2) and Sun (0) 10:00-18:00 hours for Mia and Yoyo.
async function seedHours(db) {
  const ids = await staffIdsByName(db);
  for (const name of ['Mia', 'Yoyo']) {
    for (const weekday of [2, 0]) {
      await db.query(
        `insert into weekly_hours (staff_id, weekday, start_time, end_time)
         values ($1, $2, '10:00', '18:00')`,
        [ids[name], weekday]
      );
    }
  }
  return ids;
}

async function setup() {
  const db = await newDb();
  await pinClock(db);
  const staffIds = await seedHours(db);
  return { db, staffIds };
}

function publicDay(db, day = DEFAULT_DAY) {
  return db.query('select public_day($1) as result', [day]).then((r) => r.rows[0].result);
}

const DEFAULT_REQUEST = {
  name: 'Test Customer',
  phone: '718-555-0100',
  email: 'test@example.com',
  services: ['Nails'],
  staffId: null,
  day: DEFAULT_DAY,
  startMin: 780, // 13:00
  notes: null,
};

// request_appointment never returns the new row's id, so tests that need
// the row look up the most recently inserted appointment instead.
async function latestId(db) {
  const { rows } = await db.query('select id from appointments order by id desc limit 1');
  return rows[0].id;
}

function requestAppointment(db, overrides = {}) {
  const r = { ...DEFAULT_REQUEST, ...overrides };
  return db
    .query('select request_appointment($1, $2, $3, $4, $5, $6, $7, $8) as result', [
      r.name,
      r.phone,
      r.email,
      r.services,
      r.staffId,
      r.day,
      r.startMin,
      r.notes,
    ])
    .then((res) => res.rows[0].result);
}

test('public_day returns hours, off and busy as day minutes, no customer fields', async () => {
  const { db, staffIds } = await setup();

  // A declined appointment must not show up in busy.
  await insertAppointment(db, {
    staffId: staffIds.Mia,
    services: ['Nails'],
    start: '2026-10-27T11:00:00-04',
    end: '2026-10-27T12:00:00-04',
    status: 'declined',
  });

  await db.query(
    `insert into appointments (staff_id, services, starts_at, ends_at, status, customer_name, phone, email, notes, source)
     values ($1, $2, $3, $4, 'pending', $5, $6, $7, $8, 'web')`,
    [
      staffIds.Mia,
      ['Nails'],
      '2026-10-27T14:00:00-04',
      '2026-10-27T15:00:00-04',
      'Secret Name',
      '555-0000',
      'secret@example.com',
      'Secret notes',
    ]
  );

  const result = await publicDay(db);

  assert.deepEqual(Object.keys(result).sort(), ['busy', 'day', 'hours', 'off', 'services', 'staff'].sort());
  assert.equal(result.day, '2026-10-27');

  const json = JSON.stringify(result);
  for (const secret of ['Secret Name', '555-0000', 'secret@example.com', 'Secret notes']) {
    assert.ok(!json.includes(secret), `leaked: ${secret}`);
  }

  assert.equal(result.busy.length, 1);
  assert.equal(result.busy[0].staff_id, staffIds.Mia);
  assert.equal(result.busy[0].start_min, 840); // 14:00
  assert.equal(result.busy[0].end_min, 900); // 15:00
});

test('inactive staff hidden and not bookable', async () => {
  const { db, staffIds } = await setup();

  await db.query('update staff set active = false where id = $1', [staffIds.Yoyo]);

  const result = await publicDay(db);
  assert.ok(!result.staff.some((s) => s.id === staffIds.Yoyo));
  assert.ok(!result.hours.some((h) => h.staff_id === staffIds.Yoyo));

  const res = await requestAppointment(db, { staffId: staffIds.Yoyo });
  assert.deepEqual(res, { ok: false, reason: 'slot_taken' });

  // Yoyo's existing appointment stays visible to staff tooling.
  await db.query(
    `insert into appointments (staff_id, services, starts_at, ends_at, status)
     values ($1, $2, $3, $4, 'confirmed')`,
    [staffIds.Yoyo, ['Nails'], '2026-10-27T15:00:00-04', '2026-10-27T16:00:00-04']
  );
  await asRole(db, 'authenticated', async () => {
    const { rows } = await db.query('select id from appointments where staff_id = $1', [staffIds.Yoyo]);
    assert.equal(rows.length, 1);
  });
});

test('request creates pending 60-min block', async () => {
  const { db } = await setup();

  const res = await requestAppointment(db);
  assert.equal(res.ok, true);

  const { rows } = await db.query(
    `select status, source, extract(epoch from (ends_at - starts_at)) / 60 as minutes
     from appointments where id = $1`,
    [await latestId(db)]
  );
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].source, 'web');
  assert.equal(Number(rows[0].minutes), 60);
});

test('request on DST day stores local wall time', async () => {
  const { db, staffIds } = await setup();

  const res = await requestAppointment(db, { day: '2026-11-01', startMin: 600, staffId: staffIds.Mia });
  assert.equal(res.ok, true);

  const { rows } = await db.query('select starts_at from appointments where id = $1', [await latestId(db)]);
  assert.equal(new Date(rows[0].starts_at).toISOString(), '2026-11-01T15:00:00.000Z');

  const day = await publicDay(db, '2026-11-01');
  const busy = day.busy.find((b) => b.staff_id === staffIds.Mia);
  assert.deepEqual(busy, { staff_id: staffIds.Mia, start_min: 600, end_min: 660 });
});

test('slot must be inside a shift, off-grid rejected', async () => {
  const { db, staffIds } = await setup();

  const late = await requestAppointment(db, { startMin: 1050, staffId: staffIds.Mia });
  assert.deepEqual(late, { ok: false, reason: 'slot_taken' });

  const fits = await requestAppointment(db, { startMin: 1020, staffId: staffIds.Mia });
  assert.equal(fits.ok, true);

  const offGrid = await requestAppointment(db, { startMin: 607, staffId: staffIds.Mia });
  assert.deepEqual(offGrid, { ok: false, reason: 'invalid' });
});

test('time off and busy block', async () => {
  const { db, staffIds } = await setup();

  await db.query(
    `insert into time_off (staff_id, starts_at, ends_at) values ($1, $2, $3)`,
    [staffIds.Mia, '2026-10-27T13:00:00-04', '2026-10-27T15:00:00-04']
  );

  const res = await requestAppointment(db, { startMin: 780, staffId: staffIds.Mia });
  assert.deepEqual(res, { ok: false, reason: 'slot_taken' });
});

test('lead time and horizon', async () => {
  const { db } = await setup();

  // Lead-time/horizon misses are reported as slot_taken (not invalid) so the
  // public form refetches and shows the current open times instead of a
  // dead-end "couldn't send" — e.g. a same-day slot that aged past the
  // 60-minute lead time while the customer was filling the form in.
  const tooSoon = await requestAppointment(db, { day: '2026-10-20', startMin: 720 });
  assert.deepEqual(tooSoon, { ok: false, reason: 'slot_taken' });

  const past = await requestAppointment(db, { day: '2026-10-19', startMin: 780 });
  assert.deepEqual(past, { ok: false, reason: 'slot_taken' });

  const ok = await requestAppointment(db, { day: '2026-10-20', startMin: 780 });
  assert.equal(ok.ok, true);

  const tooFar = await requestAppointment(db, { day: '2026-12-20', startMin: 780 });
  assert.deepEqual(tooFar, { ok: false, reason: 'slot_taken' });
});

test('no preference picks least-booked capable staff', async () => {
  const { db, staffIds } = await setup();

  await db.query(
    `insert into appointments (staff_id, services, starts_at, ends_at, status)
     values ($1, $2, $3, $4, 'pending')`,
    [staffIds.Mia, ['Nails'], '2026-10-27T10:00:00-04', '2026-10-27T11:00:00-04']
  );

  const res = await requestAppointment(db, { staffId: null, startMin: 780 });
  assert.equal(res.ok, true);
  assert.equal(res.staff_name, 'Yoyo');

  // Nobody has Massage as a skill, but skills no longer turn a request away:
  // a free provider still gets it.
  const unskilled = await requestAppointment(db, { staffId: null, startMin: 900, services: ['Massage'] });
  assert.equal(unskilled.ok, true);
});

test('no preference prefers a skilled provider over a less-booked one without the skill', async () => {
  const { db, staffIds } = await setup();

  // Mia (has Gel X) is busier than Yoyo (doesn't), but Gel X still goes to Mia.
  await db.query(
    `insert into appointments (staff_id, services, starts_at, ends_at, status)
     values ($1, $2, $3, $4, 'pending')`,
    [staffIds.Mia, ['Nails'], '2026-10-27T10:00:00-04', '2026-10-27T11:00:00-04']
  );
  const res = await requestAppointment(db, { staffId: null, startMin: 780, services: ['Gel X'] });
  assert.equal(res.staff_name, 'Mia');

  // With Mia taken at that time, Yoyo gets it rather than turning it away.
  const next = await requestAppointment(db, { staffId: null, startMin: 780, services: ['Gel X'], phone: '718-555-0199' });
  assert.equal(next.staff_name, 'Yoyo');
});

test('requires mapping', async () => {
  const { db } = await setup();

  const res = await requestAppointment(db, { services: ['$38 Bundle: Regular Mani + Pedi', 'Other'] });
  assert.equal(res.ok, true);
  assert.ok(['Mia', 'Yoyo', 'Carmela', 'Lili', 'Linda'].includes(res.staff_name));

  const unknown = await requestAppointment(db, { services: ['Not A Real Service'] });
  assert.deepEqual(unknown, { ok: false, reason: 'invalid' });
});

test('validation', async () => {
  const { db } = await setup();

  assert.deepEqual(await requestAppointment(db, { name: '' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { phone: '' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { email: 'not-an-email' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { services: [] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { name: 'A'.repeat(101) }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { notes: 'A'.repeat(1001) }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { day: null }), { ok: false, reason: 'invalid' });
});

test('phone needs at least 10 digits', async () => {
  const { db } = await setup();

  assert.deepEqual(await requestAppointment(db, { phone: '555-0100' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await requestAppointment(db, { phone: 'call me maybe' }), { ok: false, reason: 'invalid' });
  assert.equal((await requestAppointment(db, { phone: '(718) 555-0100' })).ok, true);
});

test('input length caps', async () => {
  const { db } = await setup();

  // phone <= 30 chars (31 chars here, with plenty of digits)
  assert.deepEqual(await requestAppointment(db, { phone: '7185550100 ext 12345678901234567' }), { ok: false, reason: 'invalid' });
  // email <= 254 chars
  const longEmail = `${'a'.repeat(243)}@example.com`; // 255 chars
  assert.equal(longEmail.length, 255);
  assert.deepEqual(await requestAppointment(db, { email: longEmail }), { ok: false, reason: 'invalid' });
  // services <= 10 entries
  assert.deepEqual(await requestAppointment(db, { services: Array(11).fill('Nails') }), { ok: false, reason: 'invalid' });
  // each service <= 100 chars
  assert.deepEqual(await requestAppointment(db, { services: ['N'.repeat(101)] }), { ok: false, reason: 'invalid' });

  // At the limits it's accepted.
  const ok = await requestAppointment(db, {
    phone: `718-555-0100${' '.repeat(18)}`, // 30 chars
    email: `${'a'.repeat(242)}@example.com`, // 254 chars
    services: Array(10).fill('Nails'),
  });
  assert.equal(ok.ok, true);
});

test('success returns ok and staff_name only, never the row id', async () => {
  const { db } = await setup();

  const res = await requestAppointment(db);
  assert.deepEqual(Object.keys(res).sort(), ['ok', 'staff_name']);
  assert.equal(res.ok, true);
});

test('per-phone cap', async () => {
  const { db } = await setup();

  await requestAppointment(db, { phone: '718-555-0100', startMin: 780 });
  await requestAppointment(db, { phone: '718-555-0100', startMin: 900 });
  await requestAppointment(db, { phone: '718-555-0100', startMin: 1020 });

  const fourth = await requestAppointment(db, { phone: '(718) 555 0100', startMin: 660 });
  assert.deepEqual(fourth, { ok: false, reason: 'too_many' });

  // A +1 country code can't be used to slip past the cap: the last 10
  // digits are what's compared.
  const withCountryCode = await requestAppointment(db, { phone: '+1 718 555 0100', startMin: 660 });
  assert.deepEqual(withCountryCode, { ok: false, reason: 'too_many' });

  // The cap is applied only once a provider has been found, so a slot that
  // is simply not available reports slot_taken (prompting a refetch).
  const unavailable = await requestAppointment(db, { phone: '718-555-0100', startMin: 1080 });
  assert.deepEqual(unavailable, { ok: false, reason: 'slot_taken' });

  // A different number is unaffected.
  const other = await requestAppointment(db, { phone: '718-555-0199', startMin: 660 });
  assert.equal(other.ok, true);
});

test('no preference falls through to the next candidate on an insert-time overlap', async () => {
  const { db, staffIds } = await setup();

  // Simulate a race: Mia looks free when candidates are chosen, but her
  // insert hits the exclusion constraint (someone else grabbed her first).
  await db.exec(`
    create function test_race() returns trigger language plpgsql as $$
    begin
      if new.staff_id = ${Number(staffIds.Mia)} and new.source = 'web' then
        raise exception 'simulated overlap' using errcode = 'exclusion_violation';
      end if;
      return new;
    end $$;
    create trigger test_race before insert on appointments
      for each row execute function test_race();
  `);

  const res = await requestAppointment(db, { staffId: null, startMin: 780 });
  assert.deepEqual(res, { ok: true, staff_name: 'Yoyo' });

  const pinned = await requestAppointment(db, { staffId: staffIds.Mia, startMin: 900 });
  assert.deepEqual(pinned, { ok: false, reason: 'slot_taken' });
});

test('double submit', async () => {
  const { db, staffIds } = await setup();

  const first = await requestAppointment(db, { staffId: staffIds.Mia, startMin: 780 });
  assert.equal(first.ok, true);

  const second = await requestAppointment(db, { staffId: staffIds.Mia, startMin: 780 });
  assert.deepEqual(second, { ok: false, reason: 'slot_taken' });
});

test('broadcast on change', async () => {
  const { db, staffIds } = await setup();

  const res = await requestAppointment(db, { staffId: staffIds.Mia, startMin: 780, day: '2026-10-27' });
  assert.equal(res.ok, true);

  await db.query(
    `update appointments set starts_at = $2, ends_at = $3 where id = $1`,
    [await latestId(db), '2026-10-28T14:00:00-04', '2026-10-28T15:00:00-04']
  );

  const { rows } = await db.query('select payload, event, topic, private from realtime.sent');
  const days = rows.map((r) => r.payload.day);
  assert.ok(days.includes('2026-10-27'));
  assert.ok(days.includes('2026-10-28'));
  for (const r of rows) {
    assert.equal(r.event, 'changed');
    assert.equal(r.topic, 'availability');
    assert.equal(r.private, false);
  }
});

test('anon can call both RPCs', async () => {
  const { db, staffIds } = await setup();

  await asRole(db, 'anon', async () => {
    const day = await publicDay(db);
    assert.equal(day.day, '2026-10-27');

    const res = await requestAppointment(db, { staffId: staffIds.Mia, startMin: 780 });
    assert.equal(res.ok, true);

    const { rows } = await db.query('select count(*) from appointments');
    assert.equal(Number(rows[0].count), 0);
  });
});

test('a customer can choose Yoyo for Gel X or UV Gel/Hard Gel even without the skill', async () => {
  const { db, staffIds } = await setup();
  for (const [service, startMin] of [['Gel X', 660], ['UV Gel/Hard Gel', 780]]) {
    const res = await requestAppointment(db, { services: [service], staffId: staffIds.Yoyo, startMin });
    assert.deepEqual(res, { ok: true, staff_name: 'Yoyo' }, service);
  }
});

test('UV Gel and Hard Gel are one service; the old names are gone', async () => {
  const db = await newDb();
  const { rows } = await db.query(
    "select name from services where name in ('UV Gel', 'Hard Gel', 'UV Gel/Hard Gel')"
  );
  assert.deepEqual(rows.map((r) => r.name), ['UV Gel/Hard Gel']);
  const skills = await db.query("select count(*) from staff_services where service in ('UV Gel', 'Hard Gel')");
  assert.equal(Number(skills.rows[0].count), 0);
});
