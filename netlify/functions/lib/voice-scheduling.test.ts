// netlify/functions/lib/voice-scheduling.test.ts
//
// Run:  node --test netlify/functions/lib/voice-scheduling.test.ts
// (Node 20.6+/22/24 — native TypeScript type-stripping + built-in test runner.
//  No dependencies, no DB — the Supabase client is an in-memory fake.)
//
// Covers the 10 scenarios from the rebuild spec:
//   1  new booking with full args
//   2  new booking with book_appointment({})
//   3  book_appointment fired 7x -> one appointment
//   4  caller changes slot before confirmation
//   5  slot taken between check and commit
//   6  reschedule an existing appointment
//   7  reschedule with no matching appointment
//   8  reschedule with multiple matches (then disambiguated)
//   9  repeated reschedule calls
//   10 DB write failure never produces a verbal success

process.env.TZ = 'UTC'; // deterministic date parsing regardless of host tz

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleCheckAvailability,
  handleBookAppointment,
  handleRescheduleAppointment,
  persistLeadLinkage,
  parseNaturalDate,
  type SchedulingDeps,
} from './voice-scheduling.ts';
import {
  resolveVoiceCallId,
  recordToolInvocations,
  backfillCallContact,
  resolveAuthoritativeOutcome,
} from './voice-call-audit.ts';

// ─────────────────────────────────────────────
// In-memory fake Supabase
// ─────────────────────────────────────────────

type Row = Record<string, any>;

class FakeDB {
  tables: Record<string, Row[]> = {
    voice_call_scheduling_state: [],
    appointments: [],
    contacts: [],
    leads: [],
    voice_calls: [],
    voice_call_tools: [],
  };
  seq = 0;
  failInsertAppointments = false;
  failUpdateAppointments = false;
  failSchedulingStateUpdate = false; // simulates a backend fault on the claim (e.g. table missing)
  failInsertToolAudit = false;       // simulates voice_call_tools insert failing

  id(prefix: string) {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }
}

class FakeQuery {
  private filters: Array<{ kind: string; field: string; value: any }> = [];
  private op: 'select' | 'update' | 'insert' | 'upsert' | 'delete' = 'select';
  private payload: any = null;
  private onConflict: string[] = [];
  private orderBy: { field: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private db: FakeDB;
  private table: string;

  constructor(db: FakeDB, table: string) {
    this.db = db;
    this.table = table;
  }

  select(_cols?: string) { return this; }
  eq(field: string, value: any) { this.filters.push({ kind: 'eq', field, value }); return this; }
  neq(field: string, value: any) { this.filters.push({ kind: 'neq', field, value }); return this; }
  gte(field: string, value: any) { this.filters.push({ kind: 'gte', field, value }); return this; }
  gt(field: string, value: any) { this.filters.push({ kind: 'gt', field, value }); return this; }
  lt(field: string, value: any) { this.filters.push({ kind: 'lt', field, value }); return this; }
  is(field: string, value: any) { this.filters.push({ kind: 'is', field, value }); return this; }
  in(field: string, value: any[]) { this.filters.push({ kind: 'in', field, value }); return this; }
  order(field: string, opts?: { ascending?: boolean }) { this.orderBy = { field, asc: opts?.ascending !== false }; return this; }
  limit(n: number) { this.limitN = n; return this; }

  update(patch: Row) { this.op = 'update'; this.payload = patch; return this; }
  insert(row: Row) { this.op = 'insert'; this.payload = row; return this; }
  delete() { this.op = 'delete'; return this; }
  upsert(row: Row, opts?: { onConflict?: string }) {
    this.op = 'upsert';
    this.payload = row;
    this.onConflict = (opts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const v = row[f.field];
      switch (f.kind) {
        case 'eq': return v === f.value;
        case 'neq': return v !== f.value;
        case 'is': return v === f.value || (f.value === null && (v === null || v === undefined));
        case 'gte': return v >= f.value;
        case 'gt': return v > f.value;
        case 'lt': return v < f.value;
        case 'in': return (f.value as any[]).includes(v);
        default: return true;
      }
    });
  }

