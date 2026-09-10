import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Coupon, Customer, DeliveryZone, Order, Payment, Product, Restaurant, RestaurantSettings } from '../common/schemas';
import { canAcceptOrdersNow } from '../restaurants/business-hours';
import { OrdersGateway } from './orders.gateway';

export type CheckoutItem = { productId: string; quantity: number; addonNames?: string[]; observation?: string };
export type CheckoutInput = {
  customerName: string; phone: string; fulfillment: 'DELIVERY' | 'PICKUP'; paymentMethod: string;
  address?: Record<string, string>; changeFor?: number; couponCode?: string; items: CheckoutItem[];
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(DeliveryZone.name) private readonly zones: Model<DeliveryZone>,
    @InjectModel(Restaurant.name) private readonly restaurants: Model<Restaurant>,
    @InjectModel(RestaurantSettings.name) private readonly settings: Model<RestaurantSettings>,
    @InjectModel(Coupon.name) private readonly coupons: Model<Coupon>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    private readonly gateway: OrdersGateway,
  ) {}

  async create(restaurantId: string, input: CheckoutInput, customerId?: string) {
    if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found');
    const [restaurant, settings] = await Promise.all([
      this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(),
      this.settings.findOne({ restaurantId }).lean(),
    ]);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    const availability = canAcceptOrdersNow({
      blocked: restaurant.blocked,
      acceptingOrders: restaurant.open,
      openingHours: settings?.openingHours ?? [],
      timezone: restaurant.timezone,
    });
    if (!availability.canAcceptOrdersNow) throw new BadRequestException('Restaurant is currently closed');
    if (!(await this.payments.exists({ restaurantId, method: input.paymentMethod, active: true }))) {
      throw new BadRequestException('Payment method is unavailable');
    }
    if (input.fulfillment === 'DELIVERY' && !input.address?.neighborhood) {
      throw new BadRequestException('Neighborhood is required for delivery');
    }
    if (input.fulfillment === 'DELIVERY' && (!input.address?.street?.trim() || !input.address?.number?.trim())) {
      throw new BadRequestException('Street and number are required for delivery');
    }
    const productIds = input.items.map(({ productId }) => productId);
    if (productIds.some((id) => !Types.ObjectId.isValid(id))) throw new BadRequestException('Invalid product');
    const products = await this.products.find({ _id: { $in: productIds }, restaurantId, available: true, archivedAt: { $exists: false } }).lean();
    if (products.length !== new Set(productIds).size) throw new BadRequestException('One or more products are unavailable');
    const productById = new Map(products.map((product) => [product._id.toString(), product]));
    const items = input.items.map((item) => {
      const product = productById.get(item.productId);
      if (!product || item.quantity < 1) throw new BadRequestException('Invalid order item');
      const selectedNames = item.addonNames ?? [];
      if (new Set(selectedNames).size !== selectedNames.length) throw new BadRequestException('An add-on can only be selected once');
      const allowed = new Map(product.addonGroups.flatMap((group) => group.addons.map((addon) => [addon.name, addon.price])));
      const addons = selectedNames.map((name) => {
        const price = allowed.get(name);
        if (price === undefined) throw new BadRequestException(`Invalid add-on: ${name}`);
        return { name, price };
      });
      for (const group of product.addonGroups) {
        const selectedCount = selectedNames.filter((name) => group.addons.some((addon) => addon.name === name)).length;
        const minimum = group.min ?? (group.required ? 1 : 0);
        const maximum = group.max ?? 1;
        if (selectedCount < minimum || selectedCount > maximum) throw new BadRequestException(`Invalid add-on selection for group: ${group.name}`);
      }
      return { productName: product.name, unitPrice: product.promotionalPrice ?? product.price, quantity: item.quantity, addons, observation: item.observation };
    });
    const subtotal = items.reduce((sum, item) => sum + item.quantity * (item.unitPrice + item.addons.reduce((total, addon) => total + addon.price, 0)), 0);
    if (settings && subtotal < settings.minimumOrder) throw new BadRequestException(`Minimum order is ${settings.minimumOrder}`);
    let deliveryFee = 0;
    if (input.fulfillment === 'DELIVERY') {
      const zone = await this.zones.findOne({ restaurantId, name: input.address?.neighborhood, active: true }).lean();
      if (!zone) throw new BadRequestException('Delivery is unavailable for this neighborhood');
      deliveryFee = zone.fee;
    }
    let discount = 0;
    let couponId: Types.ObjectId | undefined;
    if (input.couponCode) {
      const now = new Date();
      const coupon = await this.coupons.findOne({ restaurantId, code: input.couponCode.toUpperCase(), active: true, $and: [{ $or: [{ startsAt: { $exists: false } }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }] }).lean();
      if (!coupon || subtotal < coupon.minimumOrder || (coupon.usageLimit !== undefined && coupon.usageCount >= coupon.usageLimit)) throw new BadRequestException('Invalid coupon');
      discount = coupon.type === 'PERCENTAGE' ? subtotal * (coupon.value / 100) : coupon.value;
      discount = Math.min(discount, subtotal);
      couponId = coupon._id;
    }
    const total = subtotal + deliveryFee - discount;
    if (input.changeFor !== undefined && input.paymentMethod !== 'CASH') throw new BadRequestException('Change is only available for cash payments');
    if (input.changeFor !== undefined && input.changeFor < total) throw new BadRequestException('Change amount must cover the order total');
    const order = await this.orders.create({ customerName: input.customerName, phone: input.phone, fulfillment: input.fulfillment, paymentMethod: input.paymentMethod, address: input.address, changeFor: input.changeFor, restaurantId: new Types.ObjectId(restaurantId), customerId: customerId ? new Types.ObjectId(customerId) : undefined, orderNumber: `MF-${new Types.ObjectId().toString().toUpperCase()}`, items, subtotal, deliveryFee, discount, total });
    if (couponId) {
      const couponUsed = await this.coupons.updateOne({ _id: couponId, $or: [{ usageLimit: { $exists: false } }, { $expr: { $lt: ['$usageCount', '$usageLimit'] } }] }, { $inc: { usageCount: 1 } });
      if (couponUsed.modifiedCount !== 1) {
        await this.orders.deleteOne({ _id: order._id });
        throw new BadRequestException('Coupon usage limit has been reached');
      }
    }
    await this.customers.findOneAndUpdate(
      { restaurantId, phone: input.phone },
      { $set: { name: input.customerName, lastOrderAt: new Date() }, $addToSet: input.address ? { addresses: input.address } : {}, $inc: { orderCount: 1, totalSpent: order.total } },
      { upsert: true, new: true },
    );
    this.gateway.publishNewOrder(restaurantId, order.toJSON());
    return order;
  }

  list(restaurantId: string) { return this.orders.find({ restaurantId }).sort({ createdAt: -1 }).lean(); }
  forCustomer(customerId: string) { return this.orders.find({ customerId }).populate('restaurantId', 'name slug').sort({ createdAt: -1 }).lean(); }

  async updateStatus(restaurantId: string, id: string, status: string) {
    const transitions: Record<string, string[]> = { NEW: ['ACCEPTED', 'CANCELLED'], ACCEPTED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY', 'CANCELLED'], READY: ['OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'], OUT_FOR_DELIVERY: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
    if (!Types.ObjectId.isValid(restaurantId) || !Types.ObjectId.isValid(id)) throw new NotFoundException('Order not found');
    const order = await this.orders.findOne({ _id: id, restaurantId });
    if (!order) throw new NotFoundException('Order not found');
    if (!transitions[order.status]?.includes(status)) throw new BadRequestException('Invalid status transition');
    order.status = status;
    if (status === 'COMPLETED' && !order.completedAt) order.completedAt = new Date();
    if (status === 'CANCELLED' && !order.cancelledAt) order.cancelledAt = new Date();
    await order.save();
    this.gateway.publishOrderUpdated(restaurantId, order.toJSON());
    return order;
  }
}
