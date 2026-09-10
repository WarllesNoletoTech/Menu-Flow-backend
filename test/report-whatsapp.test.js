const test=require('node:test');const assert=require('node:assert/strict');const {normalizeReportWhatsapp}=require('../dist/users/report-whatsapp');
test('normaliza WhatsApp brasileiro de relatórios',()=>assert.equal(normalizeReportWhatsapp('(94) 99999-9999'),'5594999999999'));
test('rejeita URLs, scripts e letras',()=>{for(const value of ['javascript:alert(1)','https://evil.com','94abc9999'])assert.throws(()=>normalizeReportWhatsapp(value),/WhatsApp para relatórios inválido/)});
