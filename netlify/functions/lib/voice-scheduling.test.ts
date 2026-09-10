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
  reconcileCallContactIdentity,
  resolveAuthoritativeOutcome,
} from './voice-call-audit.ts';
import { normalizeServiceTitle } from './voice-crm.ts';

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
    conversation_states: [],
    deals: [],
    projects: [],
  };
  seq = 0;
  queryCount = 0;                    // every FakeQuery.run() bumps this — latency guard
  failInsertAppointments = false;
  failUpdateAppointments = false;
  failSchedulingStateUpdate = false; // simulates a backend fault on the claim (e.g. table missing)
  failInsertToolAudit = false;       // simulates voice_call_tools insert failing
  failMarkResult = false;            // fail state updates that write resulting_appointment_id (simulate crash after insert)
  failAppointmentsRangeSelect = false; // fail appointments SELECTs that use a scheduled_at range (isSlotFree) -> fail-open path

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
    this.db.queryCount += 1;
    const rows = this.db.tables[this.table];
    if (!rows) return { data: null, error: { message: `no table ${this.table}` } };

    if (
      this.op === 'select' && this.table === 'appointments' && this.db.failAppointmentsRangeSelect &&
      this.filters.some((f) => f.kind === 'gte' && f.field === 'scheduled_at')
    ) {
      return { data: null, error: { code: 'XX000', message: 'simulated appointments range select failure' } };
    }

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
      if (
        this.table === 'voice_call_scheduling_state' && this.db.failMarkResult &&
        this.payload && Object.prototype.hasOwnProperty.call(this.payload, 'resulting_appointment_id') &&
        this.payload.resulting_appointment_id != null
      ) {
        return { data: null, error: { code: 'XX000', message: 'simulated crash after insert (markResult)' } };
      }
      // Enforce conversation_states unique (org_id, contact_id, channel):
      // re-pointing a row to a contact that already has one collides.
      if (this.table === 'conversation_states' && typeof this.payload?.contact_id === 'string') {
        const target = this.payload.contact_id;
        const collides = matched.some((m) =>
          rows.some((r) => r !== m && r.org_id === m.org_id && r.channel === m.channel && r.contact_id === target),
        );
        if (collides) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
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

// ── hot path stays minimal: no voice_calls / voice_call_id writes ──
test('book hot path does NOT touch voice_calls or set appointment.voice_call_id (linked at end-of-call instead)', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: null });
  const deps = makeDeps(db, NOW);
  const res = await handleBookAppointment(deps, {
    vapiCallId: CALL(), orgId: ORG, callerPhone: '+15551234567',
    args: { date: '2026-09-14', time: '10am', name: 'Jane Doe', service: 'kitchen remodel estimate' },
  });
  assert.equal(res.outcome, 'booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].voice_call_id, null, 'voice_call_id left null on the hot path');
  assert.equal(db.tables.voice_calls[0].contact_id, null, 'voice_calls untouched on the hot path');
  assert.equal(state(db, CALL())!.resulting_appointment_id, appts(db)[0].id, 'result recorded on the state row');
  // voice_call_id + voice_calls.outcome are linked by handleEndOfCallReport;
  // voice_calls.contact_id by reconcileCallContactIdentity — both in vapi-webhook.ts.
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

test('linkage: reconcileCallContactIdentity sets voice_calls.contact_id from scheduling state after save_lead', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: null });
  const deps = makeDeps(db, NOW);
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId: 'contact_42', leadId: 'lead_9' });

  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CALL(), voiceCallId: 'vc_1', tenantId: ORG, callerNumber: null });
  assert.equal(db.tables.voice_calls[0].contact_id, 'contact_42');
});

test('linkage: reconcileCallContactIdentity does nothing until save_lead has resolved a real contact', async () => {
  const db = new FakeDB();
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: null });
  // no persistLeadLinkage / no scheduling-state contact yet -> provisional identity stays
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CALL(), voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, null);
});

