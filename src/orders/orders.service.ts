import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Category, Coupon, Customer, DeliveryCoverageType, DeliveryZone, Order, Payment, Product, Restaurant, RestaurantSettings } from '../common/schemas';
import { canAcceptOrdersNow } from '../restaurants/business-hours';
import { OrdersGateway } from './orders.gateway';
import { buildOrderWhatsAppMessage, buildWhatsAppUrl } from './order-whatsapp';

export type CheckoutItem = { productId: string; quantity: number; addons?: Array<{ groupId: string; addonId: string }>; addonNames?: string[]; observation?: string };
export type CheckoutInput = { customerName: string; phone: string; fulfillment: 'DELIVERY' | 'PICKUP'; paymentMethod: string; deliveryZoneId?: string; address?: Record<string, string>; needsChange?: boolean; changeForCents?: number; couponCode?: string; items: CheckoutItem[] };
export const transitions: Record<string, string[]> = { PENDING: ['ACCEPTED', 'REJECTED', 'CANCELLED'], ACCEPTED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY', 'CANCELLED'], READY: ['OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'], OUT_FOR_DELIVERY: ['COMPLETED', 'CANCELLED'], COMPLETED: [], REJECTED: [], CANCELLED: [] };
const cents = (modern: number | undefined, legacy: number | undefined) => modern ?? Math.round((legacy ?? 0) * 100);
export function expectedChangeCents(paymentMethod: string, needsChange: boolean | undefined, changeForCents: number | undefined, totalCents: number) {
  if (paymentMethod !== 'CASH') {
    if (needsChange || changeForCents !== undefined) throw new BadRequestException('Troco só está disponível para pagamento em dinheiro.');
    return undefined;
  }
  if (!needsChange) return undefined;
  if (!Number.isInteger(changeForCents) || changeForCents! < totalCents) throw new BadRequestException('O valor para troco não pode ser menor que o total do pedido.');
  return changeForCents! - totalCents;
}

export function deliveryAddressSnapshot(address: Record<string, string>, restaurant: { city?: string; state?: string }) {
  const clean = (field: string, max: number) => String(address[field] ?? '').trim().slice(0, max);
  return {
    zipCode: clean('zipCode', 10), street: clean('street', 160), number: clean('number', 30),
    neighborhood: clean('neighborhood', 100), complement: clean('complement', 160),
    city: String(restaurant.city ?? '').trim(), state: String(restaurant.state ?? '').trim().toUpperCase(), reference: clean('reference', 160),
  };
}

export function zoneMatchesNeighborhood(zone: { coverageType?: string; name: string }, neighborhood: string) {
  return zone.coverageType === DeliveryCoverageType.ALL || (zone.coverageType !== DeliveryCoverageType.ALL && zone.name.localeCompare(neighborhood, 'pt-BR', { sensitivity: 'base' }) === 0);
}

export function deliveryFeeForZone(zone: { coverageType?: string; name: string; fee?: number; feeCents?: number }, neighborhood: string) {
  return zoneMatchesNeighborhood(zone, neighborhood) ? cents(zone.feeCents, zone.fee) : undefined;
}

export function addressBelongsToRestaurant(address: Record<string, string>, restaurant: { city?: string; state?: string }) {
  const city = typeof address.city === 'string' ? address.city.trim() : '';
  const state = typeof address.state === 'string' ? address.state.trim().toUpperCase() : '';
  return (!city || city.localeCompare(restaurant.city ?? '', 'pt-BR', { sensitivity: 'base' }) === 0)
    && (!state || state === restaurant.state?.trim().toUpperCase());
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>, @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Category.name) private readonly categories: Model<Category>, @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(DeliveryZone.name) private readonly zones: Model<DeliveryZone>, @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>, @InjectModel(Coupon.name) private readonly coupons: Model<Coupon>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>, private readonly gateway: OrdersGateway,
  ) {}

  async create(restaurantId: string, input: CheckoutInput, customerId?: string, idempotencyKey?: string) {
    if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Estabelecimento não encontrado.');
    const rid = new Types.ObjectId(restaurantId);
    const authenticatedCustomerId = customerId ? this.objectId(customerId, 'Cliente autenticado inválido.') : undefined;
    if (idempotencyKey) { const existing = await this.orders.findOne({ restaurantId: rid, idempotencyKey }).lean(); if (existing) { const restaurant = await this.restaurants.findById(rid).lean(); return this.checkoutResponse(existing, restaurant!); } }
    const [restaurant, settings] = await Promise.all([this.restaurants.findById(rid).lean(), this.settings.findOne({ restaurantId: rid }).lean()]);
    if (!restaurant || restaurant.blocked) throw new NotFoundException('Estabelecimento não encontrado.');
    const availability = canAcceptOrdersNow({ blocked: restaurant.blocked, acceptingOrders: restaurant.open, openingHours: settings?.openingHours ?? [], timezone: restaurant.timezone });
    if (!availability.canAcceptOrdersNow) throw new BadRequestException('Este estabelecimento não está recebendo pedidos agora.');
    if (input.fulfillment === 'PICKUP' && settings?.pickupEnabled === false) throw new BadRequestException('Retirada no local não está disponível.');
    if (input.fulfillment === 'DELIVERY' && !settings?.deliveryEnabled) throw new BadRequestException('Entrega não está disponível.');
    if (!(await this.payments.exists({ restaurantId: rid, method: input.paymentMethod, active: true }))) throw new BadRequestException('Forma de pagamento indisponível.');
    if (!input.customerName?.trim() || !input.phone?.trim()) throw new BadRequestException('Nome e telefone são obrigatórios.');
    let deliveryAddress: Record<string, string> | undefined;
    if (input.fulfillment === 'DELIVERY') {
      this.validateAddress(input.address);
      if (!restaurant.city?.trim() || !restaurant.state?.trim()) throw new BadRequestException('A cidade e a UF do estabelecimento precisam estar configuradas para entrega.');
      if (!addressBelongsToRestaurant(input.address!, restaurant)) {
        throw new BadRequestException(`Este estabelecimento realiza entregas somente em ${restaurant.city} - ${restaurant.state.toUpperCase()}.`);
      }
      deliveryAddress = deliveryAddressSnapshot(input.address!, restaurant);
    }

    const productIds = input.items.map(({ productId }) => productId);
    if (!input.items.length || productIds.some((id) => !Types.ObjectId.isValid(id))) throw new BadRequestException('Pedido sem produtos válidos.');
    const products = await this.products.find({ _id: { $in: productIds }, restaurantId: rid, available: true, archivedAt: { $exists: false } }).lean();
    if (products.length !== new Set(productIds).size) throw new BadRequestException('Um ou mais produtos estão indisponíveis.');
    const categoryIds = [...new Set(products.map((p) => p.categoryId.toString()))].map((id) => new Types.ObjectId(id));
    if (await this.categories.countDocuments({ _id: { $in: categoryIds }, restaurantId: rid, archivedAt: { $exists: false }, active: true }) !== categoryIds.length) throw new BadRequestException('Um produto pertence a uma categoria indisponível.');
    const productById = new Map(products.map((product) => [product._id.toString(), product]));
    const items = input.items.map((item) => {
      const product = productById.get(item.productId); if (!product || !Number.isInteger(item.quantity) || item.quantity < 1) throw new BadRequestException('Item inválido.');
      const selections = item.addons ?? this.legacySelections(product, item.addonNames ?? []);
      const unique = new Set(selections.map((selection) => `${selection.groupId}:${selection.addonId}`));
      if (unique.size !== selections.length) throw new BadRequestException('Um adicional só pode ser selecionado uma vez.');
      const selected = selections.map((selection) => {
        const group = product.addonGroups.find((candidate: any) => candidate._id?.toString() === selection.groupId);
        const addon = group?.addons.find((candidate: any) => candidate._id?.toString() === selection.addonId);
        if (!group || !addon) throw new BadRequestException('Adicional inválido ou desatualizado. Atualize o cardápio.');
        const priceCents = cents(addon.priceCents, addon.price);
        return { groupId: group._id.toString(), addonId: addon._id.toString(), groupName: group.name, name: addon.name, price: priceCents / 100, priceCents };
      });
      for (const group of product.addonGroups as any[]) {
        const count = selected.filter((addon) => addon.groupId === group._id.toString()).length;
        const minimum = group.required ? Math.max(1, group.min ?? 1) : group.min ?? 0;
        if (count < minimum || count > (group.max ?? 1)) throw new BadRequestException(`Seleção inválida no grupo ${group.name}.`);
      }
      const unitPriceCents = cents(product.promotionalPriceCents, product.promotionalPrice ?? product.price);
      return { productId: product._id, productName: product.name, unitPrice: unitPriceCents / 100, unitPriceCents, quantity: item.quantity, addons: selected, observation: item.observation?.trim() };
    });
    const subtotalCents = items.reduce((sum, item) => sum + item.quantity * (item.unitPriceCents + item.addons.reduce((n, addon) => n + addon.priceCents, 0)), 0);
    const minimumOrderCents = cents(settings?.minimumOrderCents, settings?.minimumOrder);
    if (subtotalCents < minimumOrderCents) throw new BadRequestException(`O pedido mínimo é ${(minimumOrderCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.`);
    let deliveryFeeCents = 0;
    if (input.fulfillment === 'DELIVERY') {
      const neighborhood = deliveryAddress!.neighborhood;
      const zone = input.deliveryZoneId
        ? await this.zones.findOne({ _id: input.deliveryZoneId, restaurantId: rid, active: true }).lean()
        : await this.zones.findOne({ restaurantId: rid, active: true, $or: [{ coverageType: DeliveryCoverageType.ALL }, { coverageType: DeliveryCoverageType.SPECIFIC, name: new RegExp(`^${escapeRegex(neighborhood)}$`, 'i') }, { coverageType: { $exists: false }, name: new RegExp(`^${escapeRegex(neighborhood)}$`, 'i') }] }).lean();
      if (!zone) throw new BadRequestException('Este endereço está fora da área de entrega deste estabelecimento.');
      if (!zoneMatchesNeighborhood(zone, neighborhood)) throw new BadRequestException('A região selecionada não corresponde ao bairro informado.');
      deliveryFeeCents = cents(zone.feeCents, zone.fee);
    }
    let discountCents = 0; let couponId: Types.ObjectId | undefined;
    if (input.couponCode) { const coupon = await this.validCoupon(rid, input.couponCode, subtotalCents); discountCents = coupon.type === 'PERCENTAGE' ? Math.round(subtotalCents * coupon.value / 100) : Math.round(coupon.value * 100); discountCents = Math.min(discountCents, subtotalCents); couponId = coupon._id; }
    const totalCents = subtotalCents + deliveryFeeCents - discountCents;
    const needsChange = input.paymentMethod === 'CASH' && Boolean(input.needsChange);
    const calculatedChangeCents = expectedChangeCents(input.paymentMethod, input.needsChange, input.changeForCents, totalCents);
    const publicToken = randomBytes(32).toString('base64url');
    try {
      // customerId links "Meus pedidos" to the authenticated User CUSTOMER.
      // The restaurant-scoped Customer document below remains CRM data and must not replace it.
      const order = await this.orders.create({ restaurantId: rid, customerId: authenticatedCustomerId, idempotencyKey, publicToken, orderNumber: `MF-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`, customerName: input.customerName.trim(), phone: input.phone.trim(), fulfillment: input.fulfillment, address: deliveryAddress, paymentMethod: input.paymentMethod, needsChange, changeForCents: needsChange ? input.changeForCents : undefined, changeFor: needsChange ? input.changeForCents! / 100 : undefined, expectedChangeCents: calculatedChangeCents, items, subtotal: subtotalCents / 100, subtotalCents, deliveryFee: deliveryFeeCents / 100, deliveryFeeCents, discount: discountCents / 100, discountCents, total: totalCents / 100, totalCents, status: 'PENDING', statusHistory: [{ status: 'PENDING', changedAt: new Date(), ...(authenticatedCustomerId ? { changedBy: authenticatedCustomerId } : {}) }] });
      if (couponId) await this.consumeCoupon(couponId, order._id);
      await this.customers.findOneAndUpdate({ restaurantId: rid, phone: input.phone.trim() }, { $set: { name: input.customerName.trim(), lastOrderAt: new Date() }, ...(deliveryAddress ? { $addToSet: { addresses: deliveryAddress } } : {}), $inc: { orderCount: 1, totalSpent: totalCents / 100 } }, { upsert: true });
      this.gateway.publishNewOrder(rid.toHexString(), order.toJSON()); return this.checkoutResponse(order.toObject(), restaurant);
    } catch (error) { if ((error as { code?: number }).code === 11000 && idempotencyKey) { const existing = await this.orders.findOne({ restaurantId: rid, idempotencyKey }).lean(); if (existing) return this.checkoutResponse(existing, restaurant); } throw error; }
  }

  list(restaurantId: string) { const rid = this.objectId(restaurantId, 'Estabelecimento inválido.'); return this.orders.find({ restaurantId: rid }).sort({ createdAt: -1 }).limit(200).lean(); }
  forCustomer(customerId: string) { const uid = this.objectId(customerId, 'Cliente inválido.'); return this.orders.find({ customerId: uid }).populate('restaurantId', 'name tradeName slug address mapUrl').sort({ createdAt: -1 }).limit(100).lean(); }
  async publicOrder(orderNumber: string, token: string) { const order = await this.orders.findOne({ orderNumber, publicToken: token }).populate('restaurantId', 'name tradeName slug address mapUrl').lean(); if (!order) throw new NotFoundException('Pedido não encontrado.'); return order; }
  async updateStatus(restaurantId: string, id: string, status: string, actorId: string, reason?: string) {
    const rid = this.objectId(restaurantId, 'Pedido não encontrado.', true);
    const oid = this.objectId(id, 'Pedido não encontrado.', true);
    const actor = this.objectId(actorId, 'Responsável pela alteração inválido.');
    const order = await this.orders.findOne({ _id: oid, restaurantId: rid }); if (!order) throw new NotFoundException('Pedido não encontrado.');
    if (!transitions[order.status]?.includes(status)) throw new ConflictException('Transição de status inválida.');
    if (status === 'REJECTED' && !reason?.trim()) throw new BadRequestException('Informe o motivo da recusa.');
    if (order.fulfillment === 'PICKUP' && status === 'OUT_FOR_DELIVERY') throw new ConflictException('Pedidos para retirada não saem para entrega.');
    const now = new Date(); order.status = status;
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status, changedAt: now, changedBy: actor });
    if (status === 'ACCEPTED') { order.acceptedAt = now; order.acceptedBy = actor; } if (status === 'PREPARING') order.preparingAt = now; if (status === 'READY') order.readyAt = now; if (status === 'OUT_FOR_DELIVERY') order.outForDeliveryAt = now; if (status === 'COMPLETED') { order.completedAt = now; order.completedBy = actor; } if (status === 'REJECTED') { order.rejectedAt = now; order.rejectedBy = actor; order.rejectionReason = reason!.trim(); } if (status === 'CANCELLED') { order.cancelledAt = now; order.cancellationReason = reason?.trim(); }
    try { await order.save(); }
    catch (error) { if ((error as { name?: string }).name === 'VersionError') throw new ConflictException('Este pedido já foi atualizado.'); throw error; }
    this.gateway.publishOrderUpdated(rid.toHexString(), order.customerId?.toString(), order.toJSON()); return order;
  }
  async cancelByCustomer(customerId: string, id: string, reason?: string) { const order = await this.orders.findOne({ _id: id, customerId }); if (!order) throw new NotFoundException('Pedido não encontrado.'); if (order.status !== 'PENDING') throw new ConflictException('Após a aceitação, entre em contato com o estabelecimento.'); return this.updateStatus(order.restaurantId.toString(), id, 'CANCELLED', customerId, reason); }

  private validateAddress(address?: Record<string, string>) {
    for (const field of ['zipCode', 'street', 'number', 'neighborhood']) if (typeof address?.[field] !== 'string' || !address[field].trim()) throw new BadRequestException('Preencha o endereço completo para entrega.');
    if (address!.neighborhood.trim().length > 100) throw new BadRequestException('O bairro deve ter no máximo 100 caracteres.');
  }
  private checkoutResponse(order: any, restaurant: Restaurant) {
    const trackingUrl = `/acompanhar/${encodeURIComponent(order.orderNumber)}?token=${encodeURIComponent(order.publicToken)}`;
    const whatsappMessage = buildOrderWhatsAppMessage(order, restaurant);
    return { ...order, trackingUrl, whatsappUrl: buildWhatsAppUrl(restaurant.orderWhatsapp, whatsappMessage) };
  }
  private objectId(value: string, message: string, notFound = false) { if (!Types.ObjectId.isValid(value)) { if (notFound) throw new NotFoundException(message); throw new BadRequestException(message); } return new Types.ObjectId(value); }
  private legacySelections(product: any, names: string[]) { return names.map((name) => { const matches = product.addonGroups.flatMap((group: any) => group.addons.filter((addon: any) => addon.name === name).map((addon: any) => ({ groupId: group._id?.toString(), addonId: addon._id?.toString() }))); if (matches.length !== 1 || !matches[0].groupId || !matches[0].addonId) throw new BadRequestException('Adicional antigo ambíguo. Selecione novamente.'); return matches[0]; }); }
  private async validCoupon(rid: Types.ObjectId, code: string, subtotalCents: number): Promise<any> { const now = new Date(); const coupon = await this.coupons.findOne({ restaurantId: rid, code: code.toUpperCase(), active: true, $and: [{ $or: [{ startsAt: { $exists: false } }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }] }).lean(); if (!coupon || subtotalCents < Math.round(coupon.minimumOrder * 100) || (coupon.usageLimit !== undefined && coupon.usageCount >= coupon.usageLimit)) throw new BadRequestException('Cupom inválido.'); return coupon; }
  private async consumeCoupon(id: Types.ObjectId, orderId: Types.ObjectId) { const used = await this.coupons.updateOne({ _id: id, $or: [{ usageLimit: { $exists: false } }, { $expr: { $lt: ['$usageCount', '$usageLimit'] } }] }, { $inc: { usageCount: 1 } }); if (used.modifiedCount !== 1) { await this.orders.deleteOne({ _id: orderId }); throw new BadRequestException('O limite do cupom foi atingido.'); } }
}
function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
