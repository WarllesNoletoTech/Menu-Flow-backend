import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";
import { Role } from "./roles";

export enum EstablishmentType {
  RESTAURANT = "RESTAURANT",
  PHARMACY = "PHARMACY",
  CLOTHING = "CLOTHING",
  OTHER = "OTHER",
}

@Schema({ timestamps: true })
export class EstablishmentTypeDefinition {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) slug!: string;
  @Prop({ required: true, unique: true, lowercase: true, trim: true }) normalizedName!: string;
  @Prop({ default: true, index: true }) active!: boolean;
  @Prop({ default: 0, index: true }) sortOrder!: number;
  @Prop({ type: Types.ObjectId, ref: "User", required: true }) createdBy!: Types.ObjectId;
}
export type EstablishmentTypeDefinitionDocument = HydratedDocument<EstablishmentTypeDefinition>;
export const EstablishmentTypeDefinitionSchema = SchemaFactory.createForClass(EstablishmentTypeDefinition);
EstablishmentTypeDefinitionSchema.index({ sortOrder: 1, name: 1 });

@Schema({ timestamps: true })
export class HomeBanner {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ trim: true }) title?: string;
  @Prop({ trim: true }) description?: string;
  @Prop({ required: true, trim: true }) desktopImageUrl!: string;
  @Prop({ required: true, trim: true }) mobileImageUrl!: string;
  @Prop({ type: String, trim: true, default: null }) targetUrl?: string | null;
  @Prop({ default: true, index: true }) active!: boolean;
  @Prop({ default: 0, index: true, min: 0 }) sortOrder!: number;
  @Prop({ type: Types.ObjectId, ref: "User", required: true }) createdBy!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", required: true }) updatedBy!: Types.ObjectId;
}
export type HomeBannerDocument = HydratedDocument<HomeBanner>;
export const HomeBannerSchema = SchemaFactory.createForClass(HomeBanner);
HomeBannerSchema.index({ active: 1, sortOrder: 1, createdAt: 1 });

@Schema({ timestamps: true })
export class Restaurant {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug!: string;
  @Prop() tradeName?: string;
  @Prop() cnpj?: string;
  @Prop() email?: string;
  @Prop() address?: string;
  @Prop({ trim: true }) city?: string;
  @Prop({ uppercase: true, trim: true }) state?: string;
  @Prop() logoUrl?: string;
  @Prop() bannerUrl?: string;
  @Prop() bannerDesktopUrl?: string;
  @Prop() bannerMobileUrl?: string;
  @Prop() description?: string;
  @Prop() phone?: string;
  @Prop() whatsapp?: string;
  @Prop({ match: /^55\d{10,11}$/ }) orderWhatsapp?: string;
  @Prop() instagram?: string;
  @Prop({ match: /^https:\/\//i }) mapUrl?: string;
  @Prop() pickupInstructions?: string;
  @Prop({ enum: EstablishmentType, default: EstablishmentType.RESTAURANT })
  establishmentType!: EstablishmentType;
  @Prop({ type: Types.ObjectId, ref: "EstablishmentTypeDefinition", index: true })
  establishmentTypeId?: Types.ObjectId;
  @Prop({ type: [String], default: [] }) restaurantCategories!: string[];
  @Prop({ default: false }) blocked!: boolean;
  @Prop({ default: true }) open!: boolean;
  @Prop({ default: "America/Sao_Paulo", trim: true }) timezone!: string;
  @Prop({ type: Types.ObjectId, ref: "BillingPlan" })
  billingPlanId?: Types.ObjectId;
  @Prop() billingStartAt?: Date;
  @Prop({ min: 1, max: 28 }) billingDueDay?: number;
}
export type RestaurantDocument = HydratedDocument<Restaurant>;
export const RestaurantSchema = SchemaFactory.createForClass(Restaurant);
RestaurantSchema.index({
  blocked: 1,
  city: 1,
  state: 1,
  establishmentType: 1,
  open: 1,
});

@Schema({ _id: true })
export class CustomerAddress {
  @Prop({ required: true }) label!: string;
  @Prop({ required: true }) street!: string;
  @Prop({ required: true }) number!: string;
  @Prop({ required: true }) neighborhood!: string;
  @Prop({ required: true }) city!: string;
  @Prop({ required: true }) state!: string;
  @Prop({ required: true }) zipCode!: string;
  @Prop() complement?: string;
  @Prop({ default: false }) primary!: boolean;
}
export const CustomerAddressSchema =
  SchemaFactory.createForClass(CustomerAddress);
@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, lowercase: true, trim: true, unique: true })
  email!: string;
  @Prop({ required: true, select: false }) passwordHash!: string;
  @Prop({ required: true }) name!: string;
  @Prop() phone?: string;
  @Prop({ match: /^55\d{10,11}$/ }) reportWhatsapp?: string;
  @Prop({ enum: Role, required: true }) role!: Role;
  @Prop({ type: Types.ObjectId, ref: "Restaurant" })
  restaurantId?: Types.ObjectId;
  @Prop({ type: [CustomerAddressSchema], default: [] })
  addresses!: CustomerAddress[];
  @Prop({ default: true }) active!: boolean;
  @Prop() deletedAt?: Date;
}
export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);