  private run(): { data: any; error: any } {
    const rows = this.db.tables[this.table];
    if (!rows) return { data: null, error: { message: `no table ${this.table}` } };

    if (this.op === 'insert') {
      if (this.table === 'appointments' && this.db.failInsertAppointments) {
        return { data: null, error: { code: 'XX000', message: 'simulated insert failure' } };
      }
      if (this.table === 'voice_call_tools' && this.db.failInsertToolAudit) {
        return { data: null, error: { code: 'XX000', message: 'simulated voice_call_tools failure' } };
      }
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = incoming.map((p: Row) => {
        const row = { ...p };
        if (!row.id) row.id = this.db.id(this.table.slice(0, 4));
        if (!row.created_at) row.created_at = new Date().toISOString();
        rows.push(row);
        return { ...row };
      });
      return { data: Array.isArray(this.payload) ? inserted : inserted[0], error: null };
    }

    if (this.op === 'upsert') {
      const key = this.onConflict.length ? this.onConflict : Object.keys(this.payload);
      const existing = rows.find((r) => key.every((k) => r[k] === this.payload[k]));
      if (existing) {
        Object.assign(existing, this.payload);
        return { data: { ...existing }, error: null };
      }
      const row = { ...this.payload };
      if (!row.id) row.id = this.db.id(this.table.slice(0, 4));
      if (!row.created_at) row.created_at = new Date().toISOString();
      rows.push(row);
      return { data: { ...row }, error: null };
    }

    let matched = rows.filter((r) => this.matches(r));

    if (this.op === 'update') {
      if (this.table === 'appointments' && this.db.failUpdateAppointments) {
        return { data: null, error: { code: 'XX000', message: 'simulated update failure' } };
      }
      if (this.table === 'voice_call_scheduling_state' && this.db.failSchedulingStateUpdate) {
        return { data: null, error: { code: '42P01', message: 'relation "voice_call_scheduling_state" does not exist' } };
      }
      matched.forEach((r) => Object.assign(r, this.payload));
      return { data: matched.map((r) => ({ ...r })), error: null };
    }

    if (this.op === 'delete') {
      this.db.tables[this.table] = rows.filter((r) => !this.matches(r));
      return { data: null, error: null };
    }

    // select
    if (this.orderBy) {
      const { field, asc } = this.orderBy;
      matched = [...matched].sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.limitN != null) matched = matched.slice(0, this.limitN);
    return { data: matched.map((r) => ({ ...r })), error: null };
  }

  maybeSingle() { const { data, error } = this.run(); return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error }); }
  single() { const { data, error } = this.run(); return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error }); }
  then(resolve: (v: { data: any; error: any }) => void) { const { data, error } = this.run(); resolve({ data: Array.isArray(data) ? data : data, error }); }
}

function makeDeps(db: FakeDB, now: Date): SchedulingDeps {
  return {
    supabase: { from: (t: string) => new FakeQuery(db, t) } as any,
    getOrgTimezone: async () => 'UTC',
    upsertContact: async () => {
      const id = db.id('contact');
      db.tables.contacts.push({ id, org_id: ORG });
      return id;
    },
    now: () => now,
  };
}

const ORG = 'org_1';
const NOW = new Date('2026-09-07T12:00:00.000Z');
const CALL = (n = 1) => `vapi_call_${n}`;

function seedAppointment(db: FakeDB, over: Row = {}): Row {
  const row: Row = {
    id: db.id('appt'),
    org_id: ORG,
    contact_id: null,
    scheduled_at: '2026-09-14T10:00:00.000Z',
    ends_at: '2026-09-14T11:00:00.000Z',
    duration_min: 60,
    time_zone: 'UTC',
    status: 'scheduled',
    source: 'Voice AI',
    voice_call_id: null,
    ...over,
  };
  db.tables.appointments.push(row);
  return row;
}

const appts = (db: FakeDB) => db.tables.appointments.filter((a) => a.status !== 'cancelled');
const state = (db: FakeDB, call: string) =>
  db.tables.voice_call_scheduling_state.find((s) => s.vapi_call_id === call && s.org_id === ORG);
