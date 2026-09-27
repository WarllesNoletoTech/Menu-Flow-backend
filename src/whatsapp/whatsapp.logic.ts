import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { openingStatus } from '../restaurants/business-hours';
import type { BusinessDay } from '../common/schemas';

export function validSignature(body: Buffer | undefined, signature: string | undefined, secret: string) {
  if (!body || !secret || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature!.slice(7), 'hex'));
}
export function encryptToken(token: string, key: string) {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Configure WHATSAPP_ENCRYPTION_KEY com 64 caracteres hexadecimais.');
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(value => value.toString('base64')).join('.');
}
export function decryptToken(value: string, key: string) {
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
export function withinWindow(date: Date | undefined, now = Date.now()) {
  return Boolean(date && date.getTime() <= now + 300000 && now - date.getTime() < 24 * 60 * 60 * 1000);
}
export function normalize(text: string) { return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }
export function botReply(text: string, data: {
  name: string; menuUrl: string; greeting?: string; handoffText?: string; deliveryText?: string;
  address?: string; mapUrl?: string; openingHours: BusinessDay[]; timezone?: string;
  open: boolean; deliveryEnabled: boolean; pickupEnabled: boolean;
}) {
  const value = normalize(text);
  if (['sair', 'parar', 'stop'].includes(value)) return { text: 'Atendimento automático pausado. Envie MENU para voltar.', optedOut: true };
  if (['4', 'atendente', 'humano', 'falar com a loja', 'falar com atendente'].includes(value)) return { text: data.handoffText || 'Sua conversa está aguardando atendimento da loja. O atendimento depende da disponibilidade da equipe. Para voltar ao automático, envie MENU.', human: true };
  if (['2', 'horario', 'horarios', 'endereco'].includes(value)) {
    const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const status = openingStatus(data.openingHours, data.timezone || 'America/Sao_Paulo');
    const hours = [...data.openingHours].sort((a,b) => a.dayOfWeek-b.dayOfWeek).map(day => `${days[day.dayOfWeek]}: ${day.isOpen ? day.periods.map(p => `${p.openTime} às ${p.closeTime}`).join(' / ') : 'fechado'}`).join('\n');
    return { text: `${data.name}\n${!data.open ? 'Pedidos pausados.' : status.isOpen === null ? 'Consulte a disponibilidade no cardápio.' : status.isOpen ? 'Aberto agora.' : 'Fechado no momento.'}\n${hours || 'Horários ainda não informados.'}\n${data.address || 'Endereço ainda não informado.'}${data.mapUrl ? `\n${data.mapUrl}` : ''}\n\nMENU: voltar às opções.` };
  }
  if (['3', 'entrega', 'retirada', 'taxa'].includes(value)) return { text: `${data.deliveryEnabled ? 'Entrega disponível. Consulte cobertura e taxa para seu endereço no checkout.' : 'Entrega não está habilitada.'}\n${data.pickupEnabled ? 'Retirada disponível.' : 'Retirada não está habilitada.'}${data.deliveryText ? `\n${data.deliveryText}` : ''}\n${data.menuUrl}\n\nMENU: voltar às opções.` };
  if (['1', 'cardapio', 'pedido', 'pedir'].includes(value)) return { text: `Confira o cardápio de ${data.name} e faça seu pedido:\n${data.menuUrl}\n\nMENU: voltar às opções.` };
  return { text: `${data.greeting || `Olá! Bem-vindo(a) a ${data.name}.`}\n\nFaça seu pedido pelo cardápio:\n${data.menuUrl}\n\nDigite uma opção:\n1 — Cardápio\n2 — Horários e endereço\n3 — Entrega e retirada\n4 — Falar com a loja\n\nSAIR: pausar respostas automáticas.` };
}
