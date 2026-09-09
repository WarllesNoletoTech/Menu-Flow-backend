import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CustomerAddress, User, UserDocument } from '../common/schemas';
import { Role } from '../common/roles';

export type AddressInput = { label: string; street: string; number: string; neighborhood: string; city: string; state: string; zipCode: string; complement?: string; primary?: boolean };
@Injectable()
export class CustomersService {
  constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {}
  private customer(id: string) { return this.users.findOne({ _id: id, role: Role.CUSTOMER, active: true }); }
  async profile(id: string) { const user = await this.customer(id).lean(); if (!user) throw new NotFoundException('Customer not found'); return { id: user._id.toString(), name: user.name, email: user.email, phone: user.phone, addresses: user.addresses ?? [] }; }
  async updateProfile(id: string, input: { name?: string; phone?: string }) { const user = await this.users.findOneAndUpdate({ _id: id, role: Role.CUSTOMER }, input, { new: true }).lean(); if (!user) throw new NotFoundException('Customer not found'); return this.profile(id); }
  async addAddress(id: string, input: AddressInput) { const user = await this.customer(id); if (!user) throw new NotFoundException('Customer not found'); if (input.primary || user.addresses.length === 0) user.addresses.forEach((address) => { address.primary = false; }); user.addresses.push({ ...input, primary: input.primary ?? user.addresses.length === 0 }); await user.save(); return user.addresses; }
  async updateAddress(id: string, addressId: string, input: Partial<AddressInput>) { const user = await this.customer(id); if (!user) throw new NotFoundException('Customer not found'); const address = (user.addresses as Array<CustomerAddress & { _id: { toString(): string } }>).find((item) => item._id.toString() === addressId); if (!address) throw new NotFoundException('Address not found'); if (input.primary) user.addresses.forEach((item) => { item.primary = false; }); Object.assign(address, input); await user.save(); return user.addresses; }
  async removeAddress(id: string, addressId: string) { const user = await this.customer(id); if (!user) throw new NotFoundException('Customer not found'); const index = (user.addresses as Array<CustomerAddress & { _id: { toString(): string } }>).findIndex((item) => item._id.toString() === addressId); if (index < 0) throw new NotFoundException('Address not found'); const wasPrimary = user.addresses[index].primary; user.addresses.splice(index, 1); if (wasPrimary && user.addresses[0]) user.addresses[0].primary = true; await user.save(); return user.addresses; }
}
