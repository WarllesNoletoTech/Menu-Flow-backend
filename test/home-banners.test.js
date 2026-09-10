const test = require('node:test');
const assert = require('node:assert/strict');
const { isSafeHttpsUrl, isSafeTargetUrl } = require('../dist/home-banners/home-banners.controller');
test('banner image URLs only accept HTTPS', () => {
  assert.equal(isSafeHttpsUrl('https://exemplo.com/banner.jpg'), true);
  assert.equal(isSafeHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpsUrl('data:image/png;base64,abc'), false);
  assert.equal(isSafeHttpsUrl('http://exemplo.com/banner.jpg'), false);
});
test('banner targets accept safe internal paths or HTTPS', () => {
  assert.equal(isSafeTargetUrl('/restaurante/sabor-da-praca'), true);
  assert.equal(isSafeTargetUrl('https://exemplo.com/campanha'), true);
  assert.equal(isSafeTargetUrl('//evil.example'), false);
  assert.equal(isSafeTargetUrl('vbscript:alert(1)'), false);
});