test('linkage: reconcileCallContactIdentity REPLACES a provisional caller-ID contact with the save_lead-resolved one', async () => {
  const db = new FakeDB();
  // provisional identity from caller ID = Ron Glaser
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CALL(), org_id: ORG, contact_id: 'ron_glaser' });
  const deps = makeDeps(db, NOW);
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId: 'michael_mister', leadId: null });

  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CALL(), voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'michael_mister');
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

// ═════════════════════════════════════════════
// LOCAL BOOKING PATH — the 5 exact cases for this pass
// (natural-language check_availability, then book_appointment({}))
// ═════════════════════════════════════════════

const SUN_SEP6 = new Date('2026-09-06T16:00:00.000Z'); // a Sunday — "Tuesday" must resolve forward to Sep 8

test('L1: check_availability("Tuesday","10am") then book_appointment({}) inserts the stored slot', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, SUN_SEP6);

  const chk = await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: 'Tuesday', time: '10am' });
  assert.equal(chk.outcome, 'slot_available');

  const st = state(db, CALL())!;
  assert.equal(st.availability_status, 'available');
  assert.equal(st.selected_slot_at, '2026-09-08T10:00:00.000Z'); // slot persisted by check_availability

  const book = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(book.ok, true);
  assert.equal(book.outcome, 'booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].scheduled_at, '2026-09-08T10:00:00.000Z');
  assert.equal(state(db, CALL())!.resulting_appointment_id, appts(db)[0].id);
});

test('L2: repeated book_appointment({}) after L1 makes no duplicate', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, SUN_SEP6);
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: 'Tuesday', time: '10am' });

  const first = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  const dupes = [];
  for (let i = 0; i < 5; i++) dupes.push(await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} }));

  assert.equal(appts(db).length, 1);
  assert.equal(first.outcome, 'booked');
  for (const d of dupes) {
    assert.equal(d.ok, true);
    assert.equal(d.outcome, 'already_booked');
    assert.equal(d.appointmentId, first.appointmentId);
  }
});

test('L3: book_appointment({}) with no prior check_availability => safe "check first" response, no insert', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, SUN_SEP6);
  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'missing_slot');
  assert.match(res.speech, /check_availability/);
  assert.doesNotMatch(res.speech, /you're all set|i booked/i);
  assert.equal(appts(db).length, 0);
});

test('L4: slot taken between check and book => conflict response, no insert', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, SUN_SEP6);
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: 'Tuesday', time: '10am' });

  // someone else books 2026-09-08 10:00 in the meantime
  seedAppointment(db, { scheduled_at: '2026-09-08T10:00:00.000Z' });

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'slot_taken');
  assert.doesNotMatch(res.speech, /you're all set|i booked/i);
  assert.equal(appts(db).length, 1); // only the intruder's
  assert.equal(state(db, CALL())!.availability_status, 'unavailable');
});

test('L5: DB insert failure => no success wording, no appointment, claim released', async () => {
  const db = new FakeDB();
  db.failInsertAppointments = true;
  const deps = makeDeps(db, SUN_SEP6);
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: 'Tuesday', time: '10am' });

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'write_failed');
  assert.doesNotMatch(res.speech, /you're all set|i booked|all booked|confirmed for/i);
  assert.equal(appts(db).length, 0);
  assert.equal(state(db, CALL())!.consumed_at, null); // released for a retry
});

// ═════════════════════════════════════════════
// LOOP FIX — book_appointment must not get stuck on "one moment"
// (a prior invocation timed out after claiming consumed_at but before
//  writing resulting_appointment_id -> every retry used to loop forever)
// ═════════════════════════════════════════════

function seedConfirmedState(db: FakeDB, over: Row = {}): Row {
  const row: Row = {
    vapi_call_id: CALL(), org_id: ORG,
    contact_id: 'contact_seed', lead_id: null, action_type: 'book',
    selected_date: 'Tuesday', selected_time: '10am', selected_timezone: 'UTC',
    selected_slot_at: '2026-09-08T10:00:00.000Z',
    availability_status: 'available',
    slot_checked_at: NOW.toISOString(),
    existing_appointment_id: null, consumed_at: null, resulting_appointment_id: null,
    ...over,
  };
  db.tables.voice_call_scheduling_state.push(row);
  db.tables.contacts.push({ id: 'contact_seed', org_id: ORG });
  return row;
}

