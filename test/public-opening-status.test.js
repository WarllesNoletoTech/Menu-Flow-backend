const test = require('node:test');
const assert = require('node:assert/strict');
const { Types } = require('mongoose');
const { RestaurantsService } = require('../dist/restaurants/restaurants.service');

const query = (value) => ({ select() { return this; }, sort() { return this; }, lean: async () => value });
const week = (isOpen) => Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, isOpen, periods: isOpen ? [{ openTime: '00:00', closeTime: '23:59' }] : [] }));
function harness() {
  const openId = new Types.ObjectId(); const closedId = new Types.ObjectId();
  const restaurantsData = [
    { _id: openId, name: 'Sempre aberta', slug: 'aberta', timezone: 'UTC' },
    { _id: closedId, name: 'Fechada', slug: 'fechada', timezone: 'UTC' },
  ];
  const settingsData = [
    { restaurantId: openId, openingHours: week(true) },
    { restaurantId: closedId, openingHours: week(false) },
  ];
  const restaurants = {
    find: () => query(restaurantsData),
    findOne: ({ slug }) => query(restaurantsData.find((item) => item.slug === slug) || null),
  };
  const settings = {
    find: () => query(settingsData),
    findOne: ({ restaurantId }) => query(settingsData.find((item) => item.restaurantId.equals(restaurantId)) || null),
  };
  return new RestaurantsService(restaurants, settings, {}, {}, {}, {});
}
const params = { page: 1, limit: 12 };

test('listing and individual endpoint data use the same calculated status', async () => {
  const service = harness();
  const list = await service.publicList(params);
  const detail = await service.bySlug('fechada');
  const listed = list.items.find((item) => item.slug === 'fechada');
  assert.equal(listed.isOpenNow, false);
  assert.equal(listed.businessHoursConfigured, true);
  assert.equal(detail.isOpenNow, listed.isOpenNow);
  assert.deepEqual(detail.openingStatus, listed.openingStatus);
});

test('open-now filter only returns dynamically open stores', async () => {
  const result = await harness().publicList({ ...params, open: true });
  assert.deepEqual(result.items.map((item) => item.slug), ['aberta']);
  assert.equal(result.pagination.total, 1);
});

test('missing hours are safe and are never reported open', async () => {
  const service = harness(); service.settings.find = () => query([]);
  const result = await service.publicList(params);
  assert.equal(result.items[0].isOpenNow, false);
  assert.equal(result.items[0].businessHoursConfigured, false);
});