const auditDeps = (db: FakeDB) => ({ supabase: { from: (t: string) => new FakeQuery(db, t) } as any, now: () => NOW });
const toolRows = (db: FakeDB) => db.tables.voice_call_tools;

// ─────────────────────────────────────────────
// 1 — new booking with full args
// ─────────────────────────────────────────────
test('1: new booking with full args creates exactly one appointment', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const res = await handleBookAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: '+15551234567',
    args: { date: '2026-09-14', time: '10am', name: 'Jane Doe', service: 'kitchen remodel estimate' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].scheduled_at, '2026-09-14T10:00:00.000Z');
  assert.match(res.speech, /all set/i);
  assert.equal(state(db, CALL())!.consumed_at != null, true);
  assert.equal(state(db, CALL())!.resulting_appointment_id, appts(db)[0].id);
});

// ─────────────────────────────────────────────
// 2 — new booking with book_appointment({})
// ─────────────────────────────────────────────
test('2: book_appointment({}) uses the last confirmed check_availability slot', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const chk = await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-14', time: '10am' });
  assert.equal(chk.outcome, 'slot_available');

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].scheduled_at, '2026-09-14T10:00:00.000Z');
});

// ─────────────────────────────────────────────
// 3 — book_appointment fired 7 times
// ─────────────────────────────────────────────
test('3: book_appointment fired 7x creates one appointment, rest return already-booked', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const args = { date: '2026-09-14', time: '10am', name: 'Repeat Caller' };
  const results = [];
  for (let i = 0; i < 7; i++) {
    results.push(await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args }));
  }
  assert.equal(appts(db).length, 1);
  assert.equal(results[0].outcome, 'booked');
  for (let i = 1; i < 7; i++) {
    assert.equal(results[i].ok, true, `call ${i} ok`);
    assert.equal(results[i].outcome, 'already_booked', `call ${i} outcome`);
    assert.equal(results[i].appointmentId, results[0].appointmentId);
    assert.doesNotMatch(results[i].speech, /\berror\b/i);
  }
});

// ─────────────────────────────────────────────
// 4 — caller changes slot before confirmation
// ─────────────────────────────────────────────
test('4: newest successful check wins — caller moves 10am -> 11am', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-14', time: '10am' });
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-14', time: '11am' });

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.outcome, 'booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].scheduled_at, '2026-09-14T11:00:00.000Z');
});

// ─────────────────────────────────────────────
// 5 — slot taken between check and commit
// ─────────────────────────────────────────────
test('5: slot taken after check -> no write, model told to pick another time', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-14', time: '10am' });

  // someone else books 10:00 in the meantime
  seedAppointment(db, { scheduled_at: '2026-09-14T10:00:00.000Z' });

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'slot_taken');
  assert.equal(appts(db).length, 1); // only the intruder's
  assert.equal(state(db, CALL())!.availability_status, 'unavailable');
  assert.equal(state(db, CALL())!.selected_slot_at, null);
});

// ─────────────────────────────────────────────
// 6 — reschedule an existing appointment
// ─────────────────────────────────────────────
test('6: reschedule moves the existing appointment, no second row', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const contactId = 'contact_seed';
  db.tables.contacts.push({ id: contactId, org_id: ORG });
  const appt = seedAppointment(db, { contact_id: contactId, scheduled_at: '2026-09-14T10:00:00.000Z' });
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId, leadId: null });

  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-15', time: '2pm' });
  const res = await handleRescheduleAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });

  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'rescheduled');
  assert.equal(res.appointmentId, appt.id);
  assert.equal(appts(db).length, 1);
  assert.equal(db.tables.appointments[0].scheduled_at, '2026-09-15T14:00:00.000Z');
});

// ─────────────────────────────────────────────
// 7 — reschedule with no matching appointment
// ─────────────────────────────────────────────
test('7: reschedule with no upcoming appointment reports no_appointment', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const contactId = 'contact_seed';
  db.tables.contacts.push({ id: contactId, org_id: ORG });
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId, leadId: null });
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-15', time: '2pm' });

  const res = await handleRescheduleAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'no_appointment');
  assert.equal(appts(db).length, 0);
});