@Schema({ timestamps: true })
export class Category {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({ default: 0 }) order!: number;
  @Prop({ default: true }) active!: boolean;
  @Prop() archivedAt?: Date;
}
export const CategorySchema = SchemaFactory.createForClass(Category);
CategorySchema.index({ restaurantId: 1, order: 1 });

@Schema({ _id: true })
export class Addon {
  declare _id: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({ required: true, min: 0 }) price!: number;
  @Prop({ min: 0 }) priceCents?: number;
}
export const AddonSchema = SchemaFactory.createForClass(Addon);
@Schema({ _id: true })
export class AddonGroup {
  declare _id: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({ default: false }) required!: boolean;
  @Prop({ default: 0 }) min!: number;
  @Prop({ default: 1 }) max!: number;
  @Prop({ type: [AddonSchema], default: [] }) addons!: Addon[];
}
export const AddonGroupSchema = SchemaFactory.createForClass(AddonGroup);
@Schema({ timestamps: true })
export class Product {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Category", required: true })
  categoryId!: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop() description?: string;
  @Prop() imageUrl?: string;
  @Prop({ required: true, min: 0 }) price!: number;
  @Prop({ min: 0 }) priceCents?: number;
  @Prop({ min: 0 }) promotionalPrice?: number;
  @Prop({ min: 0 }) promotionalPriceCents?: number;
  @Prop({ default: true }) available!: boolean;
  @Prop({ default: false }) featured!: boolean;
  @Prop({ default: 0 }) order!: number;
  @Prop({ type: [AddonGroupSchema], default: [] }) addonGroups!: AddonGroup[];
  @Prop() archivedAt?: Date;
}
export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ restaurantId: 1, categoryId: 1, order: 1 });

@Schema({ _id: false })
export class OrderItem {
  @Prop({ type: Types.ObjectId, ref: "Product" }) productId?: Types.ObjectId;
  @Prop({ required: true }) productName!: string;
  @Prop({ required: true }) unitPrice!: number;
  @Prop({ required: true, min: 0 }) unitPriceCents!: number;
  @Prop({ required: true }) quantity!: number;
  @Prop({ type: [Object], default: [] }) addons!: Array<{
    groupId: string;
    addonId: string;
    groupName: string;
    name: string;
    price: number;
    priceCents: number;
  }>;
  @Prop() observation?: string;
}
@Schema({ timestamps: true })
export class Order {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User", index: true })
  customerId?: Types.ObjectId;
  @Prop({ unique: true, sparse: true }) orderNumber?: string;
  @Prop({ index: true, sparse: true, unique: true }) publicToken?: string;
  @Prop({ index: true, sparse: true, unique: true }) idempotencyKey?: string;
  @Prop({ required: true }) customerName!: string;
  @Prop({ required: true }) phone!: string;
  @Prop({ enum: ["DELIVERY", "PICKUP"], required: true }) fulfillment!: string;
  @Prop({ type: Object }) address?: Record<string, string>;
  @Prop({ required: true }) paymentMethod!: string;
  @Prop({ default: false }) needsChange!: boolean;
  @Prop() changeFor?: number;
  @Prop({ min: 0 }) changeForCents?: number;
  @Prop({ min: 0 }) expectedChangeCents?: number;
  @Prop({ type: [OrderItem], required: true }) items!: OrderItem[];
  @Prop({ required: true }) subtotal!: number;
  @Prop({ required: true, min: 0 }) subtotalCents!: number;
  @Prop({ default: 0 }) deliveryFee!: number;
  @Prop({ default: 0, min: 0 }) deliveryFeeCents!: number;
  @Prop({ default: 0, min: 0 }) customerServiceFeeCents!: number;
  @Prop({ default: 0 }) discount!: number;
  @Prop({ default: 0, min: 0 }) discountCents!: number;
  @Prop({ required: true }) total!: number;
  @Prop({ required: true, min: 0 }) totalCents!: number;
  @Prop({
    enum: [
      "PENDING",
      "ACCEPTED",
      "PREPARING",
      "READY",
      "OUT_FOR_DELIVERY",
      "COMPLETED",
      "REJECTED",
      "CANCELLED",
    ],
    default: "PENDING",
  })
  status!: string;
  @Prop() rejectionReason?: string;
  @Prop() cancellationReason?: string;
  @Prop({ type: [Object], default: [] }) statusHistory!: Array<{
    status: string;
    changedAt: Date;
    changedBy?: Types.ObjectId;
  }>;
  @Prop() acceptedAt?: Date;
  @Prop() preparingAt?: Date;
  @Prop() readyAt?: Date;
  @Prop() outForDeliveryAt?: Date;
  @Prop() completedAt?: Date;
  @Prop() rejectedAt?: Date;
  @Prop() cancelledAt?: Date;
  @Prop({ type: Types.ObjectId, ref: "User" }) acceptedBy?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User" }) rejectedBy?: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "User" }) completedBy?: Types.ObjectId;

