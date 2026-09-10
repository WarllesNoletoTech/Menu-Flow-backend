const test = require('node:test');
const assert = require('node:assert/strict');
const { deliveryAvailability } = require('../dist/restaurants/restaurants.service');
const { RestaurantsService } = require('../dist/restaurants/restaurants.service');
const { Types } = require('mongoose');
const query = (value) => ({ select() { return this; }, sort() { return this; }, lean: async () => value });

test('enabled delivery plus one active zone is publicly available', () => {
  assert.deepEqual(deliveryAvailability(true, 1), { deliveryEnabled: true, deliveryAvailable: true });
});
test('disabled delivery stays unavailable even with an active zone', () => {
  assert.deepEqual(deliveryAvailability(false, 1), { deliveryEnabled: false, deliveryAvailable: false });
});
test('enabled delivery without zones explains why it is unavailable', () => {
  assert.deepEqual(deliveryAvailability(true, 0), { deliveryEnabled: true, deliveryAvailable: false, deliveryUnavailableReason: 'Nenhuma região de entrega ativa.' });
});

test('public restaurant response carries enabled, available, and the active R$ 9 zone end to end', async () => {
  const restaurantId = new Types.ObjectId();
  const week = Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen: true, periods: [{ openTime: '00:00', closeTime: '23:59' }] }));
  const restaurants = { findOne: () => query({ _id: restaurantId, name: 'Sabor da Praça', slug: 'sabor-da-praca-teste', open: true, blocked: false, timezone: 'America/Sao_Paulo' }) };
  const settings = { findOne: () => query({ restaurantId, pickupEnabled: true, deliveryEnabled: true, openingHours: week }) };
  const zones = { find: () => query([{ _id: new Types.ObjectId(), name: 'todos', active: true, fee: 9, feeCents: 900 }]) };
  const payments = { find: () => query([]) };
  const value = await new RestaurantsService(restaurants, settings, {}, {}, zones, payments, {}, {}).bySlug('sabor-da-praca-teste');
  assert.equal(value.pickupEnabled, true); assert.equal(value.deliveryEnabled, true); assert.equal(value.deliveryAvailable, true);
  assert.equal(value.deliveryZones.length, 1); assert.equal(value.deliveryZones[0].feeCents, 900);
});