// ─────────────────────────────────────────────
// 8 — reschedule with multiple matches, then disambiguated
// ─────────────────────────────────────────────
test('8: multiple upcoming appointments -> ask to clarify, then current_date resolves it', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const contactId = 'contact_seed';
  db.tables.contacts.push({ id: contactId, org_id: ORG });
  const a1 = seedAppointment(db, { contact_id: contactId, scheduled_at: '2026-09-14T10:00:00.000Z' });
  seedAppointment(db, { contact_id: contactId, scheduled_at: '2026-09-18T15:00:00.000Z' });
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId, leadId: null });
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-20', time: '9am' });

  const ambiguous = await handleRescheduleAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.outcome, 'ambiguous_appointment');
  assert.equal(appts(db).length, 2);

  const resolved = await handleRescheduleAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: { current_date: '2026-09-14' },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.outcome, 'rescheduled');
  assert.equal(resolved.appointmentId, a1.id);
  assert.equal(appts(db).length, 2);
  assert.equal(db.tables.appointments.find((a) => a.id === a1.id)!.scheduled_at, '2026-09-20T09:00:00.000Z');
});

// ─────────────────────────────────────────────
// 9 — repeated reschedule calls
// ─────────────────────────────────────────────
test('9: repeated reschedule for the same transition returns already-rescheduled', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const contactId = 'contact_seed';
  db.tables.contacts.push({ id: contactId, org_id: ORG });
  const appt = seedAppointment(db, { contact_id: contactId, scheduled_at: '2026-09-14T10:00:00.000Z' });
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId, leadId: null });
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-15', time: '2pm' });

  const first = await handleRescheduleAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(first.outcome, 'rescheduled');

  for (let i = 0; i < 5; i++) {
    const again = await handleRescheduleAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
    assert.equal(again.ok, true);
    assert.equal(again.outcome, 'already_rescheduled');
    assert.equal(again.appointmentId, appt.id);
  }
  assert.equal(appts(db).length, 1);
  assert.equal(db.tables.appointments[0].scheduled_at, '2026-09-15T14:00:00.000Z');
});

// ─────────────────────────────────────────────
// 10 — DB write failure never produces a verbal success
// ─────────────────────────────────────────────
test('10a: book DB insert failure -> actionable failure, no success wording, claim released', async () => {
  const db = new FakeDB();
  db.failInsertAppointments = true;
  const deps = makeDeps(db, NOW);
  const res = await handleBookAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: null,
    args: { date: '2026-09-14', time: '10am', name: 'Jane' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'write_failed');
  assert.doesNotMatch(res.speech, /you're all set|i booked|it's booked|confirmed for/i);
  assert.equal(appts(db).length, 0);
  assert.equal(state(db, CALL())!.consumed_at, null); // released for a retry
  assert.equal(state(db, CALL())!.resulting_appointment_id, null);
});

test('10b: reschedule DB update failure -> actionable failure, no success wording', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const contactId = 'contact_seed';
  db.tables.contacts.push({ id: contactId, org_id: ORG });
  seedAppointment(db, { contact_id: contactId, scheduled_at: '2026-09-14T10:00:00.000Z' });
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId, leadId: null });
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-15', time: '2pm' });

  db.failUpdateAppointments = true;
  const res = await handleRescheduleAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'write_failed');
  assert.doesNotMatch(res.speech, /done\.|i moved your|it's moved|rescheduled to/i);
  assert.equal(db.tables.appointments[0].scheduled_at, '2026-09-14T10:00:00.000Z'); // unchanged
});

// ─────────────────────────────────────────────
// bonus — missing slot with no prior check is actionable, not a crash
// ─────────────────────────────────────────────
test('bonus: book_appointment({}) with no prior check asks the model to check first', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'missing_slot');
  assert.match(res.speech, /check_availability/);
  assert.equal(appts(db).length, 0);
});

// ═════════════════════════════════════════════
// REGRESSION — defects found on the Sep 5 2026 test call
// ═════════════════════════════════════════════