test('loop-fix: a STALE claim (consumed_at old, no appointment) is reclaimed and the booking finishes', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  seedConfirmedState(db, { consumed_at: new Date(NOW.getTime() - 30_000).toISOString() }); // 30s ago, abandoned

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });

  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].scheduled_at, '2026-09-08T10:00:00.000Z');
  assert.equal(state(db, CALL())!.resulting_appointment_id, appts(db)[0].id);
});

test('loop-fix: a FRESH concurrent claim (consumed_at seconds ago) is NOT reclaimed — returns a bounded retry hint', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  seedConfirmedState(db, { consumed_at: new Date(NOW.getTime() - 2_000).toISOString() }); // 2s ago, genuinely in-flight

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });

  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'book_in_progress');
  assert.doesNotMatch(res.speech, /you're all set|i booked/i);
  assert.equal(appts(db).length, 0); // no double-book
});

test('loop-fix: once a stale claim IS resolved, a later retry returns already_booked (no duplicate)', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, NOW);
  seedConfirmedState(db, {
    consumed_at: new Date(NOW.getTime() - 30_000).toISOString(),
    resulting_appointment_id: 'appt_prior',
  });
  db.tables.appointments.push({ id: 'appt_prior', org_id: ORG, scheduled_at: '2026-09-08T10:00:00.000Z', status: 'scheduled' });

  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'already_booked');
  assert.equal(res.appointmentId, 'appt_prior');
  assert.equal(appts(db).length, 1);
});