  // Rappidex metadata is kept separate from Menu Flow's own order status.
  // Delivery orders can be dispatched asynchronously without blocking checkout.
  @Prop({ default: false, index: true }) rappidexSyncRequested?: boolean;
  @Prop({ trim: true }) rappidexSyncStatus?: string;
  @Prop({ min: 0, default: 0 }) rappidexSyncAttempts?: number;
  @Prop({ trim: true }) rappidexDeliveryId?: string;
  @Prop({ trim: true }) rappidexStatus?: string;
  @Prop({ trim: true }) rappidexStatusLabel?: string;
  @Prop({ trim: true }) rappidexLastEventId?: string;
  @Prop() rappidexLastAttemptAt?: Date;
  @Prop() rappidexSyncedAt?: Date;
  @Prop() rappidexLastUpdateAt?: Date;
  @Prop() rappidexSyncError?: string;
  @Prop({ default: false, index: true }) rappidexReleaseRequested?: boolean;
  @Prop({ default: false, index: true }) rappidexCancelRequested?: boolean;
  @Prop() rappidexMotoboyName?: string;
  @Prop() rappidexMotoboyPhone?: string;
}
export const OrderSchema = SchemaFactory.createForClass(Order);
OrderSchema.set("optimisticConcurrency", true);
OrderSchema.index({ restaurantId: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
OrderSchema.index({ restaurantId: 1, status: 1, completedAt: 1 });
OrderSchema.index({ restaurantId: 1, status: 1, rejectedAt: 1 });
OrderSchema.index({ restaurantId: 1, status: 1, cancelledAt: 1 });
OrderSchema.index({ customerId: 1, createdAt: -1 });
OrderSchema.index({ rappidexSyncRequested: 1, rappidexSyncStatus: 1, createdAt: 1 });
OrderSchema.index({ rappidexReleaseRequested: 1, createdAt: 1 });
OrderSchema.index({ rappidexCancelRequested: 1, createdAt: 1 });
OrderSchema.pre("validate", function backfillLegacyMoney() {
  const order = this as unknown as Record<string, unknown>;
  for (const field of ["subtotal", "deliveryFee", "discount", "total"]) {
    const centsField = `${field}Cents`;
    if (order[centsField] === undefined)
      order[centsField] = Math.round(Number(order[field] ?? 0) * 100);
  }
  if (order.status === "NEW") order.status = "PENDING";
});

@Schema({ _id: false })
export class BillingTier {
  @Prop({ required: true, min: 0 }) minOrders!: number;
  @Prop({ type: Number, min: 0, default: null }) maxOrders!: number | null;
  @Prop({ required: true, min: 0 }) amountCents!: number;
}
@Schema({ timestamps: true })
export class BillingPlan {
  @Prop({ required: true, trim: true }) name!: string;
  @Prop({ default: true }) active!: boolean;
  @Prop({ default: false }) isDefault!: boolean;
  @Prop({ min: 1, max: 28 }) dueDay?: number;
  @Prop({ type: [BillingTier], required: true }) tiers!: BillingTier[];
}
export const BillingPlanSchema = SchemaFactory.createForClass(BillingPlan);

export enum BillingInvoiceStatus {
  OPEN = "OPEN",
  PAID = "PAID",
  OVERDUE = "OVERDUE",
  WAIVED = "WAIVED",
  CANCELLED = "CANCELLED",
}
@Schema({ timestamps: true })
export class BillingInvoice {
  @Prop({ type: Types.ObjectId, ref: "Restaurant", required: true })
  restaurantId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "BillingPlan", required: true })
  billingPlanId!: Types.ObjectId;
  @Prop({ required: true, match: /^\d{4}-\d{2}$/ }) period!: string;
  @Prop({ required: true }) periodStart!: Date;
  @Prop({ required: true }) periodEnd!: Date;
  @Prop({ required: true, min: 0 }) completedOrderCount!: number;
  @Prop({ required: true, min: 0 }) amountCents!: number;
  @Prop({ enum: BillingInvoiceStatus, default: BillingInvoiceStatus.OPEN })
  status!: BillingInvoiceStatus;
  @Prop() dueDate?: Date;
  @Prop() paidAt?: Date;
  @Prop({ type: Types.ObjectId, ref: "User" }) paidBy?: Types.ObjectId;
  @Prop({ type: Object, required: true }) pricingSnapshot!: Record<
    string,
    unknown
  >;
}
export const BillingInvoiceSchema =
  SchemaFactory.createForClass(BillingInvoice);