const SAT_SEP5   = new Date('2026-09-05T20:19:00.000Z'); // Saturday ~4:19pm ET — the real test-call time
const TUE_SEP8_1PM = new Date('2026-09-08T13:00:00.000Z'); // a Tuesday, 1:00pm UTC
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'null');

// ── weekday parsing ──────────────────────────
test('parse: Saturday Sep 5 + "Tuesday" => coming Tuesday Sep 8', () => {
  assert.equal(ymd(parseNaturalDate('Tuesday', SAT_SEP5)), '2026-09-08');
  assert.equal(ymd(parseNaturalDate('tuesday', SAT_SEP5)), '2026-09-08');
});

test('parse: "next Tuesday" from Saturday also resolves to the COMING Tuesday (not +1 week)', () => {
  // The Sep 5 call: caller said "Tuesday", the model passed "next Tuesday",
  // and the old parser returned Sep 15. Collapsed now.
  assert.equal(ymd(parseNaturalDate('next Tuesday', SAT_SEP5)), '2026-09-08');
  assert.equal(ymd(parseNaturalDate('this Tuesday', SAT_SEP5)), '2026-09-08');
});

test('parse: today IS Tuesday, requested time still ahead + "Tuesday" => same day', () => {
  // 3pm requested, now 1pm -> today
  assert.equal(ymd(parseNaturalDate('Tuesday', TUE_SEP8_1PM, 15 * 60)), '2026-09-08');
});

test('parse: today IS Tuesday, requested time already passed + "Tuesday" => following Tuesday', () => {
  // 9am requested, now 1pm -> next week
  assert.equal(ymd(parseNaturalDate('Tuesday', TUE_SEP8_1PM, 9 * 60)), '2026-09-15');
});

test('parse: "the week after next Tuesday" from Saturday => the Tuesday after the coming one (Sep 15)', () => {
  assert.equal(ymd(parseNaturalDate('the week after next Tuesday', SAT_SEP5)), '2026-09-15');
  assert.equal(ymd(parseNaturalDate('Tuesday in two weeks', SAT_SEP5)), '2026-09-15');
});

// ── month/day with no year ───────────────────
test('parse: "September 8" (no year) => Sep 8 of the current year, NOT 2001', () => {
  assert.equal(ymd(parseNaturalDate('September 8', SAT_SEP5)), '2026-09-08');
  assert.equal(ymd(parseNaturalDate('Sep 8', SAT_SEP5)), '2026-09-08');
});

test('parse: explicit "September 8, 2026" stays 2026-09-08', () => {
  assert.equal(ymd(parseNaturalDate('September 8, 2026', SAT_SEP5)), '2026-09-08');
  assert.equal(ymd(parseNaturalDate('2026-09-08', SAT_SEP5)), '2026-09-08');
});

// ── past-slot guard ──────────────────────────
test('check_availability rejects a past date and stores nothing usable', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW); // now = 2026-09-07
  const res = await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-01', time: '10am' });
  assert.equal(res.outcome, 'slot_unavailable');
  assert.match(res.speech, /past/i);
  assert.equal(state(db, CALL())!.availability_status, 'unavailable');
  assert.equal(state(db, CALL())!.selected_slot_at, null);

  const book = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(book.ok, false);
  assert.equal(book.outcome, 'missing_slot');
  assert.equal(appts(db).length, 0);
});

test('book_appointment refuses a year-2001 / past-dated slot passed as explicit args', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  const res = await handleBookAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: null,
    args: { date: '2001-09-08', time: '10am', name: 'Jane' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'slot_in_past');
  assert.doesNotMatch(res.speech, /you're all set|i booked/i);
  assert.equal(appts(db).length, 0);
});

// ── voice_calls linkage after a successful booking ──
test('successful booking links voice_calls.contact_id and appointment.voice_call_id', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: null });
  const deps = makeDeps(db, NOW);
  const res = await handleBookAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: '+15551234567',
    args: { date: '2026-09-14', time: '10am', name: 'Jane Doe', service: 'kitchen remodel estimate' },
  });
  assert.equal(res.outcome, 'booked');
  assert.equal(db.tables.voice_calls[0].contact_id != null, true, 'voice_calls.contact_id linked');
  assert.equal(appts(db)[0].voice_call_id, 'vc_1', 'appointment.voice_call_id linked');
  // NOTE: voice_calls.outcome ("Appointment Booked") is written by
  // handleEndOfCallReport in vapi-webhook.ts, not by this module.
});