test('latency guard: book_appointment({}) after save_lead + check does a small, bounded number of DB round-trips', async () => {
  const db = new FakeDB();
  const deps = makeDeps(db, SUN_SEP6);
  // realistic flow: save_lead linked the contact, then check_availability stored the slot
  await persistLeadLinkage(deps, { vapiCallId: CALL(), orgId: ORG, contactId: 'contact_1', leadId: 'lead_1' });
  await handleCheckAvailability(deps, { vapiCallId: CALL(), orgId: ORG, date: 'Tuesday', time: '10am' });

  db.queryCount = 0;
  const res = await handleBookAppointment(deps, { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(res.outcome, 'booked');
  // hot path: loadState, isSlotFree, claim, insert, markResult == 5.
  // The old path also did resolveVoiceCallRowId x2, an appointments redelivery
  // lookup and a voice_calls update — this guards against re-adding them.
  assert.ok(db.queryCount <= 6, `book hot path used ${db.queryCount} queries (expected <= 6)`);
});

// ═════════════════════════════════════════════
// DUPLICATE-SAFETY — stale reclaim must never insert a 2nd appointment
// Race: Request A claims -> inserts OK -> crashes BEFORE markResult.
//       Request B (20s+ later) sees stale claim + null result.
// ═════════════════════════════════════════════

test('dup-safety: insert succeeds, markResult fails, retry after stale timeout => exactly ONE appointment', async () => {
  const db = new FakeDB();
  seedConfirmedState(db, { consumed_at: null }); // fresh, ready to book

  // ── Request A: claim + insert succeed, markResult crashes ──
  db.failMarkResult = true;
  const resA = await handleBookAppointment(makeDeps(db, NOW), {
    vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {},
  });
  assert.equal(resA.outcome, 'booked');                         // A "succeeded" (markResult error swallowed)
  assert.equal(appts(db).length, 1);
  assert.equal(state(db, CALL())!.resulting_appointment_id, null); // never recorded
  assert.notEqual(state(db, CALL())!.consumed_at, null);           // claim is set -> B will see it "lost"

  // ── Request B: 31s later, retries book_appointment({}) ──
  db.failMarkResult = false;
  const resB = await handleBookAppointment(makeDeps(db, new Date(NOW.getTime() + 31_000)), {
    vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {},
  });

  assert.equal(appts(db).length, 1, 'exactly one appointment total — no duplicate from the reclaim path');
  assert.equal(resB.ok, true);
  assert.equal(resB.outcome, 'already_booked');
  assert.equal(resB.appointmentId, appts(db)[0].id);
  assert.equal(state(db, CALL())!.resulting_appointment_id, appts(db)[0].id, 'scheduling state repaired');
});

test('dup-safety: even when isSlotFree fails open, the stale-claim path still finds the prior booking (no duplicate)', async () => {
  const db = new FakeDB();
  seedConfirmedState(db, { consumed_at: null });

  db.failMarkResult = true;
  await handleBookAppointment(makeDeps(db, NOW), { vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {} });
  assert.equal(appts(db).length, 1);

  // Request B: isSlotFree's range query errors -> fails open -> B reaches the claim/reclaim path
  db.failMarkResult = false;
  db.failAppointmentsRangeSelect = true;
  const resB = await handleBookAppointment(makeDeps(db, new Date(NOW.getTime() + 31_000)), {
    vapiCallId: CALL(), orgId: ORG, callerPhone: null, args: {},
  });

  assert.equal(appts(db).length, 1, 'reclaim path checked appointments by (org,contact,slot,source) before reclaiming');
  assert.equal(resB.ok, true);
  assert.equal(resB.outcome, 'already_booked');
  assert.equal(resB.appointmentId, appts(db)[0].id);
});

// ═════════════════════════════════════════════
// IDENTITY SPLIT — caller ID != the contact the caller identifies as
// Inbound caller ID belongs to Ron Glaser; during the call save_lead
// resolves Michael Mister (a different SPOKEN phone). After save_lead the
// authoritative contact must be Michael on every Voice artifact, with
// nothing new left attached to Ron.
// ═════════════════════════════════════════════

test('identity-split: caller ID = Ron Glaser, save_lead resolves Michael Mister => all Voice artifacts follow Michael', async () => {
  const db = new FakeDB();
  const CID = CALL();

  db.tables.contacts.push({ id: 'ron', org_id: ORG, full_name: 'Ron Glaser', phone: '+19548718466' });
  db.tables.contacts.push({ id: 'michael', org_id: ORG, full_name: 'Michael Mister', phone: '5548728466' });
  // call-started wrote a voice_calls row keyed to the raw inbound caller ID,
  // contact_id still null (the Inbox would show it under Ron via caller_number)
  db.tables.voice_calls.push({
    id: 'vc_1', vapi_call_id: CID, org_id: ORG, tenant_id: ORG,
    caller_number: '+19548718466', contact_id: null,
  });
  // the caller had previously archived Ron's voice conversation
  db.tables.conversation_states.push({ id: 'cs_ron', org_id: ORG, contact_id: 'ron', channel: 'voice', is_archived: true });

  const deps = makeDeps(db, SUN_SEP6);

  // ── save_lead resolves Michael as the authoritative contact ──
  await persistLeadLinkage(deps, { vapiCallId: CID, orgId: ORG, contactId: 'michael', leadId: 'lead_m' });
  // handleToolCalls reconciles identity after every tool batch
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });

  // ── check_availability + book_appointment({}) ──
  await handleCheckAvailability(deps, { vapiCallId: CID, orgId: ORG, date: 'Tuesday', time: '10am' });
  const book = await handleBookAppointment(deps, { vapiCallId: CID, orgId: ORG, callerPhone: '+19548718466', args: {} });
  assert.equal(book.outcome, 'booked');

  // authoritative contact = Michael everywhere
  assert.equal(db.tables.voice_calls[0].contact_id, 'michael', 'voice_calls.contact_id = Michael (drives conversation identity + call-log name)');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].contact_id, 'michael', 'appointment.contact_id = Michael');

  // no Voice artifact left attached to Ron
  assert.equal(
    db.tables.conversation_states.filter((c) => c.channel === 'voice' && c.contact_id === 'ron').length,
    0, 'no voice conversation_states row still on Ron',
  );
  assert.equal(db.tables.conversation_states.find((c) => c.id === 'cs_ron')!.contact_id, 'michael', 'archive state moved to Michael');

  // end-of-call reconcile is idempotent
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'michael');
  assert.equal(appts(db).length, 1);
});

