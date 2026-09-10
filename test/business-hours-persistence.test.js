const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException } = require('@nestjs/common');
const { Types } = require('mongoose');
const { RestaurantsService } = require('../dist/restaurants/restaurants.service');

const week = () => Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: false, periods: [] }));
const query = (value) => ({ select() { return this; }, lean: async () => value });

function harness(existing = null, legacy = null) {
  const restaurantId = new Types.ObjectId().toHexString();
  const stored = existing;
  const calls = { creates: 0, saves: 0, audits: 0, legacyUpdates: 0 };
  const settings = {
    collection: {
      findOne: async () => legacy,
      updateOne: async () => { calls.legacyUpdates += 1; },
    },
    findOne: async () => stored,
    findById: async () => legacy ? document(legacy.openingHours || [], calls) : null,
    create: async ({ openingHours }) => { calls.creates += 1; return document(openingHours, calls); },
  };
  const restaurants = {
    exists: async ({ _id }) => _id.toString() === restaurantId,
    findById: () => query({ timezone: 'America/Sao_Paulo' }),
  };
  const service = new RestaurantsService(restaurants, settings, {}, { create: async () => { calls.audits += 1; } }, {}, {});
  return { service, restaurantId, calls };
}
function document(openingHours, calls) { return { openingHours, async save() { calls.saves += 1; } }; }

test('creates settings on the first merchant save and persists seven days', async () => {
  const { service, restaurantId, calls } = harness();
  const days = week(); days[2] = { dayOfWeek: 2, isOpen: true, periods: [{ openTime: '08:00', closeTime: '18:00' }] };
  const result = await service.updateBusinessHours(restaurantId, days, new Types.ObjectId().toHexString(), false);
  assert.equal(calls.creates, 1); assert.equal(calls.audits, 0); assert.equal(result.days.length, 7); assert.deepEqual(result.days[2], days[2]);
});

test('updates existing settings and supports all closed, multiple, and overnight periods', async () => {
  const calls = { saves: 0 }; const current = document([], calls); const { service, restaurantId } = harness(current);
  let days = week(); await service.updateBusinessHours(restaurantId, days, new Types.ObjectId().toHexString(), false); assert.equal(calls.saves, 1);
  days = week(); days[5] = { dayOfWeek: 5, isOpen: true, periods: [{ openTime: '11:00', closeTime: '14:00' }, { openTime: '18:00', closeTime: '02:00' }] };
  const result = await service.updateBusinessHours(restaurantId, days, new Types.ObjectId().toHexString(), false);
  assert.equal(calls.saves, 2); assert.equal(result.days[5].periods.length, 2);
});

test('converts a legacy string link instead of creating duplicate settings', async () => {
  const legacy = { _id: new Types.ObjectId(), openingHours: [] }; const { service, restaurantId, calls } = harness(null, legacy);
  await service.updateBusinessHours(restaurantId, week(), new Types.ObjectId().toHexString(), false);
  assert.equal(calls.legacyUpdates, 1); assert.equal(calls.creates, 0);
});

test('rejects overlapping periods as HTTP 400 before persistence', async () => {
  const { service, restaurantId, calls } = harness(); const days = week();
  days[1] = { dayOfWeek: 1, isOpen: true, periods: [{ openTime: '08:00', closeTime: '14:00' }, { openTime: '13:00', closeTime: '18:00' }] };
  await assert.rejects(service.updateBusinessHours(restaurantId, days, new Types.ObjectId().toHexString(), false), (error) => error instanceof BadRequestException && error.getStatus() === 400);
  assert.equal(calls.creates, 0);
});

test('SUPER_ADMIN uses the same persistence path and records the audit', async () => {
  const { service, restaurantId, calls } = harness();
  const result = await service.updateBusinessHours(restaurantId, week(), new Types.ObjectId().toHexString(), true);
  assert.equal(result.configured, true); assert.equal(calls.creates, 1); assert.equal(calls.audits, 1);
});
