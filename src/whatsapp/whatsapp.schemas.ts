import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true })
export class WhatsappConnection {
  @Prop({ type: Types.ObjectId, required: true, unique: true }) restaurantId!: Types.ObjectId;
  @Prop({ unique: true, sparse: true }) phoneNumberId?: string;
  @Prop() displayPhone?: string;
  @Prop({ select: false }) encryptedToken?: string;
  @Prop({ default: false }) enabled!: boolean;
  @Prop({ default: '' }) greeting!: string;
  @Prop({ default: '' }) deliveryText!: string;
  @Prop({ default: '' }) handoffText!: string;
  @Prop() verifiedAt?: Date;
  @Prop() lastReceivedAt?: Date;
  @Prop() lastError?: string;
  @Prop() leaseUntil?: Date;
}
export const WhatsappConnectionSchema = SchemaFactory.createForClass(WhatsappConnection);

@Schema({ timestamps: true })
export class WhatsappConversation {
  @Prop({ type: Types.ObjectId, required: true }) restaurantId!: Types.ObjectId;
  @Prop({ required: true }) phoneNumberId!: string;
  @Prop({ required: true }) customerPhone!: string;
  @Prop({ default: '' }) customerName!: string;
  @Prop({ default: false }) human!: boolean;
  @Prop({ default: false }) optedOut!: boolean;
  @Prop() lastIncomingAt?: Date;
  @Prop({ default: '' }) lastText!: string;
}
export const WhatsappConversationSchema = SchemaFactory.createForClass(WhatsappConversation);
WhatsappConversationSchema.index({ restaurantId: 1, phoneNumberId: 1, customerPhone: 1 }, { unique: true });
WhatsappConversationSchema.index({ restaurantId: 1, updatedAt: -1 });

@Schema({ timestamps: true })
export class WhatsappMessage {
  @Prop({ type: Types.ObjectId, required: true }) restaurantId!: Types.ObjectId;
  @Prop({ type: Types.ObjectId, required: true }) conversationId!: Types.ObjectId;
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ enum: ['IN', 'OUT'], required: true }) direction!: string;
  @Prop({ required: true }) text!: string;
  @Prop() metaId?: string;
  @Prop({ default: 'pending' }) status!: string;
  @Prop({ default: '' }) controlReply!: string;
  @Prop() error?: string;
  @Prop() sentAt?: Date;
}
export const WhatsappMessageSchema = SchemaFactory.createForClass(WhatsappMessage);
WhatsappMessageSchema.index({ restaurantId: 1, status: 1, createdAt: 1 });
WhatsappMessageSchema.index({ restaurantId: 1, metaId: 1 });
WhatsappMessageSchema.index({ conversationId: 1, createdAt: -1 });
WhatsappMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