test('identity-split: outcome linkage after the identity move still resolves appointment_booked', async () => {
  const db = new FakeDB();
  const CID = CALL();
  db.tables.contacts.push({ id: 'michael', org_id: ORG, full_name: 'Michael Mister', phone: '5548728466' });
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CID, org_id: ORG, tenant_id: ORG, caller_number: '+19548718466', contact_id: null });
  const deps = makeDeps(db, SUN_SEP6);

  await persistLeadLinkage(deps, { vapiCallId: CID, orgId: ORG, contactId: 'michael', leadId: null });
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  await handleCheckAvailability(deps, { vapiCallId: CID, orgId: ORG, date: 'Tuesday', time: '10am' });
  await handleBookAppointment(deps, { vapiCallId: CID, orgId: ORG, callerPhone: '+19548718466', args: {} });

  const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
    voiceCallId: 'vc_1', vapiCallId: CID, tenantId: ORG, summaryOutcome: 'unknown',
  });
  assert.equal(outcome, 'appointment_booked');
});

// ═════════════════════════════════════════════
// TITLE NORMALIZATION — clean CRM project/service label
// ═════════════════════════════════════════════

test('normalizeServiceTitle: strips generic scheduling suffixes and cleans casing', () => {
  assert.equal(normalizeServiceTitle('full house renovation'), 'Full house renovation');
  assert.equal(normalizeServiceTitle('full house renovation estimate'), 'Full house renovation');
  assert.equal(normalizeServiceTitle('bathroom remodel'), 'Bathroom remodel');
  assert.equal(normalizeServiceTitle('kitchen renovation estimate'), 'Kitchen renovation');
  assert.equal(normalizeServiceTitle('roof replacement appointment'), 'Roof replacement');
  assert.equal(normalizeServiceTitle('roof replacement estimate'), 'Roof replacement');
  assert.equal(normalizeServiceTitle('window replacement consultation'), 'Window replacement');
  assert.equal(normalizeServiceTitle('  kitchen   remodel , free estimate '), 'Kitchen remodel');
  assert.equal(normalizeServiceTitle('FULL HOUSE RENOVATION'), 'Full house renovation');
  assert.equal(normalizeServiceTitle('Kitchen remodel for ADU'), 'Kitchen remodel for ADU'); // intentional mixed case preserved
  assert.equal(normalizeServiceTitle('estimate'), ''); // nothing but a suffix
  assert.equal(normalizeServiceTitle(''), '');
  assert.equal(normalizeServiceTitle(null), '');
  // does NOT strip a non-trailing occurrence / does not change category
  assert.equal(normalizeServiceTitle('estimate review service'), 'Estimate review service');
});

// ═════════════════════════════════════════════
// reconcile — conversation_states unique collision is handled safely
// ═════════════════════════════════════════════

