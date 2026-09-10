const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { RestaurantsService } = require('../dist/restaurants/restaurants.service');

const query = (value) => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
test('persiste pagamento no tenant e o contrato público devolve apenas métodos ativos', async () => {
  const restaurantId = new Types.ObjectId();
  const restaurant = { _id: restaurantId, name: 'Loja', slug: 'loja', open: true, blocked: false, timezone: 'UTC', address: 'Rua 1', mapUrl: 'https://maps.example/loja' };
  const stored = [];
  const restaurants = { exists: async () => true, findOne: () => query(restaurant) };
  const settings = { findOne: () => query({ restaurantId, pickupEnabled: true, deliveryEnabled: false, openingHours: Array.from({length:7},(_,dayOfWeek)=>({dayOfWeek,isOpen:true,periods:[{openTime:'00:00',closeTime:'23:59'}]})) }) };
  const payments = {
    findOneAndUpdate(filter, update) { const item = { _id: new Types.ObjectId(), restaurantId: filter.restaurantId, method: filter.method, ...update.$set }; stored.splice(0, stored.length, item); return query(item); },
    find(filter) { return query(stored.filter(item => item.active && item.restaurantId.equals(filter.restaurantId))); },
  };
  const zones = { find: () => query([]) };
  const service = new RestaurantsService(restaurants, settings, {}, {}, zones, payments, {}, {});
  const saved = await service.savePaymentMethod(restaurantId.toString(), { method: 'CASH', name: 'Dinheiro', active: true });
  assert.equal(saved.method, 'CASH');
  const publicRestaurant = await service.bySlug('loja');
  assert.deepEqual(publicRestaurant.paymentMethods.map(item => item.method), ['CASH']);
  assert.equal(publicRestaurant.address, 'Rua 1');
  assert.equal(publicRestaurant.mapUrl, 'https://maps.example/loja');
});
