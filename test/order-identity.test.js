const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { BadRequestException } = require('@nestjs/common');
const { OrdersService } = require('../dist/orders/orders.service');

function serviceWithOrderModel(orders) {
  return new OrdersService(orders, {}, {}, {}, {}, {}, {}, {}, {}, {});
}

test('restaurant and customer listings query canonical ObjectIds', async () => {
  const restaurantId = new Types.ObjectId().toHexString();
  const customerId = new Types.ObjectId().toHexString();
  const filters = [];
  const orders = {
    find(filter) {
      filters.push(filter);
      const query = { sort: () => query, limit: () => query, populate: () => query, lean: async () => [] };
      return query;
    },
  };
  const service = serviceWithOrderModel(orders);

  await service.list(restaurantId);
  await service.forCustomer(customerId);

  assert.ok(filters[0].restaurantId instanceof Types.ObjectId);
  assert.equal(filters[0].restaurantId.toHexString(), restaurantId);
  assert.ok(filters[1].customerId instanceof Types.ObjectId);
  assert.equal(filters[1].customerId.toHexString(), customerId);
});

test('listing rejects malformed tenant and account identifiers before querying', () => {
  const service = serviceWithOrderModel({ find: () => assert.fail('database must not be queried') });
  assert.throws(() => service.list('invalid'), BadRequestException);
  assert.throws(() => service.forCustomer('invalid'), BadRequestException);
});