test('identity-split: conversation_states unique collision => authoritative row preserved, provisional dropped, no crash', async () => {
  const db = new FakeDB();
  const CID = CALL();
  db.tables.contacts.push({ id: 'ron', org_id: ORG, full_name: 'Ron Glaser', phone: '+19548718466' });
  db.tables.contacts.push({ id: 'michael', org_id: ORG, full_name: 'Michael Mister', phone: '5548728466' });
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CID, org_id: ORG, tenant_id: ORG, caller_number: '+19548718466', contact_id: null });
  // BOTH contacts already have a voice conversation_states row
  db.tables.conversation_states.push({ id: 'cs_ron', org_id: ORG, contact_id: 'ron', channel: 'voice', is_archived: true });
  db.tables.conversation_states.push({ id: 'cs_michael', org_id: ORG, contact_id: 'michael', channel: 'voice', is_archived: false });

  const deps = makeDeps(db, SUN_SEP6);
  await persistLeadLinkage(deps, { vapiCallId: CID, orgId: ORG, contactId: 'michael', leadId: null });
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });

  assert.equal(db.tables.voice_calls[0].contact_id, 'michael');
  const voiceCs = db.tables.conversation_states.filter((c) => c.channel === 'voice');
  assert.equal(voiceCs.length, 1, 'exactly one voice conversation_states row remains');
  assert.equal(voiceCs[0].id, 'cs_michael', 'the authoritative row is preserved');
  assert.equal(voiceCs[0].is_archived, false, 'authoritative row unchanged');
  assert.equal(db.tables.conversation_states.some((c) => c.id === 'cs_ron'), false, 'provisional row dropped');
});

// ═════════════════════════════════════════════
// RUNTIME ORDERING — separate Vapi webhook invocations
// caller ID = Ron;  save_lead resolves Tony (different spoken phone).
// Reproduces the live failure: reconcile must make voice_calls.contact_id
// authoritative even when save_lead's own voice_calls update never landed
// and the end-of-call reconcile is the only thing that runs it.
// ═════════════════════════════════════════════

// Replays the end-of-call finalization ORDER used by handleEndOfCallReport:
// resolve appt -> link voice_call_id -> reconcile identity -> outcome.
async function replayEndOfCall(db: FakeDB, vapiCallId: string, callRowId: string, callerNumber: string) {
  const st = db.tables.voice_call_scheduling_state.find(
    (s) => s.vapi_call_id === vapiCallId && s.org_id === ORG,
  );
  let apptForCall: string | null = st?.resulting_appointment_id ?? null;
  if (!apptForCall && st?.contact_id) {
    const recent = db.tables.appointments
      .filter((a) => a.org_id === ORG && a.contact_id === st.contact_id && a.source === 'Voice AI' && a.status !== 'cancelled')
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    apptForCall = recent?.id ?? null;
  }
  if (apptForCall) {
    const a = db.tables.appointments.find((x) => x.id === apptForCall);
    if (a && a.voice_call_id == null) a.voice_call_id = callRowId;
    // mirror the webhook's post-creation appointment label normalization
    if (a) {
      const cs = normalizeServiceTitle(a.service ?? null);
      const ct = normalizeServiceTitle(a.title ?? null);
      if (cs && cs !== a.service) a.service = cs;
      if (ct && ct !== a.title) a.title = ct;
    }
  }
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId, voiceCallId: callRowId, tenantId: ORG, callerNumber });
  const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
    voiceCallId: callRowId, vapiCallId, tenantId: ORG,
    summaryOutcome: 'unknown', contactId: st?.contact_id ?? null,
  });
  const vc = db.tables.voice_calls.find((v) => v.id === callRowId);
  if (vc) vc.outcome = outcome;
  return { outcome, apptForCall };
}

