const test = require('node:test');
const assert = require('node:assert/strict');
const { BadRequestException, ConflictException, ForbiddenException, NotFoundException } = require('@nestjs/common');
const { Types } = require('mongoose');
const { OrdersService } = require('../dist/orders/orders.service');
const { TenantGuard } = require('../dist/common/tenant.guard');
const { Role } = require('../dist/common/roles');

function harness(overrides = {}) {
  const restaurantId = new Types.ObjectId();
  const orderId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const published = [];
  const order = {
    _id: orderId, restaurantId, status: 'PENDING', fulfillment: 'DELIVERY', statusHistory: [], customerId: new Types.ObjectId(),
    async save() {}, toJSON() { return { ...this }; }, ...overrides,
  };
  const orders = { async findOne(filter) { harness.lastFilter = filter; return overrides.missing ? null : order; } };
  const gateway = { publishOrderUpdated(...args) { published.push(args); } };
  const service = new OrdersService(orders, {}, {}, {}, {}, {}, {}, {}, {}, gateway);
  return { service, order, restaurantId, orderId, actorId, published };
}

test('PENDING -> ACCEPTED persists audit data and publishes the update', async () => {
  const h = harness(); const result = await h.service.updateStatus(`${h.restaurantId}`, `${h.orderId}`, 'ACCEPTED', `${h.actorId}`);
  assert.equal(result.status, 'ACCEPTED'); assert.ok(result.acceptedAt); assert.ok(result.acceptedBy.equals(h.actorId)); assert.equal(result.statusHistory.at(-1).status, 'ACCEPTED'); assert.equal(h.published.length, 1);
  assert.ok(harness.lastFilter._id instanceof Types.ObjectId); assert.ok(harness.lastFilter.restaurantId instanceof Types.ObjectId);
});

test('PENDING -> REJECTED requires and stores a reason', async () => {
  const missing = harness(); await assert.rejects(missing.service.updateStatus(`${missing.restaurantId}`, `${missing.orderId}`, 'REJECTED', `${missing.actorId}`), BadRequestException);
  const h = harness(); const result = await h.service.updateStatus(`${h.restaurantId}`, `${h.orderId}`, 'REJECTED', `${h.actorId}`, 'Não conseguimos atender o pedido');
  assert.equal(result.status, 'REJECTED'); assert.equal(result.rejectionReason, 'Não conseguimos atender o pedido');
});

test('ACCEPTED -> PREPARING is allowed and invalid transitions return 409', async () => {
  const valid = harness({ status: 'ACCEPTED' }); assert.equal((await valid.service.updateStatus(`${valid.restaurantId}`, `${valid.orderId}`, 'PREPARING', `${valid.actorId}`)).status, 'PREPARING');
  const invalid = harness({ status: 'ACCEPTED' }); await assert.rejects(invalid.service.updateStatus(`${invalid.restaurantId}`, `${invalid.orderId}`, 'REJECTED', `${invalid.actorId}`, 'motivo'), error => error instanceof ConflictException && error.getStatus() === 409);
});

test('legacy order without statusHistory is accepted without a 500', async () => {
  const h = harness({ statusHistory: undefined }); await h.service.updateStatus(`${h.restaurantId}`, `${h.orderId}`, 'ACCEPTED', `${h.actorId}`); assert.deepEqual(h.order.statusHistory.map(item => item.status), ['ACCEPTED']);
});

test('missing order returns 404', async () => {
  const h = harness({ missing: true }); await assert.rejects(h.service.updateStatus(`${h.restaurantId}`, `${h.orderId}`, 'ACCEPTED', `${h.actorId}`), error => error instanceof NotFoundException && error.getStatus() === 404);
});

test('DELIVERY completes only after OUT_FOR_DELIVERY and persists completion audit fields', async () => {
  const h = harness({ status: 'OUT_FOR_DELIVERY' });
  const result = await h.service.updateStatus(`${h.restaurantId}`, `${h.orderId}`, 'COMPLETED', `${h.actorId}`);
  assert.equal(result.status, 'COMPLETED'); assert.ok(result.completedAt instanceof Date); assert.ok(result.completedBy.equals(h.actorId));
});

test('TenantGuard returns 403 when URL and authenticated tenant differ', () => {
  const guard = new TenantGuard(); const context = { switchToHttp: () => ({ getRequest: () => ({ user: { role: Role.RESTAURANT_ADMIN, restaurantId: new Types.ObjectId().toHexString() }, params: { restaurantId: new Types.ObjectId().toHexString() } }) }) };
  assert.throws(() => guard.canActivate(context), error => error instanceof ForbiddenException && error.getStatus() === 403);
});
