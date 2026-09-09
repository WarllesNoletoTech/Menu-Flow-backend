import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Coupon, Customer, DeliveryZone, Order, Product, Restaurant, RestaurantSettings } from '../common/schemas';
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
    private readonly gateway: OrdersGateway,
  ) {}

  async create(restaurantId: string, input: CheckoutInput) {
    if (!Types.ObjectId.isValid(restaurantId)) throw new NotFoundException('Restaurant not found');
    const [restaurant, settings] = await Promise.all([
      this.restaurants.findOne({ _id: restaurantId, blocked: false }).lean(),
      this.settings.findOne({ restaurantId }).lean(),
    ]);
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (!restaurant.open) throw new BadRequestException('Restaurant is currently closed');
    if (input.fulfillment === 'DELIVERY' && !input.address?.neighborhood) {
      throw new BadRequestException('Neighborhood is required for delivery');
    }
    const productIds = input.items.map(({ productId }) => productId);
    if (productIds.some((id) => !Types.ObjectId.isValid(id))) throw new BadRequestException('Invalid product');
    const products = await this.products.find({ _id: { $in: productIds }, restaurantId, available: true }).lean();
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
    const order = await this.orders.create({ customerName: input.customerName, phone: input.phone, fulfillment: input.fulfillment, paymentMethod: input.paymentMethod, address: input.address, changeFor: input.changeFor, restaurantId: new Types.ObjectId(restaurantId), items, subtotal, deliveryFee, discount, total });
    if (couponId) await this.coupons.updateOne({ _id: couponId, $or: [{ usageLimit: { $exists: false } }, { $expr: { $lt: ['$usageCount', '$usageLimit'] } }] }, { $inc: { usageCount: 1 } });
    await this.customers.findOneAndUpdate(
      { restaurantId, phone: input.phone },
      { $set: { name: input.customerName, lastOrderAt: new Date() }, $addToSet: input.address ? { addresses: input.address } : {}, $inc: { orderCount: 1, totalSpent: order.total } },
      { upsert: true, new: true },
    );
    this.gateway.publishNewOrder(restaurantId, order.toJSON());
    return order;
  }

  list(restaurantId: string) { return this.orders.find({ restaurantId }).sort({ createdAt: -1 }).lean(); }

  async updateStatus(restaurantId: string, id: string, status: string) {
    const transitions: Record<string, string[]> = { NEW: ['ACCEPTED', 'CANCELLED'], ACCEPTED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY', 'CANCELLED'], READY: ['OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED'], OUT_FOR_DELIVERY: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
    const order = await this.orders.findOne({ _id: id, restaurantId });
    if (!order) throw new NotFoundException('Order not found');
    if (!transitions[order.status]?.includes(status)) throw new BadRequestException('Invalid status transition');
    order.status = status;
    await order.save();
    this.gateway.publishOrderUpdated(restaurantId, order.toJSON());
    return order;
  }
}