test('runtime-order: 4 separate webhooks — Ron caller ID, Tony save_lead => Tony authoritative end-to-end', async () => {
  const db = new FakeDB();
  const CID = CALL();
  const nowIso = new Date().toISOString();

  db.tables.contacts.push({ id: 'ron', org_id: ORG, full_name: 'Ron Glaser', phone: '+19548718466' });
  db.tables.contacts.push({ id: 'tony', org_id: ORG, full_name: 'Tony Soprano', phone: '3548887171' });
  // call-started created the voice_calls row keyed to the raw caller ID (contact_id null / provisional)
  db.tables.voice_calls.push({
    id: 'vc_1', vapi_call_id: CID, org_id: ORG, tenant_id: ORG,
    caller_number: '+19548718466', contact_id: null, outcome: null,
  });

  // ── webhook 1: save_lead (its OWN voice_calls.update is simulated as NOT landing) ──
  const depsSL = makeDeps(db, SUN_SEP6);
  await persistLeadLinkage(depsSL, { vapiCallId: CID, orgId: ORG, contactId: 'tony', leadId: 'lead_t' });
  db.tables.leads.push({ id: 'lead_t', org_id: ORG, contact_id: 'tony', custom_fields: { service: 'Full kitchen remodel' } });
  // handleToolCalls bookkeeping now runs reconcile (fully awaited)
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'tony', 'reconcile healed contact_id during the save_lead batch');

  // ── webhook 2: check_availability ──
  await handleCheckAvailability(depsSL, { vapiCallId: CID, orgId: ORG, date: 'Tuesday', time: '10am' });
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'tony');

  // ── webhook 3: book_appointment({}) ──
  const book = await handleBookAppointment(depsSL, { vapiCallId: CID, orgId: ORG, callerPhone: '+19548718466', args: {} });
  assert.equal(book.outcome, 'booked');
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });

  // ── webhook 4: end-of-call-report ──
  const eoc = await replayEndOfCall(db, CID, 'vc_1', '+19548718466');

  assert.equal(db.tables.voice_calls[0].contact_id, 'tony', 'voice_calls.contact_id = Tony');
  assert.equal(eoc.outcome, 'appointment_booked', 'outcome from authoritative state');
  assert.equal(db.tables.voice_calls[0].outcome, 'appointment_booked');
  assert.equal(appts(db).length, 1);
  assert.equal(appts(db)[0].contact_id, 'tony', 'appointment contact = Tony');
  // Lead PROJECT column source = leads.custom_fields.service (see leads-store.ts)
  assert.equal(db.tables.leads[0].custom_fields.service, 'Full kitchen remodel', 'no "estimate" suffix in the Lead service field');
  assert.equal(db.tables.projects.length, 0, 'no Project auto-created');
});

test('runtime-order: outcome resolves appointment_booked from the contact fallback when voice_call_id + resulting_appointment_id never linked', async () => {
  const db = new FakeDB();
  const CID = CALL();
  db.tables.contacts.push({ id: 'tony', org_id: ORG, full_name: 'Tony Soprano', phone: '3548887171' });
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CID, org_id: ORG, tenant_id: ORG, caller_number: '+19548718466', contact_id: 'tony' });
  // scheduling state has NO resulting_appointment_id (book_appointment linkage lost)
  db.tables.voice_call_scheduling_state.push({ vapi_call_id: CID, org_id: ORG, contact_id: 'tony', lead_id: 'lead_t', resulting_appointment_id: null });
  // but a Voice appointment for Tony was created (voice_call_id null)
  db.tables.appointments.push({
    id: 'appt_x', org_id: ORG, contact_id: 'tony', source: 'Voice AI', status: 'scheduled',
    voice_call_id: null, scheduled_at: '2026-09-08T10:00:00.000Z', created_at: new Date().toISOString(),
  });

  const outcome = await resolveAuthoritativeOutcome(auditDeps(db), {
    voiceCallId: 'vc_1', vapiCallId: CID, tenantId: ORG, summaryOutcome: 'unknown', contactId: 'tony',
  });
  assert.equal(outcome, 'appointment_booked');
});

test('runtime-order: reconcile fixes a WRONG (Ron) voice_calls.contact_id set by a provisional path', async () => {
  const db = new FakeDB();
  const CID = CALL();
  db.tables.contacts.push({ id: 'ron', org_id: ORG, phone: '+19548718466' });
  db.tables.contacts.push({ id: 'tony', org_id: ORG, phone: '3548887171' });
  db.tables.voice_calls.push({ id: 'vc_1', vapi_call_id: CID, org_id: ORG, contact_id: 'ron' });
  const deps = makeDeps(db, SUN_SEP6);
  await persistLeadLinkage(deps, { vapiCallId: CID, orgId: ORG, contactId: 'tony', leadId: null });

  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'tony');

  // idempotent
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'tony');
});

// ═════════════════════════════════════════════
// LIVE SEQUENCE — Richard Cohen call (caller ID = Ron)
// separate save_lead / check_availability / book_appointment / end-of-call
// webhooks; book_appointment carried the raw model service.
// ═════════════════════════════════════════════