// ── backend fault on the claim must never read as success ──
test('scheduling-state claim backend fault -> write_failed, never a verbal success', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: '2026-09-14', time: '10am' });

  db.failSchedulingStateUpdate = true; // e.g. migration 20260911 not applied
  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });

  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'write_failed');
  assert.doesNotMatch(res.speech, /you're all set|i booked|all booked|confirmed for/i);
  assert.match(res.speech, /not booked/i);
  assert.equal(appts(db).length, 0);
});

// ═════════════════════════════════════════════
// PLUMBING — voice_call_tools audit / contact linkage / outcome
// (recent calls had zero voice_call_tools rows because the audit insert
//  was a fire-and-forget IIFE that Netlify froze on response)
// ═════════════════════════════════════════════

test('audit: resolveVoiceCallId returns the existing internal id', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_real', vapi_call_id: CALL(), org_id: ORG });
  const id = await resolveVoiceCallId(auditDeps(db), { vapiCallId: CALL(), tenantId: ORG });
  assert.equal(id, 'vc_real');
});

test('audit: resolveVoiceCallId creates a minimal row when call-started has not landed', async () => {
  const db = new FakeDB();
  const id = await resolveVoiceCallId(auditDeps(db), { vapiCallId: CALL(), tenantId: ORG, callerNumber: '+15551230000' });
  assert.equal(typeof id, 'string');
  assert.equal(db.tables.voice_calls.length, 1);
  assert.equal(db.tables.voice_calls[0].vapi_call_id, CALL());
});

test('audit: every tool call writes a voice_call_tools row keyed by the same voice_calls.id', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG });
  const id = await resolveVoiceCallId(auditDeps(db), { vapiCallId: CALL(), tenantId: ORG });
  const { written } = await recordToolInvocations(auditDeps(db), {
    voiceCallId: id, tenantId: ORG,
    entries: [
      { toolName: 'save_lead', args: { name: 'x' }, resultText: 'Got it', errorMsg: null },
      { toolName: 'check_availability', args: { date: 'Tuesday' }, resultText: 'available', errorMsg: null },
      { toolName: 'book_appointment', args: {}, resultText: "You're all set", errorMsg: null },
    ],
  });
  assert.equal(written, 3);
  assert.equal(toolRows(db).length, 3);
  assert.deepEqual([...new Set(toolRows(db).map((r) => r.call_id))], ['vc_1']);
  assert.equal(toolRows(db).find((r) => r.tool_name === 'book_appointment')!.result.text, "You're all set");
});

test('audit: a voice_call_tools insert failure is swallowed (never blocks the transaction)', async () => {
  const db = new FakeDB();
  db.failInsertToolAudit = true;
  const { written } = await recordToolInvocations(auditDeps(db), {
    voiceCallId: 'vc_1', tenantId: ORG,
    entries: [{ toolName: 'save_lead', args: {}, resultText: 'ok', errorMsg: null }],
  });
  assert.equal(written, 0);
  assert.equal(toolRows(db).length, 0); // logged, not thrown
});

test('audit: failed tool call is recorded with its error text', async () => {
  const db = new FakeDB();
  const { written } = await recordToolInvocations(auditDeps(db), {
    voiceCallId: 'vc_1', tenantId: ORG,
    entries: [{ toolName: 'book_appointment', args: {}, resultText: 'it is NOT booked', errorMsg: 'insert failed 42P01' }],
  });
  assert.equal(written, 1);
  assert.equal(toolRows(db)[0].error, 'insert failed 42P01');
  assert.equal(toolRows(db)[0].result.text, 'it is NOT booked');
});

test('linkage: backfillCallContact sets voice_calls.contact_id from scheduling state after save_lead', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: null });
  const deps = makeDeps(db, NOW);
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId: 'contact_42', leadId: 'lead_9' });

  await backfillCallContact(auditDeps(db), { vapiCallId: CALL(), voiceCallId: 'vc_1', tenantId: ORG });
  assert.equal(db.tables.voice_calls[0].contact_id, 'contact_42');
});