BillingInvoiceSchema.index({ restaurantId: 1, period: 1 }, { unique: true });
BillingInvoiceSchema.index({ status: 1, dueDate: 1 });

export enum BillingReportStatus {
  DRAFT = "DRAFT",
  GENERATED = "GENERATED",
  PAID = "PAID",
  CANCELLED = "CANCELLED",
}
@Schema({ timestamps: true })
export class BillingReport {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true, unique: true }) reportNumber!: string;
  @Prop({ required: true }) periodStart!: Date;
  @Prop({ required: true }) periodEnd!: Date;
  @Prop({ required: true }) timezone!: string;
  @Prop({ required: true, min: 0 }) orderCount!: number;
  @Prop({ required: true, min: 0 }) serviceFeeTotalCents!: number;
  @Prop({ required: true }) includeMonthlyFee!: boolean;
  @Prop({ required: true, min: 0 }) monthlyFeeCents!: number;
  @Prop({ required: true, min: 0 }) totalCents!: number;
  @Prop({
    enum: BillingReportStatus,
    default: BillingReportStatus.GENERATED,
    index: true,
  })
  status!: BillingReportStatus;
  @Prop({ required: true }) generatedAt!: Date;
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  generatedBy!: Types.ObjectId;
  @Prop() pdfGeneratedAt?: Date;
  @Prop() merchantViewedAt?: Date;
  @Prop() paidAt?: Date;
  @Prop({ type: Types.ObjectId, ref: "User" }) paidBy?: Types.ObjectId;
  @Prop() cancelledAt?: Date;
  @Prop({ type: Types.ObjectId, ref: "User" }) cancelledBy?: Types.ObjectId;
  @Prop({ type: Object, required: true }) restaurantSnapshot!: Record<
    string,
    unknown
  >;
  @Prop({ type: Object, required: true, default: {} }) paymentSnapshot!: {
    pixReceiverName?: string;
    pixKey?: string;
  };
}
export const BillingReportSchema = SchemaFactory.createForClass(BillingReport);
BillingReportSchema.index({ restaurantId: 1, periodStart: -1 });
BillingReportSchema.index({ restaurantId: 1, status: 1, merchantViewedAt: 1 });

@Schema({ timestamps: true })
export class ServiceReportItem {
  @Prop({
    type: Types.ObjectId,
    ref: "BillingReport",
    required: true,
    index: true,
  })
  reportId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, ref: "Order", required: true })
  orderId!: Types.ObjectId;
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true }) active!: boolean;
  @Prop({ required: true }) orderNumber!: string;
  @Prop({ required: true }) completedAt!: Date;
  @Prop({ required: true }) fulfillment!: string;
  @Prop({ required: true, min: 0 }) orderTotalCents!: number;
  @Prop({ required: true, min: 0 }) feeCents!: number;
}
export const ServiceReportItemSchema =
  SchemaFactory.createForClass(ServiceReportItem);
ServiceReportItemSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

@Schema({ timestamps: true })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  actorId!: Types.ObjectId;
  @Prop({ required: true }) action!: string;
  @Prop({ required: true }) targetType!: string;
  @Prop({ type: Types.ObjectId, required: true }) targetId!: Types.ObjectId;
  @Prop({ type: Object, default: {} }) metadata!: Record<string, unknown>;
}
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

@Schema({ timestamps: true })
export class PlatformBillingSettings {
  @Prop({ required: true, default: "global", unique: true }) key!: string;
  @Prop({ required: true, trim: true }) pixReceiverName!: string;
  @Prop({ required: true, trim: true }) pixKey!: string;
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  updatedBy!: Types.ObjectId;
}
export const PlatformBillingSettingsSchema = SchemaFactory.createForClass(
  PlatformBillingSettings,
);
@Schema({ timestamps: true })
export class BillingCounter {
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true, min: 0, default: 0 }) sequence!: number;
}
export const BillingCounterSchema =
  SchemaFactory.createForClass(BillingCounter);

