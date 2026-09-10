const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { BillingService } = require('../dist/billing/billing.service');

const query = (value) => ({ populate() { return this; }, select() { return this; }, lean: async () => value });
function harness(plan) {
  const restaurantId = new Types.ObjectId();
  const filters = [];
  const restaurant = { _id: restaurantId, name: 'Teste', timezone: 'America/Sao_Paulo', ...(plan ? { billingPlanId: plan } : {}) };
  const restaurants = { findById(id) { assert.ok(id instanceof Types.ObjectId); return query(restaurant); } };
  const metrics = { countCompleted(id, start, end) { filters.push({ id, start, end }); return Promise.resolve(1); } };
  return { service: new BillingService({}, {}, {}, {}, {}, {}, restaurants, {}, {}, metrics), restaurantId, filters };
}

test('completed order is counted even when restaurant has no billing plan', async () => {
  const { service, restaurantId, filters } = harness();
  const value = await service.estimateRestaurant(restaurantId.toHexString(), '2026-09');
  assert.equal(value.completedOrderCount, 1); assert.equal(value.plan, null); assert.equal(value.amountCents, null);
  assert.ok(filters[0].id instanceof Types.ObjectId); assert.equal(filters[0].id.toHexString(), restaurantId.toHexString());
});

test('same completed order selects the correct tier when a plan exists', async () => {
  const plan = { _id: new Types.ObjectId(), name: 'Essencial', tiers: [{ minOrders: 0, maxOrders: 10, amountCents: 4900 }, { minOrders: 11, maxOrders: null, amountCents: 9900 }] };
  const { service, restaurantId } = harness(plan);
  const value = await service.estimateRestaurant(restaurantId.toHexString(), '2026-09');
  assert.equal(value.completedOrderCount, 1); assert.equal(value.tier.amountCents, 4900); assert.equal(value.amountCents, 4900);
});
