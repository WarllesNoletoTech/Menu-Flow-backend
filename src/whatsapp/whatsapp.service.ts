import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Restaurant, RestaurantSettings } from '../common/schemas';
import { WhatsappConnection, WhatsappConversation, WhatsappMessage } from './whatsapp.schemas';
import { botReply, decryptToken, encryptToken, normalize, withinWindow } from './whatsapp.logic';

@Injectable()
export class WhatsappService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappService.name);
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(
    @InjectModel(WhatsappConnection.name) private readonly connections: Model<WhatsappConnection>,
    @InjectModel(WhatsappConversation.name) private readonly conversations: Model<WhatsappConversation>,
    @InjectModel(WhatsappMessage.name) private readonly messages: Model<WhatsappMessage>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>,
  ) {}
  async onModuleInit() {
    // Unique indexes are a correctness requirement for tenant isolation and deduplication.
    await Promise.all([this.connections.init(), this.conversations.init(), this.messages.init()]);
    this.timer = setInterval(() => { void this.tick().catch(() => this.logger.error('Falha no processamento WhatsApp; consulte o banco e a configuração.')); }, 2000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private oid(value: string) {
    if (!/^[a-f0-9]{24}$/i.test(value || '')) throw new BadRequestException('Identificador inválido.');
    return new Types.ObjectId(value);
  }
  readiness() {
    const missing = ['WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ENCRYPTION_KEY', 'WHATSAPP_GRAPH_VERSION', 'WHATSAPP_PUBLIC_MENU_URL'].filter(key => !process.env[key]?.trim());
    if (process.env.WHATSAPP_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(process.env.WHATSAPP_ENCRYPTION_KEY)) missing.push('WHATSAPP_ENCRYPTION_KEY (formato inválido)');
    if (process.env.WHATSAPP_GRAPH_VERSION && !/^v\d+\.0$/.test(process.env.WHATSAPP_GRAPH_VERSION)) missing.push('WHATSAPP_GRAPH_VERSION (formato inválido)');
    try { if (!['https:', ...(process.env.NODE_ENV !== 'production' ? ['http:'] : [])].includes(new URL(process.env.WHATSAPP_PUBLIC_MENU_URL || '').protocol)) throw Error(); } catch { if (!missing.includes('WHATSAPP_PUBLIC_MENU_URL')) missing.push('WHATSAPP_PUBLIC_MENU_URL (URL inválida)'); }
    return { ready: missing.length === 0, missing };
  }
  private ensureReady() { if (!this.readiness().ready) throw new ServiceUnavailableException('O administrador precisa concluir a configuração do WhatsApp no servidor.'); }
  private publicConnection(c: any) {
    return { connected: Boolean(c?.phoneNumberId && c?.verifiedAt), phoneNumberId: c?.phoneNumberId || '', displayPhone: c?.displayPhone || '', enabled: c?.enabled === true, greeting: c?.greeting || '', deliveryText: c?.deliveryText || '', handoffText: c?.handoffText || '', verifiedAt: c?.verifiedAt, lastReceivedAt: c?.lastReceivedAt, lastError: c?.lastError || '' };
  }
  async getSettings(id: string) {
    const rid = this.oid(id); const [c, store] = await Promise.all([this.connections.findOne({ restaurantId: rid }).lean(), this.restaurants.findById(rid).lean()]);
    if (!store) throw new NotFoundException('Loja não encontrada.');
    return { ...this.publicConnection(c), serverReady: this.readiness().ready, menuUrl: this.menuUrl(store.slug) };
  }
  private menuUrl(slug: string) { const base = process.env.WHATSAPP_PUBLIC_MENU_URL?.replace(/\/+$/, ''); return base ? `${base}/${encodeURIComponent(slug)}` : ''; }
  async updateSettings(id: string, input: { enabled?: boolean; greeting?: string; deliveryText?: string; handoffText?: string }) {
    const rid = this.oid(id); const c = await this.connections.findOne({ restaurantId: rid }).lean();
    if (!c) throw new BadRequestException('Solicite a conexão do número ao administrador.');
    if (input.enabled) { this.ensureReady(); if (!c.verifiedAt || !c.phoneNumberId) throw new BadRequestException('Conecte um número primeiro.'); }
    await this.connections.updateOne({ restaurantId: rid }, { $set: input }); return this.getSettings(id);
  }
  async adminStores() {
    const [stores, connections] = await Promise.all([this.restaurants.find().select('name slug blocked').sort({ name: 1 }).lean(), this.connections.find().lean()]);
    const map = new Map(connections.map(c => [c.restaurantId.toString(), c]));
    return { ...this.readiness(), stores: stores.map(s => ({ restaurantId: s._id.toString(), name: s.name, blocked: s.blocked, ...this.publicConnection(map.get(s._id.toString())) })) };
  }
  private async graph(path: string, token: string, body?: unknown) {
    let response: Response;
    try {
      response = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION}/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
    } catch { throw new ServiceUnavailableException('Sem confirmação da Meta. Verifique a conversa antes de reenviar.'); }
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok || data.error) throw new BadRequestException(`Meta recusou a operação (código ${Number(data.error?.code) || response.status}). Verifique token, permissões e número no painel da Meta.`);
    return data;
  }
  async connect(id: string, input: { phoneNumberId: string; accessToken: string }) {
    this.ensureReady(); const rid = this.oid(id);
    if (!await this.restaurants.exists({ _id: rid })) throw new NotFoundException('Loja não encontrada.');
    const existing = await this.connections.findOne({ restaurantId: rid }).lean();
    if (existing?.phoneNumberId && existing.phoneNumberId !== input.phoneNumberId) throw new ConflictException('Desconecte o número atual antes de trocar.');
    const meta = await this.graph(`${input.phoneNumberId}?fields=id,display_phone_number`, input.accessToken);
    if (meta.id !== input.phoneNumberId || !meta.display_phone_number) throw new BadRequestException('Número não validado pela Meta.');
    try {
      await this.connections.findOneAndUpdate({ restaurantId: rid }, { $set: { phoneNumberId: input.phoneNumberId, displayPhone: meta.display_phone_number, encryptedToken: encryptToken(input.accessToken, process.env.WHATSAPP_ENCRYPTION_KEY!), verifiedAt: new Date(), lastError: '' }, $setOnInsert: { restaurantId: rid, enabled: false } }, { upsert: true, runValidators: true });
    } catch (error: any) { if (error.code === 11000) throw new ConflictException('Este número já está vinculado a outra loja.'); throw error; }
    return this.getSettings(id);
  }
  async disconnect(id: string) {
    const rid = this.oid(id);
    const c = await this.connections.findOneAndUpdate({ restaurantId: rid, $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: { $exists: false } }] }, { $set: { enabled: false }, $unset: { phoneNumberId: 1, displayPhone: 1, encryptedToken: 1, verifiedAt: 1 } });
    if (!c) throw new ConflictException('Conexão ocupada ou inexistente. Tente novamente em alguns segundos.');
    await this.messages.updateMany({ restaurantId: rid, status: 'pending' }, { $set: { status: 'cancelled', error: 'Número desconectado.' } });
    return { disconnected: true };
  }
  async inbox(id: string) { return this.conversations.find({ restaurantId: this.oid(id) }).sort({ updatedAt: -1 }).limit(100).lean(); }
  async conversation(id: string, cid: string) {
    const c = await this.conversations.findOne({ _id: this.oid(cid), restaurantId: this.oid(id) }).lean();
    if (!c) throw new NotFoundException('Conversa não encontrada.'); return c;
  }
  async history(id: string, cid: string) {
    const c = await this.conversation(id, cid);
    const messages = await this.messages.find({ restaurantId: c.restaurantId, conversationId: c._id }).sort({ createdAt: -1, _id: -1 }).limit(100).lean();
    return { conversation: c, canReply: withinWindow(c.lastIncomingAt) && !c.optedOut, messages: messages.reverse() };
  }
  async mode(id: string, cid: string, human: boolean) {
    const c = await this.conversation(id, cid);
    await this.conversations.updateOne({ _id: c._id, restaurantId: c.restaurantId }, { $set: { human } });
    return { human };
  }
  async reply(id: string, cid: string, text: string, requestId: string) {
    this.ensureReady(); const c = await this.conversation(id, cid);
    if (!withinWindow(c.lastIncomingAt)) throw new BadRequestException('Janela de 24 horas encerrada. Aguarde nova mensagem do cliente.');
    if (c.optedOut) throw new BadRequestException('Cliente pausou as mensagens. Aguarde ele enviar MENU.');
    const connection = await this.connections.findOne({ restaurantId: c.restaurantId, phoneNumberId: c.phoneNumberId }).lean();
    if (!connection?.verifiedAt) throw new BadRequestException('Esta conversa não pertence ao número atualmente conectado.');
    if (!text.trim()) throw new BadRequestException('Digite uma mensagem.');
    await this.conversations.updateOne({ _id: c._id }, { $set: { human: true } });
    await this.messages.updateOne({ key: `manual:${id}:${requestId}` }, { $setOnInsert: { restaurantId: c.restaurantId, conversationId: c._id, key: `manual:${id}:${requestId}`, direction: 'OUT', text: text.trim(), status: 'pending' } }, { upsert: true });
    return { queued: true };
  }
  async receive(payload: any) {
    if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return;
    for (const entry of payload.entry) for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (change.field !== 'messages') continue;
      const value = change.value; const phoneNumberId = value?.metadata?.phone_number_id;
      if (typeof phoneNumberId !== 'string') continue;
      const connection = await this.connections.findOne({ phoneNumberId }).lean();
      if (!connection) continue;
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (typeof status.id !== 'string' || !['sent','delivered','read','failed'].includes(status.status)) continue;
        const previous = status.status === 'read' ? ['sending','sent','delivered'] : status.status === 'delivered' ? ['sending','sent'] : ['sending','sent'];
        await this.messages.updateOne({ restaurantId: connection.restaurantId, metaId: status.id, status: { $in: previous } }, { $set: { status: status.status, ...(status.status === 'failed' ? { error: `Falha de entrega Meta (${Number(status.errors?.[0]?.code) || 'sem código'}).` } : {}) } });
      }
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (typeof message.id !== 'string' || message.id.length > 500 || !/^\d{8,15}$/.test(message.from || '')) continue;
        const at = new Date(Number(message.timestamp) * 1000);
        if (!withinWindow(at) || !Number.isFinite(at.getTime())) continue;
        const text = (message.type === 'text' ? message.text?.body : message.interactive?.button_reply?.id || message.interactive?.list_reply?.id) || '[Mensagem não textual: consulte o atendimento humano]';
        if (typeof text !== 'string') continue;
        let c;
        const filter = { restaurantId: connection.restaurantId, phoneNumberId, customerPhone: message.from };
        try { c = await this.conversations.findOneAndUpdate(filter, { $setOnInsert: filter }, { upsert: true, new: true }); }
        catch (error: any) { if (error.code !== 11000) throw error; c = await this.conversations.findOne(filter); }
        if (!c) throw new ServiceUnavailableException();
        try { await this.messages.create({ restaurantId: connection.restaurantId, conversationId: c._id, key: `in:${phoneNumberId}:${message.id}`, direction: 'IN', text: text.slice(0,4000), metaId: message.id, sentAt: at, status: 'pending' }); }
        catch (error: any) { if (error.code === 11000) continue; throw error; }
        const name = value.contacts?.find((item: any) => item.wa_id === message.from)?.profile?.name;
        await this.conversations.updateOne({ _id: c._id }, { $max: { lastIncomingAt: at }, $set: { lastText: text.slice(0,300), ...(typeof name === 'string' ? { customerName: name.slice(0,100) } : {}) } });
        await this.connections.updateOne({ _id: connection._id }, { $set: { lastReceivedAt: new Date() } });
      }
    }
  }
  async tick() {
    if (this.busy || !this.readiness().ready) return;
    this.busy = true;
    try {
      // A crashed sender is never blindly retried: Meta may already have accepted it.
      await this.messages.updateMany({ direction: 'OUT', status: 'sending', updatedAt: { $lt: new Date(Date.now()-90000) } }, { $set: { status: 'unknown', error: 'Envio interrompido; confirme no WhatsApp antes de reenviar.' } });
      const tenantIds = await this.messages.distinct('restaurantId', { status: 'pending' });
      for (const rid of tenantIds.slice(0,100)) {
        const lease = new Date(Date.now()+45000);
        const connection = await this.connections.findOneAndUpdate({ restaurantId: rid, phoneNumberId: { $exists: true }, $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: { $exists: false } }] }, { $set: { leaseUntil: lease } }, { new: true }).select('+encryptedToken').lean();
        if (!connection) continue;
        try {
          const message = await this.messages.findOne({ restaurantId: rid, status: 'pending' }).sort({ createdAt: 1, _id: 1 }).lean();
          if (!message) continue;
          try { await this.process(connection, message); }
          catch (error) {
            const reason = error instanceof BadRequestException || error instanceof ServiceUnavailableException ? error.message : 'Erro interno ao processar mensagem. Contate o administrador.';
            await this.messages.updateOne({ _id: message._id }, { $set: { status: message.direction === 'OUT' && error instanceof ServiceUnavailableException ? 'unknown' : 'failed', error: reason } });
            await this.connections.updateOne({ _id: connection._id }, { $set: { lastError: reason } });
          }
        } finally { await this.connections.updateOne({ _id: connection._id, leaseUntil: lease }, { $unset: { leaseUntil: 1 } }); }
      }
    } finally { this.busy = false; }
  }
  private async process(connection: any, message: any) {
    if (message.direction === 'IN' && message.sentAt) {
      await this.conversations.updateOne({ _id: message.conversationId, restaurantId: connection.restaurantId }, { $max: { lastIncomingAt: message.sentAt } });
    }
    const c = await this.conversations.findOne({ _id: message.conversationId, restaurantId: connection.restaurantId }).lean();
    const store = await this.restaurants.findById(connection.restaurantId).lean();
    if ((message.direction === 'IN' && !withinWindow(message.sentAt)) || !c || !store || store.blocked || c.phoneNumberId !== connection.phoneNumberId || !withinWindow(c.lastIncomingAt)) {
      await this.messages.updateOne({ _id: message._id }, { $set: { status: 'cancelled', error: 'Conversa indisponível, loja bloqueada ou janela encerrada.' } }); return;
    }
    if (message.direction === 'OUT') {
      if ((c.optedOut && message.controlReply !== 'stop') || (message.key.startsWith('bot:') && (!connection.enabled || (c.human && !message.controlReply)))) { await this.messages.updateOne({ _id: message._id }, { $set: { status: 'cancelled' } }); return; }
      const claim = await this.messages.updateOne({ _id: message._id, status: 'pending' }, { $set: { status: 'sending' } });
      if (!claim.modifiedCount) return;
      const data = await this.graph(`${connection.phoneNumberId}/messages`, decryptToken(connection.encryptedToken, process.env.WHATSAPP_ENCRYPTION_KEY!), { messaging_product: 'whatsapp', recipient_type: 'individual', to: c.customerPhone, type: 'text', text: { preview_url: true, body: message.text } });
      if (!data.messages?.[0]?.id) throw new ServiceUnavailableException('Meta não confirmou o identificador da mensagem.');
      await this.messages.updateOne({ _id: message._id }, { $set: { status: 'sent', metaId: data.messages[0].id, sentAt: new Date() } });
      await this.connections.updateOne({ _id: connection._id }, { $set: { lastError: '' } }); return;
    }
    const command = normalize(message.text);
    const resume = ['menu','inicio'].includes(command);
    const stop = ['sair','parar','stop'].includes(command);
    const eligible = connection.enabled && (resume || stop || (!c.human && !c.optedOut));
    if (resume) await this.conversations.updateOne({ _id: c._id }, { $set: { human: false, optedOut: false } });
    if (eligible) {
      const setting = await this.settings.findOne({ restaurantId: connection.restaurantId }).lean();
      const reply = botReply(message.text.startsWith('[Mensagem não textual') ? 'atendente' : message.text, { name: store.name, menuUrl: this.menuUrl(store.slug), greeting: connection.greeting, deliveryText: connection.deliveryText, handoffText: connection.handoffText, address: store.address, mapUrl: store.mapUrl, openingHours: setting?.openingHours || [], timezone: store.timezone, open: store.open, deliveryEnabled: setting?.deliveryEnabled === true, pickupEnabled: setting?.pickupEnabled !== false });
      // Deterministic key prevents duplicate replies after a worker restart.
      await this.messages.updateOne({ key: `bot:${message.key}` }, { $setOnInsert: { restaurantId: connection.restaurantId, conversationId: c._id, key: `bot:${message.key}`, direction: 'OUT', text: reply.text, controlReply: reply.optedOut ? 'stop' : reply.human ? 'handoff' : '', status: 'pending' } }, { upsert: true });
      if (reply.human || message.text.startsWith('[Mensagem não textual')) await this.conversations.updateOne({ _id: c._id }, { $set: { human: true } });
    }
    if (stop) await this.conversations.updateOne({ _id: c._id }, { $set: { optedOut: true } });
    await this.messages.updateOne({ _id: message._id }, { $set: { status: 'received' } });
  }
}
