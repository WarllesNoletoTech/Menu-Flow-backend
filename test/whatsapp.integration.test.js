// Run against a disposable database: WHATSAPP_TEST_MONGODB_URI=mongodb://... npm test
const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {Module,ValidationPipe}=require('@nestjs/common');const {NestFactory}=require('@nestjs/core');const {ConfigModule}=require('@nestjs/config');const {MongooseModule,getModelToken}=require('@nestjs/mongoose');const {JwtService}=require('@nestjs/jwt');
const {WhatsappModule}=require('../dist/whatsapp/whatsapp.module');const {WhatsappService}=require('../dist/whatsapp/whatsapp.service');
const {WhatsappConnection,WhatsappConversation,WhatsappMessage}=require('../dist/whatsapp/whatsapp.schemas');const {Restaurant,RestaurantSettings,User}=require('../dist/common/schemas');

test('WhatsApp HTTP, persistence and multi-store workflow', {skip:!process.env.WHATSAPP_TEST_MONGODB_URI}, async t=>{
 Object.assign(process.env,{JWT_SECRET:'local-tests-only',WHATSAPP_APP_SECRET:'test-app-secret',WHATSAPP_VERIFY_TOKEN:'test-verify',WHATSAPP_ENCRYPTION_KEY:'01'.repeat(32),WHATSAPP_GRAPH_VERSION:'v25.0',WHATSAPP_PUBLIC_MENU_URL:'https://menu.example'});
 class TestModule{};Module({imports:[ConfigModule.forRoot({isGlobal:true,ignoreEnvFile:true}),MongooseModule.forRoot(process.env.WHATSAPP_TEST_MONGODB_URI,{dbName:'whatsapp_test_'+crypto.randomBytes(6).toString('hex')}),WhatsappModule]})(TestModule);
 const app=await NestFactory.create(TestModule,{logger:false,rawBody:true});app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.listen(0,'127.0.0.1');
 const base=await app.getUrl();const service=app.get(WhatsappService);service.onModuleDestroy();
 const model=n=>app.get(getModelToken(n.name));const connections=model(WhatsappConnection),conversations=model(WhatsappConversation),messages=model(WhatsappMessage),restaurants=model(Restaurant),settings=model(RestaurantSettings),users=model(User);
 const nativeFetch=global.fetch;const sent=[];let mode='ok';
 global.fetch=async(url,options)=>{
  if(String(url).startsWith('https://graph.facebook.com/')){
   if(options.method==='GET')return new Response(JSON.stringify({id:String(url).match(/\/(\d+)\?/)[1],display_phone_number:'+55 11 90000-0000'}));
   if(mode==='timeout')throw Error('network');
   if(mode==='reject')return new Response(JSON.stringify({error:{code:190}}),{status:400});
   sent.push(JSON.parse(options.body));return new Response(JSON.stringify({messages:[{id:'out-'+sent.length}]}));
  }return nativeFetch(url,options);
 };
 const call=async(path,token,method='GET',body)=>{const res=await nativeFetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()}};
 const incoming=(phone,id,text='Oi',from='5511999999999')=>({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:phone},contacts:[{wa_id:from,profile:{name:'Cliente teste'}}],messages:[{from,id,type:'text',text:{body:text},timestamp:String(Math.floor(Date.now()/1000))}]}}]}]});
 const webhook=async payload=>{const body=JSON.stringify(payload);return nativeFetch(base+'/whatsapp/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':'sha256='+crypto.createHmac('sha256',process.env.WHATSAPP_APP_SECRET).update(body).digest('hex')},body})};
 const drain=async()=>{for(let i=0;i<15&&await messages.countDocuments({status:'pending'});i++)await service.tick()};
 try{
  const a=await restaurants.create({name:'Loja A',slug:'loja-a'}),b=await restaurants.create({name:'Loja B',slug:'loja-b'});
  const mkUser=async(role,restaurantId)=>{const u=await users.create({email:crypto.randomUUID()+'@test.invalid',passwordHash:'not-used',name:'Test',role,...(restaurantId?{restaurantId}:{})});return app.get(JwtService).sign({sub:u.id,role,...(restaurantId?{restaurantId:String(restaurantId)}:{})})};
  const owner=await mkUser('RESTAURANT_ADMIN',a._id),other=await mkUser('RESTAURANT_ADMIN',b._id),admin=await mkUser('SUPER_ADMIN');
  await t.test('auth denies anonymous and non-admin credentials access',async()=>{assert.equal((await call('/whatsapp/settings')).status,401);assert.equal((await call('/whatsapp/admin/stores',owner)).status,403);assert.equal((await call('/whatsapp/admin/stores',admin)).status,200)});
  await t.test('signature validates HTTP raw body; spoofed callbacks denied',async()=>{const bad=await nativeFetch(base+'/whatsapp/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(bad.status,401);const challenge=await nativeFetch(base+'/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123');assert.equal(await challenge.text(),'123')});
  await t.test('connect validates token, encrypts it, never returns it, rejects duplicate numbers',async()=>{
   const r=await call(`/whatsapp/admin/stores/${a.id}/connection`,admin,'POST',{phoneNumberId:'111111',accessToken:'private-test-token-123456789'});assert.equal(r.status,201);assert.equal(r.body.connected,true);assert.ok(!JSON.stringify(r.body).includes('private-test-token'));
   assert.equal((await call(`/whatsapp/admin/stores/${b.id}/connection`,admin,'POST',{phoneNumberId:'111111',accessToken:'private-test-token-123456789'})).status,409);
   await service.connect(b.id,{phoneNumberId:'222222',accessToken:'another-private-test-token'});await service.updateSettings(a.id,{enabled:true});await service.updateSettings(b.id,{enabled:true});
   const stored=await connections.findOne({restaurantId:a._id}).select('+encryptedToken').lean();assert.ok(!stored.encryptedToken.includes('private-test-token'));
   assert.equal((await call('/whatsapp/settings',owner,'PATCH',{restaurantId:b.id})).status,400);
  });
  await t.test('concurrent webhook duplicates produce one inbound and one tenant-specific response',async()=>{
   const payload=incoming('111111','m1');const responses=await Promise.all(Array.from({length:6},()=>webhook(payload)));assert.ok(responses.every(r=>r.status===200));await drain();
   assert.equal(await messages.countDocuments({direction:'IN'}),1);assert.equal(sent.length,1);assert.match(sent[0].text.body,/loja-a/);
   await webhook(incoming('222222','m2'));await drain();assert.equal(sent.length,2);assert.match(sent[1].text.body,/loja-b/);
  });
  const ca=await conversations.findOne({restaurantId:a._id});
  await t.test('history, replies and handoff are isolated from other stores',async()=>{assert.equal((await call(`/whatsapp/conversations/${ca.id}`,other)).status,404);assert.equal((await call(`/whatsapp/conversations/${ca.id}`,other,'PATCH',{human:true})).status,404);assert.equal((await call(`/whatsapp/conversations/${ca.id}/messages`,other,'POST',{text:'attack',requestId:crypto.randomUUID()})).status,404)});
  await t.test('human handoff stops bot; human sends are idempotent; MENU resumes',async()=>{
   await webhook(incoming('111111','h1','4'));await drain();assert.equal((await conversations.findById(ca._id)).human,true);const before=sent.length;
   await webhook(incoming('111111','h2','Quero falar'));await drain();assert.equal(sent.length,before);
   const input={text:'Olá, sou da loja.',requestId:crypto.randomUUID()};await call(`/whatsapp/conversations/${ca.id}/messages`,owner,'POST',input);await call(`/whatsapp/conversations/${ca.id}/messages`,owner,'POST',input);await drain();assert.equal(sent.length,before+1);
   await webhook(incoming('111111','h3','MENU'));await drain();assert.equal(sent.length,before+2);assert.equal((await conversations.findById(ca._id)).human,false);
  });
  await t.test('SAIR gets one confirmation then suppresses replies until MENU',async()=>{
   const before=sent.length;await webhook(incoming('111111','stop1','SAIR'));await drain();assert.equal(sent.length,before+1);assert.match(sent.at(-1).text.body,/pausado/);
   await webhook(incoming('111111','stop2','Oi'));await drain();assert.equal(sent.length,before+1);
   assert.equal((await call(`/whatsapp/conversations/${ca.id}/messages`,owner,'POST',{text:'Olá',requestId:crypto.randomUUID()})).status,400);
   await webhook(incoming('111111','stop3','MENU'));await drain();assert.equal(sent.length,before+2);
  });
  await t.test('expired window rejects manual replies and old events',async()=>{
   await conversations.updateOne({_id:ca._id},{$set:{lastIncomingAt:new Date(Date.now()-86401000)}});
   assert.equal((await call(`/whatsapp/conversations/${ca.id}/messages`,owner,'POST',{text:'Olá',requestId:crypto.randomUUID()})).status,400);
   const count=await messages.countDocuments();const old=incoming('111111','old');old.entry[0].changes[0].value.messages[0].timestamp='1';await webhook(old);assert.equal(await messages.countDocuments(),count);
  });
  await t.test('network failure is unknown and never automatically resent',async()=>{
   await webhook(incoming('111111','timeout','1'));await service.tick();mode='timeout';await service.tick();mode='ok';const before=sent.length;await drain();assert.equal(sent.length,before);assert.equal(await messages.countDocuments({status:'unknown'}),1);
  });
  await t.test('paused bot still records inbound; disconnected number cannot send',async()=>{
   await service.updateSettings(a.id,{enabled:false});const before=sent.length;await webhook(incoming('111111','paused'));await drain();assert.equal(sent.length,before);
   await service.disconnect(a.id);assert.equal((await service.getSettings(a.id)).connected,false);assert.equal((await call(`/whatsapp/conversations/${ca.id}/messages`,owner,'POST',{text:'Olá',requestId:crypto.randomUUID()})).status,400);
  });
 }finally{global.fetch=nativeFetch;await restaurants.db.dropDatabase();await app.close()}
});
