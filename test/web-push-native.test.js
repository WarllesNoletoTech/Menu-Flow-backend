const test = require('node:test');
const assert = require('node:assert/strict');
const { encryptWebPushPayload } = require('../dist/notifications/web-push-native.js');

test('encryptWebPushPayload matches RFC 8291 Appendix A', () => {
  const uaPublicKey = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const authSecret = 'BTBZMqHH6r4Tts7J_aSIgg';
  const salt = Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url');
  const serverPrivateKey = Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url');
  const encrypted = encryptWebPushPayload(
    Buffer.from('When I grow up, I want to be a watermelon', 'utf8'),
    uaPublicKey,
    authSecret,
    { salt, serverPrivateKey },
  );
  assert.equal(
    encrypted.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});
