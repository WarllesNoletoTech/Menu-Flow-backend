import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Order, Restaurant } from '../common/schemas';
import { OrdersGateway } from '../orders/orders.gateway';

type RappidexCreateResponse = {
  accepted?: boolean;
  created?: boolean;
  reason?: string;
  message?: string;
  delivery?: { id?: string; status?: string };
};

type RappidexReleaseResponse = {
  found?: boolean;
  released?: boolean;
  alreadyReleased?: boolean;
  finished?: boolean;
  cancelled?: boolean;
  delivery?: { id?: string; status?: string };
};

type RappidexCancelResponse = {
  found?: boolean;
  cancelled?: boolean;
  locked?: boolean;
  finished?: boolean;
  status?: string;
  deliveryId?: string;
};

type RappidexStatusEvent = {
  orderId: string;
  deliveryId: string;
  status: string;
  statusLabel?: string;
  eventId?: string;
  updatedAt?: string;
  motoboyName?: string;
  motoboyPhone?: string;
  reason?: string;
};

const RAPPIDEX_ASSIGNED_STATUSES = new Set([
  'ACAMINHO',
  'CHEGOU_ESTABELECIMENTO',
  'COLETADO',
  'CHEGOU_DESTINO',
  'AGUARDANDO_CODIGO',
]);

const RAPPIDEX_STATUS_RANK: Record<string, number> = {
  AGUARDANDO_LIBERACAO: 0,
  PENDENTE: 1,
  ACAMINHO: 2,
  CHEGOU_ESTABELECIMENTO: 3,
  COLETADO: 4,
  CHEGOU_DESTINO: 5,
  AGUARDANDO_CODIGO: 6,
  FINALIZADO: 7,
};

const RAPPIDEX_STATUS_LABELS: Record<string, string> = {
  AGUARDANDO_LIBERACAO: 'Aguardando liberação',
  PENDENTE: 'Aguardando motoboy',
  ACAMINHO: 'Motoboy indo até o estabelecimento',
  CHEGOU_ESTABELECIMENTO: 'Motoboy chegou ao estabelecimento',
  COLETADO: 'Motoboy a caminho do cliente',
  CHEGOU_DESTINO: 'Motoboy chegou ao destino',
  AGUARDANDO_CODIGO: 'Aguardando código de entrega',
  FINALIZADO: 'Entrega concluída',
  CANCELADO: 'Entrega cancelada',
};

