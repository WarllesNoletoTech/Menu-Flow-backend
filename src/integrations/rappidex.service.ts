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

type RappidexStatusEvent = {
  orderId: string;
  deliveryId: string;
  status: string;
  eventId?: string;
  updatedAt?: string;
  motoboyName?: string;
  motoboyPhone?: string;
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

  queueOrder(orderId: string) {
    void this.syncOrder(orderId).catch((error) => {
      this.logger.warn(
        `Menu Flow -> Rappidex falhou no envio imediato orderId=${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  handleOrderStatusChange(orderId: string, status: string) {
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

    const now = event.updatedAt ? new Date(event.updatedAt) : new Date();
    const effectiveDate = Number.isNaN(now.getTime()) ? new Date() : now;
    order.rappidexDeliveryId = event.deliveryId;
    order.rappidexStatus = event.status;
    order.rappidexLastUpdateAt = effectiveDate;
    order.rappidexSyncedAt = order.rappidexSyncedAt ?? new Date();
    order.rappidexSyncRequested = false;
    order.rappidexSyncStatus = 'SYNCED';
    order.rappidexSyncError = '';
    if (event.motoboyName !== undefined) order.rappidexMotoboyName = event.motoboyName;
    if (event.motoboyPhone !== undefined) order.rappidexMotoboyPhone = event.motoboyPhone;

    const menuFlowChangedAt = new Date();
    const currentStatus = order.status;
    const isTerminal = ['COMPLETED', 'REJECTED', 'CANCELLED'].includes(currentStatus);
    let nextMenuFlowStatus: string | undefined;

    if (event.status === 'ACAMINHO' && !isTerminal && currentStatus !== 'OUT_FOR_DELIVERY') {
      nextMenuFlowStatus = 'OUT_FOR_DELIVERY';
      order.outForDeliveryAt = menuFlowChangedAt;
    }
    if (event.status === 'FINALIZADO' && !isTerminal) {
      nextMenuFlowStatus = 'COMPLETED';
      order.completedAt = menuFlowChangedAt;
    }

    if (nextMenuFlowStatus) {
      order.status = nextMenuFlowStatus;
      if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
      order.statusHistory.push({ status: nextMenuFlowStatus, changedAt: menuFlowChangedAt });
    }

    await order.save();
    const json = order.toJSON();
    this.gateway.publishOrderUpdated(
      order.restaurantId.toString(),
      order.customerId?.toString(),
      json,
    );

    this.logger.log(
      `Rappidex -> Menu Flow order=${order.orderNumber || order._id.toString()} deliveryId=${event.deliveryId} rappidexStatus=${event.status}${nextMenuFlowStatus ? ` menuFlowStatus=${nextMenuFlowStatus}` : ''}`,
    );

    return {
      ok: true,
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      menuFlowStatus: order.status,
      rappidexStatus: order.rappidexStatus,
    };
  }

  private async syncOrder(orderId: string) {
    if (!Types.ObjectId.isValid(orderId)) return;
    const order = await this.orders.findById(orderId).lean();
    if (!order || order.fulfillment !== 'DELIVERY' || !order.rappidexSyncRequested) return;

    if (['REJECTED', 'CANCELLED'].includes(order.status)) {
      await this.orders.updateOne(
        { _id: order._id },
        { $set: { rappidexSyncRequested: false, rappidexSyncStatus: 'CANCELLED', rappidexSyncError: '' } },
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
    } catch (error) {
      await this.markFailure(order._id, error instanceof Error ? error.message : String(error));
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
        { $set: { rappidexSyncRequested: false, rappidexCancelRequested: false } },
      );
      return;
    }

    await this.orders.updateOne(
      { _id: order._id },
      { $set: { rappidexCancelRequested: true, rappidexSyncStatus: 'CANCEL_PENDING' } },
    );

    try {
      await this.request(`/integrations/menuflow/deliveries/${encodeURIComponent(order._id.toString())}/cancel`, {
        method: 'POST',
      });
      await this.orders.updateOne(
        { _id: order._id },
        {
          $set: {
            rappidexSyncRequested: false,
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
      const [cancellations, creations] = await Promise.all([
        this.orders.find({ rappidexCancelRequested: true }).select('_id').sort({ createdAt: 1 }).limit(20).lean(),
        this.orders
          .find({
            rappidexSyncRequested: true,
            fulfillment: 'DELIVERY',
            rappidexSyncStatus: { $in: ['PENDING', 'FAILED'] },
          })
          .select('_id')
          .sort({ createdAt: 1 })
          .limit(20)
          .lean(),
      ]);

      await Promise.allSettled(cancellations.map((item) => this.requestCancellation(item._id.toString())));
      await Promise.allSettled(creations.map((item) => this.syncOrder(item._id.toString())));
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
