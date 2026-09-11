const test = require('node:test');
const assert = require('node:assert/strict');
const { orderGroups } = require('../dist/orders/orders.service');

test('merchant order groups cover real statuses without mixing rejected orders into progress', () => {
  assert.deepEqual(orderGroups.pending, ['PENDING']);
  assert.deepEqual(orderGroups.in_progress, ['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY']);
  assert.deepEqual(orderGroups.completed, ['COMPLETED']);
  assert.deepEqual(orderGroups.cancelled, ['REJECTED', 'CANCELLED']);
  const statuses = Object.values(orderGroups).flat();
  assert.equal(new Set(statuses).size, statuses.length);
});