@Injectable()
export class RappidexIntegrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RappidexIntegrationService.name);
  private retryTimer?: NodeJS.Timeout;

  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    private readonly config: ConfigService,
    private readonly gateway: OrdersGateway,
  ) {}

  onModuleInit() {
    this.retryTimer = setInterval(() => void this.retryPending(), 60_000);
    this.retryTimer.unref?.();
    setTimeout(() => void this.retryPending(), 5_000).unref?.();
  }

  onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  isDeliveryAssignedStatus(status?: string) {
    return Boolean(status && RAPPIDEX_ASSIGNED_STATUSES.has(status));
  }

  queueOrder(orderId: string) {
    void this.activateOrderSync(orderId).catch((error) => {
      this.logger.warn(
        `Menu Flow -> Rappidex falhou no envio após aceite orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  handleOrderStatusChange(orderId: string, status: string) {
    if (status === 'ACCEPTED') {
      this.queueOrder(orderId);
      return;
    }

    if (status === 'READY') {
      void this.requestRelease(orderId).catch((error) => {
        this.logger.warn(
          `Menu Flow -> Rappidex falhou ao liberar entrega orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }

    if (!['REJECTED', 'CANCELLED'].includes(status)) return;
    void this.requestCancellation(orderId).catch((error) => {
      this.logger.warn(
        `Menu Flow -> Rappidex falhou ao solicitar cancelamento orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async applyStatusUpdate(event: RappidexStatusEvent) {
    if (!Types.ObjectId.isValid(event.orderId)) {
      throw new NotFoundException('Pedido Menu Flow não encontrado.');
    }

    const order = await this.orders.findById(event.orderId);
    if (!order) throw new NotFoundException('Pedido Menu Flow não encontrado.');
    if (order.fulfillment !== 'DELIVERY') {
      throw new ConflictException('Pedido de retirada não possui entrega Rappidex.');
    }
    if (order.rappidexDeliveryId && order.rappidexDeliveryId !== event.deliveryId) {
      throw new ConflictException('A entrega Rappidex informada não corresponde a este pedido.');
    }

    if (event.eventId && order.rappidexLastEventId === event.eventId) {
      return {
        ok: true,
        duplicate: true,
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        menuFlowStatus: order.status,
        rappidexStatus: order.rappidexStatus,
      };
    }

    const parsedDate = event.updatedAt ? new Date(event.updatedAt) : new Date();
    const effectiveDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    const currentUpdateAt = order.rappidexLastUpdateAt
      ? new Date(order.rappidexLastUpdateAt)
      : undefined;

    if (currentUpdateAt && effectiveDate.getTime() < currentUpdateAt.getTime()) {
      this.logger.warn(
        `Rappidex -> Menu Flow ignorou evento antigo order=${order.orderNumber || order._id.toString()} incoming=${event.status} incomingAt=${effectiveDate.toISOString()} current=${order.rappidexStatus || 'N/A'} currentAt=${currentUpdateAt.toISOString()}`,
      );
      return {
        ok: true,
        stale: true,
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        menuFlowStatus: order.status,
        rappidexStatus: order.rappidexStatus,
      };
    }

    if (
      (order.status === 'CANCELLED' && event.status !== 'CANCELADO') ||
      (order.status === 'COMPLETED' && event.status !== 'FINALIZADO') ||
      order.status === 'REJECTED'
    ) {
      return {
        ok: true,
        stale: true,
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        menuFlowStatus: order.status,
        rappidexStatus: order.rappidexStatus,
      };
    }

    const currentRank = order.rappidexStatus
      ? RAPPIDEX_STATUS_RANK[order.rappidexStatus]
      : undefined;
    const incomingRank = RAPPIDEX_STATUS_RANK[event.status];
    if (
      event.status !== 'CANCELADO' &&
      event.status !== 'FINALIZADO' &&
      currentRank !== undefined &&
      incomingRank !== undefined &&
      incomingRank < currentRank
    ) {
      this.logger.warn(
        `Rappidex -> Menu Flow ignorou regressão order=${order.orderNumber || order._id.toString()} current=${order.rappidexStatus} incoming=${event.status}`,
      );
      return {
        ok: true,
        stale: true,
        orderId: order._id.toString(),
        orderNumber: order.orderNumber,
        menuFlowStatus: order.status,
        rappidexStatus: order.rappidexStatus,
      };
    }

    order.rappidexDeliveryId = event.deliveryId;
    order.rappidexStatus = event.status;
    order.rappidexStatusLabel =
      event.statusLabel?.trim() || RAPPIDEX_STATUS_LABELS[event.status] || event.status;
    order.rappidexLastEventId = event.eventId;
    order.rappidexLastUpdateAt = effectiveDate;
    order.rappidexSyncedAt = order.rappidexSyncedAt ?? new Date();
    order.rappidexSyncRequested = false;
    order.rappidexSyncStatus = 'SYNCED';
    order.rappidexSyncError = '';
    if (event.motoboyName !== undefined) order.rappidexMotoboyName = event.motoboyName;
    if (event.motoboyPhone !== undefined) order.rappidexMotoboyPhone = event.motoboyPhone;

    const isTerminal = ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(order.status);

    if (event.status === 'CANCELADO' && !isTerminal) {
      this.setMenuFlowStatus(order, 'CANCELLED', effectiveDate);
      order.cancelledAt = effectiveDate;
      order.cancellationReason = event.reason?.trim() || 'Entrega cancelada pela Rappidex.';
    } else if (event.status === 'FINALIZADO' && !isTerminal) {
      this.advanceToOutForDelivery(order, effectiveDate);
      this.setMenuFlowStatus(order, 'COMPLETED', effectiveDate);
      order.completedAt = effectiveDate;
    } else if (RAPPIDEX_ASSIGNED_STATUSES.has(event.status) && !isTerminal) {
      this.advanceToOutForDelivery(order, effectiveDate);
    }

    await order.save();
    const json = order.toJSON();
    this.gateway.publishOrderUpdated(
      order.restaurantId.toString(),
      order.customerId?.toString(),
      json,
    );

    this.logger.log(
      `Rappidex -> Menu Flow order=${order.orderNumber || order._id.toString()} deliveryId=${event.deliveryId} rappidexStatus=${event.status} menuFlowStatus=${order.status}`,
    );

    return {
      ok: true,
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      menuFlowStatus: order.status,
      rappidexStatus: order.rappidexStatus,
      rappidexStatusLabel: order.rappidexStatusLabel,
    };
  }

  private setMenuFlowStatus(order: any, status: string, changedAt: Date) {
    if (order.status === status) return;
    order.status = status;
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status, changedAt });
  }

  private advanceToOutForDelivery(order: any, changedAt: Date) {
    const sequence = ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY'];
    const currentIndex = sequence.indexOf(order.status);
    const targetIndex = sequence.indexOf('OUT_FOR_DELIVERY');
    if (currentIndex < 0 || currentIndex >= targetIndex) return;

    for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
      const status = sequence[index];
      this.setMenuFlowStatus(order, status, changedAt);
      if (status === 'ACCEPTED' && !order.acceptedAt) order.acceptedAt = changedAt;
      if (status === 'PREPARING' && !order.preparingAt) order.preparingAt = changedAt;
      if (status === 'READY' && !order.readyAt) order.readyAt = changedAt;
      if (status === 'OUT_FOR_DELIVERY' && !order.outForDeliveryAt) {
        order.outForDeliveryAt = changedAt;
      }
    }
  }

  private async activateOrderSync(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return;
    const order = await this.orders.findById(orderId).lean();
    if (!order || order.fulfillment !== 'DELIVERY') return;
    if (['PENDING', 'REJECTED', 'CANCELLED', 'COMPLETED'].includes(order.status)) return;
    if (order.rappidexDeliveryId) return;

    await this.orders.updateOne(
      { _id: order._id },
      {
        $set: {
          rappidexSyncRequested: true,
          rappidexSyncStatus: 'PENDING',
          rappidexSyncError: '',
        },
      },
    );
    await this.syncOrder(orderId);
  }

  private async syncOrder(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return;
    const order = await this.orders.findById(orderId).lean();
    if (!order || order.fulfillment !== 'DELIVERY' || !order.rappidexSyncRequested) return;
    if (['PENDING', 'REJECTED', 'CANCELLED', 'COMPLETED'].includes(order.status)) return;

    if (order.rappidexDeliveryId) {
      await this.orders.updateOne(
        { _id: order._id },
        { $set: { rappidexSyncRequested: false, rappidexSyncStatus: 'SYNCED' } },
      );
      return;
    }

    const restaurant = await this.restaurants.findById(order.restaurantId).lean();
    if (!restaurant) {
      await this.markFailure(order._id, 'Estabelecimento Menu Flow não encontrado.');
      return;
    }

    await this.orders.updateOne(
      { _id: order._id },
      {
        $set: { rappidexLastAttemptAt: new Date(), rappidexSyncStatus: 'PENDING' },
        $inc: { rappidexSyncAttempts: 1 },
      },
    );

    try {
      const response = await this.request<RappidexCreateResponse>('/integrations/menuflow/deliveries', {
        method: 'POST',
        body: JSON.stringify({
          orderId: order._id.toString(),
          orderNumber: order.orderNumber || order._id.toString(),
          restaurantId: order.restaurantId.toString(),
          restaurantName: restaurant.tradeName || restaurant.name,
          customerName: order.customerName,
          customerPhone: order.phone,
          address: order.address || {},
          subtotalCents: order.subtotalCents ?? Math.round(Number(order.subtotal || 0) * 100),
          deliveryFeeCents: order.deliveryFeeCents ?? Math.round(Number(order.deliveryFee || 0) * 100),
          customerServiceFeeCents: order.customerServiceFeeCents ?? 0,
          discountCents: order.discountCents ?? Math.round(Number(order.discount || 0) * 100),
          totalCents: order.totalCents ?? Math.round(Number(order.total || 0) * 100),
          paymentMethod: order.paymentMethod,
          needsChange: order.needsChange,
          changeForCents: order.changeForCents,
          expectedChangeCents: order.expectedChangeCents,
          items: (order.items || []).map((item: any) => ({
            productName: item.productName,
            quantity: item.quantity,
            unitPriceCents: item.unitPriceCents ?? Math.round(Number(item.unitPrice || 0) * 100),
            observation: item.observation,
            addons: (item.addons || []).map((addon: any) => ({
              name: addon.name,
              groupName: addon.groupName,
              priceCents: addon.priceCents ?? Math.round(Number(addon.price || 0) * 100),
            })),
          })),
          createdAt: (order as any).createdAt,
        }),
      });

      if (response?.accepted === false) {
        const reason = String(response.reason || 'NOT_LINKED').trim() || 'NOT_LINKED';
        await this.orders.updateOne(
          { _id: order._id },
          {
            $set: {
              rappidexSyncRequested: false,
              rappidexReleaseRequested: false,
              rappidexSyncStatus: reason,
              rappidexSyncError: response.message || '',
              rappidexLastUpdateAt: new Date(),
            },
          },
        );
        this.logger.log(
          `Menu Flow -> Rappidex ignorado order=${order.orderNumber || order._id} reason=${reason}`,
        );
        return;
      }

      const deliveryId = String(response?.delivery?.id || '').trim();
      if (!deliveryId) throw new Error('A Rappidex não retornou o identificador da entrega.');

      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexSyncRequested: false,
            rappidexDeliveryId: deliveryId,
            rappidexStatus: response?.delivery?.status || 'AGUARDANDO_LIBERACAO',
            rappidexStatusLabel:
              RAPPIDEX_STATUS_LABELS[response?.delivery?.status || 'AGUARDANDO_LIBERACAO'] ||
              response?.delivery?.status ||
              'Aguardando liberação',
            rappidexSyncedAt: new Date(),
            rappidexSyncStatus: 'SYNCED',
            rappidexSyncError: '',
          },
        },
      );

      const fresh = await this.orders.findById(order._id).lean();
      if (fresh) {
        this.gateway.publishOrderUpdated(
          fresh.restaurantId.toString(),
          fresh.customerId?.toString(),
          fresh,
        );
      }

      this.logger.log(
        `Menu Flow -> Rappidex order=${order.orderNumber || order._id} deliveryId=${deliveryId}`,
      );

      if (order.rappidexReleaseRequested || order.status === 'READY') {
        await this.requestRelease(order._id.toString());
      }
    } catch (error) {
      await this.markFailure(order._id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private async requestRelease(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return;
    const order = await this.orders.findById(orderId).lean();
    if (!order || order.fulfillment !== 'DELIVERY') return;
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(order.status)) return;

    if (!order.rappidexDeliveryId) {
      if (order.rappidexSyncRequested || ['PENDING', 'FAILED'].includes(order.rappidexSyncStatus || '')) {
        await this.orders.updateOne(
          { _id: order._id },
          { $set: { rappidexReleaseRequested: true } },
        );
        if (order.rappidexSyncRequested) await this.syncOrder(orderId);
      }
      return;
    }

    if (order.rappidexStatus && order.rappidexStatus !== 'AGUARDANDO_LIBERACAO') {
      await this.orders.updateOne(
        { _id: order._id },
        { $set: { rappidexReleaseRequested: false } },
      );
      return;
    }

    await this.orders.updateOne(
      { _id: order._id },
      { $set: { rappidexReleaseRequested: true, rappidexSyncError: '' } },
    );

    try {
      const response = await this.request<RappidexReleaseResponse>(
        `/integrations/menuflow/deliveries/${encodeURIComponent(order._id.toString())}/release`,
        { method: 'POST' },
      );
      const nextStatus = response?.delivery?.status;
      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexReleaseRequested: false,
            rappidexSyncError: '',
            ...(nextStatus
              ? {
                  rappidexStatus: nextStatus,
                  rappidexStatusLabel: RAPPIDEX_STATUS_LABELS[nextStatus] || nextStatus,
                }
              : {}),
          },
        },
      );
    } catch (error) {
      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexReleaseRequested: true,
            rappidexSyncError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          },
        },
      );
      throw error;
    }
  }

  private async requestCancellation(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return;
    const order = await this.orders.findById(orderId).lean();
    if (!order || order.fulfillment !== 'DELIVERY') return;

    const integrationWasCreated = Boolean(order.rappidexDeliveryId || order.rappidexSyncStatus === 'SYNCED');
    if (!integrationWasCreated) {
      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexSyncRequested: false,
            rappidexReleaseRequested: false,
            rappidexCancelRequested: false,
          },
        },
      );
      return;
    }

    await this.orders.updateOne(
      { _id: order._id },
      { $set: { rappidexCancelRequested: true, rappidexSyncStatus: 'CANCEL_PENDING' } },
    );

    try {
      const response = await this.request<RappidexCancelResponse>(
        `/integrations/menuflow/deliveries/${encodeURIComponent(order._id.toString())}/cancel`,
        { method: 'POST' },
      );
      if (response?.cancelled === false && response?.locked) {
        throw new Error('A entrega já foi assumida por um motoboy e não pode mais ser cancelada pelo Menu Flow.');
      }
      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexSyncRequested: false,
            rappidexReleaseRequested: false,
            rappidexCancelRequested: false,
            rappidexSyncStatus: 'CANCELLED',
            rappidexSyncError: '',
          },
        },
      );
    } catch (error) {
      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexCancelRequested: true,
            rappidexSyncStatus: 'CANCEL_PENDING',
            rappidexSyncError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          },
        },
      );
      throw error;
    }
  }

  private async retryPending() {
    try {
      const [cancellations, releases, creations] = await Promise.all([
        this.orders.find({ rappidexCancelRequested: true }).select('_id').sort({ createdAt: 1 }).limit(20).lean(),
        this.orders.find({ rappidexReleaseRequested: true }).select('_id').sort({ createdAt: 1 }).limit(20).lean(),
        this.orders
          .find({
            rappidexSyncRequested: true,
            fulfillment: 'DELIVERY',
            status: { $in: ['ACCEPTED', 'PREPARING', 'READY'] },
            rappidexSyncStatus: { $in: ['PENDING', 'FAILED'] },
          })
          .select('_id')
          .sort({ createdAt: 1 })
          .limit(20)
          .lean(),
      ]);

      await Promise.allSettled(cancellations.map((item) => this.requestCancellation(item._id.toString())));
      await Promise.allSettled(creations.map((item) => this.syncOrder(item._id.toString())));
      await Promise.allSettled(releases.map((item) => this.requestRelease(item._id.toString())));
    } catch (error) {
      this.logger.warn(`Fila Rappidex: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async markFailure(orderId: Types.ObjectId, message: string) {
    await this.orders.updateOne(
      { _id: orderId },
      {
        $set: {
          rappidexSyncStatus: 'FAILED',
          rappidexSyncError: String(message).slice(0, 1000),
          rappidexLastAttemptAt: new Date(),
        },
      },
    );
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const rawBase = String(this.config.get<string>('RAPPIDEX_API_URL') || '').trim();
    const secret = String(this.config.get<string>('RAPPIDEX_INTEGRATION_SECRET') || '').trim();
    if (!rawBase || !secret) {
      throw new Error('RAPPIDEX_API_URL e RAPPIDEX_INTEGRATION_SECRET precisam estar configurados no backend do Menu Flow.');
    }

    const cleanBase = rawBase.replace(/\/+$/, '');
    const base = cleanBase.endsWith('/api') ? cleanBase : `${cleanBase}/api`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${secret}`,
          ...(init.headers || {}),
        },
      });
      const text = await response.text();
      let body: any = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!response.ok) {
        const detail = body?.message || body?.error || text || `HTTP ${response.status}`;
        throw new Error(`Rappidex respondeu ${response.status}: ${Array.isArray(detail) ? detail.join(', ') : detail}`);
      }
      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
