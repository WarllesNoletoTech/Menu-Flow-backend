const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { validSignature, encryptToken, decryptToken, withinWindow, botReply } = require('../dist/whatsapp/whatsapp.logic');
const { WhatsappWebhookController } = require('../dist/whatsapp/whatsapp.controller');
const data = {name:'Loja A',menuUrl:'https://menu.example/loja-a',openingHours:[],open:true,deliveryEnabled:true,pickupEnabled:true};
test('signature requires exact raw body, correct secret and well formed header',()=>{
 const body=Buffer.from('{"entry":[]}');const secret='test-secret';const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
 assert.equal(validSignature(body,signature,secret),true);
 assert.equal(validSignature(Buffer.from('{ "entry":[]}'),signature,secret),false);
 assert.equal(validSignature(body,signature,'other'),false);
 for(const s of [undefined,'sha256=no','a'.repeat(64)])assert.equal(validSignature(body,s,secret),false);
 assert.equal(validSignature(undefined,signature,secret),false);
});
test('stored tokens are encrypted with random IVs and authenticated',()=>{
 const key='01'.repeat(32);const a=encryptToken('private-test-token',key);const b=encryptToken('private-test-token',key);
 assert.notEqual(a,b);assert.ok(!a.includes('private-test-token'));assert.equal(decryptToken(a,key),'private-test-token');
 assert.throws(()=>decryptToken(a,'02'.repeat(32)));assert.throws(()=>encryptToken('x','short'));
});
test('24h window excludes expired, invalid, missing and far-future dates',()=>{
 const now=Date.now();assert.equal(withinWindow(new Date(now-86399000),now),true);
 for(const date of [undefined,new Date(NaN),new Date(now-86400000),new Date(now+3600000)])assert.equal(withinWindow(date,now),false);
});
test('greeting includes the correct tenant menu and handoff option',()=>{
 const a=botReply('Oi',data).text;const b=botReply('Oi',{...data,name:'Loja B',menuUrl:'https://menu.example/loja-b'}).text;
 assert.match(a,/loja-a/);assert.match(a,/4 — Falar com a loja/);assert.ok(!b.includes('loja-a'));assert.match(b,/Loja B/);
});
test('all menu choices and accented commands route correctly',()=>{
 assert.match(botReply('Cardápio',data).text,/Confira o cardápio/);
 assert.match(botReply('2',data).text,/Horários ainda não informados/);
 assert.match(botReply('3',{...data,deliveryEnabled:false}).text,/Entrega não está habilitada/);
 assert.equal(botReply('4',data).human,true);assert.equal(botReply('SAIR',data).optedOut,true);
 assert.match(botReply('MENU',data).text,/Digite uma opção/);
});
test('webhook challenge fails closed when verification token is missing or wrong',()=>{
 const old=process.env.WHATSAPP_VERIFY_TOKEN;const controller=new WhatsappWebhookController({});
 try {delete process.env.WHATSAPP_VERIFY_TOKEN;assert.throws(()=>controller.verify('subscribe','','123'));process.env.WHATSAPP_VERIFY_TOKEN='test';assert.throws(()=>controller.verify('subscribe','wrong','123'));assert.equal(controller.verify('subscribe','test','123'),'123');}finally{if(old===undefined)delete process.env.WHATSAPP_VERIFY_TOKEN;else process.env.WHATSAPP_VERIFY_TOKEN=old;}
});
