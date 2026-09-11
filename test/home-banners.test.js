const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeHttpsUrl, isSafeTargetUrl } = require('../dist/home-banners/home-banners.controller');
const { isAllowedBannerImage } = require('../dist/home-banners/home-banners.service');
test('banner image URLs only accept HTTPS', () => {
  assert.equal(isSafeHttpsUrl('https://exemplo.com/banner.jpg'), true);
  assert.equal(isSafeHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpsUrl('data:image/png;base64,abc'), false);
  assert.equal(isSafeHttpsUrl('http://exemplo.com/banner.jpg'), false);
});
test('banner uploads validate the real image signature and declared MIME', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(isAllowedBannerImage({ buffer: png, mimetype: 'image/png', size: png.length }), true);
  assert.equal(isAllowedBannerImage({ buffer: Buffer.from('<html>'), mimetype: 'image/png', size: 6 }), false);
  assert.equal(isAllowedBannerImage({ buffer: png, mimetype: 'image/svg+xml', size: png.length }), false);
  assert.equal(isAllowedBannerImage({ buffer: png, mimetype: 'image/png', size: 5 * 1024 * 1024 + 1 }), false);
});
test('banner targets accept safe internal paths or HTTPS', () => {
  assert.equal(isSafeTargetUrl('/restaurante/sabor-da-praca'), true);
  assert.equal(isSafeTargetUrl('https://exemplo.com/campanha'), true);
  assert.equal(isSafeTargetUrl('//evil.example'), false);
  assert.equal(isSafeTargetUrl('vbscript:alert(1)'), false);
  assert.equal(isSafeTargetUrl('javascript:alert(1)'), false);
  assert.equal(isSafeTargetUrl('data:text/html,unsafe'), false);
  assert.equal(isSafeTargetUrl('file:///tmp/unsafe'), false);
  assert.equal(isSafeTargetUrl('http://exemplo.com/inseguro'), false);
  assert.equal(isSafeTargetUrl('/rota\\invalida'), false);
});
