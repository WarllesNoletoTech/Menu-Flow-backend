const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateOrderTotalCents } = require('../dist/orders/orders.service');
const { sumOrderServiceFees } = require('../dist/billing/billing.service');

test('retirada de R$ 20 cobra uma única taxa e totaliza R$ 21', () => {
  const customerServiceFeeCents = 100;
  assert.equal(calculateOrderTotalCents(2000, 0, 0, customerServiceFeeCents), 2100);
});

test('entrega preserva taxa de entrega e soma uma única taxa Menu Flow', () => {
  assert.equal(calculateOrderTotalCents(4000, 900, 0, 100), 5000);
});

test('relatório de um pedido copia a mesma taxa cobrada do cliente', () => {
  assert.equal(sumOrderServiceFees([{ customerServiceFeeCents: 100 }]), 100);
});

test('dez snapshots de R$ 1,00 geram R$ 10,00 e total de R$ 160,00 com mensalidade', () => {
  const fees = sumOrderServiceFees(Array.from({ length: 10 }, () => ({ customerServiceFeeCents: 100 })));
  assert.equal(fees, 1000);
  assert.equal(fees + 15000, 16000);
});

test('snapshots históricos diferentes são somados sem usar taxa atual', () => {
  assert.equal(sumOrderServiceFees([
    { customerServiceFeeCents: 100 },
    { customerServiceFeeCents: 150 },
    {},
  ]), 250);
});

const { Types } = require('mongoose');
const { BillingService } = require('../dist/billing/billing.service');
const query = (value) => ({ select() { return this; }, sort() { return this; }, lean: async () => value });

test('geração copia snapshots por pedido e exclui orderId já contabilizado', async () => {
  const restaurantId = new Types.ObjectId();
  const billedId = new Types.ObjectId();
  const firstId = new Types.ObjectId();
  const secondId = new Types.ObjectId();
  const orders = [
    { _id: billedId, orderNumber: 'MF-OLD', completedAt: new Date(), fulfillment: 'PICKUP', totalCents: 2100, customerServiceFeeCents: 100 },
    { _id: firstId, orderNumber: 'MF-A', completedAt: new Date(), fulfillment: 'PICKUP', totalCents: 2100, customerServiceFeeCents: 100 },
    { _id: secondId, orderNumber: 'MF-B', completedAt: new Date(), fulfillment: 'DELIVERY', totalCents: 5150, customerServiceFeeCents: 150 },
  ];
  let createdReport;
  let insertedItems;
  const reports = {
    exists: async () => false,
    create: async (value) => (createdReport = { ...value, _id: new Types.ObjectId(), id: 'report-id' }),
    deleteOne: async () => undefined,
  };
  const reportItems = {
    find: () => query([{ orderId: billedId }]),
    insertMany: async (value) => (insertedItems = value),
  };
  const restaurants = { findById: () => query({ _id: restaurantId, name: 'Loja', timezone: 'America/Sao_Paulo' }) };
  const orderModel = { find: () => query(orders) };
  const settings = { findOne: () => ({ lean: async () => null }) };
  const counters = { findOneAndUpdate: async () => ({ sequence: 1 }) };
  const audits = { create: async () => undefined };
  const service = new BillingService({}, {}, reports, reportItems, settings, counters, restaurants, orderModel, audits, {}, {}, {});
  service.previewReport = async () => ({ orderCount: 2, monthlyFeeAlreadyIncluded: false });
  service.report = async () => createdReport;

  await service.generateReport({ restaurantId: restaurantId.toString(), periodStart: '2026-09-01', periodEnd: '2026-09-30', includeMonthlyFee: true, monthlyFeeCents: 15000 }, new Types.ObjectId().toString());

  assert.equal(createdReport.orderCount, 2);
  assert.equal(createdReport.serviceFeeTotalCents, 250);
  assert.equal(createdReport.totalCents, 15250);
  assert.deepEqual(insertedItems.map((item) => item.orderId), [firstId, secondId]);
  assert.deepEqual(insertedItems.map((item) => item.feeCents), [100, 150]);
});