test('live-seq: Richard — identity, outcome, and all service labels end clean', async () => {
  const db = new FakeDB();
  const CID = CALL();

  db.tables.contacts.push({ id: 'ron', org_id: ORG, full_name: 'Ron Glaser', phone: '+19548718466' });
  db.tables.contacts.push({ id: 'richard', org_id: ORG, full_name: 'Richard Cohen', phone: '4125893443' });
  db.tables.voice_calls.push({
    id: 'vc_1', vapi_call_id: CID, org_id: ORG, tenant_id: ORG,
    caller_number: '+19548718466', contact_id: null, outcome: null,
  });
  // archived voice conversation state under the caller-ID contact
  db.tables.conversation_states.push({ id: 'cs_ron', org_id: ORG, contact_id: 'ron', channel: 'voice', is_archived: true });

  const deps = makeDeps(db, SUN_SEP6);

  // webhook 1: save_lead — toolSaveLead (post-fix) normalizes the service at the source
  const cleanService = normalizeServiceTitle('roof replacement estimate'); // == "Roof replacement"
  await persistLeadLinkage(deps, { vapiCallId: CID, orgId: ORG, contactId: 'richard', leadId: 'lead_r' });
  db.tables.leads.push({ id: 'lead_r', org_id: ORG, contact_id: 'richard', custom_fields: { service: cleanService } });
  db.tables.deals.push({ id: 'deal_r', org_id: ORG, lead_id: 'lead_r', contact_id: 'richard', title: cleanService, created_at: new Date().toISOString() });
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });
  assert.equal(db.tables.voice_calls[0].contact_id, 'richard', 'reconcile healed identity during save_lead batch');

  // webhook 2: check_availability
  await handleCheckAvailability(deps, { vapiCallId: CID, orgId: ORG, date: 'Tuesday', time: '10am' });
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });

  // webhook 3: book_appointment — model sent full args incl. the RAW service
  const book = await handleBookAppointment(deps, {
    vapiCallId: CID, orgId: ORG, callerPhone: '+19548718466',
    args: { date: 'Tuesday', time: '10am', service: 'roof replacement estimate', name: 'Richard Cohen' },
  });
  assert.equal(book.outcome, 'booked');
  assert.equal(appts(db)[0].service, 'roof replacement estimate', 'handleBookAppointment stores the raw string (untouched)');
  await reconcileCallContactIdentity(auditDeps(db), { vapiCallId: CID, voiceCallId: 'vc_1', tenantId: ORG, callerNumber: '+19548718466' });

  // webhook 4: end-of-call-report (replay: link appt, reconcile, normalize label, outcome)
  const eoc = await replayEndOfCall(db, CID, 'vc_1', '+19548718466');

  // identity
  assert.equal(db.tables.voice_calls[0].contact_id, 'richard', 'voice_calls.contact_id = Richard');
  assert.equal(db.tables.voice_calls[0].outcome, 'appointment_booked');
  assert.equal(eoc.outcome, 'appointment_booked');
  // Voice conversation resolves Richard (identity is voice_calls.contact_id)
  assert.equal(db.tables.conversation_states.some((c) => c.channel === 'voice' && c.contact_id === 'ron'), false, 'no Voice state remains on Ron');
  // service labels — every downstream record clean
  assert.equal(db.tables.leads[0].custom_fields.service, 'Roof replacement', 'lead service = "Roof replacement"');
  assert.equal(db.tables.deals[0].title, 'Roof replacement', 'deal title = "Roof replacement"');
  assert.equal(appts(db)[0].service, 'Roof replacement', 'appointment service normalized at end-of-call');
  assert.equal(appts(db)[0].title, 'Roof replacement', 'appointment title normalized at end-of-call');
  // one appointment, no project
  assert.equal(appts(db).length, 1);
  assert.equal(db.tables.projects.length, 0, 'no Project auto-created');
});
