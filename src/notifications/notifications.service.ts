import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  NotificationPreference,
  PushSubscriptionRecord,
  PushVapidConfig,
  Restaurant,
  User,
} from '../common/schemas';
import { Role } from '../common/roles';
import {
  generateVapidKeys,
  sendWebPush,
  WebPushHttpError,
  type VapidDetails,
} from './web-push-native';

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
};

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private vapid: VapidDetails | null = null;

  constructor(
    @InjectModel(NotificationPreference.name)
    private readonly preferences: Model<NotificationPreference>,
    @InjectModel(PushSubscriptionRecord.name)
    private readonly subscriptions: Model<PushSubscriptionRecord>,
    @InjectModel(PushVapidConfig.name)
    private readonly vapidConfigs: Model<PushVapidConfig>,
    @InjectModel(User.name)
    private readonly users: Model<User>,
    @InjectModel(Restaurant.name)
    private readonly restaurants: Model<Restaurant>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    try {
      await this.configureVapid();
      this.logger.log('Notificações Web Push inicializadas.');
    } catch (error) {
      this.logger.error(`Falha ao inicializar Web Push: ${error instanceof Error ? error.message : String(error)}`);
    }
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
      deviceCount: await this.subscriptions.countDocuments({ userId: uid }),
      publicKey: this.vapid?.publicKey ?? null,
      pushAvailable: Boolean(this.vapid),
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

  async saveSubscription(
    userId: string,
    subscription: {
      endpoint: string;
      expirationTime?: number | null;
      keys: { p256dh: string; auth: string };
    },
    userAgent?: string,
  ) {
    const uid = this.objectId(userId);
    if (!subscription.endpoint?.startsWith('https://') || !subscription.keys?.p256dh || !subscription.keys?.auth)
      throw new Error('Assinatura de notificação inválida.');
    await this.subscriptions.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        $set: {
          userId: uid,
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime ?? null,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent: userAgent?.slice(0, 500),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return { ok: true, deviceCount: await this.subscriptions.countDocuments({ userId: uid }) };
  }

  async removeSubscription(userId: string, endpoint: string) {
    const uid = this.objectId(userId);
    if (endpoint) await this.subscriptions.deleteOne({ userId: uid, endpoint });
    return { ok: true, deviceCount: await this.subscriptions.countDocuments({ userId: uid }) };
  }

  async sendTest(userId: string) {
    const user = await this.users.findById(this.objectId(userId)).lean();
    if (!user) return { ok: false, sent: 0 };
    const sent = await this.sendToUsers(
      [user],
      'newOrder',
      (target) => ({
        title: 'Menu Flow — notificações ativadas',
        body: 'Este dispositivo está pronto para avisar quando chegar um novo pedido.',
        tag: `mf-test-${target._id.toString()}`,
        url: target.role === Role.SUPER_ADMIN ? '/admin/notificacoes' : '/empresa/notificacoes',
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
    const number = input.orderNumber || 'Novo pedido';
    const total = (input.totalCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const service = input.fulfillment === 'DELIVERY' ? 'Entrega' : 'Retirada';
    await this.sendToUsers(users, 'newOrder', (user) => ({
      title: user.role === Role.SUPER_ADMIN ? `Novo pedido • ${input.restaurantName}` : 'Novo pedido recebido',
      body: `${number} • ${total} • ${service}`,
      tag: `new-order-${input.orderNumber || Date.now()}`,
      url: user.role === Role.SUPER_ADMIN ? '/admin/pedidos?status=pending' : '/empresa/pedidos?status=pending',
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
    const number = input.orderNumber || 'Pedido';
    await this.sendToUsers(users, 'orderCancelled', (user) => ({
      title: user.role === Role.SUPER_ADMIN ? `Pedido cancelado • ${store}` : 'Pedido cancelado',
      body: input.reason ? `${number} • ${input.reason}` : `${number} foi cancelado ou recusado.`,
      tag: `cancelled-${number}`,
      url: user.role === Role.SUPER_ADMIN ? '/admin/pedidos?status=cancelled' : '/empresa/pedidos?status=cancelled',
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
    const number = input.orderNumber || 'Pedido';
    await this.sendToUsers(users, 'orderStatus', (user) => ({
      title: user.role === Role.SUPER_ADMIN ? `Pedido atualizado • ${store}` : 'Pedido atualizado',
      body: `${number} agora está ${this.statusLabel(input.status)}.`,
      tag: `status-${number}-${input.status}`,
      url: user.role === Role.SUPER_ADMIN ? '/admin/pedidos' : '/empresa/pedidos',
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
    if (!this.vapid || users.length === 0) return 0;
    const userIds = users.map((user) => user._id as Types.ObjectId);
    const [preferenceRows, subscriptions] = await Promise.all([
      this.preferences.find({ userId: { $in: userIds } }).lean(),
      this.subscriptions.find({ userId: { $in: userIds } }).lean(),
    ]);
    const preferenceByUser = new Map(preferenceRows.map((row) => [row.userId.toString(), row]));
    const userById = new Map(users.map((user) => [user._id.toString(), user]));
    let sent = 0;
    await Promise.allSettled(subscriptions.map(async (subscription) => {
      const user = userById.get(subscription.userId.toString());
      if (!user) return;
      const preference = preferenceByUser.get(subscription.userId.toString());
      const enabled = preference?.enabled ?? true;
      const kindEnabled = preference?.[kind] ?? (kind === 'orderStatus' ? false : true);
      if ((!ignoreMasterPreference && !enabled) || (!ignoreTypePreference && !kindEnabled)) return;
      const payload = payloadFor(user);
      try {
        await sendWebPush(
          {
            endpoint: subscription.endpoint,
            expirationTime: subscription.expirationTime ?? null,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify({
            ...payload,
            icon: payload.icon || '/assets/branding/menu-flow-icon-192.png',
            badge: payload.badge || '/assets/branding/menu-flow-symbol.png',
          }),
          this.vapid!,
        );
        sent += 1;
      } catch (error) {
        if (error instanceof WebPushHttpError && (error.statusCode === 404 || error.statusCode === 410)) {
          await this.subscriptions.deleteOne({ _id: (subscription as any)._id });
          return;
        }
        this.logger.warn(`Falha ao enviar notificação push: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return sent;
  }

  private async configureVapid() {
    const envPublic = this.config.get<string>('WEB_PUSH_PUBLIC_KEY')?.trim();
    const envPrivate = this.config.get<string>('WEB_PUSH_PRIVATE_KEY')?.trim();
    let publicKey = envPublic;
    let privateKey = envPrivate;

    if (!publicKey || !privateKey) {
      let stored = await this.vapidConfigs.findOne({ key: 'global' }).select('+privateKey').lean();
      if (!stored) {
        const generated = generateVapidKeys();
        try {
          const created = await this.vapidConfigs.create({ key: 'global', ...generated });
          publicKey = created.publicKey;
          privateKey = generated.privateKey;
        } catch (error) {
          if ((error as { code?: number }).code !== 11000) throw error;
          stored = await this.vapidConfigs.findOne({ key: 'global' }).select('+privateKey').lean();
        }
      }
      if (stored) {
        publicKey = stored.publicKey;
        privateKey = stored.privateKey;
      }
    }

    if (!publicKey || !privateKey) throw new Error('Não foi possível obter as chaves VAPID.');
    const configuredSubject = this.config.get<string>('WEB_PUSH_SUBJECT')?.trim();
    const frontendUrl = this.config.get<string>('FRONTEND_URL')?.split(',')[0]?.trim();
    const subject = configuredSubject || (frontendUrl?.startsWith('https://') ? frontendUrl : 'mailto:notificacoes@menuflow.local');
    this.vapid = { subject, publicKey, privateKey };
  }

  private objectId(value: string) {
    if (!Types.ObjectId.isValid(value)) throw new Error('Identificador inválido.');
    return new Types.ObjectId(value);
  }

  private statusLabel(status: string) {
    return ({
      PENDING: 'aguardando aceitação',
      ACCEPTED: 'aceito',
      PREPARING: 'em preparo',
      READY: 'pronto',
      OUT_FOR_DELIVERY: 'saiu para entrega',
      COMPLETED: 'finalizado',
      REJECTED: 'recusado',
      CANCELLED: 'cancelado',
    } as Record<string, string>)[status] || status.toLowerCase();
  }
}