// Supporting tenant-owned models. Keep these separate as the platform grows, but retain
// restaurantId on every queryable record to make accidental cross-tenant reads difficult.
@Schema({ timestamps: true })
export class Customer {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({ required: true }) phone!: string;
  @Prop({ type: [Object], default: [] }) addresses!: Array<
    Record<string, string>
  >;
  @Prop({ default: 0 }) totalSpent!: number;
  @Prop({ default: 0 }) orderCount!: number;
  @Prop() lastOrderAt?: Date;
}
export const CustomerSchema = SchemaFactory.createForClass(Customer);
CustomerSchema.index({ restaurantId: 1, phone: 1 }, { unique: true });
@Schema({ timestamps: true })
export class Coupon {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true, uppercase: true, trim: true }) code!: string;
  @Prop({ enum: ["FIXED", "PERCENTAGE"], required: true }) type!: string;
  @Prop({ required: true }) value!: number;
  @Prop({ default: 0 }) minimumOrder!: number;
  @Prop() startsAt?: Date;
  @Prop() endsAt?: Date;
  @Prop() usageLimit?: number;
  @Prop({ default: 0 }) usageCount!: number;
  @Prop({ default: true }) active!: boolean;
}
export const CouponSchema = SchemaFactory.createForClass(Coupon);
CouponSchema.index({ restaurantId: 1, code: 1 }, { unique: true });
export enum DeliveryCoverageType {
  ALL = "ALL",
  SPECIFIC = "SPECIFIC",
}
@Schema({ timestamps: true })
export class DeliveryZone {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({
    enum: DeliveryCoverageType,
    default: DeliveryCoverageType.SPECIFIC,
    index: true,
  })
  coverageType!: DeliveryCoverageType;
  @Prop({ required: true, min: 0 }) fee!: number;
  @Prop({ min: 0 }) feeCents?: number;
  @Prop({ default: true }) active!: boolean;
}
export const DeliveryZoneSchema = SchemaFactory.createForClass(DeliveryZone);
DeliveryZoneSchema.index({ restaurantId: 1, name: 1 }, { unique: true });
DeliveryZoneSchema.index({ restaurantId: 1, active: 1 });
DeliveryZoneSchema.index({ restaurantId: 1, coverageType: 1, active: 1 });
@Schema({ timestamps: true })
export class Payment {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    index: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ required: true }) name!: string;
  @Prop({ enum: ["PIX", "CASH", "CREDIT_CARD", "DEBIT_CARD"], required: true })
  method!: string;
  @Prop({ default: true }) active!: boolean;
}
export const PaymentSchema = SchemaFactory.createForClass(Payment);
PaymentSchema.index({ restaurantId: 1, method: 1 }, { unique: true });
@Schema({ _id: false })
export class BusinessHourPeriod {
  @Prop({ required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ })
  openTime!: string;
  @Prop({ required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ })
  closeTime!: string;
}
export const BusinessHourPeriodSchema =
  SchemaFactory.createForClass(BusinessHourPeriod);
@Schema({ _id: false })
export class BusinessDay {
  @Prop({ required: true, min: 0, max: 6 }) dayOfWeek!: number;
  @Prop({ required: true }) isOpen!: boolean;
  @Prop({ type: [BusinessHourPeriodSchema], default: [] })
  periods!: BusinessHourPeriod[];
}
export const BusinessDaySchema = SchemaFactory.createForClass(BusinessDay);
@Schema({ timestamps: true })
export class RestaurantSettings {
  @Prop({
    type: Types.ObjectId,
    ref: "Restaurant",
    required: true,
    unique: true,
  })
  restaurantId!: Types.ObjectId;
  @Prop({ type: [BusinessDaySchema], default: [] })
  openingHours!: BusinessDay[];
  @Prop({ default: 0, min: 0 }) minimumOrder!: number;
  @Prop({ default: 0, min: 0 }) minimumOrderCents!: number;
  @Prop({ default: true }) pickupEnabled!: boolean;
  @Prop({ default: false }) deliveryEnabled!: boolean;
  @Prop({ min: 0 }) preparationMinutes?: number;
  @Prop({ default: false }) rappidexEnabled!: boolean;
}
export const RestaurantSettingsSchema =
  SchemaFactory.createForClass(RestaurantSettings);