test('linkage: backfillCallContact leaves an already-linked contact_id untouched', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: 'contact_original' });
  const deps = makeDeps(db, NOW);
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId: 'contact_new', leadId: null });
  await backfillCallContact(auditDeps(db), { vapiCallId: CALL(), voiceCallId: 'vc_1', tenantId: ORG });
  assert.equal(db.tables.voice_calls[0].contact_id, 'contact_original');
});

test('outcome: successful booking => resolveAuthoritativeOutcome returns appointment_booked (overriding summary)', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG });
  const deps = makeDeps(db, NOW);
  const book = await handleBookAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: '+15551234567',
    args: { date: '2026-09-14', time: '10am', name: 'Jane Doe' },
  });
  assert.equal(book.outcome, 'booked');

  const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
    voiceCallId: 'vc_1', vapiCallId: CALL(), tenantId: ORG, summaryOutcome: 'unknown',
  });
  assert.equal(outcome, 'appointment_booked');
});

test('outcome: no appointment => resolveAuthoritativeOutcome falls back to the summary classification', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG });
  const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
    voiceCallId: 'vc_1', vapiCallId: CALL(), tenantId: ORG, summaryOutcome: 'unknown',
  });
  assert.equal(outcome, 'unknown');
});

test('outcome: appointment linked only via scheduling-state resulting_appointment_id still => appointment_booked', async () => {
  const db = new FakeDB();
  db.tables.voice_call_scheduling_state.push({
    vapi_call_id: CALL(), org_id: ORG, resulting_appointment_id: 'appt_x', consumed_at: NOW.toISOString(),
  });
  const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
    voiceCallId: 'vc_1', vapiCallId: CALL(), tenantId: ORG, summaryOutcome: 'lead_captured',
  });
  assert.equal(outcome, 'appointment_booked');
});

test('end-to-end plumbing: book -> audit success row -> outcome appointment_booked; failed book -> audit failure row -> not booked', async () => {
  // success
  {
    const db = new FakeDB();
    db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG });
    const deps = makeDeps(db, NOW);
    const vcId = await resolveVoiceCallId(auditDeps(db), { vapiCallId: CALL(), tenantId: ORG });
    const res = await handleBookAppointment(deps, {
      vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: { date: '2026-09-14', time: '10am', name: 'A' },
    });
    await recordToolInvocations(auditDeps(db), {
      voiceCallId: vcId, tenantId: ORG,
      entries: [{ toolName: 'book_appointment', args: {}, resultText: res.speech, errorMsg: res.ok ? null : 'x' }],
    });
    assert.equal(appts(db).length, 1);
    assert.equal(toolRows(db).length, 1);
    assert.equal(toolRows(db)[0].error, null);
    const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
      voiceCallId: 'vc_1', vapiCallId: CALL(), tenantId: ORG, summaryOutcome: 'unknown',
    });
    assert.equal(outcome, 'appointment_booked');
  }
  // failure
  {
    const db = new FakeDB();
    db.failInsertAppointments = true;
    db.tables.voice_calls.push({ id: 'vc_2', vapi_call_id: CALL(), org_id: ORG });
    const deps = makeDeps(db, NOW);
    const res = await handleBookAppointment(deps, {
      vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: { date: '2026-09-14', time: '10am', name: 'B' },
    });
    await recordToolInvocations(auditDeps(db), {
      voiceCallId: 'vc_2', tenantId: ORG,
      entries: [{ toolName: 'book_appointment', args: {}, resultText: res.speech, errorMsg: res.ok ? null : 'insert failed' }],
    });
    assert.equal(res.ok, false);
    assert.equal(appts(db).length, 0);
    assert.equal(toolRows(db)[0].error, 'insert failed');
    const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
      voiceCallId: 'vc_2', vapiCallId: CALL(), tenantId: ORG, summaryOutcome: 'unknown',
    });
    assert.notEqual(outcome, 'appointment_booked');
  }
});
