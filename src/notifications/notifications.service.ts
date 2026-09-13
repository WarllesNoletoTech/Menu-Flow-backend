import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotificationPreference, Restaurant, User } from '../common/schemas';
import { Role } from '../common/roles';

export type NotificationPreferencesInput = {
  enabled?: boolean;
  newOrder?: boolean;
  orderCancelled?: boolean;
  orderStatus?: boolean;
};

type NotificationKind = 'newOrder' | 'orderCancelled' | 'orderStatus';
type PushPayload = {
  title: string;
  body: string;
  tag: string;
  url: string;
  icon?: string;
  badge?: string;
  kind?: NotificationKind | 'test';
};

type OneSignalResponse = {
  id?: string;
  recipients?: number;
  errors?: unknown;
};

const DEFAULT_ONESIGNAL_APP_ID = '2a519701-a888-4d97-90e3-e345d2dd3bea';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private oneSignalAppId = '';
  private oneSignalApiKey = '';
  private frontendOrigin = 'https://menuflowexpress.vercel.app';

  constructor(
    @InjectModel(NotificationPreference.name)
    private readonly preferences: Model<NotificationPreference>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
    @InjectModel(Restaurant.name)
    private readonly restaurants: Model<Restaurant>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.configureOneSignal();
  }

  async getPreferences(userId: string) {
    const uid = this.objectId(userId);
    const row = await this.preferences.findOneAndUpdate(
      { userId: uid },
      { $setOnInsert: { userId: uid, enabled: true, newOrder: true, orderCancelled: true, orderStatus: false } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    if (!row) throw new Error('Não foi possível carregar as preferências de notificação.');
    return {
      enabled: row.enabled,
      newOrder: row.newOrder,
      orderCancelled: row.orderCancelled,
      orderStatus: row.orderStatus,
      deviceCount: 0,
      publicKey: null,
      pushAvailable: this.oneSignalReady(),
      provider: 'onesignal' as const,
    };
  }

  async updatePreferences(userId: string, input: NotificationPreferencesInput) {
    const uid = this.objectId(userId);
    const changes: NotificationPreferencesInput = {};
    for (const key of ['enabled', 'newOrder', 'orderCancelled', 'orderStatus'] as const) {
      if (typeof input[key] === 'boolean') changes[key] = input[key];
    }
    await this.preferences.findOneAndUpdate(
      { userId: uid },
      { $set: changes, $setOnInsert: { userId: uid } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return this.getPreferences(userId);
  }

  /**
   * Endpoints mantidos por compatibilidade temporária com instalações antigas.
   * O envio atual usa OneSignal e não precisa armazenar Web Push/VAPID no Menu Flow.
   */
  async saveSubscription(_userId: string, _subscription: unknown, _userAgent?: string) {
    return { ok: true, deviceCount: 0, provider: 'onesignal' };
  }

  async removeSubscription(_userId: string, _endpoint: string) {
    return { ok: true, deviceCount: 0, provider: 'onesignal' };
  }

  async renewSubscription(_oldEndpoint: string, _oldAuth: string, _subscription: unknown) {
    return { ok: false, provider: 'onesignal' };
  }

  async pullPendingNotifications(_deliveryToken: string) {
    return { ok: false, notifications: [] as PushPayload[], provider: 'onesignal' };
  }

  async sendTest(userId: string) {
    const user = await this.users.findById(this.objectId(userId)).lean();
    if (!user) return { ok: false, sent: 0 };
    const sent = await this.sendToUsers(
      [user],
      'newOrder',
      (target) => ({
        title: '🔔 Teste de notificação — Menu Flow',
        body: target.role === Role.SUPER_ADMIN
          ? 'Tudo certo! As notificações administrativas estão funcionando neste dispositivo.'
          : 'Tudo certo! Você receberá avisos dos pedidos da sua loja neste dispositivo.',
        tag: `mf-test-${target._id.toString()}`,
        url: target.role === Role.SUPER_ADMIN ? '/admin/notificacoes' : '/empresa/notificacoes',
        kind: 'test',
      }),
      true,
      true,
    );
    return { ok: sent > 0, sent };
  }

  async notifyNewOrder(input: {
    restaurantId: string;
    restaurantName: string;
    orderNumber?: string;
    totalCents: number;
    fulfillment: string;
  }) {
    const users = await this.notificationRecipients(input.restaurantId);
    const number = this.orderNumber(input.orderNumber);
    const total = (input.totalCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const service = input.fulfillment === 'DELIVERY' ? 'Entrega' : 'Retirada no local';

    await this.sendToUsers(users, 'newOrder', (user) => ({
      title: user.role === Role.SUPER_ADMIN
        ? `🛎️ Novo pedido • ${input.restaurantName}`
        : '🛎️ Novo pedido recebido!',
      body: user.role === Role.SUPER_ADMIN
        ? `${number} • ${total} • ${service}. Toque para acompanhar.`
        : `${number} • ${total} • ${service}. Toque para abrir e aceitar o pedido.`,
      tag: `new-order-${input.orderNumber || Date.now()}`,
      url: user.role === Role.SUPER_ADMIN ? '/admin/pedidos?status=pending' : '/empresa/pedidos?status=pending',
      kind: 'newOrder',
    }));
  }

  async notifyOrderCancelled(input: {
    restaurantId: string;
    orderNumber?: string;
    reason?: string;
  }) {
    const [users, restaurant] = await Promise.all([
      this.notificationRecipients(input.restaurantId),
      this.restaurants.findById(this.objectId(input.restaurantId)).lean(),
    ]);
    const store = restaurant?.tradeName || restaurant?.name || 'Estabelecimento';
    const number = this.orderNumber(input.orderNumber);
    const reason = input.reason?.trim();

    await this.sendToUsers(users, 'orderCancelled', (user) => ({
      title: user.role === Role.SUPER_ADMIN
        ? `❌ Pedido cancelado • ${store}`
        : '❌ Pedido cancelado ou recusado',
      body: reason
        ? `${number} foi cancelado. Motivo: ${reason}`
        : `${number} foi cancelado ou recusado. Toque para ver os detalhes.`,
      tag: `cancelled-${input.orderNumber || 'pedido'}`,
      url: user.role === Role.SUPER_ADMIN ? '/admin/pedidos?status=cancelled' : '/empresa/pedidos?status=cancelled',
      kind: 'orderCancelled',
    }));
  }

  async notifyOrderStatus(input: {
    restaurantId: string;
    orderNumber?: string;
    status: string;
  }) {
    const [users, restaurant] = await Promise.all([
      this.notificationRecipients(input.restaurantId),
      this.restaurants.findById(this.objectId(input.restaurantId)).lean(),
    ]);
    const store = restaurant?.tradeName || restaurant?.name || 'Estabelecimento';
    const number = this.orderNumber(input.orderNumber);
    const status = this.statusNotification(input.status, number);

    await this.sendToUsers(users, 'orderStatus', (user) => ({
      title: user.role === Role.SUPER_ADMIN ? `${status.title} • ${store}` : status.title,
      body: status.body,
      tag: `status-${input.orderNumber || 'pedido'}-${input.status}`,
      url: user.role === Role.SUPER_ADMIN ? '/admin/pedidos' : '/empresa/pedidos',
      kind: 'orderStatus',
    }));
  }

  private async notificationRecipients(restaurantId: string) {
    const rid = this.objectId(restaurantId);
    return this.users.find({
      active: true,
      $and: [
        { $or: [{ role: Role.SUPER_ADMIN }, { role: Role.RESTAURANT_ADMIN, restaurantId: rid }] },
        { $or: [{ deletedAt: { $exists: false } }, { deletedAt: null }] },
      ],
    }).lean();
  }

  private async sendToUsers(
    users: Array<any>,
    kind: NotificationKind,
    payloadFor: (user: any) => PushPayload,
    ignoreTypePreference = false,
    ignoreMasterPreference = false,
  ) {
    if (!this.oneSignalReady() || users.length === 0) return 0;

    const userIds = users.map((user) => user._id as Types.ObjectId);
    const preferenceRows = await this.preferences.find({ userId: { $in: userIds } }).lean();
    const preferenceByUser = new Map(preferenceRows.map((row) => [row.userId.toString(), row]));

    const groups = new Map<string, { payload: PushPayload; externalIds: string[] }>();
    for (const user of users) {
      const preference = preferenceByUser.get(user._id.toString());
      const enabled = preference?.enabled ?? true;
      const kindEnabled = preference?.[kind] ?? (kind === 'orderStatus' ? false : true);
      if ((!ignoreMasterPreference && !enabled) || (!ignoreTypePreference && !kindEnabled)) continue;

      const payload = payloadFor(user);
      const key = JSON.stringify([payload.title, payload.body, payload.url, payload.tag, payload.kind]);
      const current = groups.get(key) || { payload, externalIds: [] };
      current.externalIds.push(this.externalId(user._id.toString()));
      groups.set(key, current);
    }

    let sent = 0;
    for (const group of groups.values()) {
      try {
        sent += await this.sendOneSignal(group.externalIds, group.payload);
      } catch (error) {
        this.logger.warn(`Falha ao enviar notificação via OneSignal: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return sent;
  }

  private async sendOneSignal(externalIds: string[], payload: PushPayload) {
    if (!externalIds.length) return 0;
    const icon = this.absoluteUrl(payload.icon || '/assets/branding/menu-flow-notification-icon.png');
    const badge = this.absoluteUrl(payload.badge || '/assets/branding/menu-flow-notification-icon.png');
    const url = this.absoluteUrl(payload.url);

    const response = await fetch('https://api.onesignal.com/notifications?c=push', {
      method: 'POST',
      headers: {
        Authorization: `Key ${this.oneSignalApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        app_id: this.oneSignalAppId,
        target_channel: 'push',
        include_aliases: { external_id: externalIds },
        headings: { en: payload.title, pt: payload.title },
        contents: { en: payload.body, pt: payload.body },
        web_url: url,
        chrome_web_icon: icon,
        chrome_web_badge: badge,
        name: `menu-flow-${payload.tag}`.slice(0, 128),
        custom_data: {
          source: 'MENU_FLOW',
          type: payload.kind || 'notification',
          route: payload.url,
          tag: payload.tag,
        },
      }),
    });

    const data = await response.json().catch(() => ({})) as OneSignalResponse;
    if (!response.ok) {
      throw new Error(`OneSignal respondeu ${response.status}: ${JSON.stringify(data.errors || data)}`);
    }

    // A API pode não retornar recipients em alguns modos de targeting por alias.
    // Nesse caso, a requisição aceita pelo OneSignal conta como envio para os IDs alvo.
    return typeof data.recipients === 'number' ? data.recipients : externalIds.length;
  }

  private configureOneSignal() {
    this.oneSignalAppId = this.config.get<string>('ONESIGNAL_APP_ID')?.trim() || DEFAULT_ONESIGNAL_APP_ID;
    this.oneSignalApiKey =
      this.config.get<string>('ONESIGNAL_REST_API_KEY')?.trim() ||
      this.config.get<string>('ONESIGNAL_APP_API_KEY')?.trim() ||
      this.config.get<string>('ONESIGNAL_API_KEY')?.trim() ||
      '';

    const configuredFrontend = this.config.get<string>('FRONTEND_URL')?.split(',')[0]?.trim();
    if (configuredFrontend?.startsWith('http://') || configuredFrontend?.startsWith('https://')) {
      this.frontendOrigin = configuredFrontend.replace(/\/$/, '');
    }

    if (this.oneSignalReady()) {
      this.logger.log('Notificações OneSignal inicializadas para o Menu Flow.');
    } else {
      this.logger.warn('OneSignal não está pronto. Configure ONESIGNAL_REST_API_KEY no backend.');
    }
  }

  private oneSignalReady() {
    return Boolean(this.oneSignalAppId && this.oneSignalApiKey);
  }

  private externalId(userId: string) {
    return `mf-staff:${userId}`;
  }

  private absoluteUrl(pathOrUrl: string) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.frontendOrigin}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`;
  }

  private orderNumber(value?: string) {
    const clean = value?.trim();
    if (!clean) return 'Pedido';
    return clean.startsWith('#') ? clean : `#${clean}`;
  }

  private statusNotification(status: string, number: string) {
    const byStatus: Record<string, { title: string; body: string }> = {
      PENDING: {
        title: '⏳ Pedido aguardando aceitação',
        body: `${number} está aguardando aceitação.`,
      },
      ACCEPTED: {
        title: '✅ Pedido aceito',
        body: `${number} foi aceito e entrou em andamento.`,
      },
      PREPARING: {
        title: '👨‍🍳 Pedido em preparo',
        body: `${number} começou a ser preparado.`,
      },
      READY: {
        title: '📦 Pedido pronto',
        body: `${number} está pronto para a próxima etapa.`,
      },
      OUT_FOR_DELIVERY: {
        title: '🛵 Pedido saiu para entrega',
        body: `${number} saiu para entrega ao cliente.`,
      },
      COMPLETED: {
        title: '🎉 Pedido finalizado',
        body: `${number} foi concluído com sucesso.`,
      },
      REJECTED: {
        title: '❌ Pedido recusado',
        body: `${number} foi recusado.`,
      },
      CANCELLED: {
        title: '❌ Pedido cancelado',
        body: `${number} foi cancelado.`,
      },
    };
    return byStatus[status] || {
      title: '🔔 Pedido atualizado',
      body: `${number} teve uma atualização de status.`,
    };
  }

  private objectId(value: string) {
    if (!Types.ObjectId.isValid(value)) throw new Error('Identificador inválido.');
    return new Types.ObjectId(value);
  }
}
